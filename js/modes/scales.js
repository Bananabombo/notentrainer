// Modus: Tonleitern – auf Basis des Quintenzirkels, Ton für Ton geführt
import { h, icon, burst, toast, segmented, toggle, field, setNum } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { drawStaff, COLORS } from '../core/staff.js';
import { SCALES, ROOTS, CIRCLE, transpose, pcOf, midiOf, noteName, majorSignature, keyLabel, pc } from '../core/music.js';
import { persisted, bumpProgress } from '../core/store.js';
import { record } from '../core/stats.js';

const GROUPS = [
  ['Grundlagen', ['major', 'minor', 'harmonic', 'melodic']],
  ['Kirchentonarten', ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']],
  ['Pentatonik & Blues', ['pentMajor', 'pentMinor', 'blues']],
  ['Jazz', ['phrygDom', 'lydDom', 'altered']]
];
const CIRCLE_ORDER = CIRCLE.map(k => k.major);

export default {
  mount(root, ctx) {
    const q = ctx.route.query;
    const set = persisted('scales.settings', { l: 0, a: 0, type: 'major', dir: 'updown', octaves: 1, hint: true });
    if (q.l != null) { set.l = +q.l; set.a = +q.a || 0; }
    if (q.t) set.type = q.t;

    let seq = [], step = 0, base = null, errors = 0, t0 = 0, done = false, timers = [];
    const tonic = () => ({ l: set.l, a: set.a });

    const title = h('div', { style: { fontFamily: 'var(--serif)', fontSize: '30px', letterSpacing: '-.01em' } });
    const sub = h('div', { style: { color: 'var(--muted)', fontSize: '14px' } });
    const staffEl = h('div.staff', { style: { maxWidth: '100%' } });
    const paper = h('div.paper', staffEl);
    const dots = h('div.progress-dots');
    const msg = h('div.msg.muted');
    const kb = new Keyboard({ from: 36, to: 84 });
    const keyChips = h('div.key-chips');
    const typeSel = h('select', { onchange: () => { set.type = typeSel.value; build(); } },
      GROUPS.map(([g, list]) => h('optgroup', { label: g }, list.map(t => h('option', { value: t }, SCALES[t].name)))));
    typeSel.value = set.type;

    root.append(
      h('section.stage',
        h('div.row', keyChips),
        h('div.row', typeSel,
          segmented([['up', 'Aufwärts'], ['updown', 'Auf & ab']], set.dir, v => { set.dir = v; build(); }),
          segmented([['1', '1 Oktave'], ['2', '2 Oktaven']], String(set.octaves), v => { set.octaves = +v; build(); }))),
      h('section.stage.grow',
        h('div.row', h('div', title, sub), h('span.spacer'),
          h('button.btn.ghost', { onclick: listen }, icon('play'), 'Anhören'),
          h('button.btn', { onclick: build }, 'Neu starten'),
          h('button.btn.primary', { onclick: nextKey }, 'Nächste Tonart', icon('skip'))),
        paper, dots, h('div.feedback', msg), kb.el));

    ctx.setSettings(() => [
      toggle('Nächste Taste auf der Klaviatur zeigen', set.hint, v => { set.hint = v; mark(); }),
      h('div.field-hint', 'Starte in einer beliebigen Oktave mit dem Grundton. Melodisch Moll wird abwärts wie natürliches Moll gespielt.')
    ]);

    function renderChips() {
      keyChips.innerHTML = '';
      for (const r of CIRCLE_ORDER.concat([{ l: 4, a: -1 }])) {
        if (r.l === 4 && r.a === -1 && set.type !== 'major') continue;
        const active = r.l === set.l && r.a === set.a;
        keyChips.append(h('button' + (active ? '.active' : ''), { onclick: () => { set.l = r.l; set.a = r.a; build(); } }, noteName(r)));
      }
    }
    function build() {
      timers.forEach(clearTimeout); timers = [];
      renderChips();
      const ton = tonic(), def = SCALES[set.type];
      const one = (type, dirUp) => {
        const d = SCALES[type];
        const out = [];
        for (let o = 0; o < set.octaves; o++) for (const iv of d.iv) {
          const s = transpose(ton, iv);
          out.push({ s, rel: iv[0] + 12 * o, octOff: o + Math.floor((ton.l + iv[1]) / 7) });
        }
        out.push({ s: ton, rel: 12 * set.octaves, octOff: set.octaves });
        return dirUp ? out : out.slice().reverse();
      };
      seq = one(set.type, true);
      if (set.dir === 'updown') seq = seq.concat(one(set.type === 'melodic' ? 'minor' : set.type, false).slice(1));
      step = 0; base = null; errors = 0; done = false; t0 = 0;
      const startOct = set.octaves === 2 ? (ton.l <= 1 ? 4 : 3) : 4;
      seq.forEach(n => { n.octave = startOct + n.octOff; });
      const parent = def.parent ? transpose(ton, def.parent) : null;
      let sig = parent ? majorSignature(parent) : 0;
      if (Math.abs(sig) > 7) sig = 0;
      seq.sig = sig;
      title.textContent = noteName(ton) + ' ' + def.name;
      sub.textContent = parent && sig ? `Vorzeichen wie ${keyLabel(parent)} (${Math.abs(sig)}${sig > 0 ? '♯' : '♭'})` : parent ? 'Keine Vorzeichen' : 'Mit Versetzungszeichen';
      dots.innerHTML = '';
      seq.forEach(() => dots.append(h('span')));
      // Klaviatur passend
      const startMidi = midiOf(ton, startOct);
      kb.setRange(Math.min(startMidi - 12, 48), Math.max(startMidi + 12 * set.octaves + 12, 84));
      setMsg('Spiel den Grundton ' + noteName(ton) + ' – in beliebiger Oktave.', 'muted');
      render(true);
      mark();
    }
    function render(animate) {
      const notes = seq.map((n, i) => ({
        keys: [{ s: n.s, octave: n.octave }],
        color: i < step ? COLORS.ok : i === step && !done ? COLORS.accent : COLORS.ink,
        cls: animate ? 'enter' : i === step - 1 ? 'pulse' : ''
      }));
      const r = drawStaff(staffEl, { clef: 'treble', keySig: seq.sig, notes, maxHeight: '26vh' });
      if (animate && r.vfNotes) r.vfNotes.forEach((n, i) => { if (n._el) n._el.style.animationDelay = i * 25 + 'ms'; });
      [...dots.children].forEach((d, i) => d.className = i < step ? 'done' : i === step && !done ? 'cur' : '');
    }
    function mark() {
      kb.clear(); kb.clearLabels();
      const pcs = new Set(seq.map(n => pcOf(n.s)));
      for (let m = kb.from; m <= kb.to; m++) if (pcs.has(pc(m))) kb.mark(m, 'scale');
      if (!set.hint || done) return;
      const n = seq[step];
      if (base == null) {
        for (let m = kb.from; m <= kb.to; m++) if (pc(m) === pcOf(n.s)) { kb.mark(m, 'target'); kb.label(m, '1'); }
      } else { kb.mark(base + n.rel, 'target'); kb.label(base + n.rel, noteName(n.s)); }
    }
    function setMsg(t, cls) { msg.textContent = t; msg.className = 'msg ' + cls + (cls !== 'muted' ? ' pop' : ''); }
    function listen() {
      const ton = tonic(), startMidi = base ?? midiOf(ton, 4);
      audio.playNotes(seq.map(n => startMidi + n.rel), { dur: 0.3, vel: 0.62, arpeggio: 0.28 });
    }
    function nextKey() {
      const i = CIRCLE_ORDER.findIndex(r => r.l === set.l && r.a === set.a);
      const n = CIRCLE_ORDER[(i + 1) % 12];
      set.l = n.l; set.a = n.a; build();
    }

    function onNote({ midi, src }) {
      if (done || !seq.length) return;
      const n = seq[step];
      if (base == null) {
        if (pc(midi) === pcOf(n.s)) { base = midi - n.rel; t0 = performance.now(); }
        else { kb.flash(midi, 'bad', 500); setMsg('Beginne mit dem Grundton ' + noteName(n.s) + '.', 'bad'); return; }
      }
      const expected = base + n.rel;
      const ok = midi === expected || (src === 'mic' && Math.abs(midi - expected) === 12);
      if (!ok) {
        errors++;
        kb.flash(midi, 'bad', 600);
        paper.className = 'paper'; void paper.offsetWidth; paper.className = 'paper bad';
        setMsg(`Erwartet: ${noteName(n.s)}`, 'bad');
        timers.push(setTimeout(() => { paper.className = 'paper'; }, 450));
        return;
      }
      kb.flash(midi, 'ok', 350);
      step++;
      if (step >= seq.length) return finish();
      setMsg(`${step} / ${seq.length}`, 'muted');
      render(false); mark();
    }
    function finish() {
      done = true;
      const secs = (performance.now() - t0) / 1000;
      render(false); mark();
      paper.className = 'paper ok';
      burst(paper, { count: 28, spread: 160 });
      const clean = errors === 0;
      bumpProgress('scales', { correct: clean ? 1 : 0, total: 1 });
      record('scales', `${set.l}:${set.a}:${set.type}`, { ok: clean, ms: secs * 1000, xp: (clean ? 15 : 6) + seq.length, label: title.textContent });
      setMsg(clean ? `Fehlerfrei in ${secs.toFixed(1)} s! 🎉` : `Geschafft in ${secs.toFixed(1)} s · ${errors} Fehler`, 'ok');
      if (clean) toast('Sauber gespielt – weiter im Quintenzirkel?');
    }

    const off = input.on('noteon', onNote);
    build();
    return () => { off(); kb.destroy(); timers.forEach(clearTimeout); };
  }
};
