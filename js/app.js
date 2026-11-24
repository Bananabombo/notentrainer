// App-Shell: Router mit Seitenübergängen, Kopfzeile, Startseite, globale Einstellungen
import { h, icon, sheet, segmented, toggle, field, toast } from './core/ui.js';
import { input } from './core/input.js';
import { audio } from './core/audio.js';
import { prefs, progress, account, library } from './core/store.js';
import { setNaming } from './core/music.js';

export const VERSION = '0.3.2';

const MODES = {
  notes:   { title: 'Noten lesen',   icon: 'note',   hue: 245, desc: 'Zufällige Noten im Violin- und Bassschlüssel erkennen und spielen.', load: () => import('./modes/notes.js') },
  chords:  { title: 'Akkorde',       icon: 'chord',  hue: 280, desc: 'Vom Dreiklang bis zum Jazz-Voicing – lesen, greifen, verstehen.', load: () => import('./modes/chords.js') },
  circle:  { title: 'Quintenzirkel', icon: 'circle', hue: 200, desc: 'Tonarten, Vorzeichen und Verwandtschaften interaktiv entdecken.', load: () => import('./modes/circle.js') },
  scales:  { title: 'Tonleitern',    icon: 'scale',  hue: 160, desc: 'Dur, Moll, Kirchentonarten und Pentatonik – Ton für Ton geführt.', load: () => import('./modes/scales.js') },
  improv:  { title: 'Improvisation', icon: 'wave',   hue: 25,  desc: 'Frei spielen über eine Begleitband – mit Live-Feedback zu jedem Ton.', load: () => import('./modes/improv.js') },
  jazz:    { title: 'Jazz',          icon: 'sax',    hue: 330, desc: 'Shell- und Rootless-Voicings, ii–V–I und Chord-Scales.', load: () => import('./modes/jazz.js') },
  library: { title: 'Bibliothek',    icon: 'book',   hue: 48,  desc: 'Eigene Noten hochladen, anhören und im Warte-Modus mitspielen.', load: () => import('./modes/library.js') }
};

const app = document.getElementById('app');
let cleanup = null;
let pendingSharedEl = null;

// ---------- Theme ----------
function applyTheme() {
  if (prefs.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', prefs.theme);
}

// ---------- Router ----------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { mode: parts[0] || '', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export function go(hash, fromEl) {
  pendingSharedEl = fromEl || null;
  if (location.hash === hash) route(); else location.hash = hash;
}
const accountReady = account.init();
async function route() {
  await Promise.race([accountReady, new Promise(r => setTimeout(r, 1500))]);
  const r = parseHash();
  const def = MODES[r.mode];
  const mod = def ? (await def.load()).default : null;
  const swap = () => {
    if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
    app.innerHTML = '';
    if (!def) renderHome();
    else {
      const ctx = shell(r.mode, def, r);
      cleanup = mod.mount(ctx.body, ctx) || null;
    }
    window.scrollTo(0, 0);
  };
  const shared = pendingSharedEl;
  pendingSharedEl = null;
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (shared) shared.style.viewTransitionName = 'mode-title';
    const t = document.startViewTransition(swap);
    t.ready.catch(() => {});
    t.finished.catch(() => {}).finally(() => document.querySelectorAll('[style*="view-transition-name"]').forEach(e => { e.style.viewTransitionName = ''; }));
  } else swap();
}

// ---------- Kopfzeile für Modi ----------
function shell(key, def, route) {
  const title = h('h1.title', def.title);
  if (document.startViewTransition) title.style.viewTransitionName = 'mode-title';
  const gear = h('button.icon-btn', { 'aria-label': 'Einstellungen', hidden: true }, icon('settings'));
  const extra = h('div.row');
  const bar = h('header.topbar',
    h('button.icon-btn', { 'aria-label': 'Zurück', onclick: () => go(route.query.from ? '#/' + route.query.from : route.params.length ? '#/' + key : '#/') }, icon('back')),
    title, extra, statusPills(), fullscreenBtn(), accountBtn(), gear);
  const body = h('main.screen');
  app.append(bar, body);
  return {
    body, route, title,
    setTitle(text, sub) { title.innerHTML = ''; title.append(text, sub ? h('small', sub) : ''); },
    setSettings(build) { gear.hidden = !build; gear.onclick = () => sheet('Einstellungen', build()); },
    extra
  };
}

