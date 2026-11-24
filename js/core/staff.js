// Notensatz mit VexFlow: einzelne Noten, Akkorde, Tonleitern – skalierbar per viewBox
import { LETTERS, signatureMap, vexKeyFromSig } from './music.js';

export const INK = '#1d2433';
export const COLORS = { ink: INK, ok: '#16a34a', bad: '#dc2626', hint: '#d97706', accent: '#4f46e5', muted: '#9aa1b1' };

const ACC = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': '##' };

/**
 * el: Container
 * opts.clef: 'treble' | 'bass' | 'grand'
 * opts.keySig: Vorzeichenzahl (+♯ / −♭) oder null
 * opts.notes: [{ keys: [{s, octave}], dur: 'w'|'h'|'q', color, cls, clef }]
 */
export function drawStaff(el, { clef = 'treble', keySig = null, notes = [], width, minWidth = 300, maxHeight } = {}) {
  el.innerHTML = '';
  if (!window.Vex) { el.innerHTML = '<div class="staff-error">Notensatz konnte nicht geladen werden (Internet?)</div>'; return {}; }
  const VF = Vex.Flow;
  const grand = clef === 'grand';
  const sigW = keySig ? Math.abs(keySig) * 11 + 10 : 0;
  const W = width || Math.max(minWidth, 90 + sigW + notes.length * 46);
  const H = grand ? 250 : 160;
  const renderer = new VF.Renderer(el, VF.Renderer.Backends.SVG);
  renderer.resize(W, H);
  const ctx = renderer.getContext();
  ctx.setFillStyle(INK); ctx.setStrokeStyle(INK);
  const staves = {};
  const mk = (c, y) => {
    const st = new VF.Stave(grand ? 30 : 10, y, W - (grand ? 40 : 20)).addClef(c);
    if (keySig) st.addKeySignature(vexKeyFromSig(keySig));
    st.setContext(ctx).draw();
    return st;
  };
  if (grand) {
    staves.treble = mk('treble', 0); staves.bass = mk('bass', 110);
    for (const t of ['brace', 'singleLeft', 'singleRight']) new VF.StaveConnector(staves.treble, staves.bass).setType(t).setContext(ctx).draw();
  } else staves[clef] = mk(clef, 0);

  // Vorzeichen nach Tonart & Taktregel bestimmen
  const sigMap = keySig ? signatureMap(keySig) : {};
  const state = {};
  const vfNotes = [];
  const byClef = {};
  for (const n of notes) {
    const nClef = grand ? (n.clef || 'treble') : clef;
    const keys = n.keys.map(k => LETTERS[k.s.l].toLowerCase() + '/' + k.octave);
    const note = new VF.StaveNote({ clef: nClef, keys, duration: n.dur || 'w', auto_stem: true });
    n.keys.forEach((k, i) => {
      const id = k.s.l + ':' + k.octave;
      const cur = id in state ? state[id] : (sigMap[k.s.l] || 0);
      if (k.s.a !== cur || k.forceAcc) {
        const sym = k.s.a === 0 ? 'n' : ACC[k.s.a];
        const acc = new VF.Accidental(sym);
        if (n.color) acc.setStyle({ fillStyle: n.color, strokeStyle: n.color });
        note.addModifier(acc, i);
        state[id] = k.s.a;
      }
    });
    if (n.color) {
      note.setStyle({ fillStyle: n.color, strokeStyle: n.color });
      note.setLedgerLineStyle({ strokeStyle: n.color, lineWidth: 1.4 });
    }
    note._meta = n;
    (byClef[nClef] ||= []).push(note);
    vfNotes.push(note);
  }
  for (const [c, list] of Object.entries(byClef)) {
    VF.Formatter.FormatAndDraw(ctx, staves[c], list, { auto_beam: false });
  }
  const svg = el.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.style.width = '100%'; svg.style.height = 'auto';
  if (maxHeight) svg.style.maxHeight = maxHeight;
  svg.classList.add('staff-svg');
  for (const note of vfNotes) {
    const g = note.getSVGElement?.() || null;
    if (g && note._meta.cls) g.classList.add(...note._meta.cls.split(' '));
    note._el = g;
  }
  return { svg, vfNotes, width: W, height: H };
}
