// Modus: Bibliothek – Noten (MusicXML/MXL) und MIDI hochladen, anhören, im Warte-Modus mitspielen, als MIDI exportieren.
// PDF und Fotos werden gespeichert; die automatische Notenerkennung (OMR) folgt mit dem Raspberry-Pi-Server.
import { h, icon, burst, toast, segmented, field, setNum, loadScript } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { library, bumpProgress } from '../core/store.js';
import { midiName } from '../core/music.js';
import { go } from '../app.js';

const OSMD_URL = 'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.8.9/build/opensheetmusicdisplay.min.js';
const MIDI_URL = 'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js';
const TYPE_LABEL = { musicxml: 'MusicXML', mxl: 'MXL', midi: 'MIDI', pdf: 'PDF', image: 'Foto' };

// ---------- Dateien erkennen & einlesen ----------
function detect(file, buf) {
  const b = new Uint8Array(buf.slice(0, 8));
  const s = String.fromCharCode(...b);
  if (s.startsWith('MThd')) return 'midi';
  if (s.startsWith('PK')) return 'mxl';
  if (s.startsWith('%PDF')) return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  const head = new TextDecoder().decode(buf.slice(0, 2000));
  if (/<score-(partwise|timewise)/.test(head) || /\.(musicxml|xml)$/i.test(file.name)) return 'musicxml';
  return null;
}
export async function importFile(file) {
  const buf = await file.arrayBuffer();
  const type = detect(file, buf);
  if (!type) throw new Error(`${file.name}: Format nicht erkannt`);
  let title = file.name.replace(/\.[^.]+$/, '');
  let meta = '';
  if (type === 'musicxml') {
    const txt = new TextDecoder().decode(buf);
    const m = txt.match(/<work-title>([^<]+)<\/work-title>/) || txt.match(/<movement-title>([^<]+)<\/movement-title>/);
    if (m) title = m[1].trim();
    const c = txt.match(/<creator[^>]*type="composer"[^>]*>([^<]+)</);
    if (c) meta = c[1].trim();
  } else if (type === 'midi') {
    try {
      await loadScript(MIDI_URL);
      const M = window.Midi.Midi || window.Midi;
      const mid = new M(buf);
      if (mid.name) title = mid.name;
      const n = mid.tracks.reduce((a, t) => a + t.notes.length, 0);
      meta = `${n} Noten · ${Math.round(mid.duration)} s`;
    } catch {}
  }
  const song = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), title, meta, type, fileName: file.name, size: file.size, data: buf, added: Date.now(), status: (type === 'pdf' || type === 'image') ? 'omr-pending' : 'ready' };
  await library.put(song);
  return song;
}
const binStr = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return s; };

// ---------- Song-Modell: steps = [{ t (s), notes: [{ midi, dur, staff, vel }] }] ----------
function stepsFromOSMD(osmd) {
  const sheet = osmd.Sheet;
  const bpm = sheet.DefaultStartTempoInBpm || sheet.userStartTempoInBPM || 100;
  const c = osmd.cursor;
  c.reset();
  const steps = [];
  const wholeSec = 4 * 60 / bpm;
  let guard = 0;
  while (!c.Iterator.EndReached && guard++ < 20000) {
    const ts = c.Iterator.currentTimeStamp.RealValue;
    const notes = [];
    for (const ve of c.Iterator.CurrentVoiceEntries || []) {
      for (const n of ve.Notes) {
        if (n.isRest() || !n.Pitch) continue;
        if (n.NoteTie && n.NoteTie.StartNote !== n) continue;
        const len = n.NoteTie ? n.NoteTie.Notes.reduce((a, x) => a + x.Length.RealValue, 0) : n.Length.RealValue;
        const staffIdx = n.ParentStaff ? n.ParentStaff.idInMusicSheet : 0;
        notes.push({ midi: n.halfTone + 12, dur: len * wholeSec, staff: staffIdx > 0 ? 1 : 0, vel: 0.7 });
      }
    }
    steps.push({ t: ts * wholeSec, notes });
    c.next();
  }
  c.reset();
  return { steps, bpm };
}
function stepsFromMidi(buf) {
  const M = window.Midi.Midi || window.Midi;
  const mid = new M(buf);
  const tracks = mid.tracks.filter(t => t.notes.length && t.channel !== 9);
  const all = [];
  tracks.forEach((t, ti) => t.notes.forEach(n => all.push({ midi: n.midi, t: n.time, dur: n.duration, vel: n.velocity, staff: tracks.length > 1 ? (ti === 0 ? 0 : 1) : (n.midi < 60 ? 1 : 0) })));
  all.sort((a, b) => a.t - b.t || a.midi - b.midi);
  const steps = [];
  for (const n of all) {
    const last = steps[steps.length - 1];
    if (last && n.t - last.t < 0.035) last.notes.push(n); else steps.push({ t: n.t, notes: [n] });
  }
  const bpm = mid.header.tempos[0] ? mid.header.tempos[0].bpm : 120;
  return { steps, bpm, title: mid.name };
}

