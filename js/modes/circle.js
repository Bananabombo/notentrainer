// Modus: Quintenzirkel – interaktiv entdecken und im Quiz festigen
import { h, icon, burst, svgEl, segmented, toggle, field, setNum } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { drawStaff } from '../core/staff.js';
import { CIRCLE, IV, transpose, pcOf, midiOf, noteName, rootSymbol, majorSignature, scaleNotes, keyLabel, DIATONIC, SHARP_ORDER, FLAT_ORDER, LETTERS, pick, pc, CHORDS } from '../core/music.js';
import { persisted, bumpProgress } from '../core/store.js';
import { record } from '../core/stats.js';
import { voiceChord } from './chords.js';
import { go } from '../app.js';

const MINOR_DIATONIC = [['P1', 'min', 'i'], ['M2', 'dim', 'ii°'], ['m3', 'maj', 'III'], ['P4', 'min', 'iv'], ['P5', 'min', 'v'], ['m6', 'maj', 'VI'], ['m7', 'maj', 'VII']];
const sigText = n => n === 0 ? 'keine' : Math.abs(n) + (n > 0 ? '♯' : '♭');
const accNames = n => (n > 0 ? SHARP_ORDER : FLAT_ORDER).slice(0, Math.abs(n)).map(l => noteName({ l, a: n > 0 ? 1 : -1 }));

