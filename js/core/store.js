// Speicher: Einstellungen & Fortschritt (localStorage), Bibliothek (IndexedDB).
// Mit Konto (Tonika-Server auf dem Raspberry Pi) wird beides zusätzlich mit dem Server abgeglichen:
// Einstellungen/Fortschritt pro Schlüssel („neuester gewinnt“), die Bibliothek liegt dann ganz auf dem Server.

const PREFIX = 'nt2.';
const TS_KEY = PREFIX + '__ts';

export function load(key, def) {
  try { const v = localStorage.getItem(PREFIX + key); return v == null ? structuredClone(def) : Object.assign(Array.isArray(def) ? [] : {}, structuredClone(def), JSON.parse(v)); }
  catch { return structuredClone(def); }
}
function stamps() { try { return JSON.parse(localStorage.getItem(TS_KEY) || '{}'); } catch { return {}; } }
function stamp(key, t = Date.now()) { const s = stamps(); s[key] = t; try { localStorage.setItem(TS_KEY, JSON.stringify(s)); } catch {} }
export function save(key, value, { sync = true } = {}) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  stamp(key);
  if (sync) account.queueSync(key);
}

// Alle reaktiven Objekte, damit der Server-Abgleich sie an Ort und Stelle aktualisieren kann
const registry = new Map();

/** Kleines reaktives Settings-Objekt mit Autosave (und Konto-Sync) */
export function persisted(key, def) {
  if (registry.has(key)) return registry.get(key).proxy;
  const obj = load(key, def);
  const proxy = new Proxy(obj, {
    set(t, k, v) { t[k] = v; save(key, t); return true; },
    deleteProperty(t, k) { delete t[k]; save(key, t); return true; }
  });
  registry.set(key, { obj, proxy, def });
  return proxy;
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
  if (streak != null) p.best = Math.max(p.best || 0, streak);
  progress[mode] = p;
}

// ---------- Konto (Server-API) ----------
async function api(path, opts = {}) {
  const r = await fetch('api/' + path, { credentials: 'same-origin', ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = 'Fehler ' + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.arrayBuffer();
}

const listeners = new Set();
export const account = {
  server: false,       // läuft ein Tonika-Server unter dieser Adresse?
  config: null,
  user: null,          // { username } wenn angemeldet
  syncing: false,
  _pending: new Set(), _timer: 0,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { listeners.forEach(fn => { try { fn(this); } catch (e) { console.error(e); } }); },

  async init() {
    try {
      const r = await fetch('api/config', { credentials: 'same-origin' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw 0;
      this.config = await r.json(); this.server = true;
    } catch { this.server = false; this.emit(); return; }
    try { this.user = await api('me'); await this.pull(); } catch { this.user = null; }
    this.emit();
  },
  async login(username, password) { this.user = await api('login', { method: 'POST', body: JSON.stringify({ username, password }) }); await this.pull(); this.emit(); },
  async register(username, password, code) { this.user = await api('register', { method: 'POST', body: JSON.stringify({ username, password, code }) }); await this.pull(); this.emit(); },
  async logout() { await this.flush(); try { await api('logout', { method: 'POST' }); } catch {} this.user = null; this.emit(); },
  changePassword: (old, nw) => api('password', { method: 'POST', body: JSON.stringify({ old, new: nw }) }),

  /** Server-Stand holen und mit dem lokalen zusammenführen (neuester gewinnt) */
  async pull() {
    if (!this.user) return;
    this.syncing = true; this.emit();
    try {
      const remote = await api('state');
      const local = stamps();
      const keys = new Set([...Object.keys(remote), ...registry.keys(), ...Object.keys(local)]);
      for (const key of keys) {
        const r = remote[key], lt = local[key] || 0;
        if (r && r.updated > lt) {
          const reg = registry.get(key);
          if (reg) { for (const k of Object.keys(reg.obj)) delete reg.obj[k]; Object.assign(reg.obj, structuredClone(reg.def), r.value); }
          try { localStorage.setItem(PREFIX + key, JSON.stringify(r.value)); } catch {}
          stamp(key, r.updated);
        } else if (lt && (!r || lt > r.updated)) this._pending.add(key);
      }
      await this.flush();
    } finally { this.syncing = false; this.emit(); }
  },
  queueSync(key) {
    if (!this.user) return;
    this._pending.add(key);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 1500);
  },
  async flush() {
    clearTimeout(this._timer);
    if (!this.user) return;
    const keys = [...this._pending]; this._pending.clear();
    for (const key of keys) {
      const reg = registry.get(key);
      const value = reg ? reg.obj : (() => { try { return JSON.parse(localStorage.getItem(PREFIX + key)); } catch { return null; } })();
      if (value == null) continue;
      try { await api('state/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify(value) }); }
      catch (e) { if (e.status !== 401) this._pending.add(key); }
    }
  }
};
addEventListener('pagehide', () => { if (account.user && account._pending.size) account.flush(); });

// ---------- IndexedDB (lokale Bibliothek ohne Konto) ----------
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
export const localLibrary = {
  all: () => tx('readonly', s => s.getAll()).then(list => (list || []).sort((a, b) => b.added - a.added)),
  get: id => tx('readonly', s => s.get(id)),
  put: song => tx('readwrite', s => s.put(song)),
  remove: id => tx('readwrite', s => s.delete(id))
};

// ---------- Server-Bibliothek ----------
const MIME = { midi: 'audio/midi', mxl: 'application/vnd.recordare.musicxml', musicxml: 'application/xml', pdf: 'application/pdf', image: 'image/*' };
const serverLibrary = {
  all: () => api('songs'),
  meta: id => api('songs/' + encodeURIComponent(id)),
  async get(id) {
    const meta = await api('songs/' + encodeURIComponent(id));
    meta.data = await api('songs/' + encodeURIComponent(id) + '/file');
    return meta;
  },
  original: id => api('songs/' + encodeURIComponent(id) + '/file?orig=1'),
  async put(song) {
    const fd = new FormData();
    const { data, ...meta } = song;
    fd.append('meta', JSON.stringify(meta));
    fd.append('file', new Blob([data], { type: MIME[song.type] || 'application/octet-stream' }), song.fileName || 'datei');
    return api('songs', { method: 'POST', body: fd });
  },
  rename: (id, title) => api('songs/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: id => api('songs/' + encodeURIComponent(id), { method: 'DELETE' }),
  retryOmr: id => api('songs/' + encodeURIComponent(id) + '/omr', { method: 'POST' })
};

/** Bibliothek: mit Konto auf dem Server, sonst lokal im Browser */
export const library = {
  get remote() { return !!account.user; },
  all: () => (account.user ? serverLibrary : localLibrary).all(),
  get: id => (account.user ? serverLibrary : localLibrary).get(id),
  put: song => (account.user ? serverLibrary : localLibrary).put(song),
  remove: id => (account.user ? serverLibrary : localLibrary).remove(id),
  meta: id => account.user ? serverLibrary.meta(id) : localLibrary.get(id),
  original: id => serverLibrary.original(id),
  retryOmr: id => serverLibrary.retryOmr(id),
  /** Lokale Stücke ins Konto übernehmen */
  async migrateLocal(onEach) {
    const local = await localLibrary.all();
    let n = 0;
    for (const s of local) { await serverLibrary.put(s); await localLibrary.remove(s.id); n++; onEach && onEach(n, local.length); }
    return n;
  },
  localCount: () => localLibrary.all().then(l => l.length)
};
