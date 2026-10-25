// Reads and writes the private knowledge-base repo through the GitHub REST API.
// Text files are cached on the phone (encrypted) by git blob sha, so only changed files are downloaded again.
import { fileCache } from './store.js';

const API = 'https://api.github.com';
const TEXT = /\.(md|txt|csv|json)$/i;
export const IMAGE = /\.(jpe?g|png|webp|gif|heic)$/i;

export class Repo {
  constructor({ githubToken, repo, branch }) {
    this.token = githubToken;
    this.repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    this.branch = branch || 'main';
    this.tree = [];            // [{ path, sha, size }]
    this.text = new Map();     // path -> text, for text files
  }

  get textCount() {
    return this.text.size;
  }

  async api(path, opts = {}) {
    const res = await fetch(API + path, {
      cache: 'no-store',
      ...opts,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', ...opts.headers },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg += ` ${(await res.json()).message}`; } catch {}
      const err = new Error(`GitHub: ${msg}`);
      err.status = res.status;
      err.source = 'github';
      throw err;
    }
    return res;
  }

  async check() {
    const info = await (await this.api(`/repos/${this.repo}`)).json();
    return { name: info.full_name, private: info.private, canWrite: !!info.permissions?.push };
  }

  async load(onProgress) {
    const res = await this.api(`/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    const data = await res.json();
    this.tree = data.tree.filter((e) => e.type === 'blob').map(({ path, sha, size }) => ({ path, sha, size }));
    const texts = this.tree.filter((e) => TEXT.test(e.path));
    const fresh = new Map();
    let done = 0;
    await pool(texts, 6, async (e) => {
      fresh.set(e.path, await this.blobText(e.sha));
      onProgress?.(++done, texts.length);
    });
    this.text = fresh;
    this.prune();
  }

  async blobText(sha) {
    const cached = await fileCache.get(sha).catch(() => undefined);
    if (cached !== undefined) return cached;
    const res = await this.api(`/repos/${this.repo}/git/blobs/${sha}`, {
      cache: 'default',
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    const text = await res.text();
    fileCache.put(sha, text).catch(() => {});
    return text;
  }

  async prune() {
    const keep = new Set(this.tree.map((e) => e.sha));
    for (const sha of await fileCache.keys().catch(() => [])) if (!keep.has(sha)) fileCache.del(sha).catch(() => {});
  }

  find(path) {
    const p = normalize(path);
    return this.tree.find((e) => e.path === p) || this.tree.find((e) => e.path.toLowerCase() === p.toLowerCase());
  }

  similar(path) {
    const word = normalize(path).split('/').pop().replace(/\.[^.]+$/, '').split(/[-_ ]/)[0].toLowerCase();
    return this.tree.filter((e) => word && e.path.toLowerCase().includes(word)).slice(0, 8).map((e) => e.path);
  }

  // "AGENTS.md, about-*.md" -> matching paths, in the order given.
  expand(patterns) {
    const out = [];
    for (const raw of String(patterns || '').split(',')) {
      const pat = normalize(raw);
      if (!pat) continue;
      const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`, 'i');
      for (const e of this.tree) if (re.test(e.path) && !out.includes(e.path)) out.push(e.path);
    }
    return out;
  }

  list(folder = '') {
    const f = normalize(folder).replace(/\/$/, '');
    const entries = this.tree.filter((e) => !f || e.path.startsWith(`${f}/`));
    if (!entries.length) return { error: `No files under "${folder}".` };
    return entries.slice(0, 400).map((e) => `${e.path} (${Math.max(1, Math.round(e.size / 1024))} KB)`).join('\n');
  }