function statusPills() {
  const midi = h('button.pill', { 'aria-label': 'MIDI-Status' }, h('span.dot'), h('span.pill-text'));
  const mic = h('button.pill', { 'aria-label': 'Mikrofon' }, icon('mic'), h('span.pill-text', 'Mikro'));
  const update = s => {
    const txt = midi.querySelector('.pill-text');
    midi.className = 'pill ' + (s.midi === 'connected' ? 'on' : (s.midi === 'denied' || s.midi === 'insecure' || s.midi === 'unsupported') ? 'err' : '');
    txt.textContent = s.midi === 'connected' ? s.names[0].replace(/\s*MIDI.*$/i, '') || 'MIDI' : ({ none: 'Kein MIDI', denied: 'MIDI blockiert', insecure: 'MIDI: HTTPS nötig', unsupported: 'Kein Web MIDI', init: 'MIDI …' })[s.midi] || 'MIDI';
    mic.className = 'pill ' + (s.mic ? 'on' : s.micError ? 'err' : '');
    mic.title = s.micError ? 'Mikrofon blockiert' : '';
  };
  update(input.status);
  const off = input.on('status', update);
  midi.onclick = () => deviceSheet();
  mic.onclick = () => { audio.unlock(); input.status.mic ? input.stopMic() : input.startMic(); };
  const wrap = h('div.row', midi, mic);
  // Abmelden, wenn die Kopfzeile verschwindet
  new MutationObserver((_, obs) => { if (!wrap.isConnected) { off(); obs.disconnect(); } }).observe(app, { childList: true });
  return wrap;
}

