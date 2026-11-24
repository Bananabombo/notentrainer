// Musiktheorie: Tonnamen, Intervalle, Akkorde, Skalen, Tonarten
// Ein "gespelter" Ton ist { l: Buchstabenindex 0–6 (C–H), a: Vorzeichen -2..2 }.

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const SEMI = [0, 2, 4, 5, 7, 9, 11];

let naming = 'de';
export const setNaming = n => { naming = n; };
export const getNaming = () => naming;

export const sp = (l, a = 0) => ({ l, a });
export const pcOf = s => (((SEMI[s.l] + s.a) % 12) + 12) % 12;
export const midiOf = (s, octave) => 12 * (octave + 1) + SEMI[s.l] + s.a;

const ACC_SYM = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };

/** Tonname für Text: de „Fis“, „Es“, „H“, „B“ – en „F♯“, „E♭“, „B“, „B♭“ */
export function noteName(s) {
  const L = LETTERS[s.l];
  if (naming !== 'de') return L + ACC_SYM[s.a];
  if (L === 'B') return s.a === 0 ? 'H' : s.a === -1 ? 'B' : s.a === 1 ? 'His' : s.a === -2 ? 'Heses' : 'Hisis';
  if (s.a === 0) return L;
  if (s.a > 0) return L + 'is'.repeat(s.a);
  const flat = (L === 'E' || L === 'A') ? 's' : 'es';
  return L + flat + (s.a === -2 ? 'es' : '');
}

/** Grundton für Akkordsymbole: F♯, E♭ – deutsch mit H und B */
export function rootSymbol(s) {
  const L = LETTERS[s.l];
  if (naming === 'de' && L === 'B') {
    if (s.a === 0) return 'H';
    if (s.a === -1) return 'B';
    return 'H' + ACC_SYM[s.a];
  }
  return L + ACC_SYM[s.a];
}

/** Ton aus MIDI-Nummer, bevorzugt ♯ oder ♭ */
const SHARP = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
const FLAT = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
export function spellMidi(midi, preferFlat = false) {
  const [l, a] = (preferFlat ? FLAT : SHARP)[((midi % 12) + 12) % 12];
  const octave = Math.floor((midi - a) / 12) - 1;
  return { s: { l, a }, octave };
}
export const midiName = (midi, preferFlat) => { const r = spellMidi(midi, preferFlat); return noteName(r.s) + r.octave; };

// ---------- Intervalle [Halbtöne, Stufen] ----------
export const IV = {
  P1: [0, 0], m2: [1, 1], M2: [2, 1], A2: [3, 1], m3: [3, 2], M3: [4, 2], P4: [5, 3], A4: [6, 3],
  d5: [6, 4], P5: [7, 4], A5: [8, 4], m6: [8, 5], M6: [9, 5], d7: [9, 6], m7: [10, 6], M7: [11, 6],
  m9: [1, 1], M9: [2, 1], A9: [3, 1], P11: [5, 3], A11: [6, 3], m13: [8, 5], M13: [9, 5]
};
export const IV_LABEL = {
  P1: '1', m2: '♭2', M2: '2', A2: '♯2', m3: '♭3', M3: '3', P4: '4', A4: '♯4', d5: '♭5', P5: '5', A5: '♯5',
  m6: '♭6', M6: '6', d7: '𝄫7', m7: '♭7', M7: '7', m9: '♭9', M9: '9', A9: '♯9', P11: '11', A11: '♯11', m13: '♭13', M13: '13'
};

export function transpose(s, [semi, steps]) {
  const l = (s.l + steps) % 7;
  const target = pcOf(s) + semi;
  const a = ((((target - SEMI[l]) % 12) + 18) % 12) - 6;
  return { l, a };
}

