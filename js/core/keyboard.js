// Wiederverwendbare SVG-Klaviatur mit Markierungen, Beschriftungen und Touch-Eingabe
import { svgEl } from './ui.js';
import { input } from './input.js';
import { audio } from './audio.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = m => BLACK.has(((m % 12) + 12) % 12);

export class Keyboard {
  constructor({ from = 36, to = 84, playable = true, cNames = true } = {}) {
    this.el = document.createElement('div');
    this.el.className = 'kbd';
    this.svg = svgEl('svg', { class: 'kbd-svg', role: 'img', 'aria-label': 'Klaviatur' });
    this.el.appendChild(this.svg);
    this.marks = new Map();
    this.labels = new Map();
    this.playable = playable;
    this.cNames = cNames;
    this.setRange(from, to);
    if (playable) this.bindPointer();
    this.offs = [
      input.on('noteon', e => this.mark(e.midi, 'down')),
      input.on('noteoff', e => this.unmark(e.midi, 'down'))
    ];
    for (const m of input.heldNotes()) this.mark(m, 'down');
  }
  destroy() { this.offs.forEach(f => f()); this.el.remove(); }

  setRange(from, to) {
    while (isBlack(from)) from--;
    while (isBlack(to)) to++;
    this.from = from; this.to = to;
    this.render();
  }
  /** Bereich so wählen, dass alle Töne passen (mind. zwei Oktaven) */
  fit(midis, minSpan = 24) {
    if (!midis.length) return;
    let lo = Math.min(...midis), hi = Math.max(...midis);
    while (hi - lo < minSpan) { lo -= 1; hi += 1; }
    lo = Math.floor((lo - 2) / 12) * 12; hi = Math.ceil((hi + 2) / 12) * 12;
    if (lo !== this.from || hi !== this.to) this.setRange(lo, hi);
  }

  render() {
    const WW = 24, WH = 120, BW = 14, BH = 76;
    this.svg.innerHTML = '';
    this.keys = {};
    const whites = svgEl('g'), blacks = svgEl('g'), texts = svgEl('g', { class: 'kbd-labels' });
    let x = 0;
    const blackPos = [];
    for (let m = this.from; m <= this.to; m++) {
      if (isBlack(m)) { blackPos.push([m, x - BW / 2]); continue; }
      const r = svgEl('rect', { x: x + 0.5, y: -4, width: WW - 1, height: WH + 4, rx: 4, class: 'w' });
      r.dataset.midi = m; whites.appendChild(r); this.keys[m] = { el: r, x: x + WW / 2, black: false };
      if (this.cNames && m % 12 === 0) {
        const t = svgEl('text', { x: x + WW / 2, y: WH - 8, class: 'kbd-c' });
        t.textContent = 'C' + (m / 12 - 1);
        texts.appendChild(t);
      }
      x += WW;
    }
    for (const [m, bx] of blackPos) {
      const r = svgEl('rect', { x: bx, y: -4, width: BW, height: BH + 4, rx: 3, class: 'b' });
      r.dataset.midi = m; blacks.appendChild(r); this.keys[m] = { el: r, x: bx + BW / 2, black: true };
    }
    this.labelLayer = svgEl('g', { class: 'kbd-labels' });
    this.svg.append(whites, blacks, texts, this.labelLayer);
    this.svg.setAttribute('viewBox', `0 0 ${x} ${WH}`);
    this.width = x;
    for (const m of this.marks.keys()) this.paint(m);
    for (const [m, l] of this.labels) this.drawLabel(m, l.text, l.cls);
  }

  paint(m) {
    const k = this.keys[m]; if (!k) return;
    const set = this.marks.get(m);
    k.el.setAttribute('class', (k.black ? 'b' : 'w') + (set && set.size ? ' ' + [...set].join(' ') : ''));
  }
  mark(m, cls) { if (!this.marks.has(m)) this.marks.set(m, new Set()); this.marks.get(m).add(cls); this.paint(m); }
  unmark(m, cls) { const s = this.marks.get(m); if (s) { s.delete(cls); this.paint(m); } }
  clear(cls) {
    for (const [m, s] of this.marks) { if (cls) s.delete(cls); else s.clear(); this.paint(m); }
    if (!cls) for (const m of input.heldNotes()) this.mark(m, 'down');
  }
  flash(m, cls, ms = 600) { this.mark(m, cls); setTimeout(() => this.unmark(m, cls), ms); }

  label(m, text, cls = '') { this.labels.set(m, { text, cls }); this.drawLabel(m, text, cls); }
  drawLabel(m, text, cls) {
    const k = this.keys[m]; if (!k) return;
    this.labelLayer.querySelector(`[data-m="${m}"]`)?.remove();
    const t = svgEl('text', { x: k.x, y: k.black ? 62 : 102, class: 'kbd-label ' + cls + (k.black ? ' on-black' : '') });
    t.dataset.m = m; t.textContent = text;
    this.labelLayer.appendChild(t);
  }
  clearLabels() { this.labels.clear(); if (this.labelLayer) this.labelLayer.innerHTML = ''; }

  /** Bildschirmposition (x) einer Taste – für Effekte */
  keyRect(m) { return this.keys[m]?.el.getBoundingClientRect(); }

  bindPointer() {
    const active = new Map(); // pointerId -> midi
    const midiAt = e => { const t = document.elementFromPoint(e.clientX, e.clientY); return t && t.dataset && t.dataset.midi ? +t.dataset.midi : null; };
    const down = (id, m) => { active.set(id, m); input.noteOn(m, 90, 'tap'); audio.playNotes([m], { dur: 0.6, vel: 0.6 }); };
    const up = id => { const m = active.get(id); if (m != null) { active.delete(id); input.noteOff(m, 'tap'); } };
    this.svg.addEventListener('pointerdown', e => {
      const m = midiAt(e); if (m == null) return;
      e.preventDefault(); this.svg.setPointerCapture?.(e.pointerId); down(e.pointerId, m);
    });
    this.svg.addEventListener('pointermove', e => {
      if (!active.has(e.pointerId)) return;
      const m = midiAt(e);
      if (m != null && m !== active.get(e.pointerId)) { up(e.pointerId); down(e.pointerId, m); }
    });
    for (const ev of ['pointerup', 'pointercancel']) this.svg.addEventListener(ev, e => up(e.pointerId));
  }
}