/** Standard-MIDI-Datei (Typ 1, zwei Spuren: rechte/linke Hand) */
export function writeMidi(steps, title) {
  const PPQ = 480, BPM = 120, tps = PPQ * BPM / 60;
  const vlq = n => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
  const str = s => [...new TextEncoder().encode(s)];
  const track = (events, name) => {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const bytes = [0x00, 0xff, 0x03, ...vlq(str(name).length), ...str(name)];
    let last = 0;
    for (const e of events) { bytes.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
    bytes.push(0x00, 0xff, 0x2f, 0x00);
    return [0x4d, 0x54, 0x72, 0x6b, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes];
  };
  const tempo = 60000000 / BPM;
  const conductor = [{ tick: 0, order: 0, data: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] }];
  const hands = [[], []];
  for (const s of steps) for (const n of s.notes) {
    const on = Math.round(s.t * tps), off = Math.round((s.t + Math.max(0.05, n.dur)) * tps);
    const ch = n.staff ? 1 : 0;
    hands[n.staff ? 1 : 0].push({ tick: on, order: 1, data: [0x90 | ch, n.midi, Math.round((n.vel || 0.7) * 127)] }, { tick: off, order: 0, data: [0x80 | ch, n.midi, 0] });
  }
  const tracks = [track(conductor, title || 'Notentrainer'), track(hands[0], 'Rechte Hand'), track(hands[1], 'Linke Hand')];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Blob([new Uint8Array([...header, ...tracks.flat()])], { type: 'audio/midi' });
}

// ====================================================================
export default {
  mount(root, ctx) {
    const id = ctx.route.params[0];
    return id ? player(root, ctx, id) : list(root, ctx);
  }
};