// ---------- Akkorde ----------
export const CHORDS = {
  maj:   { sym: '',       name: 'Dur',                  iv: ['P1', 'M3', 'P5'] },
  min:   { sym: 'm',      name: 'Moll',                 iv: ['P1', 'm3', 'P5'] },
  dim:   { sym: '°',      name: 'vermindert',           iv: ['P1', 'm3', 'd5'] },
  aug:   { sym: '+',      name: 'übermäßig',            iv: ['P1', 'M3', 'A5'] },
  sus2:  { sym: 'sus2',   name: 'sus2',                 iv: ['P1', 'M2', 'P5'] },
  sus4:  { sym: 'sus4',   name: 'sus4',                 iv: ['P1', 'P4', 'P5'] },
  maj7:  { sym: 'maj7',   name: 'großer Septakkord',    iv: ['P1', 'M3', 'P5', 'M7'], opt: ['P5'] },
  dom7:  { sym: '7',      name: 'Dominantseptakkord',   iv: ['P1', 'M3', 'P5', 'm7'], opt: ['P5'] },
  m7:    { sym: 'm7',     name: 'Moll-Septakkord',      iv: ['P1', 'm3', 'P5', 'm7'], opt: ['P5'] },
  m7b5:  { sym: 'm7♭5',   name: 'halbvermindert',       iv: ['P1', 'm3', 'd5', 'm7'] },
  dim7:  { sym: '°7',     name: 'verminderter Septakkord', iv: ['P1', 'm3', 'd5', 'd7'] },
  maj6:  { sym: '6',      name: 'Sextakkord',           iv: ['P1', 'M3', 'P5', 'M6'], opt: ['P5'] },
  m6:    { sym: 'm6',     name: 'Moll-Sextakkord',      iv: ['P1', 'm3', 'P5', 'M6'], opt: ['P5'] },
  mMaj7: { sym: 'm(maj7)', name: 'Moll mit großer Septime', iv: ['P1', 'm3', 'P5', 'M7'], opt: ['P5'] },
  maj9:  { sym: 'maj9',   name: 'großer Nonenakkord',   iv: ['P1', 'M3', 'P5', 'M7', 'M9'], opt: ['P1', 'P5'] },
  dom9:  { sym: '9',      name: 'Dominant-Nonenakkord', iv: ['P1', 'M3', 'P5', 'm7', 'M9'], opt: ['P1', 'P5'] },
  m9:    { sym: 'm9',     name: 'Moll-Nonenakkord',     iv: ['P1', 'm3', 'P5', 'm7', 'M9'], opt: ['P1', 'P5'] },
  dom13: { sym: '13',     name: 'Dominant-Tredezime',   iv: ['P1', 'M3', 'P5', 'm7', 'M9', 'M13'], opt: ['P1', 'P5', 'M9'] },
  b9:    { sym: '7♭9',    name: 'Dominante mit ♭9',     iv: ['P1', 'M3', 'P5', 'm7', 'm9'], opt: ['P1', 'P5'] },
  s9:    { sym: '7♯9',    name: 'Dominante mit ♯9',     iv: ['P1', 'M3', 'P5', 'm7', 'A9'], opt: ['P1', 'P5'] },
  six9:  { sym: '6/9',    name: 'Sext-Nonenakkord',     iv: ['P1', 'M3', 'P5', 'M6', 'M9'], opt: ['P1', 'P5'] }
};

/** Jazz-Voicings: Intervalle von unten nach oben (erstes = tiefster Ton) */
export const VOICINGS = {
  shell: {
    name: 'Shell (1–3–7)',
    forms: { maj7: ['P1', 'M3', 'M7'], dom7: ['P1', 'M3', 'm7'], m7: ['P1', 'm3', 'm7'], m7b5: ['P1', 'm3', 'm7'], maj6: ['P1', 'M3', 'M6'], m6: ['P1', 'm3', 'M6'] }
  },
  rootlessA: {
    name: 'Rootless A (3 unten)',
    forms: { maj7: ['M3', 'P5', 'M7', 'M9'], dom7: ['M3', 'M13', 'm7', 'M9'], m7: ['m3', 'P5', 'm7', 'M9'] }
  },
  rootlessB: {
    name: 'Rootless B (7 unten)',
    forms: { maj7: ['M7', 'M9', 'M3', 'P5'], dom7: ['m7', 'M9', 'M3', 'M13'], m7: ['m7', 'M9', 'm3', 'P5'] }
  }
};

