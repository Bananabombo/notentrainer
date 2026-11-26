// Modus: Bibliothek – Noten (MusicXML/MXL) und MIDI hochladen, anhören, im Warte-Modus mitspielen, als MIDI exportieren.
// PDF und Fotos: mit Konto erkennt der Tonika-Server sie automatisch (Audiveris) und liefert MusicXML zurück.
import { h, icon, burst, toast, segmented, field, setNum, loadScript, sheet } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio, Metronome } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { library, account, bumpProgress, persisted, prefs } from '../core/store.js';
import { musicXmlText } from '../core/unzip.js';
import { scoreMarks, analyze } from '../core/perform.js';
import { record } from '../core/stats.js';
import { midiName } from '../core/music.js';
import { playOrder, measuresFromOSMD, applyFixes, describeJumps } from '../core/repeats.js';
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
  let meta = '', composer = '';
  if (type === 'musicxml') {
    const txt = new TextDecoder().decode(buf);
    const m = txt.match(/<work-title>([^<]+)<\/work-title>/) || txt.match(/<movement-title>([^<]+)<\/movement-title>/);
    if (m) title = m[1].trim();
    const c = txt.match(/<creator[^>]*type="composer"[^>]*>([^<]+)</);
    if (c) composer = c[1].trim();
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
  const song = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), title, meta, composer, type, fileName: file.name, size: file.size, data: buf, added: Date.now(), status: (type === 'pdf' || type === 'image') ? 'omr-pending' : 'ready' };
  const saved = await library.put(song);
  return saved && saved.id ? saved : song;
}
const OMR_ACTIVE = st => st === 'omr-queued' || st === 'omr-running';
function statusTag(s) {
  if (s.status === 'omr-queued') return h('span.tag.run', 'In Warteschlange');
  if (s.status === 'omr-running') return h('span.tag.run', 'Wird erkannt …');
  if (s.status === 'omr-failed') return h('span.tag.fail', 'Nicht erkannt');
  if (s.status === 'omr-pending') return h('span.tag.wait', account.server ? 'Anmelden zum Erkennen' : 'Erkennung braucht Server');
  if (s.origType && s.origType !== s.type) return h('span.tag', 'aus ' + (TYPE_LABEL[s.origType] || s.origType));
  return '';
}
const binStr = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return s; };

// ---------- Song-Modell: steps = [{ t (s), notes: [{ midi, dur, staff, vel }] }] ----------
function stepsFromOSMD(osmd, fix) {
  const sheet = osmd.Sheet;
  let bpm = sheet.DefaultStartTempoInBpm || sheet.userStartTempoInBPM || 100;
  if (!(bpm >= 30 && bpm <= 400)) bpm = 100; // unplausible Angaben (z. B. Lesefehler) nicht übernehmen
  const c = osmd.cursor;
  c.reset();
  // 1) Noten der Reihe nach einsammeln – mit Takt und Cursor-Position
  const linear = [];
  const wholeSec = 4 * 60 / bpm;
  let guard = 0, ci = 0;
  while (!c.Iterator.EndReached && guard++ < 20000) {
    const ts = c.Iterator.currentTimeStamp.RealValue;
    const mi = c.Iterator.CurrentMeasureIndex;
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
    linear.push({ ts, mi, ci, notes });
    c.next(); ci++;
  }
  c.reset();
  // 2) Takte in Abspielreihenfolge (Wiederholungen, Volten, D.C./D.S., Coda) aneinanderreihen
  const ms = sheet.SourceMeasures;
  const startOf = i => ms[i].AbsoluteTimestamp.RealValue;
  const lenOf = i => i + 1 < ms.length ? startOf(i + 1) - startOf(i) : ms[i].Duration.RealValue;
  const byMeasure = new Map();
  for (const st of linear) { if (!byMeasure.has(st.mi)) byMeasure.set(st.mi, []); byMeasure.get(st.mi).push(st); }
  let order, info = null;
  try { info = applyFixes(measuresFromOSMD(sheet), fix); order = playOrder(info); } catch (e) { console.warn('Wiederholungen nicht auswertbar', e); order = null; }
  if (!order || !order.length) order = ms.map((_, i) => i);
  const steps = [], beats = [];
  let tAcc = 0;
  for (const mi of order) {
    for (const st of byMeasure.get(mi) || []) steps.push({ t: (tAcc + st.ts - startOf(mi)) * wholeSec, ci: st.ci, mi, w: st.ts - startOf(mi), notes: st.notes });
    // Schlagraster fürs Metronom (6/8, 9/8, 12/8 in punktierten Vierteln)
    const ts = ms[mi].ActiveTimeSignature;
    const { unit, perBar } = beatUnit(ts ? ts.Numerator : 4, ts ? ts.Denominator : 4);
    const n = Math.max(1, Math.round(lenOf(mi) / unit));
    for (let b = 0; b < n; b++) beats.push({ t: (tAcc + b * unit) * wholeSec, accent: b === 0 && n === perBar });
    tAcc += lenOf(mi);
  }
  const ts0 = ms[0] && ms[0].ActiveTimeSignature;
  const meter = beatUnit(ts0 ? ts0.Numerator : 4, ts0 ? ts0.Denominator : 4);
  const repeats = order.length !== ms.length || order.some((m, i) => m !== i);
  return { steps, bpm, beats, meter, repeats, playedMeasures: order.length, jumps: info ? describeJumps(info) : null, measures: ms.length };
}
function beatUnit(num, den) {
  if (den === 8 && num % 3 === 0 && num >= 6) return { unit: 3 / 8, perBar: num / 3 };
  return { unit: 1 / (den || 4), perBar: num || 4 };
}
/** Pixel-Positionen aller Cursor-Schritte vorab berechnen – dann ist das Weiterrücken beim Spielen kostenlos */
function cursorPositions(osmd) {
  const c = osmd.cursor, u = 10 * (osmd.zoom || 1), out = [], systems = new Map();
  c.hide(); c.reset();
  let guard = 0, prev = null;
  while (!c.Iterator.EndReached && guard++ < 20000) {
    let p = null;
    try {
      let best = null;
      for (const ve of c.Iterator.CurrentVisibleVoiceEntries() || []) {
        const g = c.getStaffEntryFromVoiceEntry(ve);
        if (g && (!best || g.PositionAndShape.AbsolutePosition.x < best.PositionAndShape.AbsolutePosition.x)) best = g;
      }
      if (best) {
        const sys = best.parentMeasure.ParentMusicSystem, sy = sys.PositionAndShape.AbsolutePosition.y;
        const l0 = sys.StaffLines[0], l1 = sys.StaffLines[sys.StaffLines.length - 1];
        const top = sy + l0.PositionAndShape.RelativePosition.y, bot = sy + l1.PositionAndShape.RelativePosition.y + l1.StaffHeight;
        const pm = best.parentMeasure.PositionAndShape;
        if (!systems.has(sys)) systems.set(sys, systems.size);
        p = { x: best.PositionAndShape.AbsolutePosition.x * u, top: top * u, h: (bot - top) * u, mx: pm.AbsolutePosition.x * u, mw: pm.Size.width * u, sys: systems.get(sys) };
      }
    } catch {}
    out.push(p || prev || { x: 0, top: 0, h: 0, mx: 0, mw: 0, sys: 0 });
    prev = out[out.length - 1];
    c.next();
  }
  c.reset();
  return out;
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
  const tracks = [track(conductor, title || 'Tonika'), track(hands[0], 'Rechte Hand'), track(hands[1], 'Linke Hand')];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Blob([new Uint8Array([...header, ...tracks.flat()])], { type: 'audio/midi' });
}

