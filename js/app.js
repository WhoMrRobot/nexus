// Nexus: chat with a private knowledge base from the phone. It runs entirely in the browser:
// files come from GitHub, answers from Gemini, and the keys stay in this phone's storage.
import { DEFAULTS, loadSettings, saveSettings, dropPinData, chats, fileCache } from './store.js';
import { Repo, IMAGE, bytesToBase64 } from './github.js';
import { stream, checkModel } from './gemini.js';
import * as openrouter from './openrouter.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { TOOLS, INBOX, INBOX_HEADER, systemPrompt } from './prompt.js';
import { Orb } from './orb.js';
import { Brain } from './brain.js';

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const log = $('#log');
const input = $('#input');
const statusEl = $('#status');
const sendBtn = $('#btn-send');
const settingsDialog = $('#settings');
const form = $('#settings-form');

let settings = { ...DEFAULTS };
let repo = null;
let repoLoading = null;
let repoLoadedAt = 0;
let chat = null;           // { id, title, created, updated, history: [Gemini Content] }
let busy = false;
let controller = null;
let notice = null;         // { kind: 'error' | 'note', text, retry }
let pending = [];          // photos picked for the next message: [base64 jpeg]
// Request shapes learned at run time; the thinking setting each model accepts is remembered, so a
// rejected request (which still counts against the free limit) isn't repeated after every restart.
const quirks = { think: (() => { try { return JSON.parse(localStorage.getItem('nexus.think') || '{}'); } catch { return {}; } })(), photoParts: 'nested' };
let deepNext = false;      // the Deep button: the next message uses the Deep model
let liveNote = '';         // shown in the loader while waiting, e.g. for the free limit
let turnStarted = 0;
let hiddenDuringTurn = false;   // iOS pauses a web app in the background and drops its connections
let resumePending = false;

// A short event log (no message text or keys) kept on the phone, shown in Settings → More → Show log.
let events = (() => { try { return JSON.parse(localStorage.getItem('nexus.log') || '[]'); } catch { return []; } })();
function note(text) {
  events.push(`${new Date().toLocaleTimeString('en-GB')} ${text}`);
  events = events.slice(-80);
  try { localStorage.setItem('nexus.log', JSON.stringify(events)); } catch {}
}
const secondsSince = (t) => ((Date.now() - t) / 1000).toFixed(1);

// Two orbs: a small one in the loader (it changes with the step), a large one on the welcome screen.
const liveOrb = new Orb({ preset: 20, px: 22 });
const brain = new Brain();   // the home screen's graph of the notes

const ICON = {
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  read: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-8 7"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>',
};

init();

// ---------- startup ----------

async function init() {
  fitViewport();
  floatBars();
  bindUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => {   // seconds counter on the loader, so a slow answer is visibly still working
    const el = busy && log.querySelector('.loader .elapsed');
    if (el) el.textContent = `${Math.floor((Date.now() - turnStarted) / 1000)}s`;
  }, 1000);
  await dropPinData();
  settings = loadSettings();
  chat = newChat();   // a fresh launch always opens the home screen; earlier chats are in the chats list
  localStorage.setItem('nexus.chat', chat.id);
  renderAll();
  updateSend();
  scrollToEnd();
  if (!ready()) {
    setStatus('Setup needed');
    openSettings();
    return;
  }
  loadRepo().catch(() => {});
}

function ready() {
  return Boolean(settings.geminiKey && settings.githubToken && settings.repo);
}

// The status line under the title shows only what needs attention; the normal "files ready" state stays quiet.
function setStatus(text, quiet = false) {
  statusEl.textContent = quiet ? '' : text;
  statusEl.hidden = quiet;
  statusEl.title = text;
}

function readyText(r) {
  return `${r.textCount} file${r.textCount === 1 ? '' : 's'} ready`;
}

// iOS keeps the layout viewport when the keyboard opens, so size the app to the visible part.
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    app.style.height = `${vv.height}px`;
    app.style.transform = `translateY(${vv.offsetTop}px)`;
    app.classList.toggle('kb', window.innerHeight - vv.height > 120);   // keyboard open: drop the home-bar gap
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// The top bar and the message box float over the conversation (so the glass has something to blur);
// keep the conversation padded by their current heights, which change as the message grows.
function floatBars() {
  const bar = $('.bar');
  const composer = $('#composer');
  const pad = () => {
    const stick = nearBottom(160);
    log.style.paddingTop = `${bar.offsetHeight + 8}px`;
    log.style.paddingBottom = `${composer.offsetHeight + 20}px`;
    if (stick) scrollToEnd();
  };
  const watch = new ResizeObserver(pad);
  watch.observe(bar);
  watch.observe(composer);
  pad();
}

function loadRepo(force = false) {
  if (!ready()) return Promise.reject(new Error('Add your keys in Settings first.'));
  if (repoLoading) return repoLoading;
  if (!force && repo && Date.now() - repoLoadedAt < 5 * 60e3) return Promise.resolve(repo);
  const r = repo && !force ? repo : new Repo(settings);
  const started = Date.now();
  setStatus('Loading files…');
  repoLoading = r.load((done, total) => setStatus(`Loading files ${done}/${total}…`))
    .then(() => {
      repo = r;
      repoLoadedAt = Date.now();
      setStatus(readyText(r), true);
      brain.setNotes(
        r.tree.filter((e) => /.md$/i.test(e.path)).map((e) => ({ path: e.path, text: r.text.get(e.path) })),
        r.tree.filter((e) => IMAGE.test(e.path)).map((e) => e.path),
      );
      if (!chat?.history.length && !busy) renderAll();   // the greeting can now use the name from the notes
      note(`files: ${r.textCount} ready in ${secondsSince(started)}s`);
      return r;
    })
    .catch((err) => {
      setStatus(friendly(err).split('.')[0]);
      note(`files failed: ${err.status ?? ''} ${String(err.message).slice(0, 200)}`);
      throw err;
    })
    .finally(() => {
      repoLoading = null;
    });
  return repoLoading;
}