export function chordNotes(root, type) {
  return CHORDS[type].iv.map(k => ({ iv: k, s: transpose(root, IV[k]), label: IV_LABEL[k] }));
}
export const chordSymbol = (root, type) => rootSymbol(root) + CHORDS[type].sym;

/**
 * Prüft gehaltene Töne gegen einen Akkord.
 * mode: 'any' (jede Umkehrung) | 'root' (Grundton unten) | Voicing-Schlüssel
 */
export function matchChord(heldMidis, root, type, mode = 'any') {
  if (!heldMidis.length) return { ok: false };
  const held = new Set(heldMidis.map(m => ((m % 12) + 12) % 12));
  const lowest = Math.min(...heldMidis);
  const rootPc = pcOf(root);
  if (VOICINGS[mode]) {
    const form = VOICINGS[mode].forms[type];
    if (!form) return { ok: false };
    const pcs = form.map(k => pcOf(transpose(root, IV[k])));
    const want = new Set(pcs);
    const ok = want.size === held.size && [...want].every(p => held.has(p)) && ((lowest % 12) + 12) % 12 === pcs[0];
    return { ok, missing: [...want].filter(p => !held.has(p)), extra: [...held].filter(p => !want.has(p)) };
  }
  const def = CHORDS[type];
  const all = new Map(def.iv.map(k => [pcOf(transpose(root, IV[k])), k]));
  const required = def.iv.filter(k => !(def.opt || []).includes(k)).map(k => pcOf(transpose(root, IV[k])));
  const missing = required.filter(p => !held.has(p));
  const extra = [...held].filter(p => !all.has(p));
  let ok = !missing.length && !extra.length && held.size >= Math.min(3, required.length);
  if (ok && mode === 'root') ok = ((lowest % 12) + 12) % 12 === rootPc;
  return { ok, missing, extra };
}

// ---------- Skalen ----------
const S = (...pairs) => pairs;
export const SCALES = {
  major:      { name: 'Dur (Ionisch)',        iv: S([0,0],[2,1],[4,2],[5,3],[7,4],[9,5],[11,6]), parent: [0, 0] },
  minor:      { name: 'Natürliches Moll',     iv: S([0,0],[2,1],[3,2],[5,3],[7,4],[8,5],[10,6]), parent: [3, 2] },
  harmonic:   { name: 'Harmonisches Moll',    iv: S([0,0],[2,1],[3,2],[5,3],[7,4],[8,5],[11,6]), parent: [3, 2] },
  melodic:    { name: 'Melodisches Moll',     iv: S([0,0],[2,1],[3,2],[5,3],[7,4],[9,5],[11,6]), parent: [3, 2] },
  dorian:     { name: 'Dorisch',              iv: S([0,0],[2,1],[3,2],[5,3],[7,4],[9,5],[10,6]), parent: [10, 6] },
  phrygian:   { name: 'Phrygisch',            iv: S([0,0],[1,1],[3,2],[5,3],[7,4],[8,5],[10,6]), parent: [8, 5] },
  lydian:     { name: 'Lydisch',              iv: S([0,0],[2,1],[4,2],[6,3],[7,4],[9,5],[11,6]), parent: [5, 3] },
  mixolydian: { name: 'Mixolydisch',          iv: S([0,0],[2,1],[4,2],[5,3],[7,4],[9,5],[10,6]), parent: [7, 4] },
  locrian:    { name: 'Lokrisch',             iv: S([0,0],[1,1],[3,2],[5,3],[6,4],[8,5],[10,6]), parent: [1, 1] },
  pentMajor:  { name: 'Dur-Pentatonik',       iv: S([0,0],[2,1],[4,2],[7,4],[9,5]), parent: [0, 0] },
  pentMinor:  { name: 'Moll-Pentatonik',      iv: S([0,0],[3,2],[5,3],[7,4],[10,6]), parent: [3, 2] },
  blues:      { name: 'Blues-Skala',          iv: S([0,0],[3,2],[5,3],[6,4],[7,4],[10,6]), parent: [3, 2] },
  phrygDom:   { name: 'Phrygisch-Dominant',   iv: S([0,0],[1,1],[4,2],[5,3],[7,4],[8,5],[10,6]), parent: null },
  altered:    { name: 'Alteriert',            iv: S([0,0],[1,1],[3,1],[4,2],[6,3],[8,5],[10,6]), parent: null },
  lydDom:     { name: 'Lydisch-Dominant',     iv: S([0,0],[2,1],[4,2],[6,3],[7,4],[9,5],[10,6]), parent: null }
};
export const scaleNotes = (tonic, type) => SCALES[type].iv.map(i => transpose(tonic, i));

