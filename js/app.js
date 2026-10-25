// Nexus: chat with a private knowledge base from the phone. It runs entirely in the browser:
// files come from GitHub, answers from Gemini, and the keys stay in this phone's storage.
import { DEFAULTS, loadSettings, saveSettings, dropPinData, chats, fileCache } from './store.js';
import { Repo, IMAGE, bytesToBase64 } from './github.js';
import { stream, checkModel } from './gemini.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { TOOLS, INBOX, INBOX_HEADER, systemPrompt } from './prompt.js';

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
const quirks = { think: {}, photoParts: 'nested' };   // request shapes learned at run time
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
  bindUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => {   // seconds counter on the loader, so a slow answer is visibly still working
    const el = busy && log.querySelector('.loader .elapsed');
    if (el) el.textContent = `${Math.floor((Date.now() - turnStarted) / 1000)}s`;
  }, 1000);
  await dropPinData();
  settings = loadSettings();
  chat = await openChat(localStorage.getItem('nexus.chat'));
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

function setStatus(text) {
  statusEl.textContent = text;
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
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
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
      setStatus(readyText(r));
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
  chat.history.push({ role: 'user', parts, _time: Date.now() });
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
  const turn = { model: settings.model, fellBack: false, stripSignatures: false, waits: 0, round: 0 };
  let current = null;   // the reply being written, dropped if its request fails
  let aborted = false;
  let resume = false;
  try {
    const r = await loadRepo();
    const system = await buildSystem(r);
    for (let round = 0; round < 12; round++) {
      turn.round = round + 1;
      const reply = { role: 'model', parts: [] };
      current = reply;
      chat.history.push(reply);
      await callModel(reply, system, turn);
      current = null;
      if (!reply.parts.length) {
        chat.history.pop();
        throw new Error('Gemini sent an empty reply. Try again.');
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
    if (repo && !repoLoading) setStatus(readyText(repo));
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

async function buildSystem(r) {
  const files = [];
  for (const path of r.expand(settings.preload)) {
    try { files.push({ path, text: await r.readText(path) }); } catch {}
  }
  const now = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return systemPrompt({ files, now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

function requestBody(system, turn) {
  const level = quirks.think[turn.model] ?? 0;
  const thinking = [
    { includeThoughts: true, thinkingLevel: settings.thinking },
    { includeThoughts: true, thinkingLevel: settings.thinking.toUpperCase() },
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
    const started = Date.now();
    let first = 0;
    let usage = null;
    let finish = '';
    try {
      const body = requestBody(system, turn);
      const size = JSON.stringify(body, (k, v) => (k === 'data' ? '' : v)).length;
      note(`→ ${turn.model} round ${turn.round}: ${Math.round(size / 1000)}k chars sent`);
      for await (const chunk of stream({ key: settings.geminiKey, model: turn.model, body, signal: controller.signal })) {
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
        renderLive();
      }
      const u = usage || {};
      note(`✓ ${secondsSince(started)}s ${finish || 'no finish reason'} · tokens in ${u.promptTokenCount ?? '?'}, out ${u.candidatesTokenCount ?? '?'}, thinking ${u.thoughtsTokenCount ?? 0}`);
      if (turn.fellBack) Object.assign(reply, { _model: turn.model, _why: turn.why });
      return;
    } catch (err) {
      note(`✗ ${turn.model} after ${secondsSince(started)}s: ${err.status ?? ''} ${String(err.message).slice(0, 300)}`);
      if (controller.signal.aborted || reply.parts.length || attempt >= 5) throw err;
      const msg = String(err.message);
      const canFallBack = !turn.fellBack && settings.fallbackModel && settings.fallbackModel !== turn.model;
      if (err.status === 400 && /thinking/i.test(msg) && (quirks.think[turn.model] ?? 0) < 3) {
        quirks.think[turn.model] = (quirks.think[turn.model] ?? 0) + 1;
      } else if (err.status === 400 && quirks.photoParts === 'nested' && /function.?response|parts/i.test(msg)) {
        quirks.photoParts = 'sibling';
      } else if (err.status === 400 && /signature/i.test(msg) && !turn.stripSignatures) {
        turn.stripSignatures = true;
      } else if (([429, 500, 503].includes(err.status) || err.status === 'timeout') && canFallBack) {
        turn.model = settings.fallbackModel;
        turn.fellBack = true;
        turn.why = err.status === 'timeout' ? 'didn’t respond' : 'hit its limit';
        turn.stripSignatures = true;
        liveNote = err.status === 'timeout' ? `No reply, trying ${turn.model}` : `Limit hit, trying ${turn.model}`;
      } else if (err.status === 429 && err.retryDelay && err.retryDelay <= 60 && turn.waits < 2) {
        turn.waits++;
        await countdown(err.retryDelay, 'Free limit reached, waiting');
      } else if ([500, 503].includes(err.status)) {
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
      if (c._model) notes.push(`Answered by ${c._model}: the main model ${c._why || 'hit its limit'}.`);
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
    ${user._time ? `<p class="time sent">${escapeHtml(clock(user._time))}</p>` : ''}
    <div class="msg assistant">
      ${acts.length ? `<ul class="activity">${acts.map(renderAct).join('')}</ul>` : ''}
      ${thoughts ? `<details class="thinking"><summary>Thinking</summary><div>${renderMarkdown(thoughts)}</div></details>` : ''}
      ${answers.length ? `<div class="answer">${renderMarkdown(answers.join('\n\n'))}</div>` : ''}
      ${waiting ? `<div class="loader"><i></i><i></i><i></i><span>${escapeHtml(liveNote || (pendingAct ? actLabel(pendingAct.call) : 'Thinking'))}…</span><span class="elapsed"></span></div>` : ''}
      ${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}
      ${answeredAt && !live ? `<p class="time">${escapeHtml(clock(answeredAt))}${took ? ` · took ${took}s` : ''}</p>` : ''}
    </div>
  </section>`;
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

function emptyState() {
  const prompts = ['What should I focus on today?', 'Summarise where everything stands.', 'I want to add a journal entry.'];
  return `<div class="empty">
    <img src="icons/icon-192.png" alt="" width="64" height="64">
    <h1>Nexus</h1>
    <p>Ask about anything in your notes, or tell me what happened. New information goes to your inbox for the PC to file.</p>
    <div class="chips">${prompts.map((p) => `<button type="button" data-prompt="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}</div>
  </div>`;
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
    if (s === 429) return 'Gemini’s free limit is used up for now (on the backup model too). Try again in a minute, or tomorrow if it was the daily limit.';
    if (s === 400 && /api key/i.test(err.message)) return 'The Gemini key was refused. Check it in Settings.';
    if (s === 401 || s === 403) return 'The Gemini key was refused. Check it in Settings.';
    if (s === 404) return `Gemini doesn't know the model "${settings.model}". Check the model name in Settings.`;
    if (s === 'timeout') return 'Gemini stopped answering (nothing came back for 75 seconds), on the backup model too. Tap Retry, or set Thinking to Low.';
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

// ---------- composer, drawer, settings ----------

function bindUi() {
  $('#composer').addEventListener('submit', submit);
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
    const chip = e.target.closest('[data-prompt]');
    if (chip) { input.value = chip.dataset.prompt; autosize(); input.focus(); return; }
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

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close').addEventListener('click', () => settingsDialog.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = readForm();
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
  for (const model of [s.model, s.fallbackModel].filter(Boolean)) {
    try {
      const m = await checkModel(s.geminiKey, model);
      lines.push(`Gemini ✓ ${m.displayName || model}`);
    } catch (err) {
      lines.push(`Gemini ✗ ${model}: ${err.status === 404 ? 'model not found' : friendly(err)}`);
    }
  }
  out.textContent = lines.join('\n');
}
