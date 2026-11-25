// App-Shell: Router mit Seitenübergängen, Kopfzeile, Startseite, globale Einstellungen
import { h, icon, sheet, segmented, toggle, field, toast, burst } from './core/ui.js';
import { input } from './core/input.js';
import { audio } from './core/audio.js';
import { prefs, progress, account, library } from './core/store.js';
import { setNaming } from './core/music.js';
import { initWake, ensure as ensureWake, release as releaseWake, wake } from './core/wake.js';
import { onStats, activity, level, streakDays, todayStats, game, weakest } from './core/stats.js';

export const VERSION = '0.5.1';

const MODES = {
  notes:   { title: 'Noten lesen',   icon: 'note',   hue: 245, desc: 'Zufällige Noten im Violin- und Bassschlüssel erkennen und spielen.', load: () => import('./modes/notes.js') },
  chords:  { title: 'Akkorde',       icon: 'chord',  hue: 280, desc: 'Vom Dreiklang bis zum Jazz-Voicing – lesen, greifen, verstehen.', load: () => import('./modes/chords.js') },
  circle:  { title: 'Quintenzirkel', icon: 'circle', hue: 200, desc: 'Tonarten, Vorzeichen und Verwandtschaften interaktiv entdecken.', load: () => import('./modes/circle.js') },
  scales:  { title: 'Tonleitern',    icon: 'scale',  hue: 160, desc: 'Dur, Moll, Kirchentonarten und Pentatonik – Ton für Ton geführt.', load: () => import('./modes/scales.js') },
  improv:  { title: 'Improvisation', icon: 'wave',   hue: 25,  desc: 'Frei spielen über eine Begleitband – mit Live-Feedback zu jedem Ton.', load: () => import('./modes/improv.js') },
  jazz:    { title: 'Jazz',          icon: 'sax',    hue: 330, desc: 'Shell- und Rootless-Voicings, ii–V–I und Chord-Scales.', load: () => import('./modes/jazz.js') },
  library: { title: 'Bibliothek',    icon: 'book',   hue: 48,  desc: 'Eigene Noten hochladen, anhören und im Warte-Modus mitspielen.', load: () => import('./modes/library.js') },
  stats:   { title: 'Fortschritt',   icon: 'chart',  hue: 130, desc: 'Statistik, Schwachstellen und Abzeichen.', hidden: true, load: () => import('./modes/stats.js') }
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
    title, extra, goalPill(), statusPills(), fullscreenBtn(), accountBtn(), gear);
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
    (() => {
      const state = h('span.wake-state');
      const upd = () => { state.textContent = wake.mode === 'api' ? '● aktiv' : wake.mode === 'video' ? '● aktiv (Ersatzmodus)' : prefs.keepAwake === false ? '' : '○ wartet auf Tippen'; state.className = 'wake-state ' + (wake.active ? 'on' : ''); };
      upd(); const off = wake.on(upd); setTimeout(() => new MutationObserver((_, o) => { if (!state.isConnected) { off(); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true }), 0);
      return h('div', toggle('Bildschirm anlassen, solange Tonika offen ist', prefs.keepAwake !== false, v => { prefs.keepAwake = v; v ? ensureWake() : releaseWake(); }), state);
    })(),
    field('Erscheinungsbild', segmented([['auto', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], prefs.theme, v => { prefs.theme = v; applyTheme(); })),
    h('div.field-hint', 'Tonika ' + VERSION)
  ];
}

