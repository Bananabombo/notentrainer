// Modus: Noten lesen – zufällige Note anzeigen, richtige Taste erkennen
import { h, icon, burst, toast, segmented, toggle, field, setNum } from '../core/ui.js';
import { input } from '../core/input.js';
import { Keyboard } from '../core/keyboard.js';
import { drawStaff, COLORS } from '../core/staff.js';
import { LETTERS, SEMI, noteName, spellMidi } from '../core/music.js';
import { persisted, bumpProgress, progress } from '../core/store.js';

// Diatonischer Index = Oktave*7 + Buchstabe (C4 = 28)
const RANGES = {
  treble: { 1: [30, 38], 2: [28, 40], 3: [26, 42] }, // E4–F5 | C4–A5 | A3–C6
  bass:   { 1: [18, 26], 2: [16, 28], 3: [14, 30] }  // G2–A3 | E2–C4 | C2–E4
};
const mkNote = (d, a, clef) => {
  const octave = Math.floor(d / 7), l = d % 7;
  return { d, clef, s: { l, a }, octave, midi: 12 * (octave + 1) + SEMI[l] + a };
};
const label = n => noteName(n.s) + n.octave;

export default {
  mount(root, ctx) {
    const set = persisted('notes.settings', { clef: 'treble', level: '2', accidentals: false, anyOctave: false, showName: true, keyboard: true });
    const misses = persisted('notes.misses', {});
    const S = { hits: 0, fails: 0, streak: 0, times: [] };
    let target = null, firstTry = true, shownAt = 0, locked = false, lastMidi = null, hint = false, timers = [];

    // ---------- Aufbau ----------
    const staffEl = h('div.staff');
    const paper = h('div.paper', staffEl);
    const msg = h('div.msg.muted', 'Spiel die angezeigte Note.');
    const kb = new Keyboard({ from: 36, to: 84 });
    const kbWrap = h('div', kb.el);
    const stat = (l) => { const v = h('div.v', '–'); return [h('div.stat', v, h('div.l', l)), v]; };
    const [sAccEl, sAcc] = stat('beim 1. Versuch');
    const [sStreakEl, sStreak] = stat('Serie');
    const [sTimeEl, sTime] = stat('Ø bis richtig');
    const [sBestEl, sBest] = stat('Rekord');
    const weak = h('div.weak');

    root.append(h('div.split',
      h('section.stage',
        paper,
        h('div.feedback', msg,
          h('button.btn.ghost', { onclick: showHint }, icon('eye'), 'Lösung'),
          h('button.btn.primary', { onclick: skip }, 'Weiter', icon('skip'))),
        kbWrap),
      h('aside.side',
        h('div.card', h('h4', 'Diese Runde'), h('div.stats', sAccEl, sStreakEl, sTimeEl, sBestEl), weak))));

    ctx.setSettings(() => [
      field('Schlüssel', segmented([['treble', 'Violin'], ['bass', 'Bass'], ['grand', 'Beide']], set.clef, v => { set.clef = v; next(); })),
      field('Tonumfang', segmented([['1', 'Im System'], ['2', '+1 Hilfslinie'], ['3', '+2 Hilfslinien']], set.level, v => { set.level = v; next(); })),
      toggle('Vorzeichen (♯ / ♭)', set.accidentals, v => { set.accidentals = v; next(); }),
      toggle('Oktave egal', set.anyOctave, v => { set.anyOctave = v; }),
      toggle('Notenname nach Treffer zeigen', set.showName, v => { set.showName = v; }),
      toggle('Klaviatur anzeigen', set.keyboard, v => { set.keyboard = v; kbWrap.hidden = !v; }),
      h('div.field-hint', 'Mit dem Mikrofon zählt auch ein Ton eine Oktave daneben, weil die Erkennung Klaviertöne oft in der Oktave verwechselt.')
    ]);
    kbWrap.hidden = !set.keyboard;

    // ---------- Logik ----------
    const keyOf = n => n.clef + ':' + n.d + ':' + n.s.a;
    function candidates() {
      const clefs = set.clef === 'grand' ? ['treble', 'bass'] : [set.clef];
      const out = [];
      for (const clef of clefs) {
        const [lo, hi] = RANGES[clef][set.level];
        for (let d = lo; d <= hi; d++) {
          const L = LETTERS[d % 7];
          out.push(mkNote(d, 0, clef));
          if (set.accidentals) {
            if (L !== 'E' && L !== 'B') out.push(mkNote(d, 1, clef));
            if (L !== 'C' && L !== 'F') out.push(mkNote(d, -1, clef));
          }
        }
      }
      return out;
    }
    function pickNote() {
      const list = candidates().filter(n => n.midi !== lastMidi);
      const w = list.map(n => 1 + 2 * (misses[keyOf(n)] || 0));
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
      return list[list.length - 1];
    }
    function render(state = 'ink', played = null, cls = 'enter') {
      const notes = [{ keys: [{ s: target.s, octave: target.octave }], color: COLORS[state], cls, clef: target.clef }];
      if (played) notes.push({ keys: [{ s: played.s, octave: played.octave }], color: COLORS.bad, cls: 'ghost', clef: target.clef });
      return drawStaff(staffEl, { clef: set.clef, notes, width: 360, maxHeight: set.clef === 'grand' ? '44vh' : '30vh' });
    }
    function setMsg(text, cls) { msg.textContent = text; msg.className = 'msg ' + cls + (cls !== 'muted' ? ' pop' : ''); }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

    function next() {
      target = pickNote();
      lastMidi = target.midi;
      firstTry = true; locked = false; hint = false;
      shownAt = performance.now();
      kb.clear(); kb.clearLabels();
      paper.className = 'paper';
      setMsg('Spiel die angezeigte Note.', 'muted');
      render();
    }
    function skip() { if (!locked) { if (firstTry) { S.streak = 0; stats(); } next(); } }
    function showHint() {
      if (locked) return;
      hint = true;
      if (firstTry) fail();
      kb.mark(target.midi, 'hint');
      render('hint', null, 'pulse');
      setMsg('Das ist ' + label(target), 'hint');
    }
    function fail() {
      firstTry = false;
      S.fails++; S.streak = 0;
      const k = keyOf(target);
      misses[k] = Math.min(5, (misses[k] || 0) + 1);
      bumpProgress('notes', { total: 1 });
      stats();
    }

    function onNote({ midi, src }) {
      if (!target || locked) return;
      const diff = midi - target.midi;
      const ok = diff === 0 || (set.anyOctave && diff % 12 === 0) || (src === 'mic' && Math.abs(diff) === 12);
      if (ok) {
        locked = true;
        const t = performance.now() - shownAt;
        if (firstTry) {
          S.hits++; S.streak++;
          const k = keyOf(target);
          if (misses[k]) { misses[k]--; if (!misses[k]) delete misses[k]; }
          bumpProgress('notes', { correct: 1, total: 1, streak: S.streak });
        }
        S.times.push(t);
        kb.mark(midi, 'ok');
        paper.className = 'paper ok';
        const r = render('ok', null, 'pulse');
        const noteEl = r.vfNotes && r.vfNotes[0]._el;
        if (noteEl) burst(noteEl, { count: S.streak >= 10 ? 22 : 14 });
        setMsg('Richtig' + (set.showName ? ' – ' + label(target) : '') + `  ·  ${(t / 1000).toFixed(1)} s`, 'ok');
        if (firstTry && [5, 10, 25, 50, 100].includes(S.streak)) { toast(`🔥 ${S.streak}er-Serie!`); burst({ x: innerWidth / 2, y: innerHeight / 3 }, { count: 30, spread: 140, color: 'var(--warn)' }); }
        stats();
        later(() => {
          const g = r.vfNotes && r.vfNotes[0]._el;
          if (g) g.classList.add('leave');
          later(next, 260);
        }, set.showName ? 650 : 380);
        return;
      }
      if (firstTry) fail();
      kb.flash(midi, 'bad', 900);
      const played = spellMidi(midi, target.s.a === -1);
      const pNote = { s: played.s, octave: played.octave, d: played.octave * 7 + played.s.l };
      const near = Math.abs(pNote.d - target.d) <= 9;
      paper.className = 'paper'; void paper.offsetWidth; paper.className = 'paper bad';
      render('ink', near ? pNote : null, '');
      setMsg(`${noteName(played.s)}${played.octave} – ${diff > 0 ? 'zu hoch' : 'zu tief'}`, 'bad');
      later(() => { if (!locked) { paper.className = 'paper'; render(hint ? 'hint' : 'ink', null, ''); } }, 1300);
    }

    function stats() {
      const total = S.hits + S.fails;
      setNum(sAcc, total ? Math.round(100 * S.hits / total) + '%' : '–');
      setNum(sStreak, S.streak);
      setNum(sTime, S.times.length ? (S.times.reduce((a, b) => a + b, 0) / S.times.length / 1000).toFixed(1) + 's' : '–');
      setNum(sBest, (progress.notes && progress.notes.best) || 0);
      const list = Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => {
        const [clef, d, a] = k.split(':'); return label(mkNote(+d, +a, clef)) + (clef === 'bass' ? ' (Bass)' : '');
      });
      weak.innerHTML = '';
      if (list.length) weak.append('Übt sich noch: ', h('b', list.join(', ')));
    }

    const off = input.on('noteon', onNote);
    stats();
    next();
    return () => { off(); kb.destroy(); timers.forEach(clearTimeout); };
  }
};
