// Modus: Improvisation – Begleitband im Browser, Live-Feedback zu jedem gespielten Ton
import { h, icon, burst, segmented, toggle, field, setNum } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio, Sequencer } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { CHORDS, IV, ROOTS, transpose, pcOf, noteName, rootSymbol, scaleNotes, SCALES, pc, pick } from '../core/music.js';
import { persisted, bumpProgress } from '../core/store.js';

export const STYLES = {
  pop:       { name: 'Pop-Ballade',   sub: 'I – V – vi – IV',       bpm: 84,  swing: 0.5,  feel: 'pop',   scale: 'key', key: 'major',
               prog: [['P1', 'maj', 4], ['P5', 'maj', 4], ['M6', 'min', 4], ['P4', 'maj', 4]] },
  minor:     { name: 'Moll-Groove',   sub: 'i – VI – III – VII',    bpm: 92,  swing: 0.5,  feel: 'pop',   scale: 'key', key: 'minor',
               prog: [['P1', 'min', 4], ['m6', 'maj', 4], ['m3', 'maj', 4], ['m7', 'maj', 4]] },
  blues:     { name: '12-Takt-Blues', sub: 'I7 – IV7 – V7 (Shuffle)', bpm: 96, swing: 0.66, feel: 'blues', scale: 'blues', key: 'major',
               prog: [['P1', 'dom7', 4], ['P4', 'dom7', 4], ['P1', 'dom7', 8], ['P4', 'dom7', 8], ['P1', 'dom7', 8], ['P5', 'dom7', 4], ['P4', 'dom7', 4], ['P1', 'dom7', 4], ['P5', 'dom7', 4]] },
  jazz251:   { name: 'Jazz ii – V – I', sub: 'm7 – 7 – maj7 (Swing)', bpm: 120, swing: 0.64, feel: 'jazz', scale: 'chord', key: 'major',
               prog: [['M2', 'm7', 4], ['P5', 'dom7', 4], ['P1', 'maj7', 8]] },
  jazzMinor: { name: 'Moll ii – V – i', sub: 'm7♭5 – 7♭9 – m6',       bpm: 112, swing: 0.64, feel: 'jazz', scale: 'chord', key: 'minor',
               prog: [['M2', 'm7b5', 4], ['P5', 'b9', 4], ['P1', 'm6', 8]] },
  jazzBlues: { name: 'Jazz-Blues',    sub: '12 Takte mit Turnarounds', bpm: 128, swing: 0.64, feel: 'jazz', scale: 'chord', key: 'major',
               prog: [['P1', 'dom7', 4], ['P4', 'dom7', 4], ['P1', 'dom7', 4], ['P5', 'm7', 2], ['P1', 'dom7', 2], ['P4', 'dom7', 4], ['A4', 'dim7', 4],
                      ['P1', 'dom7', 4], ['M6', 'dom7', 4], ['M2', 'm7', 4], ['P5', 'dom7', 4], ['P1', 'dom7', 2], ['M6', 'dom7', 2], ['M2', 'm7', 2], ['P5', 'dom7', 2]] },
  bossa:     { name: 'Bossa-Feeling', sub: 'maj7 – 7 – m7 – 7',      bpm: 136, swing: 0.5,  feel: 'bossa', scale: 'chord', key: 'major',
               prog: [['P1', 'maj7', 8], ['M2', 'dom7', 8], ['M2', 'm7', 4], ['P5', 'dom7', 4], ['P1', 'maj7', 8]] }
};
const CHORD_SCALE = { maj: 'major', maj7: 'major', maj6: 'major', six9: 'major', min: 'dorian', m7: 'dorian', m6: 'melodic', mMaj7: 'melodic', dom7: 'mixolydian', dom9: 'mixolydian', dom13: 'mixolydian', m7b5: 'locrian', b9: 'phrygDom', s9: 'altered', dim7: null, dim: null };
const WHOLE_HALF = [0, 2, 3, 5, 6, 8, 9, 11];
const SCALE_LABEL = { major: 'Ionisch', dorian: 'Dorisch', mixolydian: 'Mixolydisch', locrian: 'Lokrisch', phrygDom: 'Phrygisch-Dominant', melodic: 'Melodisch Moll', altered: 'Alteriert' };

