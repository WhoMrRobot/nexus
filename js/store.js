// Settings live in localStorage; the file cache and chats live in IndexedDB. Nothing leaves this phone.

const SETTINGS = 'nexus.settings';

export const DEFAULTS = {
  v: 2,
  geminiKey: '',
  githubToken: '',
  repo: '',
  branch: 'main',
  model: 'gemini-3.5-flash-lite',          // everyday answers (about 500 free a day)
  fallbackModel: 'gemini-3.1-flash-lite',  // its own separate daily allowance
  deepModel: 'gemini-3.8-flash',           // the Deep button (about 20 free a day)
  openrouterKey: '',
  openrouterModels: 'thinkingmachines/inkling:free, nvidia/nemotron-3-ultra-550b-a55b:free',
  thinking: 'medium',
  preload: 'AGENTS.md, current-status.md, about-*.md',
};

export function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS) || '{}');
  } catch {
    saved = {};
  }
  // Version 2 (25 Oct): Flash-Lite became the everyday model and 3.8 Flash moved to the Deep button.
  if ((saved.v || 1) < 2) {
    if (!saved.model || saved.model === 'gemini-3.8-flash') saved.model = DEFAULTS.model;
    if (!saved.fallbackModel || saved.fallbackModel === 'gemini-3.5-flash-lite') saved.fallbackModel = DEFAULTS.fallbackModel;
    saved.v = 2;
  }
  return { ...DEFAULTS, ...saved };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS, JSON.stringify(settings));
}

// The PIN version (25 Oct) stored everything encrypted; without the PIN that data is unreadable, so start clean.
export async function dropPinData() {
  if (!localStorage.getItem('nexus.vault')) return;
  for (const k of ['nexus.vault', 'nexus.settings.enc', 'nexus.chat', 'nexus.pinFails', 'nexus.pinWait']) localStorage.removeItem(k);
  await idb.clear('chats').catch(() => {});
  await idb.clear('blobs').catch(() => {});
}

let opening;
function db() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('nexus', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('blobs');                 // git blob sha -> file text
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
  get: (sha) => idb.get('blobs', sha),
  put: (sha, text) => idb.put('blobs', text, sha),
  keys: () => idb.keys('blobs'),
  del: (sha) => idb.del('blobs', sha),
  clear: () => idb.clear('blobs'),
};

export const chats = {
  get: async (id) => (await idb.get('chats', id)) || null,
  put: (chat) => idb.put('chats', chat),
  list: async () => (await idb.all('chats')).map(({ id, title, updated }) => ({ id, title, updated })),
  del: (id) => idb.del('chats', id),
  clear: () => idb.clear('chats'),
};
