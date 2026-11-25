// Datenmodell des Noten-Editors: arbeitet direkt auf dem MusicXML-DOM (partwise).
// Jeder Takt wird beim Laden „normalisiert“: Stimmen nacheinander, dazwischen <backup> über die volle
// Stimmlänge, Anmerkungen (Dynamik, Schlüsselwechsel …) hängen an der folgenden Note. So bleiben Takte
// nach jeder Änderung (Dauer, Note einfügen/löschen) gültig.

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const TYPES = [['whole', 1], ['half', 2], ['quarter', 4], ['eighth', 8], ['16th', 16], ['32nd', 32], ['64th', 64]];
const TYPE_DEN = Object.fromEntries(TYPES);
const SHARP_ORDER = 'FCGDAEB', FLAT_ORDER = 'BEADGCF';
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const lcm = (a, b) => a / gcd(a, b) * b;

const kids = (el, tag) => [...el.children].filter(c => c.tagName === tag);
const kid = (el, tag) => [...el.children].find(c => c.tagName === tag) || null;
const txt = (el, tag, def = null) => { const k = el && kid(el, tag); return k ? k.textContent.trim() : def; };

export function keyAlters(fifths) {
  const out = {};
  if (fifths > 0) for (const s of SHARP_ORDER.slice(0, fifths)) out[s] = 1;
  if (fifths < 0) for (const s of FLAT_ORDER.slice(0, -fifths)) out[s] = -1;
  return out;
}
export const midiOfPitch = (step, octave, alter = 0) => (octave + 1) * 12 + STEP_SEMI[step] + alter;
export function spell(midi, fifths = 0) {
  // Schreibweise passend zur Tonart: bei ♭-Tonarten ♭, sonst ♯
  const pcs = fifths < 0 ? [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]
    : [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const [step, alter] = pcs[((midi % 12) + 12) % 12];
  return { step, alter, octave: Math.floor((midi - alter) / 12) - 1 };
}

export class Score {
  constructor(xmlText) {
    this.doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (this.doc.querySelector('parsererror')) throw new Error('MusicXML konnte nicht gelesen werden');
    this.root = this.doc.documentElement;
    if (this.root.tagName === 'score-timewise') throw new Error('„timewise“-MusicXML wird nicht unterstützt');
    this.parts = kids(this.root, 'part');
    this.undoStack = []; this.redoStack = [];
    this.normalizeDivisions();
    this.forEachMeasure(m => this.rebuild(m));
    this.dirty = false;
  }

  // ------------------------------------------------------------ Grundlagen
  get measures() { return kids(this.parts[0], 'measure'); }
  measuresOf(pi) { return kids(this.parts[pi], 'measure'); }
  forEachMeasure(fn) { this.parts.forEach((p, pi) => kids(p, 'measure').forEach((m, mi) => fn(m, mi, pi))); }
  serialize() {
    const s = new XMLSerializer().serializeToString(this.doc);
    return s.startsWith('<?xml') ? s : '<?xml version="1.0" encoding="UTF-8"?>\n' + s;
  }
  snapshot() { return this.serialize(); }
  /** Änderung mit Undo-Punkt ausführen */
  edit(label, fn) {
    const before = this.serialize();
    const res = fn();
    if (res === false) return false;
    this.undoStack.push({ label, xml: before });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    return res ?? true;
  }
  restore(xml) {
    this.doc = new DOMParser().parseFromString(xml, 'application/xml');
    this.root = this.doc.documentElement;
    this.parts = kids(this.root, 'part');
  }
  undo() { const u = this.undoStack.pop(); if (!u) return null; this.redoStack.push({ label: u.label, xml: this.serialize() }); this.restore(u.xml); this.dirty = true; return u.label; }
  redo() { const r = this.redoStack.pop(); if (!r) return null; this.undoStack.push({ label: r.label, xml: this.serialize() }); this.restore(r.xml); this.dirty = true; return r.label; }

  // ------------------------------------------------------------ Attribute (Takt, Tonart, Schlüssel) im Verlauf
  /** Zustand am Anfang von Takt mi der Stimme pi: divisions, fifths, beats, beatType, clefs{staff} , staves */
  stateAt(mi, pi = 0) {
    const st = { divisions: 1, fifths: 0, beats: 4, beatType: 4, clefs: {}, staves: 1 };
    const ms = this.measuresOf(pi);
    for (let i = 0; i <= mi && i < ms.length; i++) {
      for (const a of ms[i].getElementsByTagName('attributes')) {
        // Attribute mitten im Takt mi zählen erst ab dem nächsten Takt (außer Schlüssel am Taktanfang)
        if (i === mi && !this.isAtMeasureStart(a)) continue;
        this.applyAttributes(st, a);
      }
    }
    return st;
  }
  applyAttributes(st, a) {
    const d = txt(a, 'divisions'); if (d) st.divisions = +d;
    const k = kid(a, 'key'); if (k && txt(k, 'fifths') != null) st.fifths = +txt(k, 'fifths');
    const t = kid(a, 'time'); if (t && txt(t, 'beats')) { st.beats = parseInt(txt(t, 'beats')) || 4; st.beatType = +txt(t, 'beat-type') || 4; }
    const sv = txt(a, 'staves'); if (sv) st.staves = +sv;
    for (const c of kids(a, 'clef')) st.clefs[c.getAttribute('number') || '1'] = { sign: txt(c, 'sign'), line: +txt(c, 'line', 0), oct: +txt(c, 'clef-octave-change', 0) };
  }
  isAtMeasureStart(el) {
    for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === 'note' || p.tagName === 'forward') return false;
    return true;
  }
  measureLength(mi, pi = 0) { const s = this.stateAt(mi, pi); return s.divisions * 4 * s.beats / s.beatType; }

  // ------------------------------------------------------------ Normalisierung
  normalizeDivisions() {
    for (const part of this.parts) {
      let D = 48;
      for (const d of part.getElementsByTagName('divisions')) D = lcm(D, +d.textContent || 1);
      let cur = 1;
      for (const m of kids(part, 'measure')) {
        for (const el of [...m.children]) {
          if (el.tagName === 'attributes') { const d = kid(el, 'divisions'); if (d) { cur = +d.textContent || 1; d.textContent = String(D); } }
          const k = D / cur;
          if (k !== 1 && ['note', 'backup', 'forward'].includes(el.tagName)) {
            const du = kid(el, 'duration'); if (du) du.textContent = String(Math.round(+du.textContent * k));
          }
        }
      }
      // erstes attributes muss divisions haben
      const first = kid(kids(part, 'measure')[0] || part, 'attributes');
      if (first && !kid(first, 'divisions')) { const d = this.doc.createElement('divisions'); d.textContent = String(D); first.prepend(d); }
    }
  }
  /** Takt in Stimmen zerlegen */
  parse(m) {
    const head = [], tail = [], voices = new Map();
    let t = 0, pending = [], lastGroup = null, seenNote = false;
    const voiceOf = v => { if (!voices.has(v)) voices.set(v, { key: v, staff: null, items: [], start: t }); return voices.get(v); };
    for (const el of [...m.children]) {
      const tag = el.tagName;
      if (tag === 'note') {
        const dur = +txt(el, 'duration', 0) || 0;
        const isGrace = !!kid(el, 'grace'), isChord = !!kid(el, 'chord');
        if (isChord && lastGroup) { lastGroup.els.push(el); continue; }
        const v = voiceOf(txt(el, 'voice', '1'));
        if (!v.items.length && t > v.start) v.start = t;
        if (v.staff == null) v.staff = txt(el, 'staff', '1');
        if (v.items.length === 0 && t > 0) v.items.push({ kind: 'forward', dur: t, pre: [], synthetic: true });
        lastGroup = { kind: 'note', els: [el], pre: pending, dur: isGrace ? 0 : dur, grace: isGrace };
        pending = []; v.items.push(lastGroup); seenNote = true;
        if (!isGrace) t += dur;
      } else if (tag === 'backup') { t -= +txt(el, 'duration', 0) || 0; if (t < 0) t = 0; lastGroup = null; }
      else if (tag === 'forward') {
        const v = voiceOf(txt(el, 'voice', lastGroup ? txt(lastGroup.els[0], 'voice', '1') : '1'));
        if (v.items.length === 0 && t > 0) v.items.push({ kind: 'forward', dur: t, pre: [], synthetic: true });
        const dur = +txt(el, 'duration', 0) || 0;
        v.items.push({ kind: 'forward', el, dur, pre: pending }); pending = []; t += dur; lastGroup = null;
      } else if (tag === 'barline') {
        ((el.getAttribute('location') || 'right') === 'left' ? head : tail).push(el);
      } else if (!seenNote && t === 0 && (tag === 'attributes' || tag === 'print')) head.push(el);
      else pending.push(el);
    }
    tail.unshift(...pending);
    return { head, tail, voices: [...voices.values()] };
  }
  /** Takt aus der Stimmen-Struktur neu aufbauen */
  write(m, model) {
    const frag = [];
    frag.push(...model.head.filter(e => e.tagName !== 'barline'), ...model.head.filter(e => e.tagName === 'barline'));
    let prevTotal = 0;
    model.voices.forEach((v, i) => {
      if (i > 0 && prevTotal > 0) frag.push(this.mk('backup', [this.mk('duration', String(prevTotal))]));
      let total = 0;
      for (const it of v.items) {
        frag.push(...it.pre);
        if (it.kind === 'note') { frag.push(...it.els); total += it.dur; }
        else {
          const f = it.el || this.mk('forward', [this.mk('duration', String(it.dur))]);
          if (it.el) this.setText(f, 'duration', String(it.dur));
          frag.push(f); total += it.dur;
        }
      }
      prevTotal = total;
    });
    frag.push(...model.tail.filter(e => e.tagName !== 'barline'), ...model.tail.filter(e => e.tagName === 'barline'));
    while (m.firstChild) m.removeChild(m.firstChild);
    for (const e of frag) m.appendChild(e);
  }
  rebuild(m) { this.write(m, this.parse(m)); }
  /** Stimmen ohne echte Noten (nur Pausen/Lücken) entfernen, wenn das System noch eine andere Stimme hat */
  prune(model) {
    const isEmpty = v => v.items.every(it => it.kind === 'forward' || (it.kind === 'note' && it.els.every(e => kid(e, 'rest'))));
    model.voices = model.voices.filter(v => {
      if (!isEmpty(v)) return true;
      const others = model.voices.some(o => o !== v && o.staff === v.staff && !isEmpty(o));
      if (others) { for (const it of v.items) { for (const e of it.els || []) e.remove(); if (it.el) it.el.remove(); model.tail.unshift(...it.pre); } return false; }
      return true;
    });
  }

  // ------------------------------------------------------------ Hilfen
  mk(tag, children = [], attrs = {}) {
    const el = this.doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (typeof children === 'string') el.textContent = children;
    else for (const c of children) typeof c === 'string' ? (el.textContent = c) : el.appendChild(c);
    return el;
  }
  setText(el, tag, value) {
    let k = kid(el, tag);
    if (!k) { k = this.doc.createElement(tag); el.appendChild(k); }
    k.textContent = value;
    return k;
  }
  /** Kindelement in MusicXML-Reihenfolge einsetzen */
  insertOrdered(note, el) {
    const ORDER = ['grace', 'cue', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'voice', 'type', 'dot', 'accidental', 'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam', 'notations', 'lyric', 'play', 'listen'];
    const idx = ORDER.indexOf(el.tagName);
    const after = [...note.children].find(c => ORDER.indexOf(c.tagName) > idx);
    note.insertBefore(el, after || null);
    return el;
  }
  measureIndexOf(el) { const m = el.closest('measure'); return this.measuresOf(this.partIndexOf(m)).indexOf(m); }
  partIndexOf(el) { return this.parts.indexOf(el.closest('part')); }

  // ------------------------------------------------------------ Noten-Infos
  noteInfo(n) {
    const p = kid(n, 'pitch');
    const info = { el: n, rest: !!kid(n, 'rest'), chord: !!kid(n, 'chord'), grace: !!kid(n, 'grace'), voice: txt(n, 'voice', '1'), staff: txt(n, 'staff', '1'),
      type: txt(n, 'type'), dots: kids(n, 'dot').length, dur: +txt(n, 'duration', 0), tie: kids(n, 'tie').map(t => t.getAttribute('type')) };
    if (p) { info.step = txt(p, 'step'); info.octave = +txt(p, 'octave'); info.alter = +txt(p, 'alter', 0); info.midi = midiOfPitch(info.step, info.octave, info.alter); }
    return info;
  }
  /** Zuordnungstabelle: (Takt, System, Einsatz, Tonhöhe) → <note> – zum Verknüpfen mit der Darstellung */
  index() {
    const out = [];
    this.parts.forEach((part, pi) => {
      let staffBase = 0;
      for (let k = 0; k < pi; k++) staffBase += this.stateAt(0, k).staves;
      kids(part, 'measure').forEach((m, mi) => {
        const st = this.stateAt(mi, pi);
        const model = this.parse(m);
        for (const v of model.voices) {
          let t = 0;
          for (const it of v.items) {
            if (it.kind === 'note') {
              for (const el of it.els) {
                const info = this.noteInfo(el);
                out.push({ el, mi, pi, staff: staffBase + (+info.staff - 1), voice: v.key, onset: t / (4 * st.divisions), midi: info.rest ? null : info.midi, grace: it.grace });
              }
            }
            t += it.dur;
          }
        }
      });
    });
    return out;
  }
  /** Gruppe (Akkord) einer Note mit Stimme und Position */
  locate(noteEl) {
    const m = noteEl.closest('measure');
    const model = this.parse(m);
    for (const v of model.voices) for (let i = 0; i < v.items.length; i++) {
      const it = v.items[i];
      if (it.kind === 'note' && it.els.includes(noteEl)) return { m, model, voice: v, index: i, group: it };
    }
    return null;
  }

  // ------------------------------------------------------------ Rhythmus-Prüfung
  /** Takte (Index), deren Stimmen nicht zur Taktart passen */
  rhythmErrors() {
    const bad = new Set();
    this.parts.forEach((part, pi) => kids(part, 'measure').forEach((m, mi) => {
      if (m.getAttribute('implicit') === 'yes') return;
      const len = this.measureLength(mi, pi);
      const model = this.parse(m);
      const staves = this.stateAt(mi, pi).staves;
      const staffsWithNotes = new Set(model.voices.map(v => v.staff));
      if (staffsWithNotes.size < staves) bad.add(mi);
      for (const v of model.voices) {
        const total = v.items.reduce((a, it) => a + it.dur, 0);
        if (Math.abs(total - len) > 0.01 && !(v.items.every(it => it.kind === 'forward'))) bad.add(mi);
      }
    }));
    return [...bad].sort((a, b) => a - b);
  }
  voiceTotal(v) { return v.items.reduce((a, it) => a + it.dur, 0); }

  // ------------------------------------------------------------ Noten bearbeiten
  /** Tonhöhe setzen (MIDI), Schreibweise nach Tonart oder vorgegeben */
  setPitch(noteEl, midi, spelled) {
    const mi = this.measureIndexOf(noteEl), pi = this.partIndexOf(noteEl);
    const st = this.stateAt(mi, pi);
    const sp = spelled || spell(midi, st.fifths);
    const rest = kid(noteEl, 'rest');
    if (rest) rest.remove();
    let p = kid(noteEl, 'pitch');
    if (!p) { p = this.mk('pitch'); this.insertOrdered(noteEl, p); }
    while (p.firstChild) p.removeChild(p.firstChild);
    p.appendChild(this.mk('step', [sp.step]));
    if (sp.alter) p.appendChild(this.mk('alter', [String(sp.alter)]));
    p.appendChild(this.mk('octave', [String(sp.octave)]));
    this.updateAccidental(noteEl, st.fifths);
    return sp;
  }
  /** Vorzeichen-Anzeige passend zur Tonart (einfach: abweichend von der Tonart → anzeigen) */
  updateAccidental(noteEl, fifths) {
    const p = kid(noteEl, 'pitch'); if (!p) return;
    const step = txt(p, 'step'), alter = +txt(p, 'alter', 0);
    const keyAlt = keyAlters(fifths)[step] || 0;
    let acc = kid(noteEl, 'accidental');
    if (alter === keyAlt) { if (acc) acc.remove(); return; }
    const name = { '-2': 'flat-flat', '-1': 'flat', '0': 'natural', '1': 'sharp', '2': 'double-sharp' }[String(alter)];
    if (!acc) acc = this.insertOrdered(noteEl, this.mk('accidental'));
    acc.textContent = name;
  }
  /** diatonisch verschieben (±Stufen), Vorzeichen der Tonart übernehmen */
  stepPitch(noteEl, steps) {
    const info = this.noteInfo(noteEl); if (info.rest) return;
    const st = this.stateAt(this.measureIndexOf(noteEl), this.partIndexOf(noteEl));
    let idx = STEPS.indexOf(info.step) + info.octave * 7 + steps;
    const step = STEPS[((idx % 7) + 7) % 7], octave = Math.floor(idx / 7);
    const alter = keyAlters(st.fifths)[step] || 0;
    this.setPitch(noteEl, midiOfPitch(step, octave, alter), { step, octave, alter });
  }
  setAlter(noteEl, alter) {
    const info = this.noteInfo(noteEl); if (info.rest) return;
    this.setPitch(noteEl, midiOfPitch(info.step, info.octave, alter), { step: info.step, octave: info.octave, alter });
  }
  /** Note ↔ Pause */
  toRest(noteEl) {
    const loc = this.locate(noteEl); if (!loc) return;
    const first = loc.group.els[0];
    for (const el of loc.group.els.slice(1)) el.remove();
    for (const tag of ['pitch', 'accidental', 'stem', 'beam', 'tie', 'notehead']) for (const k of kids(first, tag)) k.remove();
    const nt = kid(first, 'notations'); if (nt) for (const k of [...nt.children]) if (['tied', 'slur', 'arpeggiate'].includes(k.tagName)) k.remove();
    if (nt && !nt.children.length) nt.remove();
    if (!kid(first, 'rest')) this.insertOrdered(first, this.mk('rest'));
    return first;
  }
  toNote(noteEl, midi) {
    if (!kid(noteEl, 'rest')) return noteEl;
    if (midi == null) {
      const st = this.stateAt(this.measureIndexOf(noteEl), this.partIndexOf(noteEl));
      const clef = st.clefs[txt(noteEl, 'staff', '1')] || { sign: 'G' };
      midi = clef.sign === 'F' ? 50 : clef.sign === 'C' ? 60 : 71; // Mittellinie
    }
    this.setPitch(noteEl, midi);
    return noteEl;
  }
  /** Dauer setzen: type + Punkte; passt den Takt an (füllt mit Pausen auf bzw. nimmt folgende Pausen weg) */
  setDuration(noteEl, type, dots = 0) {
    const loc = this.locate(noteEl); if (!loc || loc.group.grace) return;
    const mi = this.measureIndexOf(noteEl), pi = this.partIndexOf(noteEl);
    const st = this.stateAt(mi, pi);
    const base = st.divisions * 4 / TYPE_DEN[type];
    let dur = base; for (let d = 1; d <= dots; d++) dur += base / Math.pow(2, d);
    dur = Math.round(dur);
    for (const el of loc.group.els) {
      this.setText(el, 'duration', String(dur));
      this.setText(el, 'type', type);
      for (const k of kids(el, 'dot')) k.remove();
      for (let d = 0; d < dots; d++) this.insertOrdered(el, this.mk('dot'));
      for (const k of kids(el, 'time-modification')) k.remove();
    }
    loc.group.dur = dur;
    this.clearBeams(loc.voice);
    this.fitVoice(loc.m, loc.model, loc.voice, loc.index, this.measureLength(mi, pi), st);
    this.write(loc.m, loc.model);
  }
  clearBeams(v) { for (const it of v.items) if (it.kind === 'note') for (const el of it.els) for (const b of kids(el, 'beam')) b.remove(); }
  /** Stimme auf Taktlänge bringen: Überhang durch folgende Pausen ausgleichen, Lücke mit Pausen füllen */
  fitVoice(m, model, v, fromIndex, len, st) {
    let total = this.voiceTotal(v);
    // Überhang: nachfolgende Pausen kürzen/entfernen
    for (let i = v.items.length - 1; total > len && i > fromIndex; i--) {
      const it = v.items[i];
      const isRest = it.kind === 'forward' || (it.kind === 'note' && it.els.length === 1 && kid(it.els[0], 'rest'));
      if (!isRest) continue;
      const over = total - len;
      if (it.dur <= over) { v.items.splice(i, 1); total -= it.dur; if (it.el) it.el.remove(); for (const e of it.els || []) e.remove(); for (const e of it.pre) v.items[i - 1] ? v.items[i - 1].pre.push(e) : null; }
      else { const nd = it.dur - over; this.setRestDuration(it, nd, st); total -= over; }
    }
    // Lücke: Pausen anhängen
    if (total < len) for (const d of this.splitDuration(len - total, st)) v.items.push(this.makeRest(d, v, st));
  }
  splitDuration(d, st) {
    const out = [];
    const q = st.divisions * 4;
    for (const [, den] of TYPES) { const u = q / den; while (d >= u - 0.001 && u >= 1) { out.push(u); d -= u; } }
    return out;
  }
  typeFor(dur, st) {
    const q = st.divisions * 4;
    for (const [type, den] of TYPES) { const u = q / den; if (Math.abs(dur - u) < 0.01) return { type, dots: 0 }; if (Math.abs(dur - u * 1.5) < 0.01) return { type, dots: 1 }; if (Math.abs(dur - u * 1.75) < 0.01) return { type, dots: 2 }; }
    return { type: 'quarter', dots: 0 };
  }
  makeRest(dur, v, st) {
    const { type, dots } = this.typeFor(dur, st);
    const n = this.mk('note', [this.mk('rest'), this.mk('duration', String(dur)), this.mk('voice', v.key), this.mk('type', type)]);
    for (let d = 0; d < dots; d++) n.appendChild(this.mk('dot'));
    n.appendChild(this.mk('staff', v.staff || '1'));
    return { kind: 'note', els: [n], pre: [], dur };
  }
  setRestDuration(it, dur, st) {
    it.dur = dur;
    if (it.kind === 'forward') { if (it.el) this.setText(it.el, 'duration', String(dur)); return; }
    const el = it.els[0], { type, dots } = this.typeFor(dur, st);
    this.setText(el, 'duration', String(dur)); this.setText(el, 'type', type);
    for (const k of kids(el, 'dot')) k.remove();
    for (let d = 0; d < dots; d++) this.insertOrdered(el, this.mk('dot'));
  }
  /** Ton zum Akkord hinzufügen */
  addChordNote(noteEl, midi) {
    const loc = this.locate(noteEl); if (!loc) return null;
    const src = loc.group.els[0];
    if (kid(src, 'rest')) { this.setPitch(src, midi); return src; }
    if (loc.group.els.some(e => this.noteInfo(e).midi === midi)) return null;
    const n = src.cloneNode(true);
    for (const tag of ['tie', 'accidental', 'beam', 'notations', 'lyric', 'stem']) for (const k of kids(n, tag)) k.remove();
    if (!kid(n, 'chord')) this.insertOrdered(n, this.mk('chord'));
    const last = loc.group.els[loc.group.els.length - 1];
    last.after(n);
    this.setPitch(n, midi);
    return n;
  }
  /** Note entfernen: im Akkord nur diesen Ton, sonst → Pause */
  deleteNote(noteEl) {
    const loc = this.locate(noteEl); if (!loc) return null;
    if (loc.group.els.length > 1) {
      const idx = loc.group.els.indexOf(noteEl);
      noteEl.remove();
      if (idx === 0) { const nf = loc.group.els[1]; const c = kid(nf, 'chord'); if (c) c.remove(); return nf; }
      return loc.group.els[idx - 1];
    }
    return this.toRest(noteEl);
  }
  /** Note ganz herausnehmen – die folgenden rücken nach, am Ende wird mit Pause aufgefüllt */
  removeGroup(noteEl) {
    const loc = this.locate(noteEl); if (!loc) return null;
    const mi = this.measureIndexOf(noteEl), pi = this.partIndexOf(noteEl), st = this.stateAt(mi, pi);
    const { voice: v, index } = loc;
    const [it] = v.items.splice(index, 1);
    for (const e of it.els) e.remove();
    if (v.items[index]) v.items[index].pre.unshift(...it.pre); else loc.model.tail.unshift(...it.pre);
    this.fitVoice(loc.m, loc.model, v, index - 1, this.measureLength(mi, pi), st);
    this.prune(loc.model);
    this.write(loc.m, loc.model);
    if (!loc.model.voices.includes(v)) { const any = loc.model.voices.find(x => x.staff === v.staff) || loc.model.voices[0]; const it = any && any.items.find(x => x.kind === 'note'); return it ? it.els[0] : null; }
    const next = v.items[index] || v.items[index - 1];
    return next && next.els ? next.els[0] : null;
  }
  /** Kopie der Note dahinter einfügen (z. B. wenn eine Note übersehen wurde) */
  duplicateGroup(noteEl) {
    const loc = this.locate(noteEl); if (!loc) return null;
    const mi = this.measureIndexOf(noteEl), pi = this.partIndexOf(noteEl), st = this.stateAt(mi, pi);
    const copy = { kind: 'note', els: loc.group.els.map(e => { const c = e.cloneNode(true); for (const k of kids(c, 'tie')) k.remove(); const nt = kid(c, 'notations'); if (nt) nt.remove(); return c; }), pre: [], dur: loc.group.dur };
    loc.voice.items.splice(loc.index + 1, 0, copy);
    this.clearBeams(loc.voice);
    this.fitVoice(loc.m, loc.model, loc.voice, loc.index + 1, this.measureLength(mi, pi), st);
    this.write(loc.m, loc.model);
    return copy.els[0];
  }
  /** Haltebogen zur nächsten gleichen Note */
  toggleTie(noteEl) {
    const info = this.noteInfo(noteEl); if (info.rest) return false;
    const next = this.nextInVoice(noteEl, true);
    const target = next && next.els.find(e => this.noteInfo(e).midi === info.midi);
    const has = info.tie.includes('start');
    const setTie = (el, type, on) => {
      for (const t of kids(el, 'tie')) if (t.getAttribute('type') === type) t.remove();
      let nt = kid(el, 'notations');
      if (nt) for (const t of kids(nt, 'tied')) if (t.getAttribute('type') === type) t.remove();
      if (on) {
        this.insertOrdered(el, this.mk('tie', [], { type }));
        if (!nt) nt = this.insertOrdered(el, this.mk('notations'));
        nt.appendChild(this.mk('tied', [], { type }));
      }
      if (nt && !nt.children.length) nt.remove();
    };
    setTie(noteEl, 'start', !has);
    if (target) setTie(target, 'stop', !has);
    return !has;
  }
  /** nächste/vorige Notengruppe derselben Stimme (auch über Taktgrenzen) */
  nextInVoice(noteEl, forward = true) {
    const loc = this.locate(noteEl); if (!loc) return null;
    const step = forward ? 1 : -1;
    for (let i = loc.index + step; i >= 0 && i < loc.voice.items.length; i += step) if (loc.voice.items[i].kind === 'note') return loc.voice.items[i];
    const ms = this.measuresOf(this.partIndexOf(noteEl));
    let mi = ms.indexOf(loc.m) + step;
    while (mi >= 0 && mi < ms.length) {
      const model = this.parse(ms[mi]);
      const v = model.voices.find(x => x.key === loc.voice.key) || model.voices.find(x => x.staff === loc.voice.staff);
      if (v) { const items = v.items.filter(it => it.kind === 'note'); if (items.length) return forward ? items[0] : items[items.length - 1]; }
      mi += step;
    }
    return null;
  }

  // ------------------------------------------------------------ Takte
  newMeasureLike(mi, pi) {
    const st = this.stateAt(mi, pi);
    const len = this.measureLength(mi, pi);
    const src = this.measuresOf(pi)[mi];
    const model = src ? this.parse(src) : { voices: [] };
    const m = this.mk('measure', [], { number: '0' });
    const voices = model.voices.length ? model.voices : [{ key: '1', staff: '1' }];
    const byStaff = new Map();
    for (const v of voices) if (!byStaff.has(v.staff)) byStaff.set(v.staff, v);
    for (let s = 1; s <= st.staves; s++) if (!byStaff.has(String(s))) byStaff.set(String(s), { key: String(s === 1 ? 1 : 5), staff: String(s) });
    const nm = { head: [], tail: [], voices: [] };
    for (const v of byStaff.values()) {
      const r = this.mk('note', [this.mk('rest', [], { measure: 'yes' }), this.mk('duration', String(len)), this.mk('voice', v.key), this.mk('staff', v.staff)]);
      nm.voices.push({ key: v.key, staff: v.staff, items: [{ kind: 'note', els: [r], pre: [], dur: len }] });
    }
    this.write(m, nm);
    return m;
  }
  insertMeasure(mi, after = true) {
    this.parts.forEach((part, pi) => {
      const ms = this.measuresOf(pi);
      const nm = this.newMeasureLike(mi, pi);
      const ref = ms[mi];
      if (!ref) part.appendChild(nm); else if (after) ref.after(nm); else ref.before(nm);
      // Taktanfangs-Attribute bleiben am alten Takt; beim Einfügen davor wandern sie nach vorn
      if (!after && ref) { const a = [...ref.children].find(c => c.tagName === 'attributes' && this.isAtMeasureStart(c)); if (a) nm.prepend(a); const pr = kid(ref, 'print'); if (pr) nm.prepend(pr); }
    });
    this.renumber();
    return after ? mi + 1 : mi;
  }
  /** Zustand am Ende von Takt mi (inkl. Attributen mitten im Takt) */
  stateAfter(mi, pi = 0) {
    const st = this.stateAt(mi, pi);
    const m = this.measuresOf(pi)[mi];
    if (m) for (const a of m.getElementsByTagName('attributes')) if (!this.isAtMeasureStart(a)) this.applyAttributes(st, a);
    return st;
  }
  deleteMeasure(mi) {
    if (this.measures.length <= 1) return false;
    this.parts.forEach((part, pi) => {
      const ms = this.measuresOf(pi), m = ms[mi], next = ms[mi + 1];
      if (next) {
        // was ab dem gelöschten Takt galt (Tonart, Takt, Schlüssel), muss der nächste Takt übernehmen
        const after = this.stateAfter(mi, pi), prev = mi > 0 ? this.stateAfter(mi - 1, pi) : null;
        const a = this.headAttributes(next);
        if (!prev && !kid(a, 'divisions')) this.setAttrChild(a, this.mk('divisions', String(after.divisions)));
        if ((!prev || prev.fifths !== after.fifths) && !kid(a, 'key')) this.setAttrChild(a, this.mk('key', [this.mk('fifths', String(after.fifths))]));
        if ((!prev || prev.beats !== after.beats || prev.beatType !== after.beatType) && !kid(a, 'time')) this.setAttrChild(a, this.mk('time', [this.mk('beats', String(after.beats)), this.mk('beat-type', String(after.beatType))]));
        if (!prev && after.staves > 1 && !kid(a, 'staves')) this.setAttrChild(a, this.mk('staves', String(after.staves)));
        for (const [num, c] of Object.entries(after.clefs)) {
          const pc = prev && prev.clefs[num];
          const has = kids(a, 'clef').some(x => (x.getAttribute('number') || '1') === num);
          if (!has && (!pc || pc.sign !== c.sign || pc.line !== c.line)) {
            const el = this.mk('clef', [this.mk('sign', c.sign), this.mk('line', String(c.line))], { number: num });
            this.setAttrChild(a, el, num);
          }
        }
        // Kopf-Infos (Titel-Druckangaben, Tempo) nicht verlieren
        const pr = kid(m, 'print'); if (pr && mi === 0 && !kid(next, 'print')) next.prepend(pr);
      }
      m.remove();
    });
    this.renumber();
    return true;
  }
  renumber() {
    for (const part of this.parts) {
      let n = 1;
      kids(part, 'measure').forEach((m, i) => {
        if (i === 0 && m.getAttribute('implicit') === 'yes') m.setAttribute('number', '0');
        else m.setAttribute('number', String(n++));
      });
    }
  }
  /** Attribute am Taktanfang (für alle Stimmen der Partitur) holen/anlegen */
  headAttributes(m) {
    let a = [...m.children].find(c => c.tagName === 'attributes' && this.isAtMeasureStart(c));
    if (!a) { a = this.mk('attributes'); const pr = kid(m, 'print'); pr ? pr.after(a) : m.prepend(a); }
    return a;
  }
  setAttrChild(a, el, numberAttr) {
    const ORDER = ['footnote', 'level', 'divisions', 'key', 'time', 'staves', 'part-symbol', 'instruments', 'clef', 'staff-details', 'transpose', 'directive', 'measure-style'];
    for (const old of kids(a, el.tagName)) if (!numberAttr || (old.getAttribute('number') || '1') === numberAttr) old.remove();
    const idx = ORDER.indexOf(el.tagName);
    const after = [...a.children].find(c => ORDER.indexOf(c.tagName) > idx);
    a.insertBefore(el, after || null);
  }
  setTime(mi, beats, beatType) {
    this.parts.forEach((p, pi) => {
      const m = this.measuresOf(pi)[mi];
      this.setAttrChild(this.headAttributes(m), this.mk('time', [this.mk('beats', String(beats)), this.mk('beat-type', String(beatType))]));
    });
  }
  setKey(mi, fifths, { respell = true } = {}) {
    this.parts.forEach((p, pi) => {
      const ms = this.measuresOf(pi);
      const old = this.stateAt(mi, pi).fifths;
      this.setAttrChild(this.headAttributes(ms[mi]), this.mk('key', [this.mk('fifths', String(fifths))]));
      // Tonhöhen wie geschrieben an die neue Tonart anpassen (Erkennungsfehler: Tonart falsch gelesen)
      if (respell && old !== fifths) {
        const oldA = keyAlters(old), newA = keyAlters(fifths);
        for (let i = mi; i < ms.length; i++) {
          if (i > mi && [...ms[i].getElementsByTagName('key')].length) break;
          for (const n of ms[i].getElementsByTagName('note')) {
            const pch = kid(n, 'pitch'); if (!pch || kid(n, 'accidental')) continue;
            const step = txt(pch, 'step'), alter = +txt(pch, 'alter', 0);
            if (alter === (oldA[step] || 0) && alter !== (newA[step] || 0)) {
              const al = kid(pch, 'alter');
              if (newA[step]) { if (al) al.textContent = String(newA[step]); else pch.insertBefore(this.mk('alter', [String(newA[step])]), kid(pch, 'octave')); }
              else if (al) al.remove();
            }
          }
        }
      }
    });
  }
  /**
   * Schlüssel setzen – am Taktanfang oder vor einer Note.
   * keepPosition: Noten behalten ihren Platz im System (Tonhöhen werden umgerechnet) – das behebt
   * die typischen Erkennungsfehler, bei denen ein Schlüsselwechsel übersehen wurde.
   */
  setClef(noteEl, staff, sign, line, keepPosition = true) {
    const m = noteEl.closest('measure'), pi = this.partIndexOf(m), ms = this.measuresOf(pi), mi = ms.indexOf(m);
    const before = this.clefBefore(noteEl, staff);
    const loc = this.locate(noteEl);
    const atStart = !loc || loc.voice.items.slice(0, loc.index).every(it => it.kind === 'forward' || !it.dur);
    const clef = this.mk('clef', [this.mk('sign', sign), this.mk('line', String(line))], { number: staff });
    let anchor;
    if (atStart) { anchor = this.headAttributes(m); this.setAttrChild(anchor, clef, staff); }
    else { anchor = this.mk('attributes', [clef]); m.insertBefore(anchor, loc.group.els[0]); }
    if (!keepPosition || !before || (before.sign === sign && before.line === line)) return;
    const shift = this.clefShift(before, { sign, line });
    // alle Elemente ab dem Anker in Dokumentreihenfolge, bis zum nächsten Schlüssel dieses Systems
    const flat = [];
    for (let i = mi; i < ms.length; i++) for (const el of ms[i].children) flat.push([i, el]);
    let k = flat.findIndex(([, el]) => el === anchor);
    if (atStart) k = flat.findIndex(([i]) => i === mi);
    for (let j = k; j < flat.length; j++) {
      const [i, el] = flat[j];
      if (el !== anchor && el.tagName === 'attributes' && kids(el, 'clef').some(c => (c.getAttribute('number') || '1') === staff)) break;
      if (el.tagName === 'note' && txt(el, 'staff', '1') === staff && kid(el, 'pitch')) this.shiftNote(el, shift, this.stateAt(i, pi).fifths);
      if (el.tagName === 'note' && txt(el, 'staff', '1') === staff && kid(el, 'rest')) this.resetRestPosition(el);
    }
  }
  /** feste Pausen-Position (vom alten Schlüssel) entfernen – die Darstellung setzt sie neu */
  resetRestPosition(n) { const r = kid(n, 'rest'); if (r) for (const k of [...r.children]) if (k.tagName === 'display-step' || k.tagName === 'display-octave') k.remove(); }
  clefBefore(noteEl, staff) {
    const m = noteEl.closest('measure'), pi = this.partIndexOf(m), mi = this.measuresOf(pi).indexOf(m);
    const st = this.stateAt(mi, pi);
    let c = st.clefs[staff] || (staff === '1' ? { sign: 'G', line: 2 } : { sign: 'F', line: 4 });
    for (const el of [...m.children]) {
      if (el === noteEl || (el.tagName === 'note' && this.locate(noteEl)?.group.els.includes(el))) break;
      if (el.tagName === 'attributes' && !this.isAtMeasureStart(el)) for (const cl of kids(el, 'clef')) if ((cl.getAttribute('number') || '1') === staff) c = { sign: txt(cl, 'sign'), line: +txt(cl, 'line') };
    }
    return c;
  }
  /** diatonischer Abstand zwischen zwei Schlüsseln (gleiche Linie im System) */
  clefShift(a, b) {
    // Bezugston auf der Mittellinie: Violin (G2) = H4 → Index, Bass (F4) = D3, Alt (C3) = C4, Tenor (C4) = A3
    const mid = c => {
      const ref = { G: ['G', 4], F: ['F', 3], C: ['C', 4] }[c.sign] || ['G', 4];
      const refIdx = STEPS.indexOf(ref[0]) + ref[1] * 7;       // Ton auf der Schlüssellinie
      return refIdx + (3 - (c.line || 2)) * 2;                 // Mittellinie = Linie 3
    };
    return mid(b) - mid(a);
  }
  shiftNote(n, steps, fifths) {
    const p = kid(n, 'pitch'); if (!p) return;
    const step = txt(p, 'step'), octave = +txt(p, 'octave');
    const hasAcc = !!kid(n, 'accidental');
    const oldAlter = +txt(p, 'alter', 0);
    // Vorzeichen gehören zur Position im System: ausdrücklich gesetzte oder im Takt fortgeltende behalten
    const keep = hasAcc || oldAlter !== (keyAlters(fifths)[step] || 0);
    let idx = STEPS.indexOf(step) + octave * 7 + steps;
    const ns = STEPS[((idx % 7) + 7) % 7], no = Math.floor(idx / 7);
    const alter = keep ? oldAlter : (keyAlters(fifths)[ns] || 0);
    while (p.firstChild) p.removeChild(p.firstChild);
    p.appendChild(this.mk('step', [ns]));
    if (alter) p.appendChild(this.mk('alter', [String(alter)]));
    p.appendChild(this.mk('octave', [String(no)]));
  }

  // ------------------------------------------------------------ Wiederholungen & Sprünge
  barline(m, location) {
    let b = kids(m, 'barline').find(x => (x.getAttribute('location') || 'right') === location);
    if (!b) {
      b = this.mk('barline', [], { location });
      if (location === 'left') { const a = [...m.children].find(c => c.tagName !== 'print' && c.tagName !== 'attributes'); m.insertBefore(b, a || null); } else m.appendChild(b);
    }
    return b;
  }
  cleanBarline(b) { if (!b.children.length) b.remove(); }
  setRepeat(mi, which, on) {
    this.parts.forEach((p, pi) => {
      const m = this.measuresOf(pi)[mi];
      const loc = which === 'start' ? 'left' : 'right';
      const b = this.barline(m, loc);
      for (const r of kids(b, 'repeat')) r.remove();
      for (const s of kids(b, 'bar-style')) s.remove();
      if (on) {
        b.insertBefore(this.mk('bar-style', [which === 'start' ? 'heavy-light' : 'light-heavy']), b.firstChild);
        b.appendChild(this.mk('repeat', [], { direction: which === 'start' ? 'forward' : 'backward' }));
      }
      this.cleanBarline(b);
    });
  }
  hasRepeat(mi, which) {
    const m = this.measures[mi];
    return kids(m, 'barline').some(b => kids(b, 'repeat').some(r => r.getAttribute('direction') === (which === 'start' ? 'forward' : 'backward')));
  }
  /** Volte (1., 2. …) über die Takte from..to; number = null entfernt */
  setEnding(from, to, number) {
    this.parts.forEach((p, pi) => {
      const ms = this.measuresOf(pi);
      for (let i = from; i <= to; i++) for (const b of kids(ms[i], 'barline')) { for (const e of kids(b, 'ending')) e.remove(); this.cleanBarline(b); }
      if (number == null) return;
      const s = this.barline(ms[from], 'left');
      s.appendChild(this.mk('ending', [String(number) + '.'], { number: String(number), type: 'start' }));
      const e = this.barline(ms[to], 'right');
      const isLast = number >= 2 && !this.hasRepeat(to, 'end');
      e.appendChild(this.mk('ending', [], { number: String(number), type: isLast ? 'discontinue' : 'stop' }));
      // Reihenfolge im barline: bar-style, …, ending, repeat
      for (const b of [s, e]) { const r = kid(b, 'repeat'); if (r) b.appendChild(r); }
    });
  }
  endingAt(mi) {
    for (const b of kids(this.measures[mi], 'barline')) for (const e of kids(b, 'ending')) return +e.getAttribute('number');
    return null;
  }
  /** Sprungzeichen: segno, coda (Zielmarken am Taktanfang), tocoda, dalsegno, dacapo, fine (am Taktende) */
  setJump(mi, kind, on) {
    const m = this.measures[mi];
    // vorhandene gleichartige Marke in diesem Takt entfernen
    for (const d of [...m.getElementsByTagName('direction')]) if (d.dataset_kind === kind || d.getAttribute('tonika-jump') === kind) d.remove();
    for (const d of [...m.getElementsByTagName('direction')]) {
      const snd = kid(d, 'sound');
      const isKind = { segno: () => d.getElementsByTagName('segno').length && !snd?.getAttribute('dalsegno'), coda: () => d.getElementsByTagName('coda').length && !snd?.getAttribute('tocoda'),
        tocoda: () => snd?.getAttribute('tocoda'), dalsegno: () => snd?.getAttribute('dalsegno'), dacapo: () => snd?.getAttribute('dacapo'), fine: () => snd?.getAttribute('fine') }[kind];
      if (isKind && isKind()) d.remove();
    }
    if (!on) { this.rebuild(m); return; }
    const words = t => this.mk('direction-type', [this.mk('words', [t])]);
    let d;
    switch (kind) {
      case 'segno': d = this.mk('direction', [this.mk('direction-type', [this.mk('segno')]), this.mk('sound', [], { segno: 'segno' })], { placement: 'above' }); break;
      case 'coda': d = this.mk('direction', [this.mk('direction-type', [this.mk('coda')]), this.mk('sound', [], { coda: 'coda' })], { placement: 'above' }); break;
      case 'tocoda': d = this.mk('direction', [words('To Coda'), this.mk('sound', [], { tocoda: 'coda' })], { placement: 'above' }); break;
      case 'dalsegno': d = this.mk('direction', [words('D.S. al Coda'), this.mk('sound', [], { dalsegno: 'segno' })], { placement: 'above' }); break;
      case 'dacapo': d = this.mk('direction', [words('D.C.'), this.mk('sound', [], { dacapo: 'yes' })], { placement: 'above' }); break;
      case 'fine': d = this.mk('direction', [words('Fine'), this.mk('sound', [], { fine: 'yes' })], { placement: 'above' }); break;
    }
    d.setAttribute('tonika-jump', kind);
    const start = kind === 'segno' || kind === 'coda';
    const model = this.parse(m);
    const v = model.voices[0];
    if (start && v && v.items[0]) v.items[0].pre.unshift(d);
    else model.tail.unshift(d);
    this.write(m, model);
  }
  hasJump(mi, kind) {
    const m = this.measures[mi];
    return [...m.getElementsByTagName('direction')].some(d => {
      const snd = kid(d, 'sound');
      return { segno: () => d.getElementsByTagName('segno').length > 0, coda: () => d.getElementsByTagName('coda').length > 0 && !snd?.getAttribute('tocoda'),
        tocoda: () => !!snd?.getAttribute('tocoda') || /to\s*coda/i.test(d.textContent), dalsegno: () => !!snd?.getAttribute('dalsegno') || /d\.\s*s\./i.test(d.textContent),
        dacapo: () => !!snd?.getAttribute('dacapo') || /d\.\s*c\./i.test(d.textContent), fine: () => !!snd?.getAttribute('fine') || /^\s*fine\s*$/i.test(d.textContent) }[kind]();
    });
  }
  setBarStyle(mi, style) {
    this.parts.forEach((p, pi) => {
      const m = this.measuresOf(pi)[mi];
      const b = this.barline(m, 'right');
      for (const s of kids(b, 'bar-style')) s.remove();
      if (style) b.insertBefore(this.mk('bar-style', [style]), b.firstChild);
      this.cleanBarline(b);
    });
  }

  // ------------------------------------------------------------ Takte kopieren
  /** Inhalt eines Takts als Vorlage (ohne Taktstrich-Zeichen, Sprünge, Seitenumbrüche, Taktanfangs-Attribute) */
  measureTemplate(mi, pi = 0) {
    const c = this.measuresOf(pi)[mi].cloneNode(true);
    for (const el of [...c.children]) {
      if (el.tagName === 'print' || el.tagName === 'barline') el.remove();
      else if (el.tagName === 'attributes' && this.isAtMeasureStart(el)) el.remove();
      else if (el.tagName === 'direction' && (el.getAttribute('tonika-jump') || el.getElementsByTagName('segno').length || el.getElementsByTagName('coda').length || [...el.getElementsByTagName('sound')].some(s => s.getAttribute('dalsegno') || s.getAttribute('dacapo') || s.getAttribute('tocoda') || s.getAttribute('fine')))) el.remove();
    }
    return c;
  }
  duplicateMeasure(mi) {
    this.parts.forEach((p, pi) => { const t = this.measureTemplate(mi, pi); this.measuresOf(pi)[mi].after(t); });
    this.renumber();
    return mi + 1;
  }
  /** Noten eines Takts in einen anderen übernehmen (Taktstriche/Attribute des Ziels bleiben) */
  pasteMeasure(fromXml, mi) {
    const src = new DOMParser().parseFromString(fromXml, 'application/xml').documentElement;
    this.parts.forEach((p, pi) => {
      const parts = [...src.children];
      const sm = parts[pi]; if (!sm) return;
      const target = this.measuresOf(pi)[mi];
      const keep = [...target.children].filter(el => el.tagName === 'print' || el.tagName === 'barline' || (el.tagName === 'attributes' && this.isAtMeasureStart(el)));
      while (target.firstChild) target.removeChild(target.firstChild);
      for (const k of keep.filter(e => e.tagName !== 'barline' || (e.getAttribute('location') === 'left'))) target.appendChild(k);
      for (const el of [...sm.children]) target.appendChild(this.doc.importNode(el, true));
      for (const k of keep.filter(e => e.tagName === 'barline' && e.getAttribute('location') !== 'left')) target.appendChild(k);
      this.rebuild(target);
    });
  }
  copyMeasureXml(mi) {
    const wrap = this.doc.implementation.createDocument(null, 'clip', null);
    this.parts.forEach((p, pi) => wrap.documentElement.appendChild(wrap.importNode(this.measureTemplate(mi, pi), true)));
    return new XMLSerializer().serializeToString(wrap);
  }

  // ------------------------------------------------------------ Bezeichnungen (Dynamik, Text, Verzierungen)
  directionLabel(d) {
    const parts = [];
    for (const dt of d.getElementsByTagName('direction-type')) for (const c of dt.children) {
      if (c.tagName === 'dynamics') parts.push([...c.children].map(x => x.tagName === 'other-dynamics' ? x.textContent : x.tagName).join(''));
      else if (c.tagName === 'words') parts.push('„' + c.textContent.trim() + '“');
      else if (c.tagName === 'wedge') parts.push(c.getAttribute('type') === 'crescendo' ? '< cresc.-Gabel' : c.getAttribute('type') === 'diminuendo' ? '> dim.-Gabel' : 'Gabel-Ende');
      else if (c.tagName === 'metronome') parts.push('♩ = ' + (c.getElementsByTagName('per-minute')[0]?.textContent || ''));
      else if (c.tagName === 'pedal') parts.push('Pedal ' + (c.getAttribute('type') || ''));
      else if (c.tagName === 'segno' || c.tagName === 'coda') parts.push(c.tagName === 'segno' ? 'Segno' : 'Coda');
      else if (c.tagName === 'octave-shift') parts.push('8va');
      else parts.push(c.tagName);
    }
    return parts.join(' ') || 'Bezeichnung';
  }
  directions(mi) {
    const m = this.measures[mi];
    return [...m.getElementsByTagName('direction')].map(d => ({ el: d, label: this.directionLabel(d), staff: txt(d, 'staff', '1'), placement: d.getAttribute('placement') || '' }));
  }
  removeEl(el) { const m = el.closest('measure'); el.remove(); if (m) this.rebuild(m); }
  setWords(d, text) { const w = d.getElementsByTagName('words')[0]; if (w) w.textContent = text; }
  /** Dynamik (p, mf, sf …) oder Text vor der gewählten Note (bzw. am Taktanfang) einfügen */
  addDirection(mi, noteEl, { dynamic, words, wedge }, { placement = 'below', staff = '1' } = {}) {
    const m = this.measures[mi];
    const dt = this.mk('direction-type');
    if (dynamic) { const dyn = this.mk('dynamics'); dyn.appendChild(/^(p|pp|ppp|pppp|f|ff|fff|ffff|mp|mf|sf|sfz|sffz|fp|rf|rfz|fz|sfp|sfpp)$/.test(dynamic) ? this.mk(dynamic) : this.mk('other-dynamics', dynamic)); dt.appendChild(dyn); }
    else if (wedge) dt.appendChild(this.mk('wedge', [], { type: wedge }));
    else dt.appendChild(this.mk('words', words, words && /^(cresc|dim|dolce|rit|riten|rall|a tempo|poco|espr|legato|leggiero|sempre)/i.test(words) ? { 'font-style': 'italic' } : {}));
    const d = this.mk('direction', [dt, this.mk('staff', staff)], { placement });
    if (dynamic) { const v = { pppp: 10, ppp: 20, pp: 36, p: 54, mp: 69, mf: 83, f: 98, ff: 112, fff: 126, sf: 110, sfz: 112, fp: 98 }[dynamic]; if (v) d.appendChild(this.mk('sound', [], { dynamics: String(v) })); }
    const model = this.parse(m);
    let placed = false;
    if (noteEl) for (const v of model.voices) for (const it of v.items) if (it.kind === 'note' && it.els.includes(noteEl)) { it.pre.push(d); placed = true; }
    if (!placed) { const v = model.voices.find(x => x.staff === staff) || model.voices[0]; if (v && v.items[0]) v.items[0].pre.push(d); else model.tail.unshift(d); }
    this.write(m, model);
    return d;
  }
  /** Verzierungen (Triller, Pralltriller …) und Fingersätze einer Note entfernen */
  clearOrnaments(noteEl) {
    const loc = this.locate(noteEl);
    const els = loc ? loc.group.els : [noteEl];
    let n = 0;
    for (const el of els) for (const nt of kids(el, 'notations')) {
      for (const k of [...nt.children]) if (['ornaments', 'technical', 'articulations', 'fermata', 'arpeggiate', 'non-arpeggiate'].includes(k.tagName)) { k.remove(); n++; }
      if (!nt.children.length) nt.remove();
    }
    return n;
  }
  hasOrnaments(noteEl) {
    const loc = this.locate(noteEl);
    return (loc ? loc.group.els : [noteEl]).some(el => kids(el, 'notations').some(nt => [...nt.children].some(k => ['ornaments', 'technical', 'articulations', 'fermata'].includes(k.tagName))));
  }

  // ------------------------------------------------------------ Kopfdaten
  get title() { return txt(this.root, 'movement-title') || this.root.querySelector('work > work-title')?.textContent || ''; }
  set title(v) {
    let mt = kid(this.root, 'movement-title');
    if (!mt) { mt = this.mk('movement-title'); const w = kid(this.root, 'work'); w ? w.after(mt) : this.root.prepend(mt); }
    mt.textContent = v;
    const wt = this.root.querySelector('work > work-title'); if (wt) wt.textContent = v;
  }
  get composer() { return this.root.querySelector('identification > creator[type="composer"]')?.textContent || ''; }
  set composer(v) {
    let id = kid(this.root, 'identification');
    if (!id) { id = this.mk('identification'); const after = kid(this.root, 'movement-title') || kid(this.root, 'work'); after ? after.after(id) : this.root.prepend(id); }
    let c = id.querySelector('creator[type="composer"]');
    if (!c) { c = this.mk('creator', [], { type: 'composer' }); id.prepend(c); }
    c.textContent = v;
  }
  get tempo() {
    for (const s of this.root.getElementsByTagName('sound')) if (s.getAttribute('tempo')) return +s.getAttribute('tempo');
    return null;
  }
  set tempo(bpm) {
    for (const d of this.root.getElementsByTagName('direction')) {
      const mt = d.getElementsByTagName('metronome')[0];
      if (mt) {
        const pm = mt.getElementsByTagName('per-minute')[0]; if (pm) pm.textContent = String(bpm);
        let s = kid(d, 'sound'); if (!s) { s = this.mk('sound'); d.appendChild(s); }
        s.setAttribute('tempo', String(bpm)); return;
      }
    }
    const m = this.measures[0];
    const d = this.mk('direction', [this.mk('direction-type', [this.mk('metronome', [this.mk('beat-unit', ['quarter']), this.mk('per-minute', [String(bpm)])])]), this.mk('sound', [], { tempo: String(bpm) })], { placement: 'above' });
    const model = this.parse(m);
    if (model.voices[0] && model.voices[0].items[0]) model.voices[0].items[0].pre.unshift(d); else model.tail.unshift(d);
    this.write(m, model);
  }
  /** Seite (0-basiert) je Takt aus <print new-page> – für den Vergleich mit dem Original */
  pageOfMeasure(mi) {
    let page = 0;
    const ms = this.measures;
    for (let i = 1; i <= mi && i < ms.length; i++) if (ms[i].querySelector('print[new-page="yes"]')) page++;
    return page;
  }
}
