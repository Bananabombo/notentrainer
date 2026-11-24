// Abspielreihenfolge von Takten: Wiederholungen, Volten (1./2. Klammer), D.C./D.S., Coda, Fine.
// Bewusst robust gegen Fehler der Notenerkennung: Volten ohne zugehöriges Wiederholungszeichen
// werden ignoriert, Sprünge ohne Ziel (z. B. D.S. ohne erkanntes Segno) ebenso.

/**
 * @typedef {Object} MeasureInfo
 * @property {boolean} [start]      Wiederholung beginnt (|:)
 * @property {boolean} [back]       Wiederholung endet (:|)
 * @property {number}  [times]      wie oft der Abschnitt gespielt wird (Standard 2)
 * @property {number[]} [endingBegin] Volte beginnt hier (Nummern)
 * @property {number[]} [endingEnd]   Volte endet hier (Nummern)
 * @property {boolean} [segno] [coda] [toCoda] [fine]
 * @property {'dc'|'ds'} [jump]     D.C. oder D.S. am Taktende
 * @property {'coda'|'fine'} [jumpTo] „al Coda“ / „al Fine“ (fehlt → beides erlaubt)
 */

/** Volten den Takten zuordnen; nur gültige (mit Wiederholungszeichen) bleiben übrig */
export function resolveEndings(ms) {
  const n = ms.length;
  const ending = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = ms[i];
    if (m.endingBegin && m.endingBegin.length) {
      // Volte reicht bis zum Ende-Zeichen bzw. :| (höchstens 6 Takte), sonst nur dieser Takt
      let to = i;
      for (let k = i; k < Math.min(n, i + 6); k++) {
        if ((ms[k].endingEnd && ms[k].endingEnd.length) || ms[k].back) { to = k; break; }
        if (k > i && ms[k].endingBegin && ms[k].endingBegin.length) break;
      }
      for (let k = i; k <= to; k++) ending[k] = ending[k] || m.endingBegin;
    } else if (!ending[i] && m.endingEnd && m.endingEnd.length) ending[i] = m.endingEnd;
  }
  // Gruppen: zusammenhängende Takte mit gleicher Volten-Nummer
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (!ending[i]) continue;
    const last = groups[groups.length - 1];
    if (last && last.to === i - 1 && last.nums.join() === ending[i].join()) last.to = i;
    else groups.push({ nums: ending[i], from: i, to: i });
  }
  // gültig: Volte endet mit :| – oder schließt direkt an eine solche gültige Volte an
  const valid = new Array(n).fill(null);
  const ok = new Set();
  groups.forEach((g, gi) => {
    const prev = groups[gi - 1];
    const followsValid = prev && ok.has(gi - 1) && prev.to === g.from - 1;
    if (ms[g.to].back || followsValid) {
      ok.add(gi);
      for (let i = g.from; i <= g.to; i++) valid[i] = g.nums;
    }
  });
  return valid;
}

/** Reihenfolge der Taktindizes zum Abspielen */
export function playOrder(ms) {
  const n = ms.length;
  if (!n) return [];
  const endings = resolveEndings(ms);
  const segno = ms.findIndex(m => m.segno);
  const coda = ms.findIndex(m => m.coda);
  // höchste Volten-Nummer einer Gruppe (beim Durchgang nach D.C./D.S. wird die letzte Volte gespielt)
  const lastEnding = j => { let a = j, b = j; while (a > 0 && endings[a - 1]) a--; while (b + 1 < n && endings[b + 1]) b++; let mx = 0; for (let x = a; x <= b; x++) mx = Math.max(mx, ...endings[x]); return mx; };
  const order = [];
  const backTaken = new Map();
  let i = 0, sectionStart = 0, pass = 1, repeatEnd = -1, jumped = false, jumpTo = null, guard = 0;
  while (i < n && guard++ < n * 12) {
    const m = ms[i];
    if (m.start) sectionStart = i;
    if (endings[i]) {
      if (!endings[i].includes(jumped ? lastEnding(i) : pass)) {
        if (m.back && !jumped && pass >= (m.times || 2)) { repeatEnd = i; sectionStart = i + 1; }  // übersprungene 1. Volte schließt die Wiederholung ab
        i++; continue;
      }
    } else if (pass > 1 && i > repeatEnd) pass = 1;   // Wiederholung samt Volten vorbei
    order.push(i);
    if (m.back && !jumped) {
      const done = backTaken.get(i) || 0;
      if (done < (m.times || 2) - 1) { backTaken.set(i, done + 1); pass = done + 2; repeatEnd = Infinity; i = sectionStart; continue; }
      sectionStart = i + 1; repeatEnd = i;
    }
    if (jumped && m.toCoda && coda > i && jumpTo !== 'fine') { i = coda; continue; }
    if (jumped && m.fine && jumpTo !== 'coda') break;
    if (!jumped && m.jump) {
      const target = m.jump === 'dc' ? 0 : segno;
      if (target >= 0 && target <= i) { jumped = true; jumpTo = m.jumpTo || null; pass = 1; i = target; continue; }
    }
    i++;
  }
  return order;
}