// ====================================================================
export default {
  mount(root, ctx) {
    const id = ctx.route.params[0];
    if (id && ctx.route.params[1] === 'edit') {
      // Editor wird nachgeladen; Aufräumen auch dann, wenn man vorher schon weg ist
      let cleanup = null, left = false;
      root.append(h('div.ed-loading', h('div.spinner'), h('div.muted', 'Editor wird geladen …')));
      import('../editor/editor.js').then(m => m.mountEditor(root, ctx, id)).then(fn => { cleanup = fn; if (left && fn) fn(); });
      return () => { left = true; if (cleanup) cleanup(); };
    }
    return id ? player(root, ctx, id) : list(root, ctx);
  }
};

// ---------- Liste ----------
function list(root, ctx) {
  const grid = h('div.song-list');
  const fileIn = h('input', { type: 'file', multiple: true, accept: '.xml,.musicxml,.mxl,.mid,.midi,.pdf,image/*', hidden: true, onchange: () => handle(fileIn.files) });
  const drop = h('div.dropzone', { onclick: () => fileIn.click() },
    icon('upload'), h('b', 'Noten hochladen'),
    h('div', account.user ? 'MusicXML (.musicxml, .mxl), MIDI (.mid), PDF oder Foto – PDFs und Fotos werden automatisch erkannt' : 'MusicXML (.musicxml, .mxl), MIDI (.mid) – oder PDF/Foto für die Notenerkennung'));
  const migrateBox = h('div');
  let pollTimer = 0, alive = true;
  if (account.user) library.localCount().then(n => {
    if (!n || !alive) return;
    const btn = h('button.btn.primary', { onclick: async () => {
      btn.disabled = true;
      try { await library.migrateLocal((i, total) => { btn.textContent = `Übertrage ${i}/${total} …`; }); toast('Ins Konto übernommen'); migrateBox.innerHTML = ''; refresh(); }
      catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Erneut versuchen'; }
    } }, icon('cloud'), 'Ins Konto übernehmen');
    migrateBox.append(h('section.stage.migrate', h('div', { style: { flex: 1 } }, h('b', `${n} Stück${n > 1 ? 'e' : ''} nur in diesem Browser`), h('div.muted', { style: { fontSize: '13.5px' } }, 'Übernimm sie in dein Konto, dann sind sie überall verfügbar und PDFs/Fotos werden erkannt.')), btn));
  });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => handle(e.dataTransfer.files));

  root.append(
    h('section.stage', drop, fileIn,
      h('div.info-box', h('b', 'Tipp: '), 'Aus MuseScore, Sibelius, Finale oder Dorico als ', h('b', 'MusicXML'), ' exportieren – dann sind alle Informationen (Noten, Hände, Tempo) dabei. ',
        account.user ? 'PDFs und Fotos erkennt dein Tonika-Server automatisch – am besten gerade, scharf und gut ausgeleuchtet (Scan mit 300 dpi ist ideal).'
          : account.server ? 'Melde dich an (oben rechts), damit PDFs und Fotos automatisch in Noten umgewandelt und deine Stücke im Konto gespeichert werden.'
          : 'PDFs und Fotos werden gespeichert; die automatische Erkennung läuft auf dem Tonika-Server (tonika.hohendorff.org).')),
    migrateBox,
    h('div.row', h('div.label-caps', { style: { margin: '8px 4px 0' } }, 'Deine Stücke'), h('span.spacer'),
      h('button.btn.ghost', { onclick: addDemo }, icon('sparkle'), 'Beispielstück hinzufügen')),
    grid);

  async function handle(files) {
    for (const f of files) {
      try { const s = await importFile(f); toast(OMR_ACTIVE(s.status) ? `„${s.title}“ wird jetzt erkannt …` : `„${s.title}“ hinzugefügt`); }
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
    let songs;
    try { songs = await library.all(); } catch (e) { grid.innerHTML = ''; grid.append(h('div.empty', 'Bibliothek nicht erreichbar: ' + e.message)); return; }
    if (!alive) return;
    clearTimeout(pollTimer);
    if (songs.some(s => OMR_ACTIVE(s.status))) pollTimer = setTimeout(refresh, 4000);
    grid.innerHTML = '';
    if (!songs.length) { grid.append(h('div.empty', 'Noch keine Stücke. Lade eine Datei hoch oder füge das Beispielstück hinzu.')); return; }
    songs.forEach((s, i) => {
      const tagCls = s.status !== 'ready' ? '.wait' : s.type === 'midi' ? '.midi' : '.xml';
      grid.append(h('div.song', { style: { '--i': i }, onclick: () => go('#/library/' + s.id) },
        h('h5', s.title),
        s.composer ? h('div.composer', s.composer) : '',
        h('div.sub', s.meta || s.fileName),
        h('div.row', { style: { gap: '6px', marginTop: '4px' } },
          h('span.tag' + tagCls, TYPE_LABEL[s.type] || s.type),
          statusTag(s),
          h('span.sub', new Date(s.added).toLocaleDateString('de-DE'))),
        h('button.del', { 'aria-label': 'Löschen', onclick: async e => { e.stopPropagation(); if (confirm(`„${s.title}“ löschen?`)) { await library.remove(s.id); refresh(); } } }, icon('trash'))));
    });
  }
  refresh();
  return () => { alive = false; clearTimeout(pollTimer); };
}

