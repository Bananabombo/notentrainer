// Speicher: Einstellungen & Fortschritt (localStorage), Bibliothek (IndexedDB).
// Später durch eine Server-API (Raspberry Pi, mit Login) ersetzbar – die Module nutzen nur diese Funktionen.

const PREFIX = 'nt2.';

export function load(key, def) {
  try { const v = localStorage.getItem(PREFIX + key); return v == null ? structuredClone(def) : Object.assign(Array.isArray(def) ? [] : {}, structuredClone(def), JSON.parse(v)); }
  catch { return structuredClone(def); }
}
export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
}

/** Kleines reaktives Settings-Objekt mit Autosave */
export function persisted(key, def) {
  const obj = load(key, def);
  return new Proxy(obj, {
    set(t, k, v) { t[k] = v; save(key, t); return true; }
  });
}

export const prefs = persisted('prefs', {
  naming: 'de',        // 'de' (H/B) | 'en'
  output: 'auto',      // 'auto' | 'browser' | 'midi'
  theme: 'auto',       // 'auto' | 'light' | 'dark'
  micSens: 6,
  volume: 0.8
});

/** Fortschritt pro Modus */
export const progress = persisted('progress', {});
export function bumpProgress(mode, { correct = 0, total = 0, streak } = {}) {
  const p = progress[mode] || { correct: 0, total: 0, best: 0, last: 0 };
  p.correct += correct; p.total += total; p.last = Date.now();
  if (streak != null && streak > p.best) p.best = streak;
  progress[mode] = p;
}

// ---------- IndexedDB (Bibliothek) ----------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('notentrainer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('songs', mode);
    const r = fn(t.objectStore('songs'));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  }));
}
export const library = {
  all: () => tx('readonly', s => s.getAll()).then(list => (list || []).sort((a, b) => b.added - a.added)),
  get: id => tx('readonly', s => s.get(id)),
  put: song => tx('readwrite', s => s.put(song)),
  remove: id => tx('readwrite', s => s.delete(id))
};