/** Takt-Infos aus OpenSheetMusicDisplay (SourceMeasures mit RepetitionInstructions) */
export function measuresFromOSMD(sheet) {
  const E = { StartLine: 0, BackJumpLine: 2, Ending: 3, DaCapo: 4, DalSegno: 5, Fine: 6, ToCoda: 7, DalSegnoAlFine: 8, DaCapoAlFine: 9, DalSegnoAlCoda: 10, DaCapoAlCoda: 11, Coda: 12, Segno: 13 };
  return sheet.SourceMeasures.map(sm => {
    const info = {};
    const all = [...(sm.FirstRepetitionInstructions || []), ...(sm.LastRepetitionInstructions || [])];
    for (const r of all) {
      switch (r.type) {
        case E.StartLine: info.start = true; break;
        case E.BackJumpLine: info.back = true; break;
        case E.Ending:
          (r.alignment === 0 ? (info.endingBegin = info.endingBegin || []) : (info.endingEnd = info.endingEnd || [])).push(...(r.endingIndices || []).map(Number));
          break;
        case E.DaCapo: info.jump = 'dc'; break;
        case E.DalSegno: info.jump = 'ds'; break;
        case E.DaCapoAlFine: info.jump = 'dc'; info.jumpTo = 'fine'; break;
        case E.DalSegnoAlFine: info.jump = 'ds'; info.jumpTo = 'fine'; break;
        case E.DaCapoAlCoda: info.jump = 'dc'; info.jumpTo = 'coda'; break;
        case E.DalSegnoAlCoda: info.jump = 'ds'; info.jumpTo = 'coda'; break;
        case E.Fine: info.fine = true; break;
        case E.ToCoda: info.toCoda = true; break;
        case E.Coda: info.coda = true; break;
        case E.Segno: info.segno = true; break;
      }
    }
    if (sm.endsWithLineRepetition && sm.endsWithLineRepetition()) info.back = true;
    if (sm.beginsWithLineRepetition && sm.beginsWithLineRepetition()) info.start = true;
    return info;
  });
}

/**
 * Manuelle Korrekturen (Taktnummern ab 1), z. B. wenn die Notenerkennung Segno/Coda übersehen hat.
 * fix = { segno, toCoda, coda, jumpAt, jump: 'ds'|'dc', off: true }
 */
export function applyFixes(ms, fix) {
  if (!fix) return ms;
  const out = ms.map(m => ({ ...m }));
  const at = n => (n >= 1 && n <= out.length ? out[n - 1] : null);
  if (fix.off) { out.forEach(m => { delete m.jump; delete m.toCoda; delete m.coda; delete m.segno; delete m.fine; }); return out; }
  for (const key of ['segno', 'toCoda', 'coda']) {
    if (fix[key] == null) continue;
    out.forEach(m => { delete m[key]; });
    if (at(fix[key])) at(fix[key])[key] = true;
  }
  if (fix.jumpAt) {
    out.forEach(m => { delete m.jump; delete m.jumpTo; });
    const m = at(fix.jumpAt);
    if (m) { m.jump = fix.jump || (fix.segno ? 'ds' : 'dc'); if (fix.coda) m.jumpTo = 'coda'; }
  } else if (fix.coda) out.forEach(m => { if (m.jump) m.jumpTo = 'coda'; });
  return out;
}

/** Kurzbeschreibung der gefundenen Sprünge (1-basiert) für die Anzeige */
export function describeJumps(ms) {
  const find = k => { const i = ms.findIndex(m => m[k]); return i >= 0 ? i + 1 : null; };
  const ji = ms.findIndex(m => m.jump);
  return { segno: find('segno'), toCoda: find('toCoda'), coda: find('coda'), fine: find('fine'),
    jumpAt: ji >= 0 ? ji + 1 : null, jump: ji >= 0 ? ms[ji].jump : null,
    repeats: ms.filter(m => m.back).length };
}