// ---------- chats ----------

function newChat() {
  const now = Date.now();
  return { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, title: '', created: now, updated: now, history: [] };
}

async function openChat(id) {
  const found = id ? await chats.get(id).catch(() => null) : null;
  const c = found || newChat();
  localStorage.setItem('nexus.chat', c.id);
  return c;
}

async function saveChat() {
  if (!chat.history.length) return;
  chat.updated = Date.now();
  if (!chat.title) chat.title = (userText(chat.history.find(isUserMessage)) || 'Photo').slice(0, 70);
  await chats.put(chat).catch((err) => console.warn('Could not save chat', err));
}

function isUserMessage(c) {
  return c?.role === 'user' && !c.parts.some((p) => p.functionResponse);
}

function userText(c) {
  return (c?.parts || []).filter((p) => p.text).map((p) => p.text).join('\n');
}

function lastUserMessage() {
  return [...chat.history].reverse().find(isUserMessage);
}

// ---------- sending ----------

async function submit(e) {
  e?.preventDefault();
  if (busy) {
    controller?.abort();
    return;
  }
  const text = input.value.trim();
  if (!text && !pending.length) return;
  if (!ready()) {
    openSettings();
    return;
  }
  const parts = [];
  if (text) parts.push({ text });
  for (const data of pending) parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
  input.value = '';
  autosize();
  pending = [];
  renderAttachments();
  notice = null;
  resumePending = false;
  repair(chat.history);   // a new message leaves an unfinished earlier answer behind
  chat.history.push({ role: 'user', parts, _time: Date.now(), ...(deepNext ? { _deep: true } : {}) });
  setDeep(false);
  renderAll();
  scrollToEnd();
  await runAgent();
}

async function runAgent(resumes = 0) {
  busy = true;
  controller = new AbortController();
  hiddenDuringTurn = document.visibilityState === 'hidden';
  turnStarted = Date.now();
  liveNote = resumes ? 'Reconnecting' : '';
  updateSend();
  renderLive();
  const deep = Boolean(lastUserMessage()?._deep);
  const turn = { chain: modelChain(deep), step: 0, deep, stripSignatures: false, waits: 0, round: 0, why: '' };
  let current = null;   // the reply being written, dropped if its request fails
  let aborted = false;
  let resume = false;
  try {
    const r = await loadRepo();
    const system = await buildSystem(r, userText(lastUserMessage()));
    for (let round = 0; round < 12; round++) {
      turn.round = round + 1;
      const reply = { role: 'model', parts: [] };
      current = reply;
      chat.history.push(reply);
      await callModel(reply, system, turn);
      current = null;
      if (!reply.parts.length) {
        chat.history.pop();
        throw new Error('The model sent an empty reply. Try again.');
      }
      const calls = reply.parts.filter((p) => p.functionCall);
      if (!calls.length) {
        Object.assign(reply, { _time: Date.now(), _took: Math.round((Date.now() - turnStarted) / 1000) });
        break;
      }
      const results = { role: 'user', parts: [] };
      chat.history.push(results);
      for (const p of calls) {
        const t = Date.now();
        const res = await runTool(p.functionCall);
        note(`tool ${p.functionCall.name} ${res.functionResponse.response?.error ? 'failed' : 'ok'} (${secondsSince(t)}s)`);
        results.parts.push(res);
        renderLive();
      }
    }
    note(`answer done in ${secondsSince(turnStarted)}s`);
  } catch (err) {
    aborted = controller.signal.aborted && !(err?.status === 'timeout');
    if (aborted) {
      notice = { kind: 'note', text: 'Stopped.' };
      note('stopped by user');
    } else {
      // Drop the half-written reply; tool results that finished stay, so a retry continues from them.
      if (current && chat.history[chat.history.length - 1] === current) chat.history.pop();
      const dropped = err instanceof TypeError || err?.status === 'timeout' || err?.name === 'AbortError';
      if (hiddenDuringTurn && dropped && resumes < 2) {
        resume = true;
        note('connection dropped while in the background; will continue');
      } else {
        notice = { kind: 'error', text: friendly(err), detail: `${err.status ?? ''} ${err.message}`.trim(), retry: true };
        note(`failed: ${err.status ?? ''} ${String(err.message).slice(0, 300)}`);
      }
    }
    console.error(err);
  } finally {
    busy = false;
    controller = null;
    liveNote = '';
    if (repo && !repoLoading) setStatus(readyText(repo), true);
    repair(chat.history, !aborted);
    updateSend();
    await saveChat();
    renderAll();
    if (nearBottom(400)) scrollToEnd();
  }
  if (resume) {
    if (document.visibilityState === 'visible') runAgent(resumes + 1);
    else resumePending = true;   // continue as soon as the app is open again
  }
}