// ---------- Fortschritt & Gamification ----------
function ring(p, size = 30, stroke = 3.5) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="ring"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(1, p))}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  const el = h('span.ring-wrap'); el.innerHTML = svg; return el;
}
function goalPill() {
  const b = h('button.pill.goal-pill', { 'aria-label': 'Tagesziel und Serie', onclick: () => go('#/stats') });
  const upd = () => {
    const t = todayStats(), st = streakDays();
    b.innerHTML = '';
    b.classList.toggle('done', t.xp >= t.goal);
    b.append(ring(t.xp / t.goal, 22, 3), h('span.pill-text', `${Math.min(t.xp, 9999)}/${t.goal}`), st ? h('span.flame', '🔥', h('b', st)) : '');
    b.title = `Heute ${t.xp} von ${t.goal} XP · ${st} Tage in Folge`;
  };
  upd();
  const off = onStats(upd);
  new MutationObserver((_, obs) => { if (!b.isConnected) { off(); obs.disconnect(); } }).observe(app, { childList: true });
  return b;
}
function progressHero() {
  const lv = level(), t = todayStats(), st = streakDays();
  const mins = Math.round(t.ms / 60000);
  return h('div.progress-hero', { onclick: () => go('#/stats') },
    h('div.ph-level', ring(lv.progress, 64, 6), h('div.ph-num', lv.level)),
    h('div.ph-main',
      h('div.ph-title', lv.name, h('span.muted', ` · Level ${lv.level}`)),
      h('div.xpbar', h('div', { style: { width: Math.round(lv.progress * 100) + '%' } })),
      h('div.ph-sub', `${lv.xp - lv.from} / ${lv.to - lv.from} XP bis Level ${lv.level + 1}`)),
    h('div.ph-chips',
      h('div.ph-chip' + (t.xp >= t.goal ? '.done' : ''), ring(t.xp / t.goal, 34, 4), h('div', h('b', `${t.xp}/${t.goal}`), h('small', 'XP heute'))),
      h('div.ph-chip', h('span.big', '🔥'), h('div', h('b', st), h('small', st === 1 ? 'Tag in Folge' : 'Tage in Folge'))),
      h('div.ph-chip', h('span.big', '⏱️'), h('div', h('b', mins + ' min'), h('small', 'heute geübt')))));
}
function weakCard() {
  const wn = weakest('notes', 6).filter(w => w.m < 0.6), wc = weakest('chords', 6).filter(w => w.m < 0.6);
  if (!wn.length && !wc.length) return '';
  const btn = (mode, list, label) => list.length ? h('button.btn', { onclick: () => go(`#/${mode}?only=${encodeURIComponent(list.map(w => w.key).join(','))}`) }, icon('sparkle'), label, h('span.muted', ` (${list.length})`)) : '';
  return h('section.weak-card',
    h('div', h('b', 'Wiederholen, was noch nicht sitzt'), h('div.muted', [...wn, ...wc].slice(0, 6).map(w => w.label || w.key).join(' · '))),
    h('div.row', btn('notes', wn, 'Noten'), btn('chords', wc, 'Akkorde')));
}
// Feiern: XP-Pop-up, Level-Aufstieg, Tagesziel, Abzeichen
let xpPop = null, xpSum = 0, xpTimer = 0;
onStats(ev => {
  if (ev.xp > 0) {
    xpSum += ev.xp;
    if (!xpPop) { xpPop = h('div.xp-pop'); document.body.append(xpPop); }
    xpPop.textContent = '+' + xpSum + ' XP';
    xpPop.classList.remove('show'); void xpPop.offsetWidth; xpPop.classList.add('show');
    clearTimeout(xpTimer); xpTimer = setTimeout(() => { xpSum = 0; }, 1400);
  }
  if (ev.levelUp) celebrate('⭐', `Level ${ev.level.level}!`, ev.level.name);
  if (ev.goalReached) celebrate('🎯', 'Tagesziel erreicht!', `${game.goal} XP heute – stark!`);
  for (const b of ev.badges || []) celebrate(b.icon, 'Neues Abzeichen', b.name + ' – ' + b.desc);
});
// Feiern nacheinander zeigen, nicht übereinander
const celQueue = [];
let celBusy = false;
function celebrate(...args) { celQueue.push(args); if (!celBusy) nextCelebration(); }
function nextCelebration() {
  const a = celQueue.shift();
  if (!a) { celBusy = false; return; }
  celBusy = true; showCelebration(...a);
  setTimeout(nextCelebration, 2700);
}
function showCelebration(emoji, title, sub) {
  const el = h('div.celebrate', h('div.cel-emoji', emoji), h('div.cel-title', title), h('div.cel-sub', sub));
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  for (let i = 0; i < 3; i++) setTimeout(() => burst({ x: innerWidth * (0.3 + 0.2 * i), y: innerHeight * 0.32 }, { count: 26, spread: 180, color: ['var(--accent)', 'var(--warn)', 'var(--ok)'][i] }), i * 160);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); }, 2400);
}
// aktive Übungszeit: jede Eingabe in einem Modus zählt
input.on('noteon', () => { const m = parseHash().mode; if (m && MODES[m] && !MODES[m].hidden) activity(m); });

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
    h('header.topbar', h('div.title'), goalPill(), statusPills(), fullscreenBtn(), accountBtn(), gear),
    h('section.hero',
      h('div.eyebrow', greet + (account.user ? ', ' + account.user.username : '') + ' 👋'),
      h('h1', 'Was üben wir ', h('em', 'heute'), '?'),
      progressHero()),
    weakCard(),
    h('section.cards', Object.entries(MODES).filter(([, m]) => !m.hidden).map(([key, m], i) => {
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

// ---------- Bildschirm wach halten & Audio freischalten ----------
// Audio: Android/iOS erlauben das nur bei Touch-Ende/Klick/Taste (nicht bei pointerdown)
const unlockAudio = () => { if (!audio.running) audio.unlock(); };
for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
initWake();

// ---------- Start ----------
applyTheme();
setNaming(prefs.naming);
window.addEventListener('hashchange', route);
route();
input.initMIDI();
