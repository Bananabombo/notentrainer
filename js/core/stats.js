// Lernstatistik & Gamification
// - pro Übungsobjekt (Note, Akkord, Tonleiter …): Versuche, Treffer, Zeit, Beherrschung (0–1), Leitner-Fach
// - pro Tag: Übungszeit, XP, Aufgaben; daraus Serie (Tage in Folge), Tagesziel, Level
// - Abzeichen
// Alles liegt in persisted()-Objekten → wird mit dem Konto synchronisiert.
import { persisted, progress } from './store.js';

export const items = persisted('stats.items', {});        // { mode: { key: Item } }
export const days = persisted('stats.days', {});          // { 'YYYY-MM-DD': Day }
export const game = persisted('stats.game', { xp: 0, badges: {}, goal: 300, goalDays: 0, bestStreak: 0 });

const listeners = new Set();
export function onStats(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = ev => listeners.forEach(fn => { try { fn(ev); } catch (e) { console.error(e); } });

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayObj = () => days[today()] || { xp: 0, ms: 0, ok: 0, total: 0, modes: {} };
function saveDay(d) {
  days[today()] = d;
  // auf ~400 Tage begrenzen
  const keys = Object.keys(days).sort();
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete days[k];
}

// ---------------------------------------------------------------- Beherrschung
const BOX_DUE = [0, 5 * 60e3, 30 * 60e3, 6 * 3600e3, 2 * 86400e3, 7 * 86400e3]; // Leitner-Abstände
/** Beherrschung 0–1 aus Trefferquote (geglättet), Tempo und Anzahl */
export function mastery(it) {
  if (!it || !it.n) return null;
  const conf = it.n / (it.n + 2);                           // wenige Versuche → vorsichtig
  const speed = it.ms ? Math.max(0.35, Math.min(1, 1.35 - it.ms / 5000)) : 0.8;
  return Math.max(0, Math.min(1, (it.acc ?? 0.5) * speed * conf + 0.15 * (1 - conf)));
}
export function masteryLabel(m) {
  if (m == null) return 'neu';
  return m >= 0.85 ? 'sitzt' : m >= 0.65 ? 'gut' : m >= 0.4 ? 'wackelt' : 'übt sich';
}

/**
 * Ergebnis einer Aufgabe festhalten.
 * @param mode   'notes' | 'chords' | 'scales' | 'circle' | 'improv' | 'library'
 * @param key    eindeutiger Schlüssel des Objekts
 * @param r      { ok: richtig beim 1. Versuch, ms: Zeit bis richtig, label, xp?: eigene Punkte, streak? }
 * @returns { xp, levelUp, badges }
 */
export function record(mode, key, r) {
  const now = Date.now();
  if (key != null) {
    const m = items[mode] || {};
    const it = m[key] || { n: 0, ok: 0, err: 0, acc: 0.5, ms: 0, box: 0, last: 0, due: 0 };
    it.n++; r.ok ? it.ok++ : it.err++;
    it.acc = it.acc * 0.7 + (r.ok ? 1 : 0) * 0.3;
    if (r.ms && r.ms < 30000) it.ms = it.ms ? it.ms * 0.7 + r.ms * 0.3 : r.ms;
    it.box = r.ok ? Math.min(5, it.box + 1) : 0;
    it.due = now + BOX_DUE[it.box];
    it.last = now;
    if (r.label) it.label = r.label;
    m[key] = it;
    items[mode] = m;
  }
  // XP: Grundwert (Note 3, Akkord 6 …) für richtig beim ersten Versuch, +Tempo-Bonus, +Serien-Bonus
  const base = r.base || 3;
  let xp = r.xp ?? (r.ok ? base + (r.ms && r.ms < 1500 ? 2 : r.ms && r.ms < 3000 ? 1 : 0) + Math.min(3, Math.floor((r.streak || 0) / 10)) : 0);
  return addXP(mode, xp, { ok: r.ok ? 1 : 0, total: 1, fast: r.ok && r.ms && r.ms < 1000, streak: r.streak });
}

export function addXP(mode, xp, { ok = 0, total = 0, fast = false, streak = 0 } = {}) {
  const before = level(game.xp).level;
  const d = dayObj();
  const goalBefore = d.xp >= game.goal;
  d.xp += xp; d.ok += ok; d.total += total;
  const md = d.modes[mode] || { xp: 0, ok: 0, total: 0, ms: 0 };
  md.xp += xp; md.ok += ok; md.total += total;
  d.modes[mode] = md;
  saveDay(d);
  game.xp = (game.xp || 0) + xp;
  if (fast) game.fast = (game.fast || 0) + 1;
  if (streak > (game.bestRun || 0)) game.bestRun = streak;
  const lv = level(game.xp);
  const ev = { mode, xp, level: lv, levelUp: lv.level > before, goalReached: !goalBefore && d.xp >= game.goal, badges: [] };
  if (ev.goalReached) game.goalDays = (game.goalDays || 0) + 1;
  const s = streakDays();
  if (s > (game.bestStreak || 0)) game.bestStreak = s;
  ev.badges = checkBadges();
  emit(ev);
  return ev;
}

/** Übungszeit (aktive Zeit) mitzählen – vom App-Rahmen bei jeder Eingabe aufgerufen */
let lastActive = 0, lastMode = null;
export function activity(mode) {
  const now = Date.now();
  if (lastActive && mode === lastMode) {
    const gap = now - lastActive;
    if (gap < 20000) {
      const d = dayObj();
      d.ms += gap;
      const md = d.modes[mode] || { xp: 0, ok: 0, total: 0, ms: 0 };
      md.ms = (md.ms || 0) + gap; d.modes[mode] = md;
      // nicht bei jedem Tastendruck speichern: höchstens alle 5 s
      if (!activity._t || now - activity._t > 5000) { saveDay(d); activity._t = now; } else days[today()] = d;
    }
  }
  lastActive = now; lastMode = mode;
}

// ---------------------------------------------------------------- Auswahl (adaptives Üben)
/**
 * Gewichtete Auswahl: Unsicheres, Fälliges und Neues kommt öfter dran.
 * @param candidates [{ key, … }]
 * @param opts { focus: 0..1 (wie stark auf Schwächen), exclude: key }
 */
export function pickAdaptive(mode, candidates, { focus = 0.6, exclude } = {}) {
  const now = Date.now();
  const m = items[mode] || {};
  const list = candidates.filter(c => c.key !== exclude);
  if (!list.length) return candidates[0];
  const w = list.map(c => {
    const it = m[c.key];
    if (!it) return 1 + 2 * focus;                         // Neues einstreuen
    const mas = mastery(it);
    const due = it.due && it.due < now ? 1 + Math.min(2, (now - it.due) / 86400e3) : 0.6;
    return 0.25 + focus * 6 * Math.pow(1 - mas, 1.6) * due + (1 - focus);
  });
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

/** Schwächste Objekte eines Modus */
export function weakest(mode, n = 8, minTries = 2) {
  const m = items[mode] || {};
  return Object.entries(m).filter(([, it]) => it.n >= minTries).map(([key, it]) => ({ key, ...it, m: mastery(it) }))
    .sort((a, b) => a.m - b.m).slice(0, n);
}

// ---------------------------------------------------------------- Level, Serie, Tagesziel
const LEVEL_NAMES = ['Neugierig', 'Entdecker', 'Notenleser', 'Tastenfreund', 'Akkordbauer', 'Skalenläufer', 'Groovefinder',
  'Harmoniker', 'Improvisator', 'Jazzkatze', 'Klangarchitekt', 'Virtuose', 'Maestro', 'Legende'];
/** Level aus XP: Level n braucht 120·n² XP insgesamt (Level 5 ≈ 3000, Level 10 ≈ 12 000) */
export function level(xp = game.xp || 0) {
  const need = n => 120 * n * n;
  let n = 1;
  while (xp >= need(n)) n++;
  const lo = n > 1 ? need(n - 1) : 0, hi = need(n);
  return { level: n, name: LEVEL_NAMES[Math.min(LEVEL_NAMES.length - 1, Math.floor((n - 1) / 2))], xp, from: lo, to: hi, progress: (xp - lo) / (hi - lo) };
}
/** Tage in Folge mit Übung (mind. 30 XP); heute zählt, sobald geübt – gestern reicht, um die Serie zu halten */
export function streakDays() {
  let n = 0;
  const d = new Date();
  const has = dt => (days[today(dt)] || {}).xp >= 30;
  if (!has(d)) d.setDate(d.getDate() - 1);
  while (has(d)) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
export function todayStats() { return { ...dayObj(), goal: game.goal }; }

// ---------------------------------------------------------------- Abzeichen
const sumMode = (mode, f) => Object.values(items[mode] || {}).reduce((a, it) => a + (it[f] || 0), 0);
export const BADGES = [
  { id: 'first', icon: '🎹', name: 'Erste Töne', desc: 'Die erste Aufgabe gelöst', test: () => game.xp > 0 },
  { id: 'notes100', icon: '🎼', name: 'Notenleser', desc: '100 Noten richtig gelesen', test: () => sumMode('notes', 'ok') >= 100 },
  { id: 'notes1000', icon: '📜', name: 'Blattspieler', desc: '1000 Noten richtig gelesen', test: () => sumMode('notes', 'ok') >= 1000 },
  { id: 'run25', icon: '🔥', name: 'Heiße Hand', desc: '25 richtig in Folge', test: () => (game.bestRun || 0) >= 25 },
  { id: 'run100', icon: '☄️', name: 'Unaufhaltsam', desc: '100 richtig in Folge', test: () => (game.bestRun || 0) >= 100 },
  { id: 'fast50', icon: '⚡', name: 'Blitzschnell', desc: '50-mal in unter einer Sekunde richtig', test: () => (game.fast || 0) >= 50 },
  { id: 'chords50', icon: '🎶', name: 'Akkordgreifer', desc: '50 Akkorde gegriffen', test: () => sumMode('chords', 'ok') >= 50 },
  { id: 'jazz', icon: '🎷', name: 'Jazzhände', desc: '25 Jazz-Voicings gegriffen', test: () => Object.entries(items.chords || {}).filter(([k]) => /\|(shell|rootless)/.test(k)).reduce((a, [, it]) => a + it.ok, 0) >= 25 },
  { id: 'scales12', icon: '🪜', name: 'Quintenzirkel-Reise', desc: 'Alle 12 Dur-Tonleitern fehlerfrei', test: () => Object.entries(items.scales || {}).filter(([k, it]) => k.endsWith(':major') && it.ok > 0).length >= 12 },
  { id: 'circle25', icon: '🧭', name: 'Navigator', desc: '25 Quintenzirkel-Fragen richtig', test: () => sumMode('circle', 'ok') >= 25 },
  { id: 'improv', icon: '🎺', name: 'Jam-Session', desc: '10 Minuten improvisiert', test: () => Object.values(days).reduce((a, d) => a + ((d.modes.improv || {}).ms || 0), 0) >= 600e3 },
  { id: 'song', icon: '🏁', name: 'Erstes Stück', desc: 'Ein Stück im Warte-Modus durchgespielt', test: () => sumMode('library', 'ok') >= 1 },
  { id: 'streak3', icon: '📅', name: 'Dranbleiber', desc: '3 Tage in Folge geübt', test: () => (game.bestStreak || 0) >= 3 },
  { id: 'streak7', icon: '🗓️', name: 'Eine Woche', desc: '7 Tage in Folge geübt', test: () => (game.bestStreak || 0) >= 7 },
  { id: 'streak30', icon: '🏆', name: 'Gewohnheit', desc: '30 Tage in Folge geübt', test: () => (game.bestStreak || 0) >= 30 },
  { id: 'goal7', icon: '🎯', name: 'Zielstrebig', desc: '7-mal das Tagesziel erreicht', test: () => (game.goalDays || 0) >= 7 },
  { id: 'level5', icon: '⭐', name: 'Aufsteiger', desc: 'Level 5 erreicht', test: () => level().level >= 5 },
  { id: 'level10', icon: '🌟', name: 'Fortgeschritten', desc: 'Level 10 erreicht', test: () => level().level >= 10 },
  { id: 'night', icon: '🦉', name: 'Nachteule', desc: 'Nach 22 Uhr geübt', test: () => new Date().getHours() >= 22 },
  { id: 'early', icon: '🐦', name: 'Frühaufsteher', desc: 'Vor 7 Uhr geübt', test: () => new Date().getHours() < 7 }
];
function checkBadges() {
  const got = [];
  const b = { ...(game.badges || {}) };
  for (const badge of BADGES) {
    if (b[badge.id]) continue;
    try { if (badge.test()) { b[badge.id] = Date.now(); got.push(badge); } } catch {}
  }
  if (got.length) game.badges = b;
  return got;
}

// Einmalig: bisherigen Fortschritt (vor Version 0.4) in XP umrechnen
if (!game.migrated) {
  const old = Object.values(progress || {}).reduce((a, p) => a + (p.correct || 0) * 3 + (p.total || 0), 0);
  if (old && !game.xp) game.xp = old;
  game.migrated = true;
}