// Make the history valid for the next request: drop empty replies and tool calls without results.
// With keepResults, a finished set of tool results stays so the answer can continue from it.
function repair(history, keepResults = false) {
  while (history.length) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (last.role === 'model' && !last.parts.length) {
      history.pop();
    } else if (last.role === 'user' && !isUserMessage(last) && !last.parts.length) {
      history.pop();
    } else if (last.role === 'model' && last.parts.some((p) => p.functionCall)) {
      history.pop();
    } else if (last.role === 'user' && !isUserMessage(last)) {
      const complete = prev?.role === 'model' && prev.parts.filter((p) => p.functionCall).length === last.parts.length;
      if (keepResults && complete) break;
      history.pop();
      if (history[history.length - 1]?.role === 'model') history.pop();
    } else {
      break;
    }
  }
}

async function buildSystem(r, message) {
  const files = [];
  for (const path of r.expand(settings.preload)) {
    try { files.push({ path, text: await r.readText(path) }); } catch {}
  }
  const found = r.relevant(message, { exclude: files.map((f) => f.path) });
  if (found.length) note(`search sent along: ${found.map((f) => f.path).join(', ')}`);
  const now = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return systemPrompt({ files, found, now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

// The models to try for one answer, in order: each is used until it fails, then the next.
function modelChain(deep) {
  const chain = [];
  const add = (provider, model) => {
    if (model && !chain.some((m) => m.provider === provider && m.model === model)) chain.push({ provider, model });
  };
  if (deep) add('gemini', settings.deepModel);
  add('gemini', settings.model);
  add('gemini', settings.fallbackModel);
  if (settings.openrouterKey) add('openrouter', settings.openrouterModels);
  return chain;
}

// "gemini-3.5-flash-lite" → "Gemini 3.5 Flash-Lite"; "thinkingmachines/inkling:free" → "inkling".
function modelLabel(target) {
  const id = String(typeof target === 'string' ? target : target?.model || '');
  if (target?.provider === 'openrouter' && !id.includes(':free,') && id.includes(',')) return 'OpenRouter';
  if (id.startsWith('gemini-')) {
    return `Gemini ${id.slice(7).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').replace('Flash Lite', 'Flash-Lite')}`;
  }
  const name = id.split(',')[0].trim().split('/').pop().replace(/:free$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function requestBody(system, turn, model) {
  const level = quirks.think[model] ?? 0;
  const wanted = turn.deep && model === settings.deepModel ? 'high' : settings.thinking;
  const thinking = [
    { includeThoughts: true, thinkingLevel: wanted },
    { includeThoughts: true, thinkingLevel: wanted.toUpperCase() },
    { includeThoughts: true },
    null,
  ][level];
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: serialize(chat.history, turn),
    tools: [{ functionDeclarations: TOOLS }],
    ...(thinking ? { generationConfig: { thinkingConfig: thinking } } : {}),
  };
}

async function callModel(reply, system, turn) {
  for (let attempt = 0; ; attempt++) {
    const target = turn.chain[turn.step];
    if (!target) throw new Error('No model is set up. Check the Gemini key in Settings.');
    const started = Date.now();
    let first = 0;
    let usage = null;
    let finish = '';
    let answeredBy = '';
    try {
      let chunks;
      let size;
      if (target.provider === 'openrouter') {
        const contents = serialize(chat.history, turn);
        size = system.length + JSON.stringify(contents, (k, v) => (k === 'data' ? '' : v)).length;
        chunks = openrouter.stream({
          key: settings.openrouterKey,
          models: target.model.split(',').map((m) => m.trim()),
          system,
          contents,
          tools: TOOLS,
          signal: controller.signal,
        });
      } else {
        const body = requestBody(system, turn, target.model);
        size = JSON.stringify(body, (k, v) => (k === 'data' ? '' : v)).length;
        chunks = stream({ key: settings.geminiKey, model: target.model, body, signal: controller.signal });
      }
      note(`→ ${modelLabel(target)} round ${turn.round}: ${Math.round(size / 1000)}k chars sent`);
      for await (const chunk of chunks) {
        if (!first) {
          first = Date.now();
          note(`← first data after ${secondsSince(started)}s`);
          liveNote = '';
        }
        if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini refused the request (${chunk.promptFeedback.blockReason}).`);
        const cand = chunk.candidates?.[0];
        for (const p of cand?.content?.parts || []) mergePart(reply.parts, p);
        if (cand?.finishReason) finish = cand.finishReason;
        if (cand?.finishReason && cand.finishReason !== 'STOP') reply._finish = cand.finishReason;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (target.provider === 'openrouter' && chunk.modelVersion) answeredBy = chunk.modelVersion;
        renderLive();
      }
      const u = usage || {};
      note(`✓ ${secondsSince(started)}s ${finish || 'no finish reason'} · tokens in ${u.promptTokenCount ?? '?'}, out ${u.candidatesTokenCount ?? '?'}, thinking ${u.thoughtsTokenCount ?? 0}`);
      reply._by = answeredBy || target.model;
      if (turn.step > 0) Object.assign(reply, { _model: modelLabel(answeredBy || target), _why: `${modelLabel(turn.chain[0])} ${turn.why}` });
      return;
    } catch (err) {
      note(`✗ ${modelLabel(target)} after ${secondsSince(started)}s: ${err.status ?? ''} ${String(err.message).slice(0, 300)}`);
      if (controller.signal.aborted || reply.parts.length || attempt >= 6) throw err;
      const msg = String(err.message);
      const next = turn.chain[turn.step + 1];
      const gemini = target.provider === 'gemini';
      if (gemini && err.status === 400 && /thinking/i.test(msg) && (quirks.think[target.model] ?? 0) < 3) {
        quirks.think[target.model] = (quirks.think[target.model] ?? 0) + 1;
        try { localStorage.setItem('nexus.think', JSON.stringify(quirks.think)); } catch {}
      } else if (gemini && err.status === 400 && quirks.photoParts === 'nested' && /function.?response|parts/i.test(msg)) {
        quirks.photoParts = 'sibling';
      } else if (gemini && err.status === 400 && /signature/i.test(msg) && !turn.stripSignatures) {
        turn.stripSignatures = true;
      } else if (([429, 500, 502, 503].includes(err.status) || err.status === 'timeout') && next) {
        turn.step++;
        turn.stripSignatures = true;
        turn.why = err.status === 'timeout' ? 'didn’t respond' : err.status === 429 ? 'hit its free limit' : 'was overloaded (not your limit)';
        liveNote = `${modelLabel(target)} ${err.status === 429 ? 'is at its limit' : 'is unavailable'}, trying ${modelLabel(next)}`;
      } else if (err.status === 429 && err.retryDelay && err.retryDelay <= 60 && turn.waits < 2) {
        turn.waits++;
        await countdown(err.retryDelay, 'Free limit reached, waiting');
      } else if ([500, 502, 503].includes(err.status)) {
        await sleep(1500 * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
}

async function countdown(seconds, label) {
  for (let s = Math.ceil(seconds); s > 0; s--) {
    if (controller.signal.aborted) throw new Error('Stopped.');
    liveNote = `${label} ${s}s`;
    renderLive();
    await sleep(1000);
  }
  liveNote = '';
}

// Streamed text arrives in pieces; join them, keeping thought text and answer text apart.
function mergePart(parts, p) {
  const last = parts[parts.length - 1];
  if (p.text !== undefined && !p.functionCall && last && last.text !== undefined && !last.functionCall &&
      Boolean(last.thought) === Boolean(p.thought) && !last.thoughtSignature) {
    last.text += p.text;
    if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
    return;
  }
  if (p.text === '' && !p.thoughtSignature && !p.functionCall) return;
  parts.push({ ...p });
}

// What Gemini sees. To stay inside the free limits, earlier answers keep their text but not the files
// they read or their thinking (the model can read a file again), and photos come only from the last two messages.
function serialize(history, turn) {
  const users = history.map((c, i) => (isUserMessage(c) ? i : -1)).filter((i) => i >= 0);
  const photosFrom = users.length > 2 ? users[users.length - 2] : 0;
  const thisTurn = users.length ? users[users.length - 1] : 0;
  const out = [];
  history.forEach((c, i) => {
    const old = i < photosFrom;
    const earlier = i < thisTurn;
    const parts = [];
    for (const p of c.parts) {
      if (p.inlineData) {
        parts.push(old ? { text: '[photo sent earlier]' } : { inlineData: p.inlineData });
      } else if (p.functionResponse) {
        const { parts: media, ...fr } = p.functionResponse;
        if (earlier && fr.name !== 'save_to_inbox') {
          parts.push({ functionResponse: { ...fr, response: { note: 'Result shown earlier and left out here; call the tool again if you need it.' } } });
        } else if (media?.length && !old) {
          if (quirks.photoParts === 'nested') parts.push({ functionResponse: { ...fr, parts: media } });
          else parts.push({ functionResponse: fr }, ...media);
        } else {
          parts.push({ functionResponse: fr });
        }
      } else if (earlier && p.thought) {
        continue;
      } else {
        const q = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')));
        if (turn.stripSignatures && q.thoughtSignature) {
          if (q.functionCall) q.thoughtSignature = 'skip_thought_signature_validator';
          else delete q.thoughtSignature;
        }
        parts.push(q);
      }
    }
    if (!parts.length) return;   // e.g. the reply being written right now
    const prev = out[out.length - 1];
    if (prev && isUserMessage(c) && isUserMessage(prev)) prev.parts.push(...parts);
    else out.push({ role: c.role, parts });
  });
  return trim(out);
}

// Keep the text sent per request under about 100k tokens by dropping the oldest exchanges.
function trim(contents) {
  const size = (cs) => JSON.stringify(cs, (k, v) => (k === 'data' ? '' : v)).length;
  let cs = contents;
  while (size(cs) > 400_000) {
    const next = cs.findIndex((c, i) => i > 0 && isUserMessage(c));
    if (next <= 0) break;
    cs = cs.slice(next);
  }
  return cs;
}

// ---------- tools ----------

// read_file takes `paths`; accept a single `path` too, in case the model sends that.
function readPaths(args = {}) {
  return [...(Array.isArray(args.paths) ? args.paths : []), ...(args.path ? [args.path] : [])].filter(Boolean);
}

async function runTool({ name, args = {}, id }) {
  const reply = (response, media) => ({
    functionResponse: { name, ...(id ? { id } : {}), response, ...(media?.length ? { parts: media } : {}) },
  });
  try {
    switch (name) {
      case 'list_files':
        return reply({ result: repo.list(args.folder) });
      case 'read_file': {
        const files = [];
        let budget = 120_000;   // characters for all files in this call together
        for (const path of readPaths(args).slice(0, 6)) {
          try {
            let text = await repo.readText(path);
            if (text.length > budget) text = `${text.slice(0, Math.max(0, budget))}\n\n[Cut here: too much for one call.]`;
            budget -= text.length;
            files.push({ path, content: text });
          } catch (err) {
            files.push({ path, error: err.message, ...(err.similar?.length ? { similar_paths: err.similar } : {}) });
          }
        }
        return reply(files.length ? { files } : { error: 'No path given.' });
      }
      case 'search_files':
        return reply({ result: repo.search(args.query) });
      case 'view_photos': {
        const paths = (args.paths || []).slice(0, 4);
        const media = [];
        const loaded = [];
        for (const path of paths) {
          if (!IMAGE.test(path)) continue;
          const { path: real, blob } = await repo.readBytes(path);
          media.push({ inlineData: { mimeType: 'image/jpeg', data: await shrink(blob, 1280, 0.8) } });
          loaded.push(real);
        }
        if (!loaded.length) return reply({ error: 'No photo found at those paths.' });
        return reply({ result: `Loaded ${loaded.length} photo(s), attached in order: ${loaded.join(', ')}` }, media);
      }
      case 'save_to_inbox':
        return reply(await saveToInbox(args));
      default:
        return reply({ error: `Unknown tool ${name}` });
    }
  } catch (err) {
    return reply({ error: err.message, ...(err.similar?.length ? { similar_paths: err.similar } : {}) });
  }
}

async function saveToInbox({ kind = 'note', text = '', include_photos: withPhotos = false }) {
  if (!String(text).trim()) return { error: 'Nothing to save.' };
  const stamp = localStamp(new Date());
  const photos = [];
  if (withPhotos) {
    const images = (lastUserMessage()?.parts || []).filter((p) => p.inlineData);
    for (let i = 0; i < images.length; i++) {
      const path = `inbox/photos/${stamp.file}-${i + 1}.jpg`;
      await repo.putFile(path, images[i].inlineData.data, `Phone: photo ${stamp.date}`);
      photos.push(path);
    }
  }
  const entry = `\n## ${stamp.date} ${stamp.time} · ${kind}\n${String(text).trim()}\n${photos.length ? `Photos: ${photos.join(', ')}\n` : ''}`;
  await repo.appendFile(INBOX, entry, `Phone: ${kind} ${stamp.date}`, INBOX_HEADER);
  return { saved: true, file: INBOX, photos };
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { date, time: `${p(d.getHours())}:${p(d.getMinutes())}`, file: `${date}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that photo.')); };
    img.src = url;
  });
}

// Resize to fit `max` pixels and re-encode as JPEG; returns base64 without the data: prefix.
async function shrink(blob, max, quality) {
  const img = await loadImage(blob);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const bytes = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return bytesToBase64(new Uint8Array(await bytes.arrayBuffer()));
}

// ---------- rendering ----------

function exchanges(history) {
  const out = [];
  for (const c of history) {
    if (isUserMessage(c)) out.push({ user: c, steps: [] });
    else if (out.length) out[out.length - 1].steps.push(c);
  }
  return out;
}

function renderAll() {
  const groups = exchanges(chat.history);
  log.innerHTML = groups.length ? groups.map((g, i) => renderExchange(g, busy && i === groups.length - 1)).join('') : emptyState();
  if (notice) log.insertAdjacentHTML('beforeend', renderNotice());
  input.placeholder = placeholder();
  placeOrbs();
}

// Put the orb canvases into their slots (the same canvas each time, so the animation runs on).
function placeOrbs() {
  const slot = log.querySelector('.orb-slot');
  if (slot) {
    liveOrb.setState(slot.dataset.state || 'working');
    slot.replaceWith(liveOrb.canvas);
    liveOrb.start();
  } else {
    liveOrb.stop();
  }
  const hero = log.querySelector('.hero-slot');
  if (hero) {
    brain.setSize(Math.min(window.innerWidth - 32, 380));
    hero.replaceWith(brain.canvas);
    brain.start();
  } else {
    brain.stop();
  }
}

let liveQueued = false;
function renderLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    const groups = exchanges(chat.history);
    if (!groups.length) return;
    const near = nearBottom();
    const nodes = log.querySelectorAll('.exchange');
    const html = renderExchange(groups[groups.length - 1], busy);
    if (nodes.length === groups.length) {
      const opened = nodes[nodes.length - 1].querySelector('details.thinking')?.open;
      nodes[nodes.length - 1].outerHTML = html;
      if (opened) log.querySelector('.exchange:last-of-type details.thinking')?.setAttribute('open', '');
      placeOrbs();
    }
    else renderAll();
    if (near) scrollToEnd();
  });
}

// "9:41 PM" for today, "24 Oct, 9:41 PM" for other days, in the phone's own 12/24-hour style.
function clock(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

function renderExchange({ user, steps }, live) {
  const text = userText(user);
  const photos = user.parts.filter((p) => p.inlineData)
    .map((p) => `<img src="data:${p.inlineData.mimeType};base64,${p.inlineData.data}" alt="">`).join('');
  const acts = [];
  const answers = [];
  const notes = [];
  let thoughts = '';
  let answeredAt = 0;
  let took = 0;
  let by = '';
  for (const c of steps) {
    if (c.role === 'model') {
      let answer = '';
      for (const p of c.parts) {
        if (p.functionCall) acts.push({ call: p.functionCall, res: null });
        else if (p.thought && p.text) thoughts += `${p.text}\n\n`;
        else if (p.text) answer += p.text;
      }
      if (answer.trim()) answers.push(answer);
      if (c._time) answeredAt = c._time;
      if (c._took) took = c._took;
      if (c._by) by = modelLabel(c._by);
      if (c._model) notes.push(`Answered by ${c._model}: ${c._why || 'the main model hit its limit'}.`);
      if (c._finish) notes.push(finishNote(c._finish));
    } else {
      for (const p of c.parts) {
        const fr = p.functionResponse;
        const act = fr && acts.find((a) => !a.res && a.call.name === fr.name);
        if (act) act.res = fr;
      }
    }
  }
  const lastStep = steps[steps.length - 1];
  const streamingAnswer = lastStep?.role === 'model' && lastStep.parts.some((p) => p.text && !p.thought);
  const pendingAct = live ? acts.find((a) => !a.res) : null;
  const waiting = live && (pendingAct || !streamingAnswer);
  return `<section class="exchange">
    <div class="msg user">${photos ? `<div class="photos">${photos}</div>` : ''}${text ? `<div class="text">${escapeHtml(text)}</div>` : ''}</div>
    ${user._time ? `<p class="time sent">${user._deep ? '<span class="tag">Deep</span>' : ''}${escapeHtml(clock(user._time))}</p>` : ''}
    <div class="msg assistant">
      ${acts.length ? `<ul class="activity">${acts.map(renderAct).join('')}</ul>` : ''}
      ${thoughts ? `<details class="thinking"><summary>Thinking</summary><div>${renderMarkdown(thoughts)}</div></details>` : ''}
      ${answers.length ? `<div class="answer">${renderMarkdown(answers.join('\n\n'))}</div>` : ''}
      ${waiting ? `<div class="loader"><span class="orb-slot" data-state="${orbState(pendingAct?.call, liveNote, thoughts)}"></span><span class="label">${escapeHtml(liveNote || (pendingAct ? actLabel(pendingAct.call) : 'Thinking'))}…</span><span class="elapsed"></span></div>` : ''}
      ${[...new Set(notes)].map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}
      ${answeredAt && !live ? `<p class="time">${escapeHtml([clock(answeredAt), took ? `${took}s` : '', by].filter(Boolean).join(' · '))}</p>` : ''}
    </div>
  </section>`;
}

// Which orb animation fits the current step.
function orbState(call, note, thoughts) {
  if (/limit|waiting/i.test(note)) return 'breathing';
  if (/reconnect|trying|unavailable/i.test(note)) return 'connecting';
  if (call?.name === 'save_to_inbox') return 'weaving';
  if (call?.name === 'view_photos') return 'shaping';
  if (call) return 'searching';
  return thoughts ? 'solving' : 'working';
}

function actLabel({ name, args = {} }) {
  switch (name) {
    case 'read_file': {
      const paths = readPaths(args);
      return `Reading ${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` and ${paths.length - 2} more` : ''}`;
    }
    case 'search_files': return `Searching “${args.query}”`;
    case 'list_files': return args.folder ? `Listing ${args.folder}` : 'Listing files';
    case 'view_photos': return `Looking at ${(args.paths || []).length} photo(s)`;
    case 'save_to_inbox': return 'Saving to inbox';
    default: return name;
  }
}

function renderAct({ call, res }) {
  const failed = res?.response?.error;
  const icon = failed ? ICON.error : ({ read_file: ICON.read, search_files: ICON.search, list_files: ICON.list, view_photos: ICON.photo, save_to_inbox: ICON.save })[call.name] || ICON.list;
  let label = actLabel(call);
  if (call.name === 'save_to_inbox' && res && !failed) label = `Saved to inbox (${call.args?.kind || 'note'})`;
  const thumbs = (res?.parts || []).filter((p) => p.inlineData)
    .map((p) => `<img src="data:${p.inlineData.mimeType};base64,${p.inlineData.data}" alt="">`).join('');
  return `<li class="${failed ? 'failed' : res ? 'done' : 'running'}">${icon}<span>${escapeHtml(label)}${failed ? ` — ${escapeHtml(String(failed))}` : ''}</span>${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}</li>`;
}

function finishNote(reason) {
  return ({
    MAX_TOKENS: 'The reply was cut off at the length limit.',
    SAFETY: 'Gemini stopped this reply for safety reasons.',
    RECITATION: 'Gemini stopped this reply (it looked like quoted text).',
    MALFORMED_FUNCTION_CALL: 'Gemini made a broken tool call. Try again.',
  })[reason] || `Gemini stopped early (${reason}).`;
}

function renderNotice() {
  return `<div class="notice ${notice.kind}">${escapeHtml(notice.text)}${notice.retry ? ' <button type="button" data-act="retry">Retry</button>' : ''}` +
    `${notice.detail ? `<details><summary>Details</summary><pre>${escapeHtml(notice.detail)}</pre></details>` : ''}</div>`;
}

// A greeting for the time of day, with the name from Settings or the notes, and a question.
// The line is picked by the hour, so it stays the same while the screen re-renders.
const GREETINGS = [
  [0, 4, 'Late night', ['Still up? What’s on your mind?', 'Quiet hours. What are we thinking about?']],
  [4, 7, 'Early start', ['The day hasn’t started yet. What are we planning?', 'Up before the sun. What’s first?']],
  [7, 11, 'Good morning', ['Coffee first? Then what are we up to today?', 'What’s the plan for today?']],
  [11, 14, 'Good afternoon', ['How’s the day going so far?', 'What are we working on now?']],
  [14, 17, 'Afternoon', ['Coffee break? What are we up to now?', 'What’s next on the list?']],
  [17, 21, 'Good evening', ['How did today go?', 'Anything worth writing down from today?']],
  [21, 24, 'Winding down', ['Anything to note before the day ends?', 'How was today, honestly?']],
];

function emptyState() {
  const now = new Date();
  const h = now.getHours();
  const [, , hello, questions] = GREETINGS.find(([from, to]) => h >= from && h < to);
  const name = settings.name || repo?.ownerName || '';
  const question = questions[(now.getDate() + h) % questions.length];
  return `<div class="empty">
    <div class="hero"><span class="hero-slot"></span></div>
    <h1>${escapeHtml(name ? `${hello}, ${name}` : hello)}</h1>
    <p>${escapeHtml(question)}</p>
  </div>`;
}

function placeholder() {
  if (deepNext) return `Deep answer with ${modelLabel(settings.deepModel)}…`;
  return chat?.history.length ? 'Reply…' : 'Message Nexus';
}

function nearBottom(margin = 120) {
  return log.scrollHeight - log.scrollTop - log.clientHeight < margin;
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

function updateSend() {
  sendBtn.innerHTML = busy ? ICON.stop : ICON.send;
  sendBtn.classList.toggle('stop', busy);
  sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
}

function friendly(err) {
  const s = err?.status;
  if (err?.source === 'gemini') {
    if (s === 429) return `Gemini’s free limits are used up for now. Try again in a minute; the daily limits reset at ${dailyReset()}. Adding an OpenRouter key in Settings gives you a backup.`;
    if (s === 400 && /api key/i.test(err.message)) return 'The Gemini key was refused. Check it in Settings.';
    if (s === 401 || s === 403) return 'The Gemini key was refused. Check it in Settings.';
    if (s === 404) return `Gemini doesn't know the model "${settings.model}". Check the model name in Settings.`;
    if (s === 'timeout') return 'Gemini stopped answering (nothing came back for 75 seconds), on the backup model too. Tap Retry, or set Thinking to Low.';
    if (s === 500 || s === 503) return 'Gemini is overloaded right now (Google’s side, not your limit). Tap Retry in a minute.';
  }
  if (err?.source === 'openrouter') {
    if (s === 401) return 'OpenRouter refused the key. Check it in Settings.';
    if (s === 402) return 'OpenRouter wants credit for that model. Use models ending in :free (Settings → Advanced).';
    if (s === 404 && /polic|endpoint/i.test(err.message)) return 'OpenRouter blocked the free models: on openrouter.ai go to Settings → Privacy and allow free models.';
    if (s === 429) return `Every free limit is used up for now (Gemini and OpenRouter). Gemini’s daily limits reset at ${dailyReset()}.`;
    if (s === 'timeout') return 'OpenRouter stopped answering (nothing for 75 seconds). Tap Retry.';
  }
  if (err?.source === 'github') {
    if (s === 401) return 'GitHub refused the token. It may have expired: make a new one and paste it in Settings.';
    if (s === 403) return 'GitHub refused access. Check that the token can read and write this repo.';
    if (s === 404) return 'GitHub can’t find the repo or file. Check the repo name, and that the token includes this repo.';
  }
  if (err instanceof TypeError) return 'The connection dropped. This happens when the phone switches network or the app goes to the background mid-answer. Tap Retry.';
  return err?.message || String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini's daily limits reset at midnight Pacific time; shown in the phone's own time.
function dailyReset() {
  const start = Math.ceil(Date.now() / 900_000) * 900_000;
  for (let t = start; t < start + 26 * 3_600_000; t += 900_000) {
    const pacific = new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
    if (pacific === '00:00') return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return 'midnight Pacific time';
}

function setDeep(on) {
  deepNext = on;
  const btn = $('#btn-deep');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  input.placeholder = placeholder();
}

// ---------- composer, drawer, settings ----------

function bindUi() {
  $('#composer').addEventListener('submit', submit);
  $('#btn-deep').addEventListener('click', () => setDeep(!deepNext));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover) and (pointer: fine)').matches) submit(e);
  });

  $('#file').addEventListener('change', async (e) => {
    for (const f of [...e.target.files].slice(0, 4 - pending.length)) {
      try { pending.push(await shrink(f, 1600, 0.85)); } catch (err) { notice = { kind: 'error', text: err.message }; renderAll(); }
    }
    e.target.value = '';
    renderAttachments();
  });
  $('#attachments').addEventListener('click', (e) => {
    const i = e.target.closest('[data-remove]')?.dataset.remove;
    if (i !== undefined) { pending.splice(Number(i), 1); renderAttachments(); }
  });

  log.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="retry"]') && !busy) {
      // Continue from the last finished step (files already read stay); a half-written reply was dropped.
      repair(chat.history, true);
      notice = null;
      renderAll();
      runAgent();
    }
  });

  $('#btn-new').addEventListener('click', async () => {
    if (busy || !chat.history.length) return;
    await saveChat();
    chat = newChat();
    localStorage.setItem('nexus.chat', chat.id);
    notice = null;
    renderAll();
    input.focus();
  });

  $('#btn-chats').addEventListener('click', openDrawer);
  $('#drawer').addEventListener('click', async (e) => {
    if (e.target.closest('.drawer-backdrop')) { closeDrawer(); return; }
    const del = e.target.closest('[data-delete]');
    if (del) {
      if (!confirm('Delete this chat from this phone?')) return;
      await chats.del(del.dataset.delete);
      if (chat.id === del.dataset.delete) { chat = newChat(); localStorage.setItem('nexus.chat', chat.id); renderAll(); }
      openDrawer();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open && !busy) {
      chat = await openChat(open.dataset.open);
      notice = null;
      renderAll();
      scrollToEnd();
      closeDrawer();
    }
  });

  $('#btn-settings').addEventListener('click', () => { closeDrawer(); openSettings(); });
  $('#btn-close').addEventListener('click', () => settingsDialog.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = readForm();
    if (!next.geminiKey || !next.githubToken) {
      $('#test-result').textContent = 'Add the Gemini key and the GitHub token first.';
      return;
    }
    if (!next.repo) {
      $('#advanced').open = true;
      $('#test-result').textContent = 'Add the repository under Advanced (owner/name).';
      return;
    }
    const reload = ['githubToken', 'repo', 'branch'].some((k) => next[k] !== settings[k]);
    settings = next;
    saveSettings(settings);
    settingsDialog.close();
    if (reload) repo = null;
    if (ready()) loadRepo(reload).catch(() => {});
  });
  $('#btn-test').addEventListener('click', testConnection);
  $('#btn-log').addEventListener('click', () => {
    $('#test-result').textContent = events.length ? events.slice(-40).join('\n') : 'Nothing logged yet.';
    $('#test-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('#btn-refresh').addEventListener('click', async () => {
    await fileCache.clear().catch(() => {});
    repo = null;
    settingsDialog.close();
    loadRepo(true).catch(() => {});
  });
  $('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Delete every chat saved on this phone? Your knowledge base is not touched.')) return;
    await chats.clear();
    chat = newChat();
    localStorage.setItem('nexus.chat', chat.id);
    renderAll();
    settingsDialog.close();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (busy) hiddenDuringTurn = true;
      return;
    }
    if (busy || !ready()) return;
    if (resumePending) {
      resumePending = false;
      runAgent(1);
      return;
    }
    loadRepo().catch(() => {});
  });
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = pending.map((data, i) =>
    `<div class="pending"><img src="data:image/jpeg;base64,${data}" alt=""><button type="button" data-remove="${i}" aria-label="Remove photo">×</button></div>`).join('');
  box.hidden = !pending.length;
}

