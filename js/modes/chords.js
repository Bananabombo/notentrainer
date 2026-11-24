// Modus: Akkorde – Symbol lesen, Akkord greifen; inkl. Jazz-Voicings (Shell, Rootless A/B)
import { h, icon, burst, toast, segmented, toggle, field, setNum } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { drawStaff, COLORS } from '../core/staff.js';
import { CHORDS, VOICINGS, IV, IV_LABEL, ROOTS, NATURAL_ROOTS, transpose, pcOf, midiOf, noteName, rootSymbol, chordSymbol, matchChord, pick, pc } from '../core/music.js';
import { persisted, bumpProgress } from '../core/store.js';

const LEVELS = {
  1: { name: 'Dur & Moll (weiße Tasten)', types: ['maj', 'min'], roots: NATURAL_ROOTS },
  2: { name: 'Dur & Moll (alle Tonarten)', types: ['maj', 'min'], roots: ROOTS },
  3: { name: '+ vermindert, übermäßig, sus', types: ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4'], roots: ROOTS },
  4: { name: 'Septakkorde', types: ['maj7', 'dom7', 'm7', 'm7b5', 'dim7', 'maj6', 'm6'], roots: ROOTS },
  5: { name: 'Jazz-Erweiterungen', types: ['maj9', 'dom9', 'm9', 'dom13', 'b9', 's9', 'six9', 'mMaj7'], roots: ROOTS }
};
const VOICE_MODES = [['any', 'Beliebig'], ['root', 'Grundstellung'], ['shell', 'Shell'], ['rootlessA', 'Rootless A'], ['rootlessB', 'Rootless B']];

/** Klingende Töne für Hinweis/Vorspielen */
export function voiceChord(root, type, mode = 'root') {
  const base = midiOf(root, pcOf(root) <= 7 ? 4 : 3) - 12 * (mode === 'any' || mode === 'root' ? 0 : 0);
  if (VOICINGS[mode] && VOICINGS[mode].forms[type]) {
    const out = [];
    let prev = base - 12;
    for (const k of VOICINGS[mode].forms[type]) {
      const p = pcOf(transpose(root, IV[k]));
      let m = prev + 1;
      while (pc(m) !== p) m++;
      out.push({ midi: m, iv: k }); prev = m;
    }
    return out;
  }
  return CHORDS[type].iv.map(k => ({ midi: base + IV[k][0] + (['m9', 'M9', 'A9', 'P11', 'A11', 'm13', 'M13'].includes(k) ? 12 : 0), iv: k }));
}

export default {
  mount(root, ctx) {
    const q = ctx.route.query;
    const saved = persisted('chords.settings', { level: '1', voicing: 'any', display: 'symbol', autoPlay: false });
    // Einstiege aus dem Jazz-Bereich überschreiben die Einstellungen nur für diese Sitzung
    const set = q.voicing || q.level ? Object.assign({ ...saved }, q.voicing && { voicing: q.voicing }, q.level && { level: q.level }) : saved;
    if (q.voicing && VOICINGS[q.voicing]) ctx.setTitle('Jazz-Voicings', VOICINGS[q.voicing].name);

    const S = { hits: 0, fails: 0, streak: 0 };
    let cur = null, firstTry = true, locked = false, evalTimer = null, wrongTimer = null, lastChange = 0, waitRelease = false;

    const symbol = h('div.chord-symbol');
    const name = h('div.chord-name');
    const tones = h('div.chord-tones');
    const staffEl = h('div.staff', { style: { maxWidth: '360px', width: '100%' } });
    const display = h('div.chord-display', symbol, staffEl, name, tones);
    const msg = h('div.msg.muted', '');
    const kb = new Keyboard({ from: 36, to: 84 });
    const stat = l => { const v = h('div.v', '0'); return [h('div.stat', v, h('div.l', l)), v]; };
    const [aEl, a] = stat('gegriffen'), [bEl, b] = stat('Serie'), [cEl, c] = stat('Quote');
    const micNote = h('div.info-box', { hidden: true }, 'Akkorde lassen sich nur per MIDI erkennen – das Mikrofon hört nur einzelne Töne. Verbinde dein Digitalpiano oder nutze die Bildschirm-Klaviatur.');

    root.append(h('div.split',
      h('section.stage',
        h('div.paper', { style: { minHeight: '260px', flexDirection: 'column' } }, display),
        h('div.feedback', msg,
          h('button.btn.ghost', { onclick: listen }, icon('speaker'), 'Anhören'),
          h('button.btn.ghost', { onclick: showHint }, icon('eye'), 'Zeigen'),
          h('button.btn.primary', { onclick: () => { if (firstTry && !locked) { S.streak = 0; stats(); } next(); } }, 'Weiter', icon('skip'))),
        kb.el),
      h('aside.side',
        h('div.card', h('h4', 'Diese Runde'), h('div.stats', aEl, bEl, cEl)),
        h('div.card', h('h4', 'So geht’s'), h('div.weak', { style: { marginTop: 0 } }, helpText())),
        micNote)));

    function helpText() {
      if (VOICINGS[set.voicing]) {
        return ({
          shell: 'Shell-Voicing: Grundton unten, dazu Terz und Septime (bei 6-Akkorden die Sexte). Das ist das Gerüst jedes Jazz-Akkords.',
          rootlessA: 'Rootless A: ohne Grundton, die Terz liegt unten (3–5–7–9; beim Dominantakkord 3–13–7–9). Den Grundton spielt der Bass.',
          rootlessB: 'Rootless B: ohne Grundton, die Septime liegt unten (7–9–3–5; beim Dominantakkord 7–9–3–13).'
        })[set.voicing];
      }
      return set.voicing === 'root' ? 'Greife den Akkord in Grundstellung – der Grundton muss der tiefste Ton sein.' : 'Greife alle Töne des Akkords gleichzeitig, in jeder Umkehrung und Lage. Die Quinte darf bei Vierklängen fehlen.';
    }

    ctx.setSettings(() => [
      field('Stufe', segmented(Object.entries(LEVELS).map(([k, v]) => [k, k]), set.level, v => { set.level = v; next(); })),
      h('div.field-hint', { style: { marginTop: '-10px', marginBottom: '16px' } }, Object.entries(LEVELS).map(([k, v]) => `${k}: ${v.name}`).join(' · ')),
      field('Voicing', (() => { const sg = segmented(VOICE_MODES, set.voicing, v => { set.voicing = v; next(); }); sg.classList.add('wrap'); return sg; })(), 'Shell und Rootless verwenden nur Septakkorde (maj7, 7, m7 …).'),
      field('Anzeige', segmented([['symbol', 'Akkordsymbol'], ['staff', 'Noten']], set.display, v => { set.display = v; render(); })),
      toggle('Akkord beim Erscheinen vorspielen', set.autoPlay, v => { set.autoPlay = v; })
    ]);

    function pool() {
      if (VOICINGS[set.voicing]) return { types: Object.keys(VOICINGS[set.voicing].forms), roots: ROOTS };
      return LEVELS[set.level] || LEVELS[1];
    }
    function next() {
      clearTimeout(evalTimer); clearTimeout(wrongTimer);
      const p = pool();
      let n;
      do { n = { root: pick(p.roots), type: pick(p.types) }; if (pcOf(n.root) === 6 && Math.random() < 0.5) n.root = { l: 4, a: -1 }; }
      while (cur && n.type === cur.type && pcOf(n.root) === pcOf(cur.root));
      cur = n; firstTry = true; locked = false; waitRelease = input.held.size > 0;
      kb.clear(); kb.clearLabels();
      tones.innerHTML = '';
      setMsg(VOICINGS[set.voicing] ? 'Greife das ' + VOICINGS[set.voicing].name.split(' (')[0] + '-Voicing.' : 'Greife den Akkord.', 'muted');
      render(true);
      if (set.autoPlay) setTimeout(listen, 250);
    }
    function render(animate) {
      symbol.textContent = chordSymbol(cur.root, cur.type);
      symbol.className = 'chord-symbol' + (animate ? ' enter' : '');
      symbol.hidden = set.display === 'staff' && !locked;
      name.textContent = noteName(cur.root) + ' · ' + CHORDS[cur.type].name;
      name.hidden = set.display === 'staff' && !locked;
      staffEl.hidden = set.display !== 'staff';
      if (set.display === 'staff') {
        const v = voiceChord(cur.root, cur.type, 'root');
        const keys = v.map(x => { const s = transpose(cur.root, IV[x.iv]); return { s, octave: Math.floor((x.midi - s.a) / 12) - 1 }; });
        drawStaff(staffEl, { clef: 'treble', notes: [{ keys, color: locked ? COLORS.ok : COLORS.ink, cls: animate ? 'enter' : '' }], width: 200, minWidth: 200, maxHeight: '28vh' });
      }
    }
    function setMsg(t, cls) { msg.textContent = t; msg.className = 'msg ' + cls + (cls !== 'muted' ? ' pop' : ''); }
    function chips(heldPcs) {
      tones.innerHTML = '';
      const list = VOICINGS[set.voicing] ? VOICINGS[set.voicing].forms[cur.type] : CHORDS[cur.type].iv;
      list.forEach((k, i) => {
        const s = transpose(cur.root, IV[k]);
        const cls = heldPcs ? (heldPcs.has(pcOf(s)) ? '.have' : '.miss') : '';
        tones.append(h('span.tone-chip' + cls, { style: { '--i': i } }, noteName(s), h('small', IV_LABEL[k])));
      });
    }
    function labelKeys(midis) {
      const list = VOICINGS[set.voicing] ? VOICINGS[set.voicing].forms[cur.type] : CHORDS[cur.type].iv;
      const byPc = new Map(list.map(k => [pcOf(transpose(cur.root, IV[k])), IV_LABEL[k]]));
      for (const m of midis) if (byPc.has(pc(m))) kb.label(m, byPc.get(pc(m)));
    }
    function listen() {
      const v = voiceChord(cur.root, cur.type, VOICINGS[set.voicing] ? set.voicing : 'root');
      const bass = VOICINGS[set.voicing] && set.voicing !== 'shell' ? [midiOf(cur.root, 2)] : [];
      audio.playNotes([...bass, ...v.map(x => x.midi)], { dur: 1.6, vel: 0.6, arpeggio: 0.04 });
    }
    function showHint() {
      if (locked) return;
      if (firstTry) failOnce();
      const v = voiceChord(cur.root, cur.type, VOICINGS[set.voicing] ? set.voicing : 'root');
      kb.clear('hint');
      v.forEach(x => kb.mark(x.midi, 'hint'));
      labelKeys(v.map(x => x.midi));
      chips(null);
      if (set.display === 'staff') { symbol.hidden = false; name.hidden = false; }
      setMsg('So sieht er aus – jetzt du!', 'hint');
    }
    function failOnce() { firstTry = false; S.fails++; S.streak = 0; bumpProgress('chords', { total: 1 }); stats(); }

    function evaluate() {
      if (!cur || locked) return;
      const held = input.heldNotes();
      if (waitRelease) { if (!held.length) waitRelease = false; return; }
      const need = VOICINGS[set.voicing] ? VOICINGS[set.voicing].forms[cur.type].length : Math.min(3, CHORDS[cur.type].iv.length);
      if (held.length < Math.min(need, 3)) return;
      const r = matchChord(held, cur.root, cur.type, set.voicing);
      if (r.ok) return success(held);
      // falsch – erst melden, wenn der Griff kurz stabil ist
      clearTimeout(wrongTimer);
      wrongTimer = setTimeout(() => {
        if (locked || input.heldNotes().join() !== held.join() || held.length < need) return;
        if (firstTry) failOnce();
        held.forEach(m => kb.flash(m, 'bad', 900));
        chips(new Set(held.map(pc)));
        const lowestWrong = set.voicing === 'root' && !r.missing?.length && !r.extra?.length;
        setMsg(lowestWrong ? 'Richtige Töne – aber der Grundton muss unten liegen.' :
          r.extra && r.extra.length ? 'Nicht ganz – ein Ton gehört nicht dazu.' : 'Fast – es fehlt noch etwas.', 'bad');
      }, 650);
    }
    function success(held) {
      locked = true; clearTimeout(wrongTimer);
      if (firstTry) { S.hits++; S.streak++; bumpProgress('chords', { correct: 1, total: 1, streak: S.streak }); }
      kb.clear('hint');
      held.forEach(m => kb.mark(m, 'ok'));
      labelKeys(held);
      chips(new Set(held.map(pc)));
      render(false);
      symbol.classList.add('ok');
      burst(symbol, { count: 18, spread: 110 });
      setMsg('Sauber gegriffen!', 'ok');
      if ([5, 10, 25, 50].includes(S.streak)) toast(`🔥 ${S.streak} Akkorde in Folge!`);
      stats();
      // nächster Akkord, sobald losgelassen (oder nach kurzer Zeit)
      const t0 = performance.now();
      const wait = () => {
        if (!locked) return;
        if (!input.held.size || performance.now() - t0 > 2500) { setTimeout(next, 250); return; }
        setTimeout(wait, 80);
      };
      setTimeout(wait, 700);
    }
    function stats() {
      setNum(a, S.hits); setNum(b, S.streak);
      setNum(c, S.hits + S.fails ? Math.round(100 * S.hits / (S.hits + S.fails)) + '%' : '–');
    }
    const schedule = () => { lastChange = performance.now(); clearTimeout(evalTimer); evalTimer = setTimeout(evaluate, 90); };
    const offs = [input.on('noteon', schedule), input.on('noteoff', schedule),
      input.on('status', s => { micNote.hidden = !(s.mic && s.midi !== 'connected'); })];
    micNote.hidden = !(input.status.mic && input.status.midi !== 'connected');
    stats();
    next();
    return () => { offs.forEach(f => f()); kb.destroy(); clearTimeout(evalTimer); clearTimeout(wrongTimer); };
  }
};