// ---------- Liste ----------
function list(root, ctx) {
  const grid = h('div.song-list');
  const fileIn = h('input', { type: 'file', multiple: true, accept: '.xml,.musicxml,.mxl,.mid,.midi,.pdf,image/*', hidden: true, onchange: () => handle(fileIn.files) });
  const drop = h('div.dropzone', { onclick: () => fileIn.click() },
    icon('upload'), h('b', 'Noten hochladen'),
    h('div', 'MusicXML (.musicxml, .mxl), MIDI (.mid) – oder PDF/Foto für die spätere Notenerkennung'));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => handle(e.dataTransfer.files));

  root.append(
    h('section.stage', drop, fileIn,
      h('div.info-box', h('b', 'Tipp: '), 'Aus MuseScore, Sibelius, Finale oder Dorico als ', h('b', 'MusicXML'), ' exportieren – dann sind alle Informationen (Noten, Hände, Tempo) dabei. ',
        'PDFs und Fotos werden schon gespeichert; die automatische Umwandlung in MIDI kommt mit dem Raspberry-Pi-Server.')),
    h('div.row', h('div.label-caps', { style: { margin: '8px 4px 0' } }, 'Deine Stücke'), h('span.spacer'),
      h('button.btn.ghost', { onclick: addDemo }, icon('sparkle'), 'Beispielstück hinzufügen')),
    grid);

  async function handle(files) {
    for (const f of files) {
      try { const s = await importFile(f); toast(`„${s.title}“ hinzugefügt`); }
      catch (e) { toast(e.message); }
    }
    refresh();
  }
  async function addDemo() {
    const r = await fetch('demo/ode-an-die-freude.musicxml');
    const blob = await r.blob();
    await handle([new File([blob], 'ode-an-die-freude.musicxml', { type: 'application/xml' })]);
  }
  async function refresh() {
    const songs = await library.all();
    grid.innerHTML = '';
    if (!songs.length) { grid.append(h('div.empty', 'Noch keine Stücke. Lade eine Datei hoch oder füge das Beispielstück hinzu.')); return; }
    songs.forEach((s, i) => {
      const tagCls = s.status === 'omr-pending' ? '.wait' : s.type === 'midi' ? '.midi' : '.xml';
      grid.append(h('div.song', { style: { '--i': i }, onclick: () => go('#/library/' + s.id) },
        h('h5', s.title),
        h('div.sub', s.meta || s.fileName),
        h('div.row', { style: { gap: '6px', marginTop: '4px' } },
          h('span.tag' + tagCls, TYPE_LABEL[s.type] || s.type),
          s.status === 'omr-pending' ? h('span.tag.wait', 'Erkennung folgt') : '',
          h('span.sub', new Date(s.added).toLocaleDateString('de-DE'))),
        h('button.del', { 'aria-label': 'Löschen', onclick: async e => { e.stopPropagation(); if (confirm(`„${s.title}“ löschen?`)) { await library.remove(s.id); refresh(); } } }, icon('trash'))));
    });
  }
  refresh();
}