function fullscreenBtn() {
  const can = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  if (!can || matchMedia('(display-mode: fullscreen)').matches) return '';
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const b = h('button.icon-btn.fs-btn', { 'aria-label': 'Vollbild' }, icon(isFs() ? 'shrink' : 'expand'));
  b.onclick = async () => {
    const root = document.documentElement;
    try {
      if (isFs()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else root.webkitRequestFullscreen();
    } catch { toast('Vollbild ist hier nicht erlaubt'); }
  };
  const upd = () => { b.innerHTML = ''; b.append(icon(isFs() ? 'shrink' : 'expand')); };
  document.addEventListener('fullscreenchange', upd);
  return b;
}

function deviceSheet() {
  const s = input.status;
  const lines = {
    connected: 'Verbunden mit: ' + s.names.join(', '),
    none: 'Kein MIDI-Gerät gefunden. Verbinde dein Digitalpiano per USB oder koppel es per Bluetooth.',
    denied: 'Der MIDI-Zugriff wurde verweigert. Erlaube ihn in den Website-Einstellungen von Chrome.',
    insecure: 'MIDI funktioniert nur über HTTPS oder localhost.',
    unsupported: 'Dieser Browser kann kein Web MIDI (z. B. Safari). Nutze Chrome, Edge oder Firefox – oder das Mikrofon.',
    init: 'MIDI wird gestartet …'
  };
  sheet('Eingabe & Klang', [
    h('div.info-box', lines[s.midi] || ''),
    h('div', { style: { height: '16px' } }),
    globalSettings()
  ]);
}

function globalSettings() {
  return [
    field('Tonnamen', segmented([['de', 'Deutsch (H, B)'], ['en', 'International (B, B♭)']], prefs.naming, v => { prefs.naming = v; setNaming(v); toast('Wird beim nächsten Wechsel übernommen'); })),
    field('Klang der App', segmented([['auto', 'Automatisch'], ['midi', 'Digitalpiano'], ['browser', 'Browser']], prefs.output, v => { prefs.output = v; }),
      'Automatisch: Vorgespieltes kommt aus deinem Digitalpiano, wenn es per MIDI verbunden ist – sonst aus dem Browser. Begleitbands spielen immer im Browser.'),
    h('button.btn', { onclick: () => {
      audio.playNotes([60, 64, 67, 72], { dur: 0.5, arpeggio: 0.18 });
      const t = input.soundTarget;
      toast(t ? `Klang geht an „${t}“ – stell dort die Lautstärke ein` : (audio.running ? 'Klang kommt aus dem Browser' : 'Audio blockiert – tippe nochmal'));
    } }, icon('play'), 'Klang testen'),
    field('Lautstärke (Browser)', (() => { const r = h('input', { type: 'range', min: 0, max: 1, step: 0.05 }); r.value = prefs.volume; r.oninput = () => audio.setVolume(+r.value); return r; })()),
    field('Mikrofon-Empfindlichkeit', (() => { const r = h('input', { type: 'range', min: 1, max: 10, step: 1 }); r.value = prefs.micSens; r.oninput = () => { prefs.micSens = +r.value; }; return r; })()),
    field('Erscheinungsbild', segmented([['auto', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], prefs.theme, v => { prefs.theme = v; applyTheme(); })),
    h('div.field-hint', 'Tonika ' + VERSION)
  ];
}

// ---------- Konto ----------
function accountBtn() {
  const b = h('button.icon-btn.account-btn', { 'aria-label': 'Konto', onclick: () => accountSheet() });
  const upd = () => {
    b.hidden = !account.server;
    b.innerHTML = '';
    if (account.user) { b.classList.add('in'); b.append(h('span.avatar', account.user.username.slice(0, 1).toUpperCase())); b.title = 'Angemeldet als ' + account.user.username; }
    else { b.classList.remove('in'); b.append(icon('user')); b.title = 'Anmelden'; }
  };
  upd();
  const off = account.on(upd);
  new MutationObserver((_, obs) => { if (!b.isConnected) { off(); obs.disconnect(); } }).observe(app, { childList: true });
  return b;
}

function accountSheet() {
  if (account.user) {
    let s;
    const oldPw = h('input.input', { type: 'password', placeholder: 'Bisheriges Passwort', autocomplete: 'current-password' });
    const newPw = h('input.input', { type: 'password', placeholder: 'Neues Passwort (mind. 8 Zeichen)', autocomplete: 'new-password' });
    const pwMsg = h('div.form-msg');
    s = sheet('Konto', [
      h('div.account-card', h('span.avatar.big', account.user.username.slice(0, 1).toUpperCase()),
        h('div', h('b', account.user.username), h('div.muted', 'Fortschritt, Einstellungen und Bibliothek werden mit deinem Tonika-Konto synchronisiert.'))),
      h('div.row', { style: { margin: '14px 0 22px' } },
        h('button.btn', { onclick: async () => { await account.pull(); toast('Synchronisiert'); } }, icon('refresh'), 'Jetzt synchronisieren'),
        h('button.btn.ghost', { onclick: async () => { await account.logout(); s.close(); toast('Abgemeldet'); route(); } }, 'Abmelden')),
      h('details.pw-box', h('summary', 'Passwort ändern'),
        h('form.auth-form', { onsubmit: async e => {
          e.preventDefault(); pwMsg.textContent = '';
          try { await account.changePassword(oldPw.value, newPw.value); oldPw.value = newPw.value = ''; pwMsg.className = 'form-msg ok'; pwMsg.textContent = 'Passwort geändert.'; }
          catch (err) { pwMsg.className = 'form-msg bad'; pwMsg.textContent = err.message; }
        } }, oldPw, newPw, pwMsg, h('button.btn.primary', { type: 'submit' }, 'Ändern')))
    ]);
    return;
  }
  let mode = 'login', s;
  const name = h('input.input', { placeholder: 'Benutzername', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, required: true });
  const pw = h('input.input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password', required: true });
  const code = h('input.input', { placeholder: 'Einladungscode', autocapitalize: 'off', hidden: true });
  const msg = h('div.form-msg');
  const submit = h('button.btn.primary.wide', { type: 'submit' }, 'Anmelden');
  const setMode = m => {
    mode = m;
    code.hidden = !(m === 'register' && account.config && account.config.registration === 'code');
    pw.autocomplete = m === 'register' ? 'new-password' : 'current-password';
    pw.placeholder = m === 'register' ? 'Passwort (mind. 8 Zeichen)' : 'Passwort';
    submit.textContent = m === 'register' ? 'Konto anlegen' : 'Anmelden';
    msg.textContent = '';
  };
  const form = h('form.auth-form', { onsubmit: async e => {
    e.preventDefault(); msg.textContent = ''; submit.disabled = true;
    try {
      if (mode === 'register') await account.register(name.value, pw.value, code.value);
      else await account.login(name.value, pw.value);
      s.close();
      toast('Willkommen, ' + account.user.username + '!');
      const n = await library.localCount();
      route();
      if (n) setTimeout(() => toast(`${n} Stück${n > 1 ? 'e' : ''} aus diesem Browser kannst du in der Bibliothek ins Konto übernehmen`), 1600);
    } catch (err) { msg.className = 'form-msg bad'; msg.textContent = err.message; }
    finally { submit.disabled = false; }
  } }, name, pw, code, msg, submit);
  s = sheet('Anmelden', [
    h('p.muted', { style: { marginTop: 0 } }, 'Mit einem Konto liegen Fortschritt, Einstellungen und deine Noten auf deinem Tonika-Server – auf jedem Gerät gleich. PDFs und Fotos werden dort automatisch in Noten umgewandelt.'),
    segmented([['login', 'Anmelden'], ['register', 'Neues Konto']], 'login', setMode),
    h('div', { style: { height: '14px' } }),
    form
  ]);
  setTimeout(() => name.focus(), 350);
}

// ---------- Startseite ----------
function renderHome() {
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Schönen Tag' : 'Guten Abend';
  const totals = Object.values(progress).reduce((a, p) => ({ c: a.c + (p.correct || 0), t: a.t + (p.total || 0), b: Math.max(a.b, p.best || 0) }), { c: 0, t: 0, b: 0 });
  const gear = h('button.icon-btn', { 'aria-label': 'Einstellungen', onclick: () => sheet('Einstellungen', globalSettings()) }, icon('settings'));
  app.append(
    h('header.topbar', h('div.title'), statusPills(), fullscreenBtn(), accountBtn(), gear),
    h('section.hero',
      h('div.eyebrow', greet + (account.user ? ', ' + account.user.username : '') + ' 👋'),
      h('h1', 'Was üben wir ', h('em', 'heute'), '?'),
      totals.t ? h('div.hero-stats',
        h('div.hero-stat', h('div.v', totals.t.toLocaleString('de-DE')), h('div.l', 'Aufgaben gelöst')),
        h('div.hero-stat', h('div.v', Math.round(100 * totals.c / totals.t) + ' %'), h('div.l', 'beim ersten Versuch')),
        h('div.hero-stat', h('div.v', totals.b), h('div.l', 'längste Serie'))) : ''),
    h('section.cards', Object.entries(MODES).map(([key, m], i) => {
      const p = progress[key];
      const title = h('h3', m.title);
      return h('button.mode-card', { style: { '--hue': m.hue, '--i': i }, onclick: () => go('#/' + key, title) },
        h('div.badge-icon', icon(m.icon)), title, h('p', m.desc),
        h('div.meta', p && p.total ? [h('span', h('b', p.total), ' geübt'), p.best ? h('span', 'Serie ', h('b', p.best)) : ''] : h('span', 'Noch nicht geübt')));
    })),
    h('footer.home-foot', h('span', 'Tonika ' + VERSION), h('span.spacer'),
      h('a', { href: 'https://github.com/Bananabombo/notentrainer', style: { color: 'inherit' } }, 'GitHub'))
  );
}

// ---------- Bildschirm wach halten ----------
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener('visibilitychange', keepAwake);
// Audio freischalten: Android/iOS erlauben das nur bei Touch-Ende/Klick/Taste (nicht bei pointerdown)
const unlockAudio = () => { keepAwake(); if (!audio.running) audio.unlock(); };
for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });

// ---------- Start ----------
applyTheme();
setNaming(prefs.naming);
window.addEventListener('hashchange', route);
route();
input.initMIDI();