// ---------- Player ----------
const sessions = persisted('library.sessions', {});
const PLAYER_ICONS = {
  volume: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v9M12 5v9M16 5v9M8 14v5M12 14v5M16 14v5"/>',
  focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><path d="M8 10h8M8 14h5"/>'
};
const picon = name => { const el = h('span.icon'); el.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PLAYER_ICONS[name]}</svg>`; return el; };

function player(root, ctx, id) {
  let song = null, steps = [], view = null, mode = 'idle', pos = 0, hand = 'both', tempo = 1, playTimer = null, raf = 0, destroyed = false;
  let satisfied = new Set(), stats = { ok: 0, bad: 0 }, startClock = 0, startT = 0, scheduled = [];
  let rec = [], pedalEv = [], marks = null, anyMidi = false, pendingOther = [];
  // Einhand-Üben: geschätztes Spieltempo (Partiturzeit pro Echtzeit), danach richtet sich die Begleithand
  let rate = 1, lastOwn = -1;
  const pace = () => hand === 'both' ? tempo : rate;
  const metro = new Metronome();
  const kb = new Keyboard({ from: 36, to: 84 });
  const display = h('div.pl-display', h('div.spinner'));
  const timeline = h('div.timeline', h('div'));
  const okEl = h('div.v', '0'), badEl = h('div.v', '0'), progEl = h('div.v', '0%');
  const msg = h('div.msg.muted', '');
  const pedalPill = h('span.pedal-pill', 'Pedal');
  const playBtn = h('button.btn.accent', { onclick: () => mode === 'play' ? stopAll() : startPlay() }, icon('play'), 'Anhören');
  const practiceBtn = h('button.btn.primary', { onclick: () => mode === 'wait' ? stopAll(true) : startWait() }, icon('hand'), 'Üben');
  const tempoLabel = h('span', '100 %');
  const tempoIn = h('input', { type: 'range', min: 40, max: 150, step: 5, value: 100, oninput: () => {
    tempo = +tempoIn.value / 100; tempoLabel.textContent = tempoIn.value + ' %';
    if (mode === 'wait' && metro.running) metro.setBpm(metroBpm());
  } });
  const handSeg = segmented([['both', 'Beide Hände'], ['0', 'Rechts'], ['1', 'Links']], 'both', v => { hand = v; if (mode === 'wait') { stopAll(); startWait(); } });
  const metroBtn = h('button.btn.ghost.toggle-btn', { onclick: () => setMetro(!prefs.libMetro), title: 'Metronom' }, icon('metronome'), 'Metronom');
  const volIn = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: prefs.volume ?? 0.8, oninput: () => audio.setVolume(+volIn.value), 'aria-label': 'Lautstärke Vorspielen' });
  const kbBtn = h('button.btn.ghost.toggle-btn', { onclick: () => setKeyboard(!showKb), hidden: true, title: 'Klaviatur ein/aus' }, picon('keys'), 'Klaviatur');
  const focusBtn = h('button.btn.ghost.toggle-btn', { onclick: () => setFocus(!document.body.classList.contains('focus-mode')), hidden: true, title: 'Nur die Noten anzeigen' }, picon('focus'), 'Notenansicht');
  const histBtn = h('button.btn.ghost.sec', { onclick: () => historySheet(), hidden: true }, icon('chart'), 'Verlauf');
  const exportBtn = h('button.btn.ghost.sec', { onclick: exportMidi, hidden: true }, icon('download'), 'MIDI');
  const origBtn = h('button.btn.ghost.sec', { onclick: () => showOriginal(), hidden: true }, icon('eye'), 'Original');
  const editBtn = h('button.btn.ghost.sec', { onclick: () => go('#/library/' + id + '/edit'), hidden: true }, icon('edit'), 'Bearbeiten');
  const jumpBtn = h('button.btn.ghost.sec', { onclick: () => jumpSheet(), hidden: true }, icon('refresh'), 'Sprünge');
  const jumpFixes = persisted('library.jumpFixes', {});
  let osmdRef = null, lastInfo = null, showKb = true;

  const stage = h('section.stage.grow.player',
    h('div.player-bar', playBtn, practiceBtn, handSeg,
      h('label.tempo', icon('metronome'), tempoIn, tempoLabel), metroBtn,
      h('label.tempo.vol', picon('volume'), volIn),
      h('span.spacer'), kbBtn, focusBtn, histBtn, editBtn, jumpBtn, origBtn, exportBtn),
    timeline, display,
    h('div.feedback', msg, pedalPill, h('div.stats', { style: { gridTemplateColumns: 'repeat(3, minmax(70px, 1fr))', flex: '0 0 auto' } },
      h('div.stat', okEl, h('div.l', 'richtig')), h('div.stat', badEl, h('div.l', 'daneben')), h('div.stat', progEl, h('div.l', 'Fortschritt')))),
    kb.el);
  root.append(stage);
  setMetro(!!prefs.libMetro, true);

  (async () => {
    song = await library.get(id).catch(() => null);
    if (!song) { display.innerHTML = ''; display.append(h('div.empty', 'Stück nicht gefunden.')); return; }
    ctx.setTitle(song.title, song.composer || TYPE_LABEL[song.type]);
    try {
      if (song.type === 'musicxml' || song.type === 'mxl') await setupScore();
      else if (song.type === 'midi') await setupRoll();
      else return setupFile();
      exportBtn.hidden = false;
      histBtn.hidden = false;
      origBtn.hidden = !(library.remote && song.origType && song.origType !== song.type);
      editBtn.hidden = !(song.type === 'mxl' || song.type === 'musicxml');
      const all = steps.flatMap(s => s.notes.map(n => n.midi));
      kb.fit(all);
      msg.textContent = `${steps.filter(s => s.notes.length).length} Schritte · ${Math.round(totalTime())} s`;
      const unsure = song.report && song.report.uncertain || [];
      if (unsure.length) {
        msg.textContent += ` · unsicher erkannt: Takt ${unsure.slice(0, 6).join(', ')}${unsure.length > 6 ? ' …' : ''}`;
        msg.append(' ', h('a', { href: '#/library/' + id + '/edit', style: { color: 'var(--accent)' } }, 'Im Editor korrigieren'));
      }
    } catch (e) {
      console.error(e);
      display.innerHTML = ''; display.append(h('div.empty', 'Die Datei konnte nicht gelesen werden: ' + e.message));
    }
  })();

  // ---------- Ansicht: Klaviatur, Notenansicht, Metronom ----------
  function setKeyboard(on) {
    showKb = on;
    if (view && view.kind === 'score') prefs.libKeyboard = on;
    stage.classList.toggle('no-kb', !on);
    kbBtn.classList.toggle('on', on);
    if (view && view.kind === 'score') requestAnimationFrame(() => view.goto(pos, true));
  }
  function setFocus(on) {
    document.body.classList.toggle('focus-mode', on);
    focusBtn.classList.toggle('on', on);
    const root = document.documentElement;
    try {
      if (on && !document.fullscreenElement && root.requestFullscreen) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch {}
    if (view && view.kind === 'score') setTimeout(() => view.goto(pos, true), 350);
  }
  const onFsChange = () => { if (!document.fullscreenElement && document.body.classList.contains('focus-mode')) setFocus(false); };
  document.addEventListener('fullscreenchange', onFsChange);
  function setMetro(on, silent) {
    prefs.libMetro = on;
    metroBtn.classList.toggle('on', on);
    if (silent) return;
    if (!on) metro.stop();
    else if (mode === 'wait') startFreeMetro();
    else if (mode === 'play' && lastInfo && lastInfo.beats) metro.follow(lastInfo.beats, { startT: currentTime(), clock0: audio.now + 0.02, tempo });
  }
  const metroBpm = () => {
    const m = lastInfo && lastInfo.meter || { unit: 1 / 4, perBar: 4 };
    return (lastInfo ? lastInfo.bpm : 100) * tempo * (1 / 4) / m.unit;
  };
  function startFreeMetro() { metro.start({ bpm: metroBpm(), perBar: (lastInfo && lastInfo.meter || { perBar: 4 }).perBar }); }

  // ---------- Darstellungen ----------
  async function setupScore() {
    await loadScript(OSMD_URL);
    display.innerHTML = '';
    const box = h('div.score-box');
    display.append(box);
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(box, { autoResize: false, backend: 'svg', drawTitle: true, followCursor: false, drawPartNames: false });
    const xml = song.type === 'mxl' ? binStr(song.data) : new TextDecoder().decode(song.data);
    await osmd.load(xml);
    // Ansicht vor dem ersten Zeichnen festlegen (Breite der Noten hängt davon ab)
    setKeyboard(prefs.libKeyboard === true);
    kbBtn.hidden = false; focusBtn.hidden = false;
    osmd.render();
    osmdRef = osmd;
    const r = stepsFromOSMD(osmd, jumpFixes[song.id]);
    steps = r.steps; lastInfo = r;
    jumpBtn.hidden = false;
    if (r.repeats) toast(`Mit Wiederholungen: ${r.playedMeasures} Takte`);
    if (r.jumps && r.jumps.jump === 'ds' && !r.jumps.segno && !jumpFixes[song.id]) setTimeout(() => toast('„D.S.“ gefunden, aber kein Segno – unter „Sprünge“ kannst du es nachtragen'), 2500);
    musicXmlText(song.data, song.type).then(t => { marks = scoreMarks(t); }).catch(() => { marks = null; });

    // eigener Cursor: Positionen einmal berechnen, danach nur noch verschieben (kein Neuzeichnen, kein weiches Scrollen)
    const bar = h('div.sc-cursor'), meas = h('div.sc-measure');
    let posList = cursorPositions(osmd), curSys = -1, curCi = -1, anim = 0;
    const attach = () => { box.append(meas, bar); };
    attach();
    const scrollTo = (y, smooth) => {
      cancelAnimationFrame(anim);
      const max = box.scrollHeight - box.clientHeight;
      y = Math.max(0, Math.min(max, y));
      if (!smooth || Math.abs(y - box.scrollTop) > box.clientHeight * 1.5) { box.scrollTop = y; return; }
      const y0 = box.scrollTop, t0 = performance.now(), D = 170;
      const stepA = now => { const k = Math.min(1, (now - t0) / D); box.scrollTop = y0 + (y - y0) * (1 - Math.pow(1 - k, 3)); if (k < 1) anim = requestAnimationFrame(stepA); };
      anim = requestAnimationFrame(stepA);
    };
    let lastW = box.clientWidth, rzT = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - lastW) < 24) return;
      clearTimeout(rzT);
      rzT = setTimeout(() => {
        lastW = box.clientWidth;
        try { osmd.render(); } catch (e) { console.warn(e); }
        posList = cursorPositions(osmd); attach(); curSys = -1; curCi = -1;
        view.goto(pos, true);
      }, 250);
    });
    ro.observe(box);
    view = {
      kind: 'score',
      // i = Schritt in Abspielreihenfolge; Cursor und Taktmarkierung springen sofort an die Stelle
      goto(i, force) {
        const ci = steps[i] ? steps[i].ci : 0;
        if (ci === curCi && !force) return;
        const p = posList[ci]; if (!p) return;
        const newSys = p.sys !== curSys;
        const back = curCi >= 0 && ci < curCi;
        bar.classList.toggle('jump', newSys || back);
        bar.style.transform = `translate(${p.x - 2}px, ${p.top - 6}px)`; bar.style.height = (p.h + 12) + 'px';
        meas.style.transform = `translate(${p.mx}px, ${p.top - 10}px)`; meas.style.width = p.mw + 'px'; meas.style.height = (p.h + 20) + 'px';
        if (newSys || force) {
          // aktuelle Zeile oben, damit die nächste schon darunter zu sehen ist
          const forward = p.sys === curSys + 1 && !back;
          scrollTo(p.sys === 0 ? 0 : p.top - Math.min(70, box.clientHeight * 0.1), forward && !force);
          curSys = p.sys;
        }
        curCi = ci;
      },
      flash(cls) { bar.classList.remove('ok', 'bad'); void bar.offsetWidth; bar.classList.add(cls); },
      reset() { curSys = -1; curCi = -1; this.goto(0, true); },
      destroy() { ro.disconnect(); cancelAnimationFrame(anim); try { osmd.clear(); } catch {} }
    };
    view.reset();
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
      const target = mode === 'play' ? currentTime() : (steps[pos] ? steps[pos].t : 0);
      viewT += (target - viewT) * (mode === 'play' ? 1 : 0.18);
      const pps = 140;
      const hit = H - 6;
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
    view = { kind: 'roll', goto() {}, flash() {}, reset() { viewT = 0; }, destroy() { cancelAnimationFrame(raf); } };
  }
  let omrTimer = 0;
  function setupFile() {
    display.innerHTML = '';
    [playBtn, practiceBtn].forEach(b => b.disabled = true);
    const url = URL.createObjectURL(new Blob([song.data], { type: song.type === 'pdf' ? 'application/pdf' : 'image/*' }));
    const box = h('div');
    const preview = song.type === 'pdf' ? h('iframe', { src: url, style: { width: '100%', height: '60vh', border: 0, borderRadius: '14px', background: '#fff' } })
      : h('img', { src: url, style: { maxWidth: '100%', borderRadius: '14px' } });
    display.append(box, preview);
    const retry = label => h('button.btn.primary', { onclick: async () => {
      try { song = Object.assign(song, await library.retryOmr(song.id)); renderStatus(); poll(); } catch (e) { toast(e.message); }
    } }, icon('refresh'), label);
    function renderStatus() {
      box.innerHTML = '';
      const st = song.status;
      if (OMR_ACTIVE(st)) {
        const stepsDef = [['Hochgeladen', 'done'], ['In der Warteschlange', st === 'omr-queued' ? 'cur' : 'done'], ['Noten werden erkannt (dauert 1–5 Minuten)', st === 'omr-running' ? 'cur' : ''], ['Bereit zum Mitspielen', '']];
        box.append(h('div.info-box', { style: { marginBottom: '12px' } },
          h('b', 'Notenerkennung läuft'),
          h('div.omr-steps', stepsDef.map(([t, c]) => h('div.omr-step' + (c ? '.' + c : ''), h('span.d'), t))),
          'Du kannst die Seite verlassen – das Stück erscheint fertig in deiner Bibliothek.'));
      } else if (st === 'omr-failed') {
        box.append(h('div.info-box', { style: { marginBottom: '12px' } }, h('b', 'Erkennung fehlgeschlagen: '), song.error || 'Unbekannter Fehler',
          h('div.row', { style: { marginTop: '10px' } }, retry('Erneut versuchen'))));
      } else if (account.user) {
        box.append(h('div.info-box', { style: { marginBottom: '12px' } }, h('b', 'Noch nicht erkannt. '), 'Starte die Notenerkennung auf deinem Tonika-Server.',
          h('div.row', { style: { marginTop: '10px' } }, retry('Jetzt erkennen'))));
      } else {
        box.append(h('div.info-box', { style: { marginBottom: '12px' } }, h('b', 'Notenerkennung: '),
          account.server ? 'Melde dich oben rechts an und übernimm das Stück in dein Konto – dann wandelt der Server es automatisch in Noten um.'
            : 'Öffne Tonika unter tonika.hohendorff.org und melde dich an – dort wandelt der Server PDFs und Fotos automatisch in Noten um.'));
      }
    }
    function poll() {
      clearTimeout(omrTimer);
      if (!OMR_ACTIVE(song.status) || destroyed) return;
      omrTimer = setTimeout(async () => {
        try {
          const m = await library.meta(song.id);
          if (destroyed) return;
          if (m.status === 'ready') { toast('Erkannt! 🎉'); go('#/library/' + song.id); return; }
          if (m.status !== song.status) { Object.assign(song, m); renderStatus(); }
        } catch {}
        poll();
      }, 4000);
    }
    renderStatus(); poll();
  }
  function jumpSheet() {
    if (!osmdRef || !lastInfo) return;
    const j = lastInfo.jumps || {}, fix = jumpFixes[song.id] || {};
    const num = (v, ph) => h('input.input', { type: 'number', min: 1, max: lastInfo.measures, placeholder: ph, value: v ?? '' });
    const segno = num(fix.segno ?? j.segno, 'z. B. 63'), jumpAt = num(fix.jumpAt ?? j.jumpAt, 'z. B. 126');
    const toCoda = num(fix.toCoda ?? j.toCoda, 'z. B. 100'), coda = num(fix.coda ?? j.coda, 'z. B. 127');
    const kind = segmented([['ds', 'D.S. (zum Segno)'], ['dc', 'D.C. (von vorn)']], fix.jump || j.jump || 'ds', v => { kindV = v; segno.disabled = v === 'dc'; });
    let kindV = fix.jump || j.jump || 'ds';
    const apply = f => {
      if (f) jumpFixes[song.id] = f; else { delete jumpFixes[song.id]; }
      stopAll();
      const r = stepsFromOSMD(osmdRef, jumpFixes[song.id]);
      steps = r.steps; lastInfo = r; pos = 0; view.reset(); setProgress();
      msg.textContent = `${steps.filter(s => s.notes.length).length} Schritte · ${Math.round(totalTime())} s`;
      toast(`Abspielreihenfolge: ${r.playedMeasures} Takte`);
    };
    const val = el => el.value ? Math.max(1, Math.min(lastInfo.measures, Math.round(+el.value))) : null;
    const s = sheet('Wiederholungen & Sprünge', [
      h('p.muted', { style: { marginTop: 0 } }, `Wiederholungszeichen und Volten werden automatisch gespielt (${j.repeats || 0} gefunden). Hat die Notenerkennung Sprungzeichen übersehen, trag hier die Taktnummern ein.`),
      field('Sprung am Ende von Takt', jumpAt), field('Art', kind),
      field('Segno (𝄋) in Takt', segno), field('„To Coda“ (𝄌) in Takt', toCoda, 'Hier springt der zweite Durchgang zur Coda.'), field('Coda beginnt in Takt', coda),
      h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.primary', { onclick: () => { apply({ jumpAt: val(jumpAt), jump: kindV, segno: kindV === 'ds' ? val(segno) : null, toCoda: val(toCoda), coda: val(coda) }); s.close(); } }, 'Übernehmen'),
        h('button.btn.ghost', { onclick: () => { apply({ off: true }); s.close(); } }, 'Sprünge ignorieren'),
        jumpFixes[song.id] ? h('button.btn.ghost', { onclick: () => { apply(null); s.close(); } }, 'Zurücksetzen') : '')
    ]);
    segno.disabled = kindV === 'dc';
  }
  async function showOriginal() {
    try {
      const data = await library.original(song.id);
      const url = URL.createObjectURL(new Blob([data], { type: song.origType === 'pdf' ? 'application/pdf' : 'image/jpeg' }));
      sheet('Original', song.origType === 'pdf' ? h('iframe', { src: url, style: { width: '100%', height: '75vh', border: 0, borderRadius: '12px', background: '#fff' } }) : h('img', { src: url, style: { width: '100%', borderRadius: '12px' } }));
    } catch (e) { toast(e.message); }
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
    audio.unlock();
    mode = 'play';
    if (pos >= steps.length - 1) pos = 0;
    startClock = audio.now + 0.12; startT = steps[pos] ? steps[pos].t : 0;
    view.goto(pos);
    if (prefs.libMetro && lastInfo && lastInfo.beats) metro.follow(lastInfo.beats, { startT, clock0: startClock, tempo });
    playBtn.innerHTML = ''; playBtn.append(icon('stop'), 'Stopp');
    let i = pos;
    playTimer = setInterval(() => {
      const now = audio.now;
      while (i < steps.length) {
        const s = steps[i];
        const at = startClock + (s.t - startT) / tempo;
        if (at > now + 0.25) break;
        for (const n of s.notes) sound(n, at, n.dur / tempo);
        const idx = i;
        scheduled.push(setTimeout(() => {
          if (mode !== 'play') return;
          pos = idx; view.goto(idx); setProgress();
          if (showKb) { kb.clear('chord'); for (const n of steps[idx].notes) kb.flash(n.midi, 'chord', Math.max(120, n.dur / tempo * 1000)); }
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
    audio.unlock();
    mode = 'wait';
    stats = { ok: 0, bad: 0 }; setNum(okEl, 0); setNum(badEl, 0);
    rec = []; pedalEv = []; anyMidi = false;
    rate = tempo; lastOwn = -1;
    pos = 0; view.reset();
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('stop'), 'Beenden');
    msg.textContent = prefs.libMetro ? 'Spiel im Takt des Metronoms – die App wartet trotzdem auf dich.'
      : hand !== 'both' ? 'Spiel deine Hand – die andere passt sich deinem Tempo an.' : 'Spiel die markierten Töne – die App wartet auf dich.'; msg.className = 'msg muted';
    if (prefs.libMetro) startFreeMetro();
    enterStep();
  }
  function enterStep() {
    // Schritte ohne eigene Töne spielt die App selbst (andere Hand / Pausen) – im Rhythmus
    while (pos < steps.length && !steps[pos].notes.some(mine)) {
      const s = steps[pos];
      for (const n of s.notes) sound(n, audio.now + 0.01, n.dur / pace());
      const nxt = steps[pos + 1];
      pos++;
      if (nxt) { view.goto(pos); setProgress(); playTimer = setTimeout(enterStep, Math.min(1500, (nxt.t - s.t) / pace() * 1000)); return; }
    }
    if (pos >= steps.length) return finish();
    view.goto(pos); setProgress();
    satisfied = new Set();
    if (showKb) { kb.clear('target'); kb.clear('chord'); kb.clearLabels(); }
    const s = steps[pos];
    // Töne der anderen Hand im selben Schritt erklingen erst mit dem ersten eigenen Ton – also gleichzeitig
    pendingOther = s.notes.filter(n => !mine(n));
    for (const n of s.notes) if (mine(n) && showKb) { kb.mark(n.midi, 'target'); kb.label(n.midi, midiName(n.midi).replace(/\d+$/, '')); }
  }
  function playPendingOther() {
    const list = pendingOther; pendingOther = [];
    for (const n of list) sound(n, audio.now + 0.005, n.dur / pace());
  }
  // Aus dem Abstand zweier eigener Einsätze das Tempo schätzen (gleitend, Zögern zählt nicht)
  function trackRate(i, now) {
    if (hand === 'both') return;
    const prev = lastOwn; lastOwn = i;
    if (prev < 0 || !rec[prev]) return;
    const dScore = steps[i].t - steps[prev].t, dReal = (now - rec[prev].t) / 1000;
    if (dScore < 0.08 || dReal < 0.04) return;
    const inst = dScore / dReal;
    if (inst < rate * 0.4) return; // Zögern/Suchen – nicht als Tempo werten
    // längere Abstände sind verlässlicher → stärker gewichten (eine Note pro Takt passt sich schnell an)
    const k = Math.min(0.8, 1 - Math.exp(-dScore / 1.2));
    rate = Math.min(1.6, Math.max(0.3, rate * (1 - k) + Math.min(inst, rate * 1.8) * k));
  }
  function onNote({ midi, vel, src }) {
    if (mode !== 'wait' || pos >= steps.length) return;
    const want = steps[pos].notes.filter(mine).map(n => n.midi);
    if (want.includes(midi) && !satisfied.has(midi)) {
      if (!rec[pos]) trackRate(pos, performance.now());
      const r = rec[pos] || (rec[pos] = { t: performance.now(), vels: [] });
      if (pendingOther.length) playPendingOther();
      if (src === 'midi') { r.vels.push(vel); anyMidi = true; }
      satisfied.add(midi);
      stats.ok++; setNum(okEl, stats.ok);
      if (showKb) { kb.unmark(midi, 'target'); kb.flash(midi, 'ok', 300); }
      if (want.every(m => satisfied.has(m))) {
        view.flash('ok');
        const prev = steps[pos];
        pos++;
        const nxt = steps[pos];
        // sofort weiter – nur bei Pausen eine kurze rhythmische Andeutung
        let gap = nxt ? Math.min(0.25, Math.max(0, (nxt.t - prev.t) / tempo - 0.4)) : 0;
        // Einhand: folgt ein Begleit-Schritt, kommt er im eigenen Tempo, gemessen ab dem eigenen Einsatz
        if (nxt && hand !== 'both' && !nxt.notes.some(mine) && rec[pos - 1])
          gap = Math.min(1.5, Math.max(0, rec[pos - 1].t / 1000 + (nxt.t - prev.t) / rate - performance.now() / 1000));
        if (gap < 0.02) enterStep(); else playTimer = setTimeout(() => enterStep(), gap * 1000);
      }
    } else if (!want.includes(midi)) {
      stats.bad++; setNum(badEl, stats.bad);
      if (showKb) kb.flash(midi, 'bad', 500);
      view.flash('bad');
      if (!showKb) { msg.textContent = `daneben: ${midiName(midi)} – gesucht: ${want.filter(m => !satisfied.has(m)).map(midiName).join(' ')}`; msg.className = 'msg bad'; clearTimeout(msg._t); msg._t = setTimeout(() => { if (mode === 'wait') { msg.textContent = ''; msg.className = 'msg muted'; } }, 1600); }
    }
  }
  function onPedal(e) {
    pedalPill.classList.toggle('on', e.down);
    if (mode === 'wait') pedalEv.push({ t: e.t || performance.now(), down: e.down });
  }
  function evaluate(complete) {
    const acc = stats.ok + stats.bad ? Math.round(100 * stats.ok / (stats.ok + stats.bad)) : 100;
    const a = analyze({ steps, rec: anyMidi ? rec : rec.map(r => r && { ...r, vels: [] }), pedal: pedalEv, marks, bpm: lastInfo ? lastInfo.bpm : 100, setting: tempo });
    const reached = steps[Math.min(pos, steps.length - 1)];
    const ownTotal = steps.filter(s => s.notes.some(mine)).length;
    const part = complete ? 1 : Math.min(1, rec.filter(Boolean).length / Math.max(1, ownTotal));
    const entry = { d: Date.now(), acc, hand, set: Math.round(tempo * 100), part: Math.round(part * 100) / 100,
      pct: a.tempo ? a.tempo.pct : null, bpm: a.tempo ? a.tempo.bpm : null, steady: a.tempo ? a.tempo.steady : null,
      dyn: a.dyn ? a.dyn.score : null, ped: a.ped ? a.ped.score : null, sec: a.tempo ? a.tempo.seconds : null };
    const list = sessions[song.id] ? [...sessions[song.id]] : [];
    const prev = list.filter(e => e.hand === hand && e.part >= 0.9).slice(-1)[0];
    if (a.notes >= 12) { list.push(entry); sessions[song.id] = list.slice(-80); }
    return { acc, a, entry, prev, complete, upTo: reached ? reached.mi + 1 : null };
  }
  function finish() {
    const r = evaluate(true);
    mode = 'idle';
    metro.stop();
    kb.clear(); kb.clearLabels();
    pos = steps.length; setProgress();
    msg.textContent = `Geschafft! ${r.acc} % Treffergenauigkeit 🎉`; msg.className = 'msg ok pop';
    burst(display, { count: 34, spread: 200 });
    bumpProgress('library', { total: 1, correct: r.acc >= 90 ? 1 : 0 });
    record('library', song.id, { ok: r.acc >= 90, xp: 20 + Math.round(steps.length / 3 * r.acc / 100), label: song.title });
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('hand'), 'Nochmal üben');
    setTimeout(() => !destroyed && resultSheet(r), 900);
  }

  // ---------- Auswertung & Verlauf ----------
  function resultSheet(r) {
    const { a, entry, prev } = r;
    const big = (v, l, sub) => h('div.res-stat', h('div.v', v), h('div.l', l), sub ? h('div.sub', sub) : '');
    const cmp = (cur, old, unit, better = 1) => old == null || cur == null ? '' : (cur - old) * better > 0 ? h('span.up', `▲ ${Math.abs(cur - old)}${unit} ggü. letztem Mal`) : cur === old ? h('span.muted', 'wie letztes Mal') : h('span.down', `▼ ${Math.abs(cur - old)}${unit} ggü. letztem Mal`);
    const items = list => h('ul.res-list', list.map(it => h('li' + (it.ok ? '.ok' : '.warn'), it.text)));
    const t = a.tempo;
    const content = [
      !r.complete ? h('div.info-box', `Abgebrochen in Takt ${r.upTo} – ausgewertet wird, was du bis dahin gespielt hast.`) : '',
      h('div.res-grid',
        big(r.acc + ' %', 'Treffer', cmp(entry.acc, prev && prev.acc, ' %')),
        t ? big('♩ = ' + t.bpm, `Tempo · ${t.pct} % vom Original`, cmp(t.pct, prev && prev.pct, ' %')) : '',
        t ? big(t.steady + ' %', 'Gleichmäßigkeit', cmp(t.steady, prev && prev.steady, ' %')) : ''),
      t ? h('p.res-note', t.hesMeasures.length ? `Gestockt hast du vor allem in Takt ${t.hesMeasures.join(', ')} – diese Stellen einzeln und langsam üben.` : 'Kein nennenswertes Stocken – schön flüssig!',
        t.pct < t.target - 10 ? ` Eingestellt waren ${t.target} %, gespielt hast du ${t.pct} %.` : '') : '',
      a.dyn ? h('div.res-sec', h('h4', 'Dynamik', a.dyn.score != null ? h('span.score', a.dyn.score + ' %') : ''), a.dyn.note ? h('p.muted', a.dyn.note) : '', items(a.dyn.items.slice(0, 7))) :
        h('div.res-sec', h('h4', 'Dynamik'), h('p.muted', anyMidi ? 'Zu wenige Töne für eine Auswertung.' : 'Lautstärke wird nur über MIDI vom Digitalpiano ausgewertet.')),
      a.ped ? h('div.res-sec', h('h4', 'Pedal', a.ped.score != null ? h('span.score', a.ped.score + ' %') : ''), a.ped.note ? h('p.muted', a.ped.note) : '', items(a.ped.items.slice(0, 6))) : '',
      h('div.res-sec', h('h4', 'Verlauf'), chart(sessions[song.id] || [], hand)),
      h('div.row', { style: { marginTop: '12px' } }, h('button.btn.primary', { onclick: () => { s.close(); startWait(); } }, icon('hand'), 'Nochmal üben'), h('button.btn.ghost', { onclick: () => s.close() }, 'Schließen'))
    ];
    const s = sheet(r.complete ? 'Auswertung' : 'Zwischenstand', content);
  }
  function historySheet() {
    const list = sessions[song.id] || [];
    const fmt = d => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    const H = { both: 'beide', 0: 'rechts', 1: 'links' };
    const best = list.filter(e => e.part >= 0.9 && e.acc >= 85).reduce((b, e) => (e.pct || 0) > (b ? b.pct || 0 : -1) ? e : b, null);
    sheet('Verlauf', list.length ? [
      best ? h('p.res-note', `Bestes Tempo bei mindestens 85 % Treffern: ♩ = ${best.bpm} (${best.pct} % vom Original), erreicht am ${fmt(best.d)}`) : '',
      chart(list, hand),
      h('div.res-table-wrap', h('table.res-table', h('tr', ['Datum', 'Hand', 'Treffer', 'Tempo', 'Gleichm.', 'Dynamik', 'Pedal'].map(x => h('th', x))),
        list.slice(-15).reverse().map(e => h('tr', h('td', fmt(e.d) + (e.part < 0.9 ? ' ·' : '')), h('td', H[e.hand] || e.hand), h('td', e.acc + ' %'), h('td', e.pct != null ? e.pct + ' %' : '–'), h('td', e.steady != null ? e.steady + ' %' : '–'), h('td', e.dyn != null ? e.dyn + ' %' : '–'), h('td', e.ped != null ? e.ped + ' %' : '–'))))),
      h('div.field-hint', 'Tempo in Prozent des notierten Tempos. · = nicht bis zum Ende gespielt.')
    ] : h('p.muted', 'Noch keine Übungsdurchgänge. Starte „Üben“ – nach jedem Durchgang siehst du hier, wie sich Treffer und Tempo entwickeln.'));
  }
  function chart(all, hd) {
    const list = all.filter(e => e.hand === hd).slice(-30);
    if (list.length < 2) return h('p.muted', list.length ? 'Ab dem zweiten Durchgang (mit dieser Hand-Einstellung) erscheint hier die Entwicklung.' : 'Noch keine Durchgänge mit dieser Hand-Einstellung.');
    const W = 560, Hh = 170, P = { l: 34, r: 12, t: 12, b: 22 };
    const maxY = Math.max(110, ...list.map(e => e.pct || 0)) + 5;
    const x = i => P.l + i * (W - P.l - P.r) / (list.length - 1), y = v => P.t + (1 - v / maxY) * (Hh - P.t - P.b);
    const line = (f, cls) => { const pts = list.map((e, i) => f(e) != null ? [x(i), y(f(e))] : null).filter(Boolean); return pts.length > 1 ? `<path class="${cls}" d="M${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join('L')}"/>` + pts.map(p => `<circle class="${cls}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"/>`).join('') : ''; };
    const grid = [0, 50, 100].map(v => `<line class="g" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
    const el = h('div.res-chart');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Verlauf von Treffern und Tempo">${grid}${line(e => e.acc, 'acc')}${line(e => e.pct, 'tmp')}</svg>`;
    el.append(h('div.res-legend', h('span.acc', 'Treffer %'), h('span.tmp', 'Tempo % vom Original')));
    return el;
  }

  function stopAll(evaluateRun) {
    const wasWait = mode === 'wait';
    pendingOther = [];
    clearInterval(playTimer); clearTimeout(playTimer); playTimer = null;
    scheduled.forEach(clearTimeout); scheduled = [];
    metro.stop();
    input.allNotesOff();
    if (mode !== 'idle') { kb.clear('target'); kb.clear('chord'); kb.clearLabels(); }
    mode = 'idle';
    playBtn.innerHTML = ''; playBtn.append(icon('play'), 'Anhören');
    practiceBtn.innerHTML = ''; practiceBtn.append(icon('hand'), 'Üben');
    if (evaluateRun && wasWait && rec.filter(Boolean).length >= 12) resultSheet(evaluate(false));
  }
  function exportMidi() {
    const blob = writeMidi(steps, song.title);
    const a = h('a', { href: URL.createObjectURL(blob), download: song.title.replace(/[^\w\- äöüÄÖÜß]/g, '') + '.mid' });
    document.body.append(a); a.click(); a.remove();
    toast('MIDI-Datei erstellt');
  }

  const off = input.on('noteon', onNote), offPedal = input.on('pedal', onPedal);
  window.__tonikaPlayer = { steps: () => steps, pos: () => pos, mode: () => mode, mine: n => mine(n), marks: () => marks, rate: () => rate };
  return () => {
    delete window.__tonikaPlayer;
    destroyed = true; clearTimeout(omrTimer); stopAll(); off(); offPedal(); kb.destroy(); view && view.destroy();
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.body.classList.contains('focus-mode')) { document.body.classList.remove('focus-mode'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  };
}