// ---------- Player ----------
function player(root, ctx, id) {
  let song = null, steps = [], view = null, mode = 'idle', pos = 0, hand = 'both', tempo = 1, playTimer = null, raf = 0, destroyed = false;
  let satisfied = new Set(), stats = { ok: 0, bad: 0 }, startClock = 0, startT = 0, scheduled = [];
  const kb = new Keyboard({ from: 36, to: 84 });
  const display = h('div', h('div.spinner'));
  const timeline = h('div.timeline', h('div'));
  const okEl = h('div.v', '0'), badEl = h('div.v', '0'), progEl = h('div.v', '0%');
  const msg = h('div.msg.muted', '');
  const playBtn = h('button.btn.accent', { onclick: () => mode === 'play' ? stopAll() : startPlay() }, icon('play'), 'Anhören');
  const practiceBtn = h('button.btn.primary', { onclick: () => mode === 'wait' ? stopAll() : startWait() }, icon('hand'), 'Üben');
  const tempoLabel = h('span', '100 %');
  const tempoIn = h('input', { type: 'range', min: 40, max: 150, step: 5, value: 100, oninput: () => { tempo = +tempoIn.value / 100; tempoLabel.textContent = tempoIn.value + ' %'; } });
  const handSeg = segmented([['both', 'Beide Hände'], ['0', 'Rechts'], ['1', 'Links']], 'both', v => { hand = v; if (mode === 'wait') { stopAll(); startWait(); } });
  const exportBtn = h('button.btn.ghost', { onclick: exportMidi, hidden: true }, icon('download'), 'MIDI');

  root.append(
    h('section.stage.grow',
      h('div.player-bar', playBtn, practiceBtn, handSeg,
        h('label.tempo', icon('metronome'), tempoIn, tempoLabel), h('span.spacer'), exportBtn),
      timeline, display,
      h('div.feedback', msg, h('div.stats', { style: { gridTemplateColumns: 'repeat(3, minmax(70px, 1fr))', flex: '0 0 auto' } },
        h('div.stat', okEl, h('div.l', 'richtig')), h('div.stat', badEl, h('div.l', 'daneben')), h('div.stat', progEl, h('div.l', 'Fortschritt')))),
      kb.el));

  (async () => {
    song = await library.get(id);
    if (!song) { display.innerHTML = ''; display.append(h('div.empty', 'Stück nicht gefunden.')); return; }
    ctx.setTitle(song.title, TYPE_LABEL[song.type]);
    try {
      if (song.type === 'musicxml' || song.type === 'mxl') await setupScore();
      else if (song.type === 'midi') await setupRoll();
      else return setupFile();
      exportBtn.hidden = false;
      const all = steps.flatMap(s => s.notes.map(n => n.midi));
      kb.fit(all);
      msg.textContent = `${steps.filter(s => s.notes.length).length} Schritte · ${Math.round(totalTime())} s`;
    } catch (e) {
      console.error(e);
      display.innerHTML = ''; display.append(h('div.empty', 'Die Datei konnte nicht gelesen werden: ' + e.message));
    }
  })();

  // ---------- Darstellungen ----------
  async function setupScore() {
    await loadScript(OSMD_URL);
    display.innerHTML = '';
    const box = h('div.score-box');
    display.append(box);
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(box, { autoResize: true, backend: 'svg', drawTitle: true, followCursor: true, drawPartNames: false, cursorsOptions: [{ type: 0, color: '#4f46e5', alpha: 0.45, follow: true }] });
    await osmd.load(song.type === 'mxl' ? binStr(song.data) : new TextDecoder().decode(song.data));
    osmd.render();
    const r = stepsFromOSMD(osmd);
    steps = r.steps;
    osmd.cursor.show();
    view = {
      kind: 'score',
      cursorIndex: 0,
      goto(i) {
        if (i < this.cursorIndex) { osmd.cursor.reset(); this.cursorIndex = 0; }
        while (this.cursorIndex < i && !osmd.cursor.Iterator.EndReached) { osmd.cursor.next(); this.cursorIndex++; }
      },
      reset() { osmd.cursor.reset(); this.cursorIndex = 0; },
      destroy() { try { osmd.clear(); } catch {} }
    };
  }
  async function setupRoll() {
    await loadScript(MIDI_URL);
    steps = stepsFromMidi(song.data).steps;
    display.innerHTML = '';
    const canvas = h('canvas.roll');
    display.append(canvas);
    let viewT = 0;
    const draw = () => {
      if (destroyed) return;
      const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue('--accent').trim(), ok = css.getPropertyValue('--ok').trim(), line = css.getPropertyValue('--line-strong').trim();
      // Zielzeit: im Warte-Modus der aktuelle Schritt, sonst Uhr
      const target = mode === 'play' ? currentTime() : (steps[pos] ? steps[pos].t : 0);
      viewT += (target - viewT) * (mode === 'play' ? 1 : 0.18);
      const pps = 140;
      const hit = H - 6;
      // Tastenpositionen der sichtbaren Klaviatur übernehmen (sie ist zentriert und kann schmaler sein)
      const kr = kb.svg.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      const scale = Math.min(kr.width / kb.width, kr.height / 120), off = kr.left - cr.left + (kr.width - kb.width * scale) / 2;
      const keyX = k => off + k.x * scale;
      for (let m = kb.from; m <= kb.to; m++) if (m % 12 === 0 && kb.keys[m]) { g.fillStyle = line; g.fillRect(keyX(kb.keys[m]) - 12 * scale, 0, 1, H); }
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const y0 = hit - (s.t - viewT) * pps;
        if (y0 < -400) break;
        for (const n of s.notes) {
          const k = kb.keys[n.midi]; if (!k) continue;
          const len = Math.max(6, n.dur * pps);
          const yTop = y0 - len;
          if (y0 < -10 || yTop > H) continue;
          const w = (k.black ? 12 : 18) * scale;
          const x = keyX(k) - w / 2;
          const mine = hand === 'both' || String(n.staff) === hand;
          const done = i < pos && mode === 'wait';
          g.globalAlpha = done ? 0.25 : mine ? 1 : 0.35;
          g.fillStyle = mode === 'wait' && i === pos && mine ? (satisfied.has(n.midi) ? ok : accent) : n.staff ? '#14b8a6' : accent;
          g.beginPath(); g.roundRect(x, yTop, w, len, 4); g.fill();
        }
      }
      g.globalAlpha = 1;
      g.fillStyle = accent; g.fillRect(0, hit, W, 2);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    view = { kind: 'roll', goto() {}, reset() { viewT = 0; }, destroy() { cancelAnimationFrame(raf); } };
  }
  function setupFile() {
    display.innerHTML = '';
    const url = URL.createObjectURL(new Blob([song.data], { type: song.type === 'pdf' ? 'application/pdf' : 'image/*' }));
    display.append(
      h('div.info-box', { style: { marginBottom: '12px' } }, h('b', 'Notenerkennung folgt: '), 'Diese Datei ist gespeichert. Sobald der Raspberry-Pi-Server läuft, wird sie automatisch in MusicXML/MIDI umgewandelt (z. B. mit Audiveris) und erscheint dann hier zum Mitspielen.'),
      song.type === 'pdf' ? h('iframe', { src: url, style: { width: '100%', height: '60vh', border: 0, borderRadius: '14px', background: '#fff' } })
        : h('img', { src: url, style: { maxWidth: '100%', borderRadius: '14px' } }));
    [playBtn, practiceBtn].forEach(b => b.disabled = true);
  }

  const totalTime = () => { const l = steps[steps.length - 1]; return l ? l.t + Math.max(0, ...l.notes.map(n => n.dur), 0) : 0; };
  const currentTime = () => mode === 'play' ? startT + (audio.now - startClock) * tempo : (steps[pos] ? steps[pos].t : 0);
  function setProgress() {
    const p = steps.length ? Math.min(1, pos / steps.length) : 0;
    timeline.firstChild.style.width = (p * 100) + '%';
    setNum(progEl, Math.round(p * 100) + '%');
  }
  function sound(n, atCtx, dur) {
    const delay = Math.max(0, atCtx - audio.now);
    if (!input.sendNote(n.midi, (n.vel || 0.7) * 110, performance.now() + delay * 1000, dur * 1000)) audio.piano(n.midi, atCtx, dur, n.vel || 0.7);
  }

  // ---------- Anhören ----------
  function startPlay() {
    stopAll();
    audio.ensure();
    mode = 'play';
    if (pos >= steps.length - 1) pos = 0;
    startClock = audio.now + 0.1; startT = steps[pos] ? steps[pos].t : 0;
    view.goto(pos);
    playBtn.innerHTML = ''; playBtn.append(icon('stop'), 'Stopp');
    let i = pos;
    playTimer = setInterval(() => {
      const now = audio.now;
      while (i < steps.length) {
        const s = steps[i];
        const at = startClock + (s.t - startT) / tempo;
        if (at > now + 0.15) break;
        for (const n of s.notes) sound(n, at, n.dur / tempo);
        const idx = i;
        scheduled.push(setTimeout(() => {
          if (mode !== 'play') return;
          pos = idx; view.goto(idx); setProgress();
          kb.clear('chord');
          for (const n of steps[idx].notes) kb.flash(n.midi, 'chord', Math.max(120, n.dur / tempo * 1000));
        }, Math.max(0, (at - now) * 1000)));
        i++;
      }
      if (i >= steps.length && now > startClock + (totalTime() - startT) / tempo + 0.5) { stopAll(); pos = 0; view.reset(); setProgress(); }
    }, 30);
  }

  // ---------- Warte-Modus ----------
  const mine = n => hand === 'both' || String(n.staff) === hand;
  function startWait() {
    stopAll();
    audio.ensure();
    mode = 'wait';
    stats = { ok: 0, bad: 0 }; setNum(okEl, 0); setNum(badEl, 0);
    pos = 0; view.reset();
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('stop'), 'Beenden');
    msg.textContent = 'Spiel die markierten Töne – die App wartet auf dich.'; msg.className = 'msg muted';
    enterStep();
  }
  function enterStep() {
    // Schritte ohne eigene Töne spielt die App selbst (andere Hand / Pausen) – im Rhythmus
    while (pos < steps.length && !steps[pos].notes.some(mine)) {
      const s = steps[pos];
      for (const n of s.notes) sound(n, audio.now + 0.01, n.dur / tempo);
      const nxt = steps[pos + 1];
      pos++;
      if (nxt) { view.goto(pos); setProgress(); playTimer = setTimeout(enterStep, Math.min(1500, (nxt.t - s.t) / tempo * 1000)); return; }
    }
    if (pos >= steps.length) return finish();
    view.goto(pos); setProgress();
    satisfied = new Set();
    kb.clear('target'); kb.clear('chord'); kb.clearLabels();
    const s = steps[pos];
    for (const n of s.notes) {
      if (mine(n)) { kb.mark(n.midi, 'target'); kb.label(n.midi, midiName(n.midi).replace(/\d+$/, '')); }
      else sound(n, audio.now + 0.01, n.dur / tempo);
    }
  }
  function onNote({ midi }) {
    if (mode !== 'wait' || pos >= steps.length) return;
    const want = steps[pos].notes.filter(mine).map(n => n.midi);
    if (want.includes(midi)) {
      satisfied.add(midi);
      stats.ok++; setNum(okEl, stats.ok);
      kb.unmark(midi, 'target'); kb.flash(midi, 'ok', 300);
      if (want.every(m => satisfied.has(m))) {
        const prev = steps[pos];
        pos++;
        const nxt = steps[pos];
        // im Warte-Modus sofort weiter – mit kurzer rhythmischer Andeutung bei Pausen
        const gap = nxt ? Math.min(0.25, Math.max(0, (nxt.t - prev.t) / tempo - 0.4)) : 0;
        playTimer = setTimeout(() => enterStep(), gap * 1000);
      }
    } else {
      stats.bad++; setNum(badEl, stats.bad);
      kb.flash(midi, 'bad', 500);
    }
  }
  function finish() {
    const acc = stats.ok + stats.bad ? Math.round(100 * stats.ok / (stats.ok + stats.bad)) : 100;
    mode = 'idle';
    kb.clear(); kb.clearLabels();
    pos = steps.length; setProgress();
    msg.textContent = `Geschafft! ${acc} % Treffergenauigkeit 🎉`; msg.className = 'msg ok pop';
    burst(display, { count: 34, spread: 200 });
    bumpProgress('library', { total: 1, correct: acc >= 90 ? 1 : 0 });
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('hand'), 'Nochmal üben');
  }

  function stopAll() {
    clearInterval(playTimer); clearTimeout(playTimer); playTimer = null;
    scheduled.forEach(clearTimeout); scheduled = [];
    input.allNotesOff();
    if (mode !== 'idle') { kb.clear('target'); kb.clear('chord'); kb.clearLabels(); }
    mode = 'idle';
    playBtn.innerHTML = ''; playBtn.append(icon('play'), 'Anhören');
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('hand'), 'Üben');
  }
  function exportMidi() {
    const blob = writeMidi(steps, song.title);
    const a = h('a', { href: URL.createObjectURL(blob), download: song.title.replace(/[^\w\- äöüÄÖÜß]/g, '') + '.mid' });
    document.body.append(a); a.click(); a.remove();
    toast('MIDI-Datei erstellt');
  }

  const off = input.on('noteon', onNote);
  return () => { destroyed = true; stopAll(); off(); kb.destroy(); view && view.destroy(); };
}