function place(pcs, lo) { return pcs.map(p => { let m = lo; while (pc(m) !== p) m++; return m; }).sort((a, b) => a - b); }

export default {
  mount(root, ctx) {
    const q = ctx.route.query;
    const set = persisted('improv.settings', { style: 'pop', l: 0, a: 0, bpm: null, challenge: 'free', drums: true, bass: true, comp: true, showScale: true });
    if (q.style && STYLES[q.style] && set.style !== q.style) { set.style = q.style; set.bpm = STYLES[q.style].bpm; }
    let seq = null, chords = [], beatMap = [], current = null, prevVoicing = null, uiTimers = [];
    const score = { chord: 0, scale: 0, out: 0, guideHit: 0, guideTotal: 0, guideArmed: null };

    // ---------- Aufbau ----------
    const nowChord = h('div.now-chord', '—');
    const nextChord = h('div.next-chord');
    const scaleName = h('div.scale-name', { hidden: true });
    const beats = h('div.beats', [0, 1, 2, 3].map(i => h('span' + (i === 0 ? '.one' : ''))));
    const bars = h('div.bars');
    const meter = h('div.meter-bar', h('div'));
    const meterText = h('div', { style: { fontSize: '13px', color: 'var(--muted)', fontWeight: 500 } }, 'Spiel los – jeder Ton wird bewertet.');
    const guideText = h('div', { style: { fontSize: '13px', color: 'var(--muted)', fontWeight: 500 }, hidden: true });
    const rain = h('div.note-rain');
    const kb = new Keyboard({ from: 48, to: 84 });
    const playBtn = h('button.btn.accent.big', { onclick: toggle_ }, icon('play'), 'Band starten');
    const keyChips = h('div.key-chips');
    const styleSeg = h('div.key-chips');
    const bpmLabel = h('span');
    const bpm = h('input', { type: 'range', min: 50, max: 220, step: 1, oninput: () => { set.bpm = +bpm.value; bpmLabel.textContent = bpm.value + ' BPM'; seq && seq.setBpm(+bpm.value); } });

    root.append(
      h('section.stage',
        h('div.row', styleSeg),
        h('div.row', keyChips, h('span.spacer'), h('label.row', { style: { gap: '8px', fontSize: '13px', color: 'var(--muted)', minWidth: '240px', flexWrap: 'nowrap', whiteSpace: 'nowrap' } }, icon('metronome'), bpm, bpmLabel))),
      h('section.stage.grow',
        h('div.jam-top',
          h('div', nowChord, nextChord, scaleName),
          h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '14px' } }, beats, playBtn)),
        bars,
        h('div', { style: { display: 'grid', gap: '6px' } }, meter, h('div.row', meterText, h('span.spacer'), guideText)),
        h('div.legend',
          h('span', h('i', { style: { background: 'var(--ok)' } }), 'Akkordton'),
          h('span', h('i', { style: { background: 'var(--accent)' } }), 'Skalenton'),
          h('span', h('i', { style: { background: 'var(--warn)' } }), 'Spannung'),
          set.challenge === 'guide' ? h('span', h('i', { style: { background: 'color-mix(in srgb, var(--warn) 60%, white)' } }), 'Leitton (3 / 7)') : ''),
        rain, kb.el));

    ctx.setSettings(() => [
      field('Aufgabe', (() => { const s = segmented([['free', 'Frei'], ['chordTones', 'Nur Akkordtöne'], ['guide', 'Leittöne auf die Eins']], set.challenge, v => { set.challenge = v; resetScore(); highlight(); }); s.classList.add('wrap'); return s; })(),
        'Leittöne: Triff bei jedem Akkordwechsel die Terz oder Septime – das klingt sofort nach Jazz.'),
      toggle('Schlagzeug', set.drums, v => { set.drums = v; }),
      toggle('Bass', set.bass, v => { set.bass = v; }),
      toggle('Akkorde', set.comp, v => { set.comp = v; }),
      toggle('Skala auf der Klaviatur zeigen', set.showScale, v => { set.showScale = v; highlight(); })
    ]);

    // ---------- Progression aufbauen ----------
    function build() {
      const st = STYLES[set.style];
      const key = { l: set.l, a: set.a };
      const keyScale = st.scale === 'blues' ? scaleNotes(key, 'blues') : scaleNotes(key, st.key === 'minor' ? 'minor' : 'major');
      chords = st.prog.map(([iv, type, beats]) => {
        const r = transpose(key, IV[iv]);
        const def = CHORDS[type];
        const pcs = def.iv.map(k => pcOf(transpose(r, IV[k])));
        let scalePcs, scaleLabel = '';
        if (st.scale === 'chord') {
          const sc = CHORD_SCALE[type];
          scalePcs = sc ? scaleNotes(r, sc).map(pcOf) : WHOLE_HALF.map(x => (pcOf(r) + x) % 12);
          scaleLabel = noteName(r) + ' ' + (sc ? SCALE_LABEL[sc] || SCALES[sc].name : 'Ganzton-Halbton');
        } else {
          scalePcs = keyScale.map(pcOf);
          scaleLabel = noteName(key) + ' ' + (st.scale === 'blues' ? 'Blues-Skala' : st.key === 'minor' ? 'Moll' : 'Dur');
        }
        const guide = def.iv.filter(k => ['m3', 'M3', 'm7', 'M7', 'd7'].includes(k) || (k === 'M6' && !def.iv.includes('m7') && !def.iv.includes('M7'))).map(k => pcOf(transpose(r, IV[k])));
        return { root: r, type, beats, pcs, scalePcs, scaleLabel, guide, sym: rootSymbol(r) + def.sym };
      });
      beatMap = [];
      chords.forEach((c, ci) => { for (let b = 0; b < c.beats; b++) beatMap.push({ ci, inChord: b }); });
      beatMap.forEach((b, i) => { b.barBeat = i % 4; b.bar = Math.floor(i / 4); });
      // Taktleiste
      bars.innerHTML = '';
      const nBars = beatMap.length / 4;
      for (let bar = 0; bar < nBars; bar++) {
        const syms = [...new Set(beatMap.filter(b => b.bar === bar).map(b => b.ci))].map(ci => chords[ci].sym);
        bars.append(h('span', { dataset: { bar } }, syms.join('  ')));
      }
      if (!set.bpm) set.bpm = st.bpm;
      bpm.value = set.bpm; bpmLabel.textContent = set.bpm + ' BPM';
      setCurrent(0, false);
      renderPickers();
    }
    function renderPickers() {
      styleSeg.innerHTML = '';
      for (const [k, st] of Object.entries(STYLES)) {
        styleSeg.append(h('button' + (k === set.style ? '.active' : ''), { onclick: () => { set.style = k; set.bpm = STYLES[k].bpm; restart(); }, title: st.sub, style: { padding: '0 12px' } }, st.name));
      }
      keyChips.innerHTML = '';
      for (const r of ROOTS) {
        keyChips.append(h('button' + (r.l === set.l && r.a === set.a ? '.active' : ''), { onclick: () => { set.l = r.l; set.a = r.a; restart(); } }, noteName(r)));
      }
    }
    function restart() { const was = !!seq; stop(); build(); if (was) start(); }

    function setCurrent(ci, animate = true) {
      current = chords[ci];
      const nxt = chords[(ci + 1) % chords.length];
      nowChord.textContent = current.sym;
      nowChord.classList.remove('change'); if (animate) { void nowChord.offsetWidth; nowChord.classList.add('change'); }
      nextChord.innerHTML = '';
      nextChord.append('Danach', h('b', nxt.sym));
      scaleName.hidden = false;
      scaleName.textContent = current.scaleLabel;
      highlight();
    }
    function highlight() {
      if (!current) return;
      kb.clear('chord'); kb.clear('scale'); kb.clear('guide');
      for (let m = kb.from; m <= kb.to; m++) {
        const p = pc(m);
        if (set.challenge === 'guide' && current.guide.includes(p)) kb.mark(m, 'guide');
        else if (current.pcs.includes(p)) kb.mark(m, 'chord');
        else if (set.showScale && set.challenge !== 'chordTones' && current.scalePcs.includes(p)) kb.mark(m, 'scale');
      }
    }

    // ---------- Band ----------
    function onStep(step, t, beatDur) {
      const sub = step % 2;
      const beatIdx = Math.floor(step / 2);
      const b = beatMap[beatIdx % beatMap.length];
      const c = chords[b.ci];
      const st = STYLES[set.style];
      const nextC = chords[(b.ci + 1) % chords.length];
      if (sub === 0) {
        uiTimers.push(Sequencer.at(t, () => {
          [...beats.children].forEach((s, i) => s.classList.toggle('on', i === b.barBeat));
          [...bars.children].forEach(s => s.classList.toggle('cur', +s.dataset.bar === b.bar));
          if (b.inChord === 0) {
            setCurrent(b.ci, true);
            if (set.challenge === 'guide') { score.guideTotal++; score.guideArmed = { until: performance.now() + beatDur * 1000 * 0.9, guide: c.guide }; updateScore(); }
          }
        }));
      }
      if (set.drums) drums(st.feel, b, sub, t, beatDur, step);
      if (set.bass) bassLine(st.feel, b, sub, t, beatDur, c, nextC);
      if (set.comp) comp(st.feel, b, sub, t, beatDur, c);
    }
    function drums(feel, b, sub, t, bd, step) {
      const bb = b.barBeat;
      if (feel === 'pop') {
        if (sub === 0 && (bb === 0 || bb === 2)) audio.kick(t);
        if (sub === 1 && bb === 2 && Math.random() < 0.4) audio.kick(t, 0.6);
        if (sub === 0 && (bb === 1 || bb === 3)) audio.snare(t, 0.8);
        audio.hat(t, sub ? 0.45 : 0.75);
      } else if (feel === 'blues') {
        if (sub === 0 && (bb === 0 || bb === 2)) audio.kick(t, 0.9);
        if (sub === 0 && (bb === 1 || bb === 3)) audio.snare(t, 0.75);
        audio.hat(t, sub ? 0.5 : 0.8);
      } else if (feel === 'jazz') {
        if (sub === 0) audio.ride(t, bb % 2 ? 0.75 : 0.95);
        if (sub === 1 && (bb === 1 || bb === 3)) audio.ride(t, 0.55);
        if (sub === 0 && (bb === 1 || bb === 3)) audio.hat(t, 0.5);
        if (sub === 0) audio.kick(t, 0.18);
        if (Math.random() < 0.08) audio.brush(t, 0.6);
      } else if (feel === 'bossa') {
        const pos = (b.bar % 2) * 8 + bb * 2 + sub;
        if ([0, 3, 6, 10, 13].includes(pos)) audio.noiseHit(t, { hp: 1800, bp: 2600, q: 4, peak: 0.22, decay: 0.05 });
        if (sub === 0 && (bb === 0 || bb === 2)) audio.kick(t, 0.75);
        if (sub === 1 && (bb === 1 || bb === 3)) audio.kick(t, 0.45);
        audio.hat(t, sub ? 0.35 : 0.5);
      }
    }
    function bassRoot(r) { let m = 36 + pcOf(r); if (m > 43) m -= 12; return m; }
    function bassLine(feel, b, sub, t, bd, c, nextC) {
      const r = bassRoot(c.root);
      if (feel === 'pop') {
        if (sub === 0 && b.barBeat === 0) audio.bass(r, t, bd * 1.8, 0.9);
        if (sub === 0 && b.barBeat === 2) audio.bass(r + 7 > 48 ? r - 5 : r + 7, t, bd * 1.3, 0.75);
        if (sub === 1 && b.barBeat === 3) audio.bass(r, t, bd * 0.4, 0.6);
      } else if (feel === 'blues') {
        if (sub) return;
        const third = c.pcs.includes((pcOf(c.root) + 4) % 12) ? 4 : 3;
        audio.bass(r + [0, third, 7, 9][b.barBeat], t, bd * 0.8, 0.85);
      } else if (feel === 'bossa') {
        if (sub === 0 && b.barBeat === 0) audio.bass(r, t, bd * 1.4, 0.9);
        if (sub === 1 && b.barBeat === 1) audio.bass(r + 7 > 48 ? r - 5 : r + 7, t, bd * 0.5, 0.7);
        if (sub === 0 && b.barBeat === 2) audio.bass(r + 7 > 48 ? r - 5 : r + 7, t, bd * 1.3, 0.8);
        if (sub === 1 && b.barBeat === 3) audio.bass(r, t, bd * 0.4, 0.6);
      } else if (feel === 'jazz') {
        if (sub) return;
        const lastBeatOfChord = b.inChord === c.beats - 1;
        let m;
        if (b.inChord === 0) m = r;
        else if (lastBeatOfChord) { const nr = bassRoot(nextC.root); m = nr + (Math.random() < 0.5 ? -1 : 1); }
        else {
          const pool = c.pcs.concat(c.scalePcs.filter(() => Math.random() < 0.3));
          const p = pick(pool);
          m = 33 + ((p - 33 % 12 + 12) % 12) + (Math.random() < 0.5 ? 0 : 12);
          if (m > 50) m -= 12;
        }
        audio.bass(m, t, bd * 0.85, b.inChord === 0 ? 0.95 : 0.8);
      }
    }
    function voicing(c) {
      const st = STYLES[set.style];
      if (st.feel === 'pop') return place(c.pcs, 55);
      const root = pcOf(c.root);
      const want = [];
      const add = semi => want.push((root + semi) % 12);
      const def = CHORDS[c.type];
      for (const k of def.iv) if (k !== 'P1') want.push(pcOf(transpose(c.root, IV[k])));
      if (['maj7', 'm7', 'dom7'].includes(c.type)) add(c.type === 'dom7' ? 9 : 2); // 13 bzw. 9 ergänzen
      const pcs = [...new Set(want)].slice(0, 4);
      // Stimmführung: Lage nahe an der vorigen
      let best = null, bestD = Infinity;
      for (let lo = 50; lo <= 58; lo++) {
        const v = place(pcs, lo);
        const d = prevVoicing ? Math.abs(v.reduce((a, b) => a + b, 0) / v.length - prevVoicing) : Math.abs(v[0] - 54);
        if (d < bestD) { bestD = d; best = v; }
      }
      prevVoicing = best.reduce((a, b) => a + b, 0) / best.length;
      return best;
    }
    function comp(feel, b, sub, t, bd, c) {
      if (feel === 'pop') {
        if (sub === 0 && b.inChord === 0) audio.pad(voicing(c), t, bd * Math.min(c.beats, 4) - 0.05, 0.7);
        if (b.barBeat === 0 && sub === 0) voicing(c).forEach(m => audio.piano(m, t, bd * 1.5, 0.35));
        if (b.barBeat === 2 && sub === 0) voicing(c).forEach(m => audio.piano(m, t, bd * 1.2, 0.28));
      } else if (feel === 'blues') {
        if (sub === 0 && (b.barBeat === 1 || b.barBeat === 3)) voicing(c).forEach(m => audio.ep(m, t, bd * 0.35, 0.6));
        if (sub === 1 && b.barBeat === 3 && Math.random() < 0.4) voicing(c).forEach(m => audio.ep(m, t, bd * 0.25, 0.45));
      } else if (feel === 'bossa') {
        const pos = (b.bar % 2) * 8 + b.barBeat * 2 + sub;
        if ([0, 3, 5, 8, 10, 13].includes(pos)) voicing(c).forEach(m => audio.ep(m, t, bd * 0.45, 0.5));
      } else {
        let hit = false;
        if (b.inChord === 0 && sub === 0) hit = Math.random() < 0.7;
        else if (sub === 1) hit = Math.random() < 0.18;
        else hit = Math.random() < 0.15;
        if (hit) voicing(c).forEach(m => audio.ep(m, t, bd * (sub ? 0.3 : 0.45), 0.55));
      }
    }

    function start() {
      audio.ensure();
      resetScore();
      seq = new Sequencer({ bpm: set.bpm, swing: STYLES[set.style].swing, onStep });
      seq.start();
      playBtn.innerHTML = ''; playBtn.append(icon('stop'), 'Stopp');
      playBtn.className = 'btn primary big';
    }
    function stop() {
      if (seq) seq.stop();
      seq = null;
      uiTimers.forEach(clearTimeout); uiTimers = [];
      [...beats.children].forEach(s => s.classList.remove('on'));
      playBtn.innerHTML = ''; playBtn.append(icon('play'), 'Band starten');
      playBtn.className = 'btn accent big';
      const total = score.chord + score.scale + score.out;
      if (total > 10) bumpProgress('improv', { total: 1, correct: (score.chord + score.scale) / total > 0.8 ? 1 : 0 });
    }
    function toggle_() { seq ? stop() : start(); }

    // ---------- Bewertung ----------
    function resetScore() { Object.assign(score, { chord: 0, scale: 0, out: 0, guideHit: 0, guideTotal: 0, guideArmed: null }); updateScore(); }
    function updateScore() {
      const total = score.chord + score.scale + score.out;
      const good = set.challenge === 'chordTones' ? score.chord : score.chord + score.scale;
      const pct = total ? Math.round(100 * good / total) : 0;
      meter.firstChild.style.width = pct + '%';
      meterText.textContent = total ? `${pct} % im Klang · ${total} Töne · ${score.chord} Akkordtöne` : 'Spiel los – jeder Ton wird bewertet.';
      guideText.hidden = set.challenge !== 'guide';
      guideText.textContent = `Leittöne getroffen: ${score.guideHit} / ${score.guideTotal}`;
    }
    function spark(midi, color) {
      const r = kb.keyRect(midi), host = rain.getBoundingClientRect();
      if (!r) return;
      const s = h('span.spark', { style: { left: (r.left + r.width / 2 - host.left) + 'px', background: color } });
      rain.append(s);
      s.addEventListener('animationend', () => s.remove());
    }
    function onNote({ midi }) {
      if (!current) return;
      const p = pc(midi);
      let cls, color;
      if (current.pcs.includes(p)) { score.chord++; cls = 'ok'; color = 'var(--ok)'; }
      else if (current.scalePcs.includes(p)) { score.scale++; cls = set.challenge === 'chordTones' ? 'tension' : 'target'; color = set.challenge === 'chordTones' ? 'var(--warn)' : 'var(--accent)'; }
      else { score.out++; cls = 'tension'; color = 'var(--warn)'; }
      if (score.guideArmed && performance.now() <= score.guideArmed.until && score.guideArmed.guide.includes(p)) {
        score.guideHit++; score.guideArmed = null;
        const r = kb.keyRect(midi); if (r) burst({ x: r.left + r.width / 2, y: r.top }, { count: 12, color: 'var(--warn)' });
      }
      kb.flash(midi, cls, 380);
      spark(midi, color);
      if (seq) updateScore();
    }

    const off = input.on('noteon', onNote);
    build();
    return () => { stop(); off(); kb.destroy(); };
  }
};
