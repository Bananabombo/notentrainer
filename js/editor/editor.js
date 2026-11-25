// Noten-Editor: erkannte Stücke korrigieren – Noten antippen, per Klavier/Tastatur/Knöpfen ändern,
// Takte, Schlüssel, Tonart, Wiederholungen bearbeiten, mit dem Original vergleichen.
import { h, icon, toast, sheet, segmented, field, toggle, loadScript } from '../core/ui.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { Keyboard } from '../core/keyboard.js';
import { library, account, persisted, prefs } from '../core/store.js';
import { musicXmlText } from '../core/unzip.js';
import { Score, TYPES, spell } from './model.js';
import { go } from '../app.js';

const OSMD_URL = 'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.8.9/build/opensheetmusicdisplay.min.js';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TYPE_NAME = { whole: 'Ganze', half: 'Halbe', quarter: 'Viertel', eighth: 'Achtel', '16th': 'Sechzehntel', '32nd': '32tel', '64th': '64tel' };
const DUR_KEYS = { 7: 'whole', 6: 'half', 5: 'quarter', 4: 'eighth', 3: '16th', 2: '32nd', 1: '64th' };
const DUR_LIST = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
/** kleines Notensymbol als SVG (Schriftarten haben die Musikzeichen oft nicht) */
function noteIcon(type) {
  const filled = !['whole', 'half'].includes(type), stem = type !== 'whole';
  const flags = { eighth: 1, '16th': 2, '32nd': 3 }[type] || 0;
  let d = `<ellipse cx="9" cy="19" rx="5" ry="3.6" transform="rotate(-20 9 19)" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.6"'}/>`;
  if (stem) d += '<path d="M13.4 18V3" stroke="currentColor" stroke-width="1.6"/>';
  for (let i = 0; i < flags; i++) d += `<path d="M13.4 ${3 + i * 4}c2.5 1.6 5 3.2 4 7" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  const el = document.createElement('span'); el.className = 'ed-ico';
  el.innerHTML = `<svg viewBox="0 0 22 24" width="20" height="22">${d}</svg>`;
  return el;
}
function restIcon() { const el = document.createElement('span'); el.className = 'ed-ico'; el.innerHTML = '<svg viewBox="0 0 22 24" width="20" height="22"><path d="M8 3l5 6-4 4 5 6c-3-1-6 0-4 3-4-2-3-6 1-5l-5-6 4-3z" fill="currentColor"/></svg>'; return el; }
const NAMES_DE = { C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', A: 'A', B: 'H' };
const WINDOW = 16;           // so viele Takte auf einmal, wenn das Stück lang ist

export async function mountEditor(root, ctx, id) {
  const opts = persisted('editor.settings', { advance: true, follow: true, original: true, keyboard: true });
  let song = null, score = null, osmd = null, map = [], byEl = new Map(), sel = null, selMeasures = null, winStart = 0;
  let addMode = false, clip = null;
  let destroyed = false, renderSeq = 0, pdf = null, pdfPage = 0, origImg = null, playTimer = null, chordBuf = [], chordTimer = 0;

  // ---------- Aufbau ----------
  root.querySelector('.ed-loading')?.remove();
  const status = h('div.ed-status', 'Lade …');
  const errNav = h('div.ed-errs');
  const scoreBox = h('div.ed-score');
  const overlay = h('div.ed-overlay');
  const scoreWrap = h('div.ed-scorewrap', scoreBox, overlay);
  const pager = h('div.ed-pager');
  const origCanvas = h('canvas.ed-orig-canvas');
  const origInfo = h('span.muted', '');
  const origPane = h('div.ed-orig', h('div.ed-orig-bar',
    h('button.icon-btn', { onclick: () => showPage(pdfPage - 1), 'aria-label': 'Vorige Seite' }, icon('back')), origInfo,
    h('button.icon-btn.flip', { onclick: () => showPage(pdfPage + 1), 'aria-label': 'Nächste Seite' }, icon('back')),
    h('span.spacer'),
    h('label.ed-mini', h('input', { type: 'checkbox', checked: opts.follow, onchange: e => { opts.follow = e.target.checked; } }), 'mitblättern')),
    h('div.ed-orig-view', origCanvas));
  const kb = new Keyboard({ from: 28, to: 96 });
  const kbWrap = h('div.ed-kb', kb.el);
  const undoBtn = h('button.btn.ghost', { onclick: () => doUndo(), title: 'Rückgängig (Strg+Z)' }, '↶');
  const redoBtn = h('button.btn.ghost', { onclick: () => doRedo(), title: 'Wiederholen (Strg+Y)' }, '↷');
  const saveBtn = h('button.btn.primary', { onclick: () => save() }, 'Speichern');
  ctx.extra.append(undoBtn, redoBtn, saveBtn);

  const tb = (label, title, fn, cls = '') => h('button.ed-tool' + cls, { title, onclick: e => { e.preventDefault(); fn(); } }, label);
  const durBtns = DUR_LIST.map(t => { const b = tb(noteIcon(t), TYPE_NAME[t] + ' (' + Object.entries(DUR_KEYS).find(([, v]) => v === t)[0] + ')', () => act('Dauer', n => score.setDuration(n, t, 0))); b.dataset.type = t; return b; });
  const dotBtn = tb('•', 'Punktiert (.)', () => act('Punkt', n => { const i = score.noteInfo(n); score.setDuration(n, i.type || 'quarter', i.dots ? 0 : 1); }));
  const restBtn = tb(restIcon(), 'Note ↔ Pause (0)', () => act('Pause', n => score.noteInfo(n).rest ? score.toNote(n) : score.toRest(n)));
  const addBtn = tb('+ Ton', 'Ton zum Akkord hinzufügen/entfernen (Umschalt+Tonname oder spielen)', () => setAddMode(!addMode), '.wide');
  function setAddMode(on) {
    addMode = on;
    addBtn.classList.toggle('active', on);
    if (on) toast('Spiel oder tippe einen Ton – er kommt zum Akkord dazu (vorhandene Töne werden entfernt)');
    describe();
  }
  const toolbar = h('div.ed-toolbar',
    h('div.ed-group', ...durBtns, dotBtn, restBtn),
    h('div.ed-group', tb('♭', 'Be (-)', () => act('Vorzeichen', n => score.setAlter(n, cur(n).alter === -1 ? 0 : -1), true)),
      tb('♮', 'Auflösung (=)', () => act('Vorzeichen', n => score.setAlter(n, 0), true)),
      tb('♯', 'Kreuz (+)', () => act('Vorzeichen', n => score.setAlter(n, cur(n).alter === 1 ? 0 : 1), true))),
    h('div.ed-group', tb('▲', 'Höher (↑)', () => act('Tonhöhe', n => score.stepPitch(n, 1), true)), tb('▼', 'Tiefer (↓)', () => act('Tonhöhe', n => score.stepPitch(n, -1), true)),
      tb('8va', 'Oktave höher (Umschalt+↑)', () => act('Oktave', n => score.stepPitch(n, 7), true)), tb('8vb', 'Oktave tiefer (Umschalt+↓)', () => act('Oktave', n => score.stepPitch(n, -7), true))),
    h('div.ed-group', tb('⁀', 'Haltebogen (T)', () => act('Haltebogen', n => { score.toggleTie(n); return n; })),
      addBtn,
      tb('+♪', 'Note dahinter einfügen (I)', () => act('Einfügen', n => score.duplicateGroup(n))),
      tb('✦̸', 'Verzierungen & Fingersätze der Note entfernen', () => act('Verzierung entfernen', n => { const k = score.clearOrnaments(n); toast(k ? 'Verzierung entfernt' : 'Keine Verzierung an dieser Note'); return n; })),
      tb('⌫', 'Löschen → Pause (Entf)', () => act('Löschen', n => score.deleteNote(n))),
      tb('✕', 'Ganz entfernen, Rest rückt nach (Umschalt+Entf)', () => act('Entfernen', n => score.removeGroup(n)))),
    h('div.ed-group', tb('Takt …', 'Takt bearbeiten (M)', () => measureSheet(), '.wide'), tb('Stück …', 'Titel, Komponist, Tempo', () => scoreSheet(), '.wide'),
      tb('▶', 'Ab Auswahl abspielen (Leertaste)', () => togglePlay())),
    h('div.ed-group.right', tb('Original', 'Original daneben anzeigen', () => toggleOriginal(), '.wide.orig-toggle'),
      tb('⌨︎', 'Klaviatur ein/aus', () => { opts.keyboard = !opts.keyboard; kbWrap.hidden = !opts.keyboard; })));
  const layout = h('div.ed-layout', h('div.ed-main', h('div.ed-statusbar', status, h('span.spacer'), errNav), scoreWrap, pager), origPane);
  root.append(h('section.stage.ed', toolbar, layout, kbWrap));
  kbWrap.hidden = !opts.keyboard;

  ctx.setSettings(() => [
    toggle('Nach Eingabe am Klavier zur nächsten Note springen', opts.advance, v => { opts.advance = v; }),
    toggle('Original automatisch mitblättern', opts.follow, v => { opts.follow = v; }),
    h('div.field-hint', '„+ Ton“: Töne werden zum gewählten Akkord hinzugefügt; ein schon vorhandener Ton wird entfernt. Esc beendet den Modus.'),
    h('div.field-hint', 'Tastatur: Umschalt+Tonname = Ton zum Akkord · ←/→ Note wählen · ↑/↓ Tonhöhe · Umschalt+↑/↓ Oktave · A–G Tonname · 1–7 Dauer (5 = Viertel) · . Punkt · 0 Pause · + − = Vorzeichen · T Haltebogen · I Einfügen · Entf Löschen · M Takt · Strg+Z/Y · Strg+S Speichern. Am Klavier gespielte Töne ersetzen die gewählte Note (mehrere gleichzeitig = Akkord).')
  ]);

  // ---------- Laden ----------
  try {
    await loadScript(OSMD_URL);
    song = await library.get(id);
    if (!song) throw new Error('Stück nicht gefunden');
    if (!['mxl', 'musicxml'].includes(song.type)) throw new Error('Bearbeiten geht für Noten (MusicXML) – dieses Stück ist noch nicht erkannt.');
    ctx.setTitle('Bearbeiten', song.title);
    let xml = await musicXmlText(song.data, song.type);
    const draftKey = 'nt2.draft.' + id;
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch {}
    if (draft && draft.base !== (song.updated || song.added)) { try { localStorage.removeItem(draftKey); } catch {} draft = null; }
    score = new Score(xml);
    if (draft && draft.xml) {
      const banner = h('div.ed-draft', h('span', `Ungespeicherte Änderungen vom ${new Date(draft.at).toLocaleString('de-DE')} gefunden.`), h('span.spacer'),
        h('button.btn.primary.sm', { onclick: async () => { const old = score.serialize(); score.restore(draft.xml); score.undoStack.push({ label: 'Entwurf', xml: old }); score.dirty = true; banner.remove(); await render(); } }, 'Wiederherstellen'),
        h('button.btn.ghost.sm', { onclick: () => { try { localStorage.removeItem(draftKey); } catch {} banner.remove(); } }, 'Verwerfen'));
      toolbar.after(banner);
    }
    if (destroyed) return;
    osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(scoreBox, { backend: 'svg', autoResize: false, drawTitle: false, drawSubtitle: false, drawComposer: false, drawCredits: false, drawPartNames: false, autoBeam: true, drawMeasureNumbers: true, measureNumberInterval: 1 });
    await render();
    const hasOrig = library.remote && song.origType && ['pdf', 'image'].includes(song.origType);
    if (!hasOrig) { toolbar.querySelector('.orig-toggle').hidden = true; origPane.hidden = true; }
    else if (opts.original && innerWidth > 900) toggleOriginal(true);
    else origPane.hidden = true;
    const firstErr = score.rhythmErrors()[0];
    selectMeasure(firstErr ?? 0, false);
    if (firstErr != null) toast('Rot markiert: Takte, deren Notenwerte nicht aufgehen');
  } catch (e) {
    console.error(e);
    root.innerHTML = '';
    root.append(h('section.stage', h('div.empty', e.message), h('div.row', h('button.btn', { onclick: () => go('#/library/' + id) }, 'Zurück zum Stück'))));
    return () => {};
  }

  // Zugriff für Tests und Automatisierung (gleiche Funktionen wie die Knöpfe)
  window.__tonikaEditor = { get score() { return score; }, get sel() { return sel; }, set sel(v) { sel = v; selMeasures = null; applySelection(); },
    render: () => render(), save: () => save(), selectMeasure: mi => selectMeasure(mi), act: (label, fn) => act(label, fn), measureAct: (label, fn) => measureAct(label, fn) };

  // ---------- Darstellung ----------
  function long() { return score.measures.length > WINDOW + 8; }
  async function render(keepScroll = true) {
    const seq = ++renderSeq;
    const scrollY = window.scrollY, boxScroll = scoreWrap.scrollTop;
    const n = score.measures.length;
    if (long()) {
      winStart = Math.max(0, Math.min(winStart, n - WINDOW));
      osmd.setOptions({ drawFromMeasureNumber: winStart + 1, drawUpToMeasureNumber: winStart + WINDOW });
    } else osmd.setOptions({ drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
    // Messen der Breite: Partitur passt sich dem Platz an
    try {
      await osmd.load(score.serialize());
      if (seq !== renderSeq || destroyed) return;
      osmd.render();
    } catch (e) { console.error(e); toast('Darstellung fehlgeschlagen: ' + e.message); }
    buildMap();
    drawOverlay();
    renderPager();
    if (keepScroll) { window.scrollTo(0, scrollY); scoreWrap.scrollTop = boxScroll; }
    undoBtn.disabled = !score.undoStack.length; redoBtn.disabled = !score.redoStack.length;
    saveBtn.classList.toggle('pulse', score.dirty);
  }
  function renderPager() {
    pager.innerHTML = '';
    if (!long()) return;
    const n = score.measures.length;
    const pages = Math.ceil(n / WINDOW);
    pager.append(h('button.btn.ghost', { disabled: winStart === 0, onclick: () => { winStart = Math.max(0, winStart - WINDOW); render(false); } }, '‹ Takte davor'),
      h('span.muted', `Takt ${winStart + 1}–${Math.min(n, winStart + WINDOW)} von ${n}`),
      h('select', { onchange: e => { winStart = +e.target.value; render(false); } }, Array.from({ length: pages }, (_, i) => {
        const o = h('option', { value: i * WINDOW }, `Takt ${i * WINDOW + 1}–${Math.min(n, (i + 1) * WINDOW)}`); if (i * WINDOW === winStart) o.selected = true; return o;
      })),
      h('button.btn.ghost', { disabled: winStart + WINDOW >= n, onclick: () => { winStart = Math.min(n - WINDOW, winStart + WINDOW); render(false); } }, 'Takte danach ›'));
  }
  /** Darstellung ↔ MusicXML verknüpfen */
  function buildMap() {
    const idx = score.index();
    const used = new Set();
    map = []; byEl = new Map();
    const ml = osmd.GraphicSheet.MeasureList || [];
    for (const staffMeasures of ml) for (const sm of staffMeasures || []) {
      if (!sm || !sm.parentSourceMeasure) continue;
      const mi = sm.parentSourceMeasure.measureListIndex;
      for (const se of sm.staffEntries || []) {
        const onset = se.relInMeasureTimestamp ? se.relInMeasureTimestamp.RealValue : 0;
        for (const gve of se.graphicalVoiceEntries || []) for (const gn of gve.notes || []) {
          const sn = gn.sourceNote; if (!sn) continue;
          const staff = sn.ParentStaff ? sn.ParentStaff.idInMusicSheet : 0;
          const midi = sn.isRest() ? null : sn.halfTone + 12;
          const voice = sn.ParentVoiceEntry && sn.ParentVoiceEntry.ParentVoice ? String(sn.ParentVoiceEntry.ParentVoice.VoiceId) : null;
          const grace = !!sn.IsGraceNote || !!(sn.ParentVoiceEntry && sn.ParentVoiceEntry.IsGrace);
          const cands = idx.filter(x => x.mi === mi && x.staff === staff && x.midi === midi && !used.has(x.el) && !!x.grace === grace && Math.abs(x.onset - onset) < 1e-3);
          const hit = cands.find(x => x.voice === voice) || cands[0];
          if (!hit) continue;
          used.add(hit.el);
          const g = gn.getSVGGElement && gn.getSVGGElement();
          const entry = { el: hit.el, g, mi, staff, midi, gn, onset };
          map.push(entry);
          if (g) { if (!byEl.has(g)) byEl.set(g, []); byEl.get(g).push(entry); g.classList.add('ed-note'); }
        }
      }
    }
    // Noteheads eines Akkords den Tönen zuordnen (tiefster Ton = unterster Notenkopf)
    for (const [g, list] of byEl) {
      const heads = [...g.querySelectorAll('.vf-notehead')].map(e => ({ e, y: e.getBoundingClientRect().top }));
      heads.sort((a, b) => b.y - a.y);
      const notes = list.filter(x => x.midi != null).sort((a, b) => a.midi - b.midi);
      notes.forEach((x, i) => { x.head = heads[i] ? heads[i].e : null; });
    }
    applySelection();
  }
  function entryOf(noteEl) { return map.find(x => x.el === noteEl); }
  function applySelection() {
    scoreBox.querySelectorAll('.ed-sel, .ed-selg').forEach(e => e.classList.remove('ed-sel', 'ed-selg'));
    if (sel) {
      const en = entryOf(sel);
      if (en) {
        if (en.head) en.head.classList.add('ed-sel'); else if (en.g) en.g.classList.add('ed-selg');
        const r = (en.head || en.g)?.getBoundingClientRect();
        if (r) {
          const wr = scoreWrap.getBoundingClientRect();
          if (r.top < wr.top + 20 || r.bottom > wr.bottom - 20) scoreWrap.scrollBy({ top: r.top - wr.top - wr.height / 3, behavior: 'smooth' });
        }
      }
    }
    drawOverlay();
    describe();
  }
  function measureBox(mi) {
    const ml = osmd.GraphicSheet.MeasureList[mi]; if (!ml) return null;
    const z = osmd.zoom * 10;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sm of ml) {
      if (!sm || !sm.PositionAndShape) continue;
      const p = sm.PositionAndShape.AbsolutePosition, s = sm.PositionAndShape.Size;
      if (!s || !s.width) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + s.width); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + 4);
    }
    if (!isFinite(x0)) return null;
    const svg = scoreBox.querySelector('svg'); const off = svg ? svg.getBoundingClientRect().left - scoreBox.getBoundingClientRect().left : 0;
    return { x: x0 * z + off, y: (y0 - 1.5) * z, w: (x1 - x0) * z, h: (y1 - y0 + 3) * z };
  }
  function drawOverlay() {
    overlay.innerHTML = '';
    const errs = score.rhythmErrors();
    for (const mi of errs) { const b = measureBox(mi); if (b) overlay.append(h('div.ed-err', { style: { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' }, title: 'Notenwerte passen nicht zur Taktart' })); }
    if (selMeasures) for (let mi = selMeasures[0]; mi <= selMeasures[1]; mi++) { const b = measureBox(mi); if (b) overlay.append(h('div.ed-msel', { style: { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' } })); }
    errNav.innerHTML = '';
    if (errs.length) {
      const curM = sel ? score.measureIndexOf(sel) : selMeasures ? selMeasures[0] : -1;
      const nextE = errs.find(e => e > curM) ?? errs[0], prevE = [...errs].reverse().find(e => e < curM) ?? errs[errs.length - 1];
      errNav.append(h('span.ed-errcount', `${errs.length} Takt${errs.length > 1 ? 'e' : ''} mit Rhythmusfehler`),
        h('button.btn.ghost.sm', { onclick: () => selectMeasure(prevE) }, '‹'), h('button.btn.ghost.sm', { onclick: () => selectMeasure(nextE) }, '›'));
    } else errNav.append(h('span.ed-ok', '✓ alle Takte rhythmisch vollständig'));
  }
  function describe() {
    if (sel) {
      const i = score.noteInfo(sel), mi = score.measureIndexOf(sel);
      const hand = i.staff === '1' ? 'oben' : i.staff === '2' ? 'unten' : 'System ' + i.staff;
      const what = i.rest ? 'Pause' : `${NAMES_DE[i.step] + (i.alter === 1 ? 'is' : i.alter === -1 ? (i.step === 'B' ? '' : i.step === 'E' || i.step === 'A' ? 's' : 'es') : '')}${i.step === 'B' && i.alter === -1 ? 'B' : ''}${i.octave}`.replace(/^HB/, 'B');
      const loc = score.locate(sel);
      status.innerHTML = '';
      if (addMode) status.append(h('span.ed-mode', '+ Ton'), ' ');
      status.append(h('b', `Takt ${mi + 1}`), ` · ${hand} · `, h('b', what), ` · ${TYPE_NAME[i.type] || '–'}${i.dots ? ' punktiert' : ''}${loc && loc.group.els.length > 1 ? ` · Akkord (${loc.group.els.length} Töne)` : ''}${i.tie.includes('start') ? ' · Haltebogen' : ''}`);
      durBtns.forEach(b => b.classList.toggle('active', b.dataset.type === i.type));
      dotBtn.classList.toggle('active', i.dots > 0); restBtn.classList.toggle('active', i.rest);
      kb.clear('target'); kb.clear('chord');
      if (loc && loc.group.els.length > 1) for (const el of loc.group.els) { const x = score.noteInfo(el); if (!x.rest) kb.mark(x.midi, el === sel ? 'target' : 'chord'); }
      else if (!i.rest) kb.mark(i.midi, 'target');
      followOriginal(mi);
    } else if (selMeasures) {
      status.innerHTML = '';
      status.append(h('b', selMeasures[0] === selMeasures[1] ? `Takt ${selMeasures[0] + 1}` : `Takte ${selMeasures[0] + 1}–${selMeasures[1] + 1}`), ' ausgewählt · „Takt …“ für Wiederholungen, Volten, Schlüssel, Tonart');
      followOriginal(selMeasures[0]);
      kb.clear('target');
    }
  }
  function cur(n) { return score.noteInfo(n); }

  // ---------- Auswahl ----------
  scoreBox.addEventListener('click', e => {
    const g = e.target.closest('.ed-note');
    if (g && byEl.has(g)) {
      const list = byEl.get(g);
      let pickE = list[0];
      if (list.length > 1) {
        let best = Infinity;
        for (const x of list) { const r = (x.head || x.g).getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - e.clientY); if (d < best) { best = d; pickE = x; } }
      }
      select(pickE.el, true);
      return;
    }
    // Klick ins Leere: Takt wählen (Umschalt: Bereich)
    const mi = measureAt(e.clientX, e.clientY);
    if (mi != null) {
      if (e.shiftKey && (selMeasures || sel)) { const a = selMeasures ? selMeasures[0] : score.measureIndexOf(sel); selMeasures = [Math.min(a, mi), Math.max(a, mi)]; sel = null; applySelection(); }
      else selectMeasure(mi, false);
    }
  });
  function measureAt(cx, cy) {
    const br = scoreBox.getBoundingClientRect();
    const x = cx - br.left, y = cy - br.top;
    for (let mi = 0; mi < score.measures.length; mi++) { const b = measureBox(mi); if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return mi; }
    return null;
  }
  function select(noteEl, sound = false) {
    sel = noteEl; selMeasures = null;
    applySelection();
    if (sound && sel) { const i = cur(sel); if (!i.rest) { const loc = score.locate(sel); audio.playNotes(loc ? loc.group.els.map(e => cur(e).midi).filter(Boolean) : [i.midi], { dur: 0.5, vel: 0.55 }); } }
  }
  function selectMeasure(mi, scroll = true) {
    if (mi == null) return;
    if (long() && (mi < winStart || mi >= winStart + WINDOW)) { winStart = Math.floor(mi / WINDOW) * WINDOW; render(false).then(() => selectMeasure(mi, scroll)); return; }
    sel = null; selMeasures = [mi, mi];
    // erste Note des Takts (oberes System) auswählen, damit man direkt loslegen kann
    const first = map.filter(x => x.mi === mi).sort((a, b) => a.staff - b.staff || a.onset - b.onset)[0];
    if (first) sel = first.el, selMeasures = null;
    applySelection();
    if (scroll) { const b = measureBox(mi); if (b) scoreWrap.scrollTo({ top: Math.max(0, b.y - 40), behavior: 'smooth' }); }
  }
  function move(dir) {
    if (!sel) return;
    const nx = score.nextInVoice(sel, dir > 0);
    if (nx) {
      const mi = score.measureIndexOf(nx.els[0]);
      if (long() && (mi < winStart || mi >= winStart + WINDOW)) { winStart = Math.floor(mi / WINDOW) * WINDOW; sel = nx.els[0]; render(false); return; }
      select(nx.els[0], true);
    }
  }
  function moveStaff(dir) {
    if (!sel) return;
    const en = entryOf(sel); if (!en) return;
    // anderer Ton im Akkord oder anderes System zur gleichen Zeit
    const loc = score.locate(sel);
    if (loc && loc.group.els.length > 1) {
      const sorted = [...loc.group.els].sort((a, b) => cur(a).midi - cur(b).midi);
      const i = sorted.indexOf(sel) + dir;
      if (i >= 0 && i < sorted.length) return select(sorted[i], true);
    }
    const other = map.filter(x => x.mi === en.mi && x.staff === en.staff - dir).sort((a, b) => Math.abs(a.onset - en.onset) - Math.abs(b.onset - en.onset))[0];
    if (other) select(other.el, true);
  }

  // ---------- Bearbeiten ----------
  /** Änderung an der gewählten Note; fn gibt ggf. die neu zu wählende Note zurück */
  async function act(label, fn, preview = false) {
    if (!sel) { toast('Erst eine Note antippen'); return; }
    const target = sel, pos = selPos();
    let next = null;
    const ok = score.edit(label, () => { const r = fn(target); next = r && r.nodeType === 1 ? r : target; });
    if (ok === false) return;
    sel = next && next.isConnected ? next : null;
    saveDraft();
    await render();
    if (!sel || !entryOf(sel)) reselect(pos);
    if (preview && sel) { const i = cur(sel); if (!i.rest) audio.playNotes([i.midi], { dur: 0.45, vel: 0.55 }); }
  }
  async function measureAct(label, fn) {
    const r = selMeasures || (sel ? [score.measureIndexOf(sel), score.measureIndexOf(sel)] : null);
    if (!r) { toast('Erst einen Takt wählen'); return; }
    score.edit(label, () => fn(r[0], r[1]));
    saveDraft();
    await render();
  }
  /** Auswahl als Position merken (Takt, System, Zeitpunkt) – überlebt Undo/Neuaufbau */
  function selPos() {
    const en = sel && entryOf(sel); if (!en) return null;
    return { mi: en.mi, staff: en.staff, onset: en.onset, midi: en.midi };
  }
  function reselect(pos) {
    if (!pos) return;
    const c = map.filter(x => x.mi === pos.mi && x.staff === pos.staff);
    if (!c.length) return;
    const on = x => x.onset;
    c.sort((a, b) => Math.abs(on(a) - pos.onset) - Math.abs(on(b) - pos.onset) || Math.abs((a.midi ?? 0) - (pos.midi ?? 0)) - Math.abs((b.midi ?? 0) - (pos.midi ?? 0)));
    sel = c[0].el; selMeasures = null; applySelection();
  }
  async function doUndo() { const pos = selPos(); const l = score.undo(); if (l) { toast('Rückgängig: ' + l); sel = null; saveDraft(); await render(); reselect(pos); } }
  async function doRedo() { const pos = selPos(); const l = score.redo(); if (l) { toast('Wiederholt: ' + l); sel = null; saveDraft(); await render(); reselect(pos); } }
  let draftTimer = 0;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { try { localStorage.setItem('nt2.draft.' + id, JSON.stringify({ xml: score.serialize(), at: Date.now(), base: song.updated || song.added })); } catch {} }, 600);
  }

  // Tonhöhe per Klavier (MIDI) oder Bildschirm-Klaviatur: gleichzeitige Töne = Akkord
  function onPlayed({ midi }) {
    if (!sel || destroyed) return;
    chordBuf.push(midi);
    clearTimeout(chordTimer);
    chordTimer = setTimeout(applyPlayed, 90);
  }
  async function applyPlayed() {
    const notes = [...new Set(chordBuf)].sort((a, b) => a - b); chordBuf = [];
    if (!sel || !notes.length) return;
    const target = sel;
    if (addMode) return toggleChordNotes(target, notes);
    score.edit(notes.length > 1 ? 'Akkord' : 'Tonhöhe', () => {
      const loc = score.locate(target); if (!loc) return false;
      const first = loc.group.els[0];
      // Akkord ersetzen: übrige Töne entfernen, erste Note setzen, weitere anfügen
      for (const el of loc.group.els.slice(1)) el.remove();
      if (score.noteInfo(first).rest) score.toNote(first, notes[0]); else score.setPitch(first, notes[0]);
      for (const m of notes.slice(1)) score.addChordNote(first, m);
      sel = first;
    });
    saveDraft();
    await render();
    if (opts.advance) move(1);
  }
  /** Töne zum Akkord hinzufügen bzw. – wenn schon vorhanden – herausnehmen; Auswahl bleibt auf dem Akkord */
  async function toggleChordNotes(target, notes) {
    let added = 0, removed = 0, keep = target;
    score.edit('Akkordton', () => {
      for (const m of notes) {
        const loc = score.locate(keep); if (!loc) return false;
        const hit = loc.group.els.find(el => score.noteInfo(el).midi === m);
        if (hit && loc.group.els.length > 1) { keep = score.deleteNote(hit) || keep; removed++; }
        else if (!hit) { const n = score.addChordNote(keep, m); if (n) { added++; if (score.noteInfo(keep).rest) keep = n; } }
      }
      if (!added && !removed) return false;
      const loc = score.locate(keep);
      sel = loc ? loc.group.els[0] : keep;
    });
    saveDraft();
    await render();
    toast(added && !removed ? `${added > 1 ? added + ' Töne' : 'Ton'} hinzugefügt` : removed && !added ? `${removed > 1 ? removed + ' Töne' : 'Ton'} entfernt` : added || removed ? 'Akkord geändert' : 'Keine Änderung');
  }
  const offs = [input.on('noteon', onPlayed)];

  // Tastatur
  function onKey(e) {
    if (destroyed || (e.target.closest && e.target.closest('input, textarea, select, .sheet'))) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (mod) return;
    const map2 = {
      ArrowRight: () => move(1), ArrowLeft: () => move(-1),
      ArrowUp: () => e.shiftKey ? act('Oktave', n => score.stepPitch(n, 7), true) : e.altKey ? moveStaff(1) : act('Tonhöhe', n => score.stepPitch(n, 1), true),
      ArrowDown: () => e.shiftKey ? act('Oktave', n => score.stepPitch(n, -7), true) : e.altKey ? moveStaff(-1) : act('Tonhöhe', n => score.stepPitch(n, -1), true),
      '+': () => act('Kreuz', n => score.setAlter(n, 1), true), '-': () => act('Be', n => score.setAlter(n, -1), true), '=': () => act('Auflösung', n => score.setAlter(n, 0), true),
      '.': () => act('Punkt', n => { const i = cur(n); score.setDuration(n, i.type || 'quarter', i.dots ? 0 : 1); }),
      '0': () => act('Pause', n => cur(n).rest ? score.toNote(n) : score.toRest(n)),
      Delete: () => e.shiftKey ? act('Entfernen', n => score.removeGroup(n)) : act('Löschen', n => score.deleteNote(n)),
      Backspace: () => act('Löschen', n => score.deleteNote(n)),
      t: () => act('Haltebogen', n => { score.toggleTie(n); return n; }), i: () => act('Einfügen', n => score.duplicateGroup(n)),
      m: () => measureSheet(), ' ': () => togglePlay(), Escape: () => { if (addMode) return setAddMode(false); sel = null; selMeasures = null; applySelection(); }
    };
    if (map2[k]) { e.preventDefault(); map2[k](); return; }
    if (DUR_KEYS[k]) { e.preventDefault(); act('Dauer', n => score.setDuration(n, DUR_KEYS[k], 0)); return; }
    const L = k.toUpperCase();
    if (/^[A-H]$/.test(L) && k.length === 1) {
      if (!sel) return;
      e.preventDefault();
      if (e.shiftKey || addMode) {
        // Ton zum Akkord: nächstgelegene Lage über dem höchsten Akkordton (bzw. darunter, wenn sehr hoch)
        const de = prefs.naming !== 'en', step = L === 'H' ? 'B' : L;
        const st = score.stateAt(score.measureIndexOf(sel));
        const alter = de && L === 'B' ? -1 : de && L === 'H' ? 0 : (keyAltersOf(st.fifths)[step] || 0);
        const loc = score.locate(sel);
        const midis = loc ? loc.group.els.map(el => score.noteInfo(el).midi).filter(x => x != null) : [];
        const top = midis.length ? Math.max(...midis) : 60;
        const pcT = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] + alter + 12) % 12;
        let m = top + 1; while (((m % 12) + 12) % 12 !== pcT) m++;
        if (m > 96) m -= 12;
        if (midis.includes(m - 12) || midis.includes(m)) { /* schon da → entfernen */ m = midis.find(x => ((x % 12) + 12) % 12 === pcT) ?? m; }
        toggleChordNotes(sel, [m]);
        return;
      }
      // deutsch: H = h, B = b (also B♭); international: B = h
      const de = prefs.naming !== 'en';
      const step = L === 'H' ? 'B' : L;
      act('Tonname', n => {
        const i = cur(n);
        const st = score.stateAt(score.measureIndexOf(n));
        const keyAlt = keyAltersOf(st.fifths)[step] || 0;
        const alter = de && L === 'B' ? -1 : de && L === 'H' ? 0 : keyAlt;
        const base = i.rest ? 60 : i.midi;
        let best = null;
        for (let o = 0; o <= 8; o++) {
          const m = (o + 1) * 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] + alter;
          if (best == null || Math.abs(m - base) < Math.abs(best.m - base)) best = { m, o };
        }
        score.setPitch(n, best.m, { step, octave: best.o, alter });
      }, true);
    }
  }
  const keyAltersOf = f => { const out = {}; if (f > 0) for (const s of 'FCGDAEB'.slice(0, f)) out[s] = 1; if (f < 0) for (const s of 'BEADGCF'.slice(0, -f)) out[s] = -1; return out; };
  document.addEventListener('keydown', onKey);

  // ---------- Takt-Menü ----------
  function measureSheet() {
    const r = selMeasures || (sel ? [score.measureIndexOf(sel), score.measureIndexOf(sel)] : null);
    if (!r) { toast('Erst einen Takt oder eine Note wählen'); return; }
    const [a, b] = r, single = a === b;
    const st = score.stateAt(a);
    let s;
    const close = fn => async () => { s.close(); await fn(); };
    const btn = (label, fn, cls = '') => h('button.btn' + cls, { onclick: close(fn) }, label);
    const staff = sel ? cur(sel).staff : '1';
    const keyNames = { '-7': 'Ces/as', '-6': 'Ges/es', '-5': 'Des/b', '-4': 'As/f', '-3': 'Es/c', '-2': 'B/g', '-1': 'F/d', 0: 'C/a', 1: 'G/e', 2: 'D/h', 3: 'A/fis', 4: 'E/cis', 5: 'H/gis', 6: 'Fis/dis', 7: 'Cis/ais' };
    const keySel = h('select', Array.from({ length: 15 }, (_, i) => i - 7).map(f => { const o = h('option', { value: f }, `${keyNames[f]} (${f > 0 ? f + '♯' : f < 0 ? -f + '♭' : 'keine'})`); if (f === st.fifths) o.selected = true; return o; }));
    const beats = h('input.input.sm', { type: 'number', min: 1, max: 32, value: st.beats }), beatType = h('select', [1, 2, 4, 8, 16].map(v => { const o = h('option', { value: v }, String(v)); if (v === st.beatType) o.selected = true; return o; }));
    const keepPos = h('input', { type: 'checkbox', checked: true });
    const respell = h('input', { type: 'checkbox', checked: true });
    s = sheet(single ? `Takt ${a + 1}` : `Takte ${a + 1}–${b + 1}`, [
      h('div.ed-sec', h('h5', 'Takte'), h('div.row.wrap',
        btn('+ Takt davor', () => measureAct('Takt einfügen', m => { const n = score.insertMeasure(m, false); selMeasures = [n, n]; sel = null; })),
        btn('+ Takt danach', () => measureAct('Takt einfügen', (m, e) => { const n = score.insertMeasure(e, true); selMeasures = [n, n]; sel = null; })),
        btn('Takt duplizieren', () => measureAct('Takt duplizieren', m => { const n = score.duplicateMeasure(m); selMeasures = [n, n]; sel = null; })),
        btn('Kopieren', async () => { clip = score.copyMeasureXml(a); toast(`Takt ${a + 1} kopiert`); }),
        clip ? btn('Einfügen (ersetzt)', () => measureAct('Takt einfügen', (m, e) => { for (let i = m; i <= e; i++) score.pasteMeasure(clip, i); })) : '',
        btn(single ? 'Takt löschen' : 'Takte löschen', () => measureAct('Takt löschen', (m, e) => { for (let i = e; i >= m; i--) score.deleteMeasure(i); sel = null; selMeasures = [Math.min(m, score.measures.length - 1), Math.min(m, score.measures.length - 1)]; }), '.danger'))),
      directionsSection(a, close),
      h('div.ed-sec', h('h5', 'Wiederholungen'), h('div.row.wrap',
        btn((score.hasRepeat(a, 'start') ? '✓ ' : '') + '|: Beginn', () => measureAct('Wiederholung', m => score.setRepeat(m, 'start', !score.hasRepeat(m, 'start')))),
        btn((score.hasRepeat(b, 'end') ? '✓ ' : '') + ':| Ende', () => measureAct('Wiederholung', (m, e) => score.setRepeat(e, 'end', !score.hasRepeat(e, 'end')))),
        btn((score.endingAt(a) === 1 ? '✓ ' : '') + '1. Volte', () => measureAct('Volte', (m, e) => score.setEnding(m, e, score.endingAt(m) === 1 ? null : 1))),
        btn((score.endingAt(a) === 2 ? '✓ ' : '') + '2. Volte', () => measureAct('Volte', (m, e) => score.setEnding(m, e, score.endingAt(m) === 2 ? null : 2))),
        btn('Doppelstrich', () => measureAct('Taktstrich', (m, e) => score.setBarStyle(e, 'light-light'))),
        btn('Schlussstrich', () => measureAct('Taktstrich', (m, e) => score.setBarStyle(e, 'light-heavy'))))),
      h('div.ed-sec', h('h5', 'Sprünge'), h('div.row.wrap',
        ...[['segno', 'Segno'], ['coda', 'Coda (Ziel)'], ['tocoda', 'To Coda'], ['dalsegno', 'D.S. al Coda'], ['dacapo', 'D.C.'], ['fine', 'Fine']].map(([k, l]) =>
          btn((score.hasJump(a, k) ? '✓ ' : '') + l, () => measureAct('Sprung', m => score.setJump(m, k, !score.hasJump(m, k))))))),
      h('div.ed-sec', h('h5', 'Schlüssel ' + (sel ? `ab der gewählten Note (System ${staff === '1' ? 'oben' : 'unten'})` : '(Taktanfang, oberes System)')),
        h('div.row.wrap', ...[['G', 2, 'Violin'], ['F', 4, 'Bass'], ['C', 3, 'Alt'], ['C', 4, 'Tenor']].map(([sg, ln, l]) => btn(l, () => clefAct(sg, ln, keepPos.checked)))),
        h('label.ed-mini', keepPos, 'Noten bleiben an ihrem Platz (Tonhöhen anpassen) – richtig, wenn die Erkennung einen Schlüsselwechsel übersehen hat')),
      h('div.ed-sec', h('h5', 'Tonart ab hier'), h('div.row.wrap', keySel, h('button.btn', { onclick: close(() => measureAct('Tonart', m => score.setKey(m, +keySel.value, { respell: respell.checked }))) }, 'Übernehmen')),
        h('label.ed-mini', respell, 'Vorzeichen der Noten mit anpassen (wenn die Tonart falsch erkannt wurde)')),
      h('div.ed-sec', h('h5', 'Taktart ab hier'), h('div.row.wrap', beats, h('span', '/'), beatType, h('button.btn', { onclick: close(() => measureAct('Taktart', m => score.setTime(m, +beats.value, +beatType.value))) }, 'Übernehmen')))
    ]);
    async function clefAct(sign, line, keep) {
      let target = sel;
      if (!target) { const first = map.filter(x => x.mi === a && x.staff === 0)[0]; target = first && first.el; }
      if (!target) return toast('Keine Note in diesem Takt');
      const stf = cur(target).staff;
      score.edit('Schlüssel', () => score.setClef(target, stf, sign, line, keep));
      saveDraft(); await render();
    }
  }
  /** Dynamik & Text des Takts: Liste mit Löschen/Ändern, neue hinzufügen */
  function directionsSection(mi, close) {
    const list = score.directions(mi);
    const staffSel = segmented([['1', 'oben'], ['2', 'unten']], sel ? cur(sel).staff : '1', () => {});
    const getStaff = () => staffSel.querySelector('.active')?.dataset.v || '1';
    const dynSel = h('select', ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sf', 'sfz', 'fp', 'ppp', 'fff'].map(d => h('option', { value: d }, d)));
    const words = h('input.input', { placeholder: 'Text, z. B. cresc., a tempo, dolce' });
    const add = (spec, placement) => close(() => measureAct('Bezeichnung', m => score.addDirection(m, sel && score.measureIndexOf(sel) === m ? sel : null, spec, { placement, staff: getStaff() })))();
    return h('div.ed-sec', h('h5', 'Dynamik & Text'),
      list.length ? h('div.ed-dirs', list.map(d => h('div.ed-dir', h('span', d.label), h('span.muted', d.staff === '2' ? 'unten' : 'oben'), h('span.spacer'),
        d.el.getElementsByTagName('words')[0] ? h('button.btn.ghost.sm', { onclick: () => { const t = prompt('Text ändern', d.el.getElementsByTagName('words')[0].textContent); if (t != null) close(() => measureAct('Text ändern', () => score.setWords(d.el, t)))(); } }, 'Ändern') : '',
        h('button.btn.ghost.sm.danger', { onclick: close(() => measureAct('Bezeichnung entfernen', () => score.removeEl(d.el))) }, '✕')))) : h('div.muted', { style: { fontSize: '13px' } }, 'Keine Bezeichnungen in diesem Takt.'),
      h('div.row.wrap', { style: { marginTop: '10px' } }, staffSel),
      h('div.row.wrap', { style: { marginTop: '8px' } }, dynSel, h('button.btn', { onclick: () => add({ dynamic: dynSel.value }, 'below') }, '+ Dynamik'),
        h('button.btn', { onclick: () => add({ wedge: 'crescendo' }, 'below') }, '+ <'), h('button.btn', { onclick: () => add({ wedge: 'diminuendo' }, 'below') }, '+ >'), h('button.btn', { onclick: () => add({ wedge: 'stop' }, 'below') }, 'Gabel-Ende')),
      h('div.row.wrap', { style: { marginTop: '8px' } }, words, h('button.btn', { onclick: () => words.value.trim() && add({ words: words.value.trim() }, 'below') }, '+ unten'), h('button.btn', { onclick: () => words.value.trim() && add({ words: words.value.trim() }, 'above') }, '+ oben')),
      h('div.field-hint', 'Neue Bezeichnungen kommen vor die gewählte Note (sonst an den Taktanfang).'));
  }
  function scoreSheet() {
    const t = h('input.input', { value: score.title }), c = h('input.input', { value: score.composer || song.composer || '' }), bpm = h('input.input', { type: 'number', min: 20, max: 400, value: score.tempo || '' });
    let s;
    s = sheet('Stück', [
      field('Titel', t), field('Komponist / Interpret', c), field('Tempo (Viertel pro Minute)', bpm),
      h('button.btn.primary', { onclick: async () => {
        score.edit('Kopfdaten', () => { score.title = t.value.trim(); score.composer = c.value.trim(); if (+bpm.value) score.tempo = +bpm.value; });
        s.close(); saveDraft(); await render();
      } }, 'Übernehmen')
    ]);
  }

  // ---------- Original ----------
  async function toggleOriginal(force) {
    const show = force ?? origPane.hidden;
    origPane.hidden = !show; opts.original = show;
    layout.classList.toggle('with-orig', show);
    if (show && !pdf && !origImg) {
      origInfo.textContent = 'Lade Original …';
      try {
        const data = await library.original(song.id);
        if (song.origType === 'pdf') {
          await loadScript(PDFJS_URL);
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
          pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        } else {
          origImg = new Image();
          origImg.src = URL.createObjectURL(new Blob([data]));
          await origImg.decode();
        }
        await showPage(sel ? score.pageOfMeasure(score.measureIndexOf(sel)) : 0);
      } catch (e) { origInfo.textContent = 'Original nicht verfügbar'; console.error(e); }
    }
    await render();
  }
  async function showPage(p) {
    const view = origPane.querySelector('.ed-orig-view');
    const W = Math.max(200, view.clientWidth - 4) * (devicePixelRatio || 1);
    const g = origCanvas.getContext('2d');
    if (pdf) {
      pdfPage = Math.max(0, Math.min(pdf.numPages - 1, p));
      const page = await pdf.getPage(pdfPage + 1);
      const vp0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: W / vp0.width });
      origCanvas.width = vp.width; origCanvas.height = vp.height;
      await page.render({ canvasContext: g, viewport: vp }).promise;
      origInfo.textContent = `Seite ${pdfPage + 1} / ${pdf.numPages}`;
    } else if (origImg) {
      origCanvas.width = W; origCanvas.height = W * origImg.naturalHeight / origImg.naturalWidth;
      g.drawImage(origImg, 0, 0, origCanvas.width, origCanvas.height);
      origInfo.textContent = 'Foto';
    }
  }
  function followOriginal(mi) {
    if (!opts.follow || origPane.hidden || !pdf) return;
    const p = score.pageOfMeasure(mi);
    if (p !== pdfPage) showPage(p);
  }

  // ---------- Abspielen ab Auswahl ----------
  function togglePlay() {
    if (playTimer) return stopPlay();
    const start = sel ? score.measureIndexOf(sel) : selMeasures ? selMeasures[0] : 0;
    const bpm = score.tempo || 100;
    const events = [];
    let t = 0;
    for (let mi = start; mi < score.measures.length; mi++) {
      const st = score.stateAt(mi);
      const q = 60 / bpm / st.divisions; // Sekunden pro division
      const model = score.parse(score.measures[mi]);
      for (const v of model.voices) {
        let vt = 0;
        for (const it of v.items) {
          if (it.kind === 'note' && !it.grace) {
            for (const el of it.els) { const i = score.noteInfo(el); if (!i.rest && !i.tie.includes('stop')) events.push({ t: t + vt * q, midi: i.midi, dur: it.dur * q, el, mi }); }
          }
          vt += it.dur;
        }
      }
      t += score.measureLength(mi) * q;
    }
    events.sort((a, b) => a.t - b.t);
    const t0 = audio.now + 0.15;
    let k = 0;
    playTimer = setInterval(() => {
      const now = audio.now;
      while (k < events.length && t0 + events[k].t < now + 0.2) {
        const ev = events[k++];
        const at = t0 + ev.t;
        if (!input.sendNote(ev.midi, 85, performance.now() + Math.max(0, at - now) * 1000, ev.dur * 1000)) audio.piano(ev.midi, at, ev.dur, 0.6);
      }
      if (k >= events.length) stopPlay();
    }, 40);
    toolbar.querySelector('[title^="Ab Auswahl"]').textContent = '■';
  }
  function stopPlay() { clearInterval(playTimer); playTimer = null; input.allNotesOff(); const b = toolbar.querySelector('[title^="Ab Auswahl"]'); if (b) b.textContent = '▶'; }

  // ---------- Speichern ----------
  async function save() {
    if (!score.dirty) { toast('Keine Änderungen'); return; }
    saveBtn.disabled = true;
    try {
      const xml = score.serialize();
      if (library.remote) {
        const r = await fetch('api/songs/' + encodeURIComponent(id) + '/score', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/xml' }, body: xml });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Fehler ' + r.status);
        const meta = await r.json();
        song.updated = meta.updated;
      } else {
        const bytes = new TextEncoder().encode(xml);
        Object.assign(song, { type: 'musicxml', data: bytes.buffer, title: score.title || song.title, composer: score.composer || song.composer, updated: Date.now() });
        await library.put(song);
      }
      score.dirty = false;
      try { localStorage.removeItem('nt2.draft.' + id); } catch {}
      saveBtn.classList.remove('pulse');
      toast('Gespeichert ✓');
    } catch (e) { toast('Speichern fehlgeschlagen: ' + e.message); }
    finally { saveBtn.disabled = false; }
  }
  const beforeUnload = e => { if (score && score.dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', beforeUnload);
  const onResize = () => { clearTimeout(onResize.t); onResize.t = setTimeout(() => render(), 300); };
  addEventListener('resize', onResize);

  return () => {
    destroyed = true;
    if (score && score.dirty) toast('Nicht gespeicherte Änderungen bleiben als Entwurf erhalten');
    stopPlay(); offs.forEach(f => f()); kb.destroy();
    document.removeEventListener('keydown', onKey);
    removeEventListener('beforeunload', beforeUnload); removeEventListener('resize', onResize);
    try { osmd && osmd.clear(); } catch {}
  };
}