async function openDrawer() {
  const list = (await chats.list().catch(() => [])).sort((a, b) => b.updated - a.updated);
  $('#chat-list').innerHTML = list.length
    ? list.map((c) => `<li class="${c.id === chat.id ? 'current' : ''}">
        <button type="button" class="open" data-open="${escapeHtml(c.id)}"><span>${escapeHtml(c.title || 'Untitled')}</span><small>${new Date(c.updated).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></button>
        <button type="button" class="icon" data-delete="${escapeHtml(c.id)}" aria-label="Delete chat">×</button>
      </li>`).join('')
    : '<li class="none">No saved chats yet.</li>';
  $('#drawer').hidden = false;
}

function closeDrawer() {
  $('#drawer').hidden = true;
}

function openSettings() {
  for (const [key, value] of Object.entries(settings)) if (form.elements[key]) form.elements[key].value = value;
  $('#test-result').textContent = '';
  if (!settingsDialog.open) settingsDialog.showModal();
}

function readForm() {
  const next = { ...settings };
  for (const key of Object.keys(settings)) if (form.elements[key]) next[key] = form.elements[key].value.trim();
  return next;
}

async function testConnection() {
  const out = $('#test-result');
  const s = readForm();
  const lines = [];
  out.textContent = 'Testing…';
  const repoName = new Repo(s).repo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoName)) {
    lines.push('GitHub ✗ Type the repository as owner/name (the grey text is only an example).');
  } else if (!s.githubToken) {
    lines.push('GitHub ✗ Paste the GitHub token first.');
  } else {
    try {
      const info = await new Repo(s).check();
      lines.push(`GitHub ✓ ${info.name}${info.private ? ' (private)' : ' (PUBLIC: make it private!)'}${info.canWrite ? '' : ' · token can’t write: the inbox won’t save'}`);
    } catch (err) {
      lines.push(`GitHub ✗ ${friendly(err)}`);
    }
  }
  for (const model of [...new Set([s.model, s.fallbackModel, s.deepModel].filter(Boolean))]) {
    try {
      const m = await checkModel(s.geminiKey, model);
      lines.push(`Gemini ✓ ${m.displayName || model}${model === s.deepModel ? ' (Deep)' : ''}`);
    } catch (err) {
      lines.push(`Gemini ✗ ${model}: ${err.status === 404 ? 'model not found' : friendly(err)}`);
    }
  }
  if (s.openrouterKey) {
    try {
      const key = await openrouter.checkKey(s.openrouterKey);
      lines.push(`OpenRouter ✓ key works${key.is_free_tier ? ' (free: about 50 requests a day)' : ''}`);
    } catch (err) {
      lines.push(`OpenRouter ✗ ${friendly(err)}`);
    }
  } else {
    lines.push('OpenRouter – no key (optional backup)');
  }
  out.textContent = lines.join('\n');
}
