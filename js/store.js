// Everything this app stores on the phone is encrypted with a key made from the user's PIN:
// the settings (API keys), the chats and the cached note files. The key exists only in memory
// while the app is unlocked; the PIN itself is never stored.

const VAULT = 'nexus.vault';
const SETTINGS = 'nexus.settings.enc';
const ITERATIONS = 310_000;

export const DEFAULTS = {
  geminiKey: '',
  githubToken: '',
  repo: '',
  branch: 'main',
  model: 'gemini-3.8-flash',
  fallbackModel: 'gemini-3.5-flash-lite',
  thinking: 'medium',
  preload: 'AGENTS.md, current-status.md, about-*.md',
};

let key = null;

// ---------- encoding ----------

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(value, k = key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data: new Uint8Array(data) };
}

async function unseal(box, k = key) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, k, box.data);
  return JSON.parse(new TextDecoder().decode(data));
}

async function sealText(value, k = key) {
  const box = await seal(value, k);
  return JSON.stringify({ iv: b64(box.iv), data: b64(box.data) });
}

async function unsealText(text, k = key) {
  const box = JSON.parse(text);
  return unseal({ iv: unb64(box.iv), data: unb64(box.data) }, k);
}

// ---------- the vault (PIN) ----------

export const vault = {
  exists: () => Boolean(localStorage.getItem(VAULT)),
  unlocked: () => Boolean(key),

  // A new vault starts clean; settings saved unencrypted by the first version are carried over.
  async create(pin) {
    let start = { ...DEFAULTS };
    try { start = { ...start, ...JSON.parse(localStorage.getItem('nexus.settings') || '{}') }; } catch {}
    localStorage.removeItem('nexus.settings');
    await idb.clear('chats').catch(() => {});
    await idb.clear('blobs').catch(() => {});
    const salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(pin, salt, ITERATIONS);
    localStorage.setItem(VAULT, JSON.stringify({ v: 1, salt: b64(salt), iterations: ITERATIONS, check: await sealText('nexus') }));
    await saveSettings(start);
  },

  // Returns true if the PIN was right.
  async unlock(pin) {
    const v = JSON.parse(localStorage.getItem(VAULT));
    const k = await deriveKey(pin, unb64(v.salt), v.iterations);
    try {
      if ((await unsealText(v.check, k)) !== 'nexus') return false;
    } catch {
      return false;
    }
    key = k;
    return true;
  },

  lock() {
    key = null;
  },

  // Re-encrypts settings and chats under the new PIN; cached note files are simply downloaded again.
  async changePin(newPin) {
    const settings = await loadSettings();
    const all = await chats.all();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const k = await deriveKey(newPin, salt, ITERATIONS);
    const sealed = await Promise.all(all.map((c) => sealChat(c, k)));
    await idb.clear('chats');
    for (const row of sealed) await idb.put('chats', row);
    await idb.clear('blobs');
    localStorage.setItem(VAULT, JSON.stringify({ v: 1, salt: b64(salt), iterations: ITERATIONS, check: await sealText('nexus', k) }));
    key = k;
    await saveSettings(settings);
  },

  // Forgotten PIN: wipe everything this app keeps on the phone. The notes repo is not touched.
  async reset() {
    key = null;
    for (const k of [VAULT, SETTINGS, 'nexus.settings', 'nexus.chat', 'nexus.pinFails', 'nexus.pinWait']) localStorage.removeItem(k);
    await idb.clear('chats').catch(() => {});
    await idb.clear('blobs').catch(() => {});
  },
};

// ---------- settings ----------

export async function loadSettings() {
  const text = localStorage.getItem(SETTINGS);
  return { ...DEFAULTS, ...(text ? await unsealText(text) : {}) };
}

export async function saveSettings(settings) {
  localStorage.setItem(SETTINGS, await sealText(settings));
}

// ---------- IndexedDB ----------

let opening;
function db() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('nexus', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('blobs');                 // git blob sha -> encrypted file text
      req.result.createObjectStore('chats', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function run(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const idb = {
  get: (store, k) => run(store, 'readonly', (s) => s.get(k)),
  put: (store, value, k) => run(store, 'readwrite', (s) => (k === undefined ? s.put(value) : s.put(value, k))),
  del: (store, k) => run(store, 'readwrite', (s) => s.delete(k)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};

// Cached note files, by git blob sha.
export const fileCache = {
  async get(sha) {
    const box = await idb.get('blobs', sha);
    return box ? unseal(box) : undefined;
  },
  async put(sha, text) {
    await idb.put('blobs', await seal(text), sha);
  },
  keys: () => idb.keys('blobs'),
  del: (sha) => idb.del('blobs', sha),
  clear: () => idb.clear('blobs'),
};

// Chats: the title and the conversation are sealed separately, so the list opens without decrypting every chat.
async function sealChat({ id, created, updated, title, history }, k = key) {
  return { id, updated, title: await seal(title, k), body: await seal({ created, history }, k) };
}

export const chats = {
  async get(id) {
    const row = await idb.get('chats', id);
    if (!row) return null;
    return { id: row.id, updated: row.updated, title: await unseal(row.title), ...(await unseal(row.body)) };
  },
  async put(chat) {
    await idb.put('chats', await sealChat(chat));
  },
  async list() {
    const rows = await idb.all('chats');
    return Promise.all(rows.map(async (r) => ({ id: r.id, updated: r.updated, title: await unseal(r.title) })));
  },
  async all() {
    const rows = await idb.all('chats');
    return Promise.all(rows.map((r) => chats.get(r.id)));
  },
  del: (id) => idb.del('chats', id),
  clear: () => idb.clear('chats'),
};