// ---------- Tonarten / Quintenzirkel ----------
/** Vorzeichenzahl einer Dur-Tonart: positiv = ♯, negativ = ♭ */
export function majorSignature(tonic) {
  return scaleNotes(tonic, 'major').reduce((n, s) => n + s.a, 0);
}
const SIG_KEYS_SHARP = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const SIG_KEYS_FLAT = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
export const vexKeyFromSig = sig => (sig >= 0 ? SIG_KEYS_SHARP[sig] : SIG_KEYS_FLAT[-sig]);

/** Vorzeichen einer Tonart als Map Buchstabe → Vorzeichen */
export function signatureMap(sig) {
  const order = sig >= 0 ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3]; // F C G D A E H | H E A D G C F
  const m = {};
  for (let i = 0; i < Math.abs(sig); i++) m[order[i]] = sig > 0 ? 1 : -1;
  return m;
}
export const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
export const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];

/** Quintenzirkel: 12 Positionen, im Uhrzeigersinn ab C */
export const CIRCLE = [
  { major: sp(0), minor: sp(5) },          // C  / a
  { major: sp(4), minor: sp(2) },          // G  / e
  { major: sp(1), minor: sp(6) },          // D  / h
  { major: sp(5), minor: sp(3, 1) },       // A  / fis
  { major: sp(2), minor: sp(0, 1) },       // E  / cis
  { major: sp(6), minor: sp(4, 1) },       // H  / gis
  { major: sp(3, 1), minor: sp(1, 1), alt: { major: sp(4, -1), minor: sp(2, -1) } }, // Fis/Ges
  { major: sp(1, -1), minor: sp(6, -1) },  // Des / b
  { major: sp(5, -1), minor: sp(3) },      // As / f
  { major: sp(2, -1), minor: sp(0) },      // Es / c
  { major: sp(6, -1), minor: sp(4) },      // B  / g
  { major: sp(3), minor: sp(1) }           // F  / d
];

/** Die 12 gebräuchlichen Grundtöne (für Akkorde & Tonleitern) */
export const ROOTS = [sp(0), sp(1, -1), sp(1), sp(2, -1), sp(2), sp(3), sp(3, 1), sp(4), sp(5, -1), sp(5), sp(6, -1), sp(6)];
export const NATURAL_ROOTS = [0, 1, 2, 3, 4, 5, 6].map(l => sp(l));

export const keyLabel = (s, minor = false) => {
  const n = noteName(s);
  return minor ? n.toLowerCase() + '-Moll' : n + '-Dur';
};

/** Stufen in Dur für Diatonik: [Intervall, Akkordtyp Dreiklang, Vierklang, römisch] */
export const DIATONIC = [
  ['P1', 'maj', 'maj7', 'I'], ['M2', 'min', 'm7', 'ii'], ['M3', 'min', 'm7', 'iii'], ['P4', 'maj', 'maj7', 'IV'],
  ['P5', 'maj', 'dom7', 'V'], ['M6', 'min', 'm7', 'vi'], ['M7', 'dim', 'm7b5', 'vii°']
];

export const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const pick = a => a[Math.floor(Math.random() * a.length)];
export const pc = m => ((m % 12) + 12) % 12;