  search(query, max = 40) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { error: 'Empty search.' };
    const scan = (test) => {
      const hits = [];
      for (const [path, text] of this.text) {
        if (!/\.(md|txt)$/i.test(path)) continue;
        text.split('\n').forEach((line, i) => {
          const l = line.toLowerCase();
          if (test(l)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 300)}`);
        });
      }
      return hits;
    };
    let hits = scan((l) => terms.every((t) => l.includes(t)));
    let note = 'lines containing all the words';
    if (!hits.length && terms.length > 1) {
      hits = scan((l) => terms.some((t) => l.includes(t)));
      note = 'no line had all the words; lines with any of them';
    }
    return { matches: hits.length, showing: Math.min(max, hits.length), note, results: hits.slice(0, max) };
  }

  // The Markdown files whose words best match a message (rare words count most), so they can be sent
  // with the question and the model can often answer without asking for files first.
  relevant(message, { exclude = [], max = 3, budget = 40_000 } = {}) {
    const terms = [...new Set(String(message).toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) || [])]
      .filter((t) => !STOP.has(t)).slice(0, 25);
    const files = [...this.text.entries()].filter(([p]) => /\.md$/i.test(p) && !exclude.includes(p));
    if (!terms.length || !files.length) return [];
    const lower = new Map(files.map(([p, t]) => [p, t.toLowerCase()]));
    const weight = Object.fromEntries(terms.map((t) => {
      const df = files.filter(([p]) => lower.get(p).includes(t)).length;
      return [t, df ? Math.log(1 + files.length / df) : 0];
    }));
    const ranked = files
      .map(([path, text]) => ({ path, text, score: terms.reduce((s, t) => s + (lower.get(path).includes(t) ? weight[t] : 0), 0) }))
      .filter((f) => f.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);
    const out = [];
    let left = budget;
    for (const f of ranked) {
      const text = f.text.length <= Math.min(left, 30_000) ? f.text : snippets(f.text, terms, Math.min(left, 8_000));
      if (!text) continue;
      out.push({ path: f.path, text, partial: text !== f.text });
      left -= text.length;
      if (left < 2_000) break;
    }
    return out;
  }

  async readText(path) {
    const e = this.find(path);
    if (!e) {
      const err = new Error(`File not found: ${path}`);
      err.similar = this.similar(path);
      throw err;
    }
    if (IMAGE.test(e.path)) throw new Error(`${e.path} is a photo; use view_photos.`);
    if (this.text.has(e.path)) return this.text.get(e.path);
    return this.blobText(e.sha);
  }

  async readBytes(path) {
    const e = this.find(path);
    if (!e) throw new Error(`File not found: ${path}`);
    const res = await this.api(`/repos/${this.repo}/git/blobs/${e.sha}`, {
      cache: 'default',
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    const ext = e.path.split('.').pop().toLowerCase();
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic' }[ext];
    return { path: e.path, blob: new Blob([await res.arrayBuffer()], { type }) };
  }

  // Creates a new file; base64 is the file's content already encoded.
  async putFile(path, base64, message) {
    const res = await this.api(`/repos/${this.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: base64, branch: this.branch }),
    });
    return res.json();
  }

  // Appends text to a file (creating it with header first), retrying if the PC changed it meanwhile.
  async appendFile(path, addition, message, header = '') {
    for (let attempt = 0; attempt < 3; attempt++) {
      let sha;
      let current = header;
      try {
        const res = await this.api(`/repos/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`);
        const file = await res.json();
        sha = file.sha;
        current = base64ToText(file.content);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      try {
        await this.api(`/repos/${this.repo}/contents/${encodePath(path)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, content: textToBase64(current + addition), branch: this.branch, ...(sha ? { sha } : {}) }),
        });
        return;
      } catch (err) {
        if (err.status !== 409 && err.status !== 422) throw err;
      }
    }
    throw new Error('GitHub: could not save after 3 tries (the file kept changing).');
  }
}

// Common words that say nothing about which file is relevant.
const STOP = new Set(`the and for are but not you your yours with have has had was were what when where who whom why how
can could should would will shall this that these those from about into onto just like then than them they there their
been being does did doing done all any some more most very also only other our ours out over its it's i'm i've me my mine
his her hers him she he we us today now tell know think please want need make get got give one two let lets yes no okay
which while because so such each every much many few here thing things something anything really actually maybe
still even ever never always again same able sure way time day days`.split(/\s+/));

// Lines containing the words, with one line of context around each, up to `limit` characters.
function snippets(text, terms, limit) {
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    if (terms.some((t) => low.includes(t))) for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < lines.length) keep.add(j);
  });
  let out = '';
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const piece = `${i !== prev + 1 ? '…\n' : ''}${lines[i]}\n`;
    if (out.length + piece.length > limit) break;
    out += piece;
    prev = i;
  }
  return out.trim();
}

export function normalize(path) {
  return String(path || '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

function encodePath(path) {
  return normalize(path).split('/').map(encodeURIComponent).join('/');
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToText(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
