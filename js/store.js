// Settings live in localStorage; the file cache and chats live in IndexedDB. Nothing leaves this phone.

const SETTINGS_KEY = 'nexus.settings';

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

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};