export default {
  mount(root, ctx) {
    const set = persisted('circle.settings', { mode: 'explore', enharm: 'sharp' });
    const S = { hits: 0, fails: 0, streak: 0 };
    let rot = 0, sel = { i: 0, minor: false }, question = null, answered = false, timers = [], quizMsg = null, quizStats = null;

    // ---------- Kreis zeichnen ----------
    const svg = svgEl('svg', { class: 'circle-svg', viewBox: '-265 -265 530 530' });
    const rotG = svgEl('g', { class: 'rot' });
    svg.appendChild(rotG);
    const P = (r, deg) => { const a = deg * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };
    const arc = (r1, r2, a1, a2) => {
      const [x1, y1] = P(r2, a1), [x2, y2] = P(r2, a2), [x3, y3] = P(r1, a2), [x4, y4] = P(r1, a1);
      return `M${x1},${y1} A${r2},${r2} 0 0 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 0 0 ${x4},${y4} Z`;
    };
    const segs = CIRCLE.map((k, i) => {
      const a = i * 30, mk = (cls, r1, r2, text, rText) => {
        const g = svgEl('g', { class: 'seg ' + cls });
        g.appendChild(svgEl('path', { d: arc(r1, r2, a - 15, a + 15) }));
        const [x, y] = P(rText, a);
        const t = svgEl('text', { x, y, style: `transform-box: fill-box; transform-origin: center; transform: rotate(var(--counter, 0deg)); transition: transform 1s var(--ease)` });
        t.textContent = text;
        g.appendChild(t);
        g.addEventListener('click', () => onPick(i, cls === 'minor'));
        rotG.appendChild(g);
        return { g, t };
      };
      const majorText = k.alt ? rootSymbol(k.major) + '/' + rootSymbol(k.alt.major) : rootSymbol(k.major);
      const minorText = (k.alt ? rootSymbol(k.minor) : rootSymbol(k.minor)).toLowerCase();
      const major = mk('major', 168, 255, majorText, 205);
      const minor = mk('minor', 108, 166, minorText, 137);
      if (k.alt) major.t.style.fontSize = '17px';
      const sig = majorSignature(k.major);
      const [sx, sy] = P(242, a);
      const st = svgEl('text', { x: sx, y: sy, class: 'sig', style: `transform-box: fill-box; transform-origin: center; transform: rotate(var(--counter, 0deg)); transition: transform 1s var(--ease)` });
      st.textContent = k.alt ? '6♯/6♭' : sigText(sig).replace('keine', '0');
      rotG.appendChild(st);
      return { major, minor, sigEl: st };
    });
    const centerTitle = svgEl('text', { x: 0, y: -8, class: 'circle-center-title' });
    const centerSub = svgEl('text', { x: 0, y: 24, class: 'sig', style: 'font-size:13px' });
    svg.append(svgEl('circle', { r: 100, fill: 'var(--surface)', stroke: 'var(--line)' }), centerTitle, centerSub);

    const panel = h('div');
    const modeSeg = segmented([['explore', 'Entdecken'], ['quiz', 'Quiz']], set.mode, v => { set.mode = v; setup(); });
    root.append(h('section.stage.grow',
      h('div.row', modeSeg, h('span.spacer')),
      h('div.circle-wrap', h('div', svg), panel)));
    ctx.setSettings(() => [
      field('Fis-Dur / Ges-Dur', segmented([['sharp', 'Fis-Dur (6♯)'], ['flat', 'Ges-Dur (6♭)']], set.enharm, v => { set.enharm = v; if (set.mode === 'explore') showKey(); })),
      h('div.field-hint', 'Tippe im Kreis auf eine Tonart: außen Dur, innen Moll. Der Kreis dreht sich mit.')
    ]);

    function rotateTo(i) {
      let target = -i * 30;
      while (target - rot > 180) target -= 360;
      while (target - rot < -180) target += 360;
      rot = target;
      rotG.style.transform = `rotate(${rot}deg)`;
      svg.style.setProperty('--counter', `${-rot}deg`);
    }
    function clearMarks() { segs.forEach(s => ['major', 'minor'].forEach(r => s[r].g.classList.remove('sel', 'rel', 'nb', 'right', 'wrong'))); }
    function keyAt(i, minor) {
      const k = CIRCLE[i];
      if (k.alt && set.enharm === 'flat') return minor ? k.alt.minor : k.alt.major;
      return minor ? k.minor : k.major;
    }

    // ---------- Entdecken ----------
    function showKey() {
      const { i, minor } = sel;
      clearMarks();
      segs[i][minor ? 'minor' : 'major'].g.classList.add('sel');
      segs[i][minor ? 'major' : 'minor'].g.classList.add('rel');
      for (const j of [(i + 1) % 12, (i + 11) % 12]) segs[j][minor ? 'minor' : 'major'].g.classList.add('nb');
      rotateTo(i);
      const tonic = keyAt(i, minor);
      const majTonic = keyAt(i, false);
      const sig = majorSignature(majTonic);
      centerTitle.textContent = minor ? noteName(tonic).toLowerCase() : noteName(tonic);
      centerSub.textContent = sigText(sig) === 'keine' ? 'keine Vorzeichen' : sigText(sig);
      const scale = scaleNotes(tonic, minor ? 'minor' : 'major');
      const dom = keyAt((i + 1) % 12, minor), sub = keyAt((i + 11) % 12, minor);
      const staff = h('div.paper', { style: { minHeight: '120px', margin: '6px 0 4px' } }, h('div.staff'));
      const diat = minor ? MINOR_DIATONIC : DIATONIC.map(d => [d[0], d[1], d[3]]);
      panel.innerHTML = '';
      panel.append(h('div.key-info',
        h('h2', keyLabel(tonic, minor)),
        h('div.sub', 'Paralleltonart: ', h('b', keyLabel(keyAt(i, !minor), !minor))),
        staff,
        h('dl.kv',
          h('dt', 'Vorzeichen'), h('dd', sig ? `${sigText(sig)} – ${accNames(sig).join(', ')}` : 'keine'),
          h('dt', 'Tonleiter'), h('dd', scale.map(noteName).join(' · ')),
          h('dt', 'Dominante'), h('dd', keyLabel(dom, minor)),
          h('dt', 'Subdominante'), h('dd', keyLabel(sub, minor))),
        h('div.label-caps', 'Leitereigene Akkorde'),
        h('div.chord-row', diat.map(([iv, type, rn]) => {
          const r = transpose(tonic, IV[iv]);
          return h('button.chord-btn', { onclick: () => audio.playNotes(voiceChord(r, type, 'root').map(x => x.midi), { dur: 1.4, arpeggio: 0.03 }) },
            h('b', rootSymbol(r) + CHORDS[type].sym), h('small', rn));
        })),
        h('div.row', { style: { marginTop: '16px' } },
          h('button.btn', { onclick: () => playScale(tonic, minor) }, icon('play'), 'Tonleiter anhören'),
          h('button.btn.accent', { onclick: () => go(`#/scales?l=${tonic.l}&a=${tonic.a}&t=${minor ? 'minor' : 'major'}`) }, 'Tonleiter üben'))));
      drawStaff(staff.firstChild, { clef: 'treble', keySig: sig, notes: [], width: 260, minWidth: 200, maxHeight: '18vh' });
    }
    function playScale(tonic, minor) {
      const base = midiOf(tonic, pcOf(tonic) <= 6 ? 4 : 3);
      const ivs = scaleNotes(tonic, minor ? 'minor' : 'major').map(s => (pcOf(s) - pcOf(tonic) + 12) % 12);
      const notes = [...ivs.map(x => base + x), base + 12];
      audio.playNotes(notes, { dur: 0.32, vel: 0.65, arpeggio: 0.3 });
    }

    // ---------- Quiz ----------
    const QTYPES = ['sigCount', 'keyFromSig', 'relative', 'dominant', 'subdominant', 'accOrder'];
    function newQuestion() {
      answered = false;
      clearMarks();
      const type = pick(QTYPES);
      const i = Math.floor(Math.random() * 12);
      const minorAsk = Math.random() < 0.3;
      const k = keyAt(i, false);
      const sig = majorSignature(k);
      const q = { type, i };
      switch (type) {
        case 'sigCount': q.text = `Wie viele Vorzeichen hat ${keyLabel(k)}?`; q.answer = String(sig); q.buttons = true; break;
        case 'keyFromSig': q.text = `Welche Dur-Tonart hat ${sigText(sig).replace('keine', 'keine Vorzeichen')}?`; q.answer = { i, minor: false }; break;
        case 'relative':
          if (minorAsk) { q.text = `Was ist die Paralleltonart von ${keyLabel(keyAt(i, true), true)}?`; q.answer = { i, minor: false }; }
          else { q.text = `Was ist die Paralleltonart von ${keyLabel(k)}?`; q.answer = { i, minor: true }; }
          break;
        case 'dominant': q.text = `Was ist die Dominante von ${keyLabel(k)}?`; q.answer = { i: (i + 1) % 12, minor: false }; break;
        case 'subdominant': q.text = `Was ist die Subdominante von ${keyLabel(k)}?`; q.answer = { i: (i + 11) % 12, minor: false }; break;
        case 'accOrder': {
          const sharps = Math.random() < 0.5, n = 1 + Math.floor(Math.random() * 7);
          q.text = `Welches ist das ${n}. ${sharps ? 'Kreuz (♯)' : 'Be (♭)'} in der Reihenfolge?`;
          q.answer = String((sharps ? SHARP_ORDER : FLAT_ORDER)[n - 1]); q.letters = sharps ? 1 : -1;
          break;
        }
      }
      question = q;
      segs.forEach(s => { s.sigEl.style.opacity = type === 'keyFromSig' || type === 'sigCount' ? 0 : 1; });
      centerTitle.textContent = '?'; centerSub.textContent = '';
      renderQuiz();
    }
    function renderQuiz(feedback) {
      panel.innerHTML = '';
      const q = question;
      const stat = (l, v) => h('div.stat', h('div.v', v), h('div.l', l));
      const body = [h('p.quiz-q', q.text)];
      if (q.buttons) {
        const opts = ['0', ...[1, 2, 3, 4, 5, 6, 7].map(String), ...[-1, -2, -3, -4, -5, -6, -7].map(String)];
        body.push(h('div.answers', opts.map(v => h('button.btn', { dataset: { v }, onclick: e => answerValue(v, e.currentTarget) }, sigText(+v).replace('keine', '0')))));
      } else if (q.letters) {
        body.push(h('div.answers', LETTERS.map((L, l) => h('button.btn', { dataset: { v: String(l) }, onclick: e => answerValue(String(l), e.currentTarget) }, noteName({ l, a: q.letters })))));
      } else body.push(h('div.info-box', 'Tippe die Antwort im Quintenzirkel an – oder spiel den Grundton auf dem Klavier.'));
      quizMsg = h('div.msg' + (feedback ? '.' + feedback.cls + '.pop' : '.muted'), { style: { margin: '16px 0', minHeight: '30px' } }, feedback ? feedback.text : '');
      quizStats = h('div.stats', { style: { gridTemplateColumns: 'repeat(3, 1fr)' } }, stat('richtig', S.hits), stat('Serie', S.streak), stat('Quote', S.hits + S.fails ? Math.round(100 * S.hits / (S.hits + S.fails)) + '%' : '–'));
      body.push(quizMsg, quizStats);
      body.push(h('div.row.end', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: newQuestion }, 'Nächste Frage', icon('skip'))));
      panel.append(h('div', body));
    }
    function result(ok, explain, el) {
      if (answered) return;
      answered = true;
      if (ok) { S.hits++; S.streak++; bumpProgress('circle', { correct: 1, total: 1, streak: S.streak }); }
      else { S.fails++; S.streak = 0; bumpProgress('circle', { total: 1 }); }
      const QT = { sigCount: 'Vorzeichen zählen', keyFromSig: 'Tonart aus Vorzeichen', relative: 'Paralleltonart', dominant: 'Dominante', subdominant: 'Subdominante', accOrder: 'Reihenfolge der Vorzeichen' };
      record('circle', question.type, { ok, base: 4, streak: S.streak, label: QT[question.type] || question.type });
      if (el) burst(el, { count: ok ? 16 : 0 });
      quizMsg.className = 'msg pop ' + (ok ? 'ok' : 'bad');
      quizMsg.textContent = (ok ? 'Richtig! ' : 'Leider nein. ') + explain;
      const v = quizStats.querySelectorAll('.v');
      setNum(v[0], S.hits); setNum(v[1], S.streak); setNum(v[2], Math.round(100 * S.hits / (S.hits + S.fails)) + '%');
      timers.push(setTimeout(() => { if (set.mode === 'quiz' && answered && question) newQuestion(); }, ok ? 1600 : 3200));
    }
    function explanation() {
      const q = question, k = keyAt(q.i, false), sig = majorSignature(k);
      switch (q.type) {
        case 'sigCount': return `${keyLabel(k)} hat ${sigText(sig).replace('keine', 'keine Vorzeichen')}${sig ? ' (' + accNames(sig).join(', ') + ')' : ''}.`;
        case 'keyFromSig': return `Das ist ${keyLabel(k)}.`;
        case 'relative': return q.answer.minor ? `${keyLabel(k)} ↔ ${keyLabel(keyAt(q.i, true), true)}.` : `${keyLabel(keyAt(q.i, true), true)} ↔ ${keyLabel(k)}.`;
        case 'dominant': return `Eine Quinte über ${noteName(k)} liegt ${keyLabel(keyAt(q.answer.i, false))}.`;
        case 'subdominant': return `Eine Quinte unter ${noteName(k)} liegt ${keyLabel(keyAt(q.answer.i, false))}.`;
        case 'accOrder': return (q.letters > 0 ? 'Kreuze: ' : 'Bes: ') + accNames(q.letters * 7).join(' – ');
      }
    }
    function answerValue(v, el) {
      if (answered) return;
      const ok = v === question.answer;
      el.classList.add(ok ? 'right' : 'wrong');
      if (!ok) panel.querySelector(`.answers [data-v="${question.answer}"]`)?.classList.add('right');
      if (question.type === 'sigCount') { segs[question.i].major.g.classList.add('sel'); rotateTo(question.i); }
      result(ok, explanation(), el);
    }
    function answerCircle(i, minor) {
      if (answered || !question || !question.answer || typeof question.answer !== 'object') return;
      const a = question.answer;
      const ok = a.i === i && a.minor === minor;
      const segOf = (j, m) => segs[j][m ? 'minor' : 'major'].g;
      segOf(i, minor).classList.add(ok ? 'right' : 'wrong');
      if (!ok) segOf(a.i, a.minor).classList.add('right');
      rotateTo(a.i);
      result(ok, explanation(), segOf(i, minor));
    }

    function onPick(i, minor) {
      if (set.mode === 'explore') { sel = { i, minor }; showKey(); }
      else answerCircle(i, minor);
    }
    function onNote({ midi }) {
      if (set.mode !== 'quiz' || answered || !question || typeof question.answer !== 'object') return;
      const a = question.answer;
      // gespielter Grundton → passende Position suchen
      const p = pc(midi);
      const idx = CIRCLE.findIndex((k, j) => pcOf(keyAt(j, a.minor)) === p);
      if (idx >= 0) answerCircle(idx, a.minor);
    }

    function setup() {
      timers.forEach(clearTimeout); timers = [];
      segs.forEach(s => { s.sigEl.style.opacity = 1; });
      if (set.mode === 'explore') { question = null; showKey(); }
      else { rotateTo(0); newQuestion(); }
    }
    const off = input.on('noteon', onNote);
    setup();
    return () => { off(); timers.forEach(clearTimeout); };
  }
};
