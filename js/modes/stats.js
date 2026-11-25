// Fortschritt: Level, Serie, Übungszeit, Beherrschung je Note/Akkord/Tonleiter, Schwachstellen, Abzeichen
import { h, icon, segmented, toast } from '../core/ui.js';
import { items, days, game, level, streakDays, todayStats, mastery, masteryLabel, weakest, BADGES, today } from '../core/stats.js';
import { CIRCLE, noteName, SCALES } from '../core/music.js';
import { go } from '../app.js';

const MODE_NAMES = { notes: 'Noten lesen', chords: 'Akkorde', circle: 'Quintenzirkel', scales: 'Tonleitern', improv: 'Improvisation', library: 'Bibliothek' };
const MODE_HUE = { notes: 245, chords: 280, circle: 200, scales: 160, improv: 25, library: 48 };
const mColor = m => m == null ? 'var(--surface-3)' : `color-mix(in srgb, ${m >= 0.5 ? 'var(--ok)' : 'var(--bad)'} ${Math.round(Math.abs(m - 0.5) * 2 * 100)}%, var(--warn))`;
const fmtMin = ms => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const dayKey = off => { const d = new Date(); d.setDate(d.getDate() - off); return today(d); };

export default {
  mount(root, ctx) {
    ctx.setTitle('Fortschritt');
    const lv = level(), t = todayStats(), st = streakDays();
    const allDays = Object.values(days);
    const totalMs = allDays.reduce((a, d) => a + (d.ms || 0), 0);
    const totalOk = allDays.reduce((a, d) => a + (d.ok || 0), 0), totalAll = allDays.reduce((a, d) => a + (d.total || 0), 0);

    // ---------- Kopf ----------
    const ring = (p, size, stroke, cls = '') => {
      const r = (size - stroke) / 2, c = 2 * Math.PI * r;
      const el = h('span.ring-wrap' + cls);
      el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
      requestAnimationFrame(() => setTimeout(() => { el.querySelector('.ring-fg').style.strokeDashoffset = c * (1 - Math.min(1, p)); }, 80));
      return el;
    };
    const tile = (big, label, sub, extra) => h('div.st-tile', extra || '', h('div', h('div.st-big', big), h('div.st-label', label), sub ? h('div.st-sub', sub) : ''));
    const goalSeg = segmented([['100', '100 · locker'], ['300', '300 · normal'], ['600', '600 · ehrgeizig'], ['1200', '1200 · intensiv']], String(game.goal), v => { game.goal = +v; toast('Tagesziel: ' + v + ' XP'); renderAll(); });
    const head = h('section.st-head',
      tile(lv.level, lv.name, `${lv.xp.toLocaleString('de-DE')} XP · noch ${lv.to - lv.xp} bis Level ${lv.level + 1}`, h('div.st-ring', ring(lv.progress, 74, 7), h('span', '★'))),
      tile(st + (st === 1 ? ' Tag' : ' Tage'), 'in Folge geübt', `Rekord: ${game.bestStreak || st} Tage`, h('div.st-emoji', '🔥')),
      tile(`${t.xp} / ${t.goal}`, 'XP heute', `${fmtMin(t.ms)} geübt`, h('div.st-ring' + (t.xp >= t.goal ? '.done' : ''), ring(t.xp / t.goal, 74, 7), h('span', '🎯'))),
      tile(fmtMin(totalMs), 'Übungszeit gesamt', totalAll ? `${totalAll.toLocaleString('de-DE')} Aufgaben · ${Math.round(100 * totalOk / totalAll)} % auf Anhieb` : 'Noch keine Aufgaben', h('div.st-emoji', '⏱️')));

    const body = h('div.st-body');
    root.append(head, h('div.row.st-goal', h('span.muted', 'Tagesziel (XP):'), goalSeg), body);

    function renderAll() {
      body.innerHTML = '';
      body.append(activityCard(), weakCard(), notesCard(), chordsCard(), scalesCard(), circleCard(), modesCard(), badgesCard());
    }

    // ---------- Aktivität: 30 Tage + Kalender ----------
    function activityCard() {
      const N = 30;
      const vals = Array.from({ length: N }, (_, i) => { const k = dayKey(N - 1 - i); return { k, d: days[k] || { xp: 0, ms: 0 } }; });
      const max = Math.max(10, ...vals.map(v => v.d.xp));
      const tip = h('div.st-tip', 'Tippe auf einen Balken');
      const goalPct = Math.min(100, game.goal / max * 100);
      const svg = h('div.st-bars', h('div.goal-line', { style: { bottom: goalPct + '%' } }),
        vals.map((v, i) => h('div.bar' + (v.d.xp >= game.goal ? '.goal' : v.d.xp ? '.some' : ''), {
          style: { height: Math.max(v.d.xp ? 3 : 1.5, v.d.xp / max * 100) + '%', animationDelay: i * 15 + 'ms' },
          onpointerenter: () => { const dt = new Date(v.k); tip.textContent = `${dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}: ${v.d.xp} XP · ${fmtMin(v.d.ms || 0)}`; }
        })));
      // Kalender (20 Wochen)
      const weeks = 20, cal = h('div.st-cal');
      const start = new Date(); start.setDate(start.getDate() - (weeks * 7 - 1) - ((start.getDay() + 6) % 7 - 6 + 7) % 7);
      for (let w = 0; w < weeks; w++) {
        const col = h('div.st-calcol');
        for (let d = 0; d < 7; d++) {
          const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d);
          const k = today(dt), x = (days[k] || {}).xp || 0;
          const lvl = !x ? 0 : x < game.goal * 0.34 ? 1 : x < game.goal * 0.67 ? 2 : x < game.goal ? 3 : 4;
          col.append(h('span.c' + lvl + (k === today() ? '.today' : ''), { title: `${dt.toLocaleDateString('de-DE')}: ${x} XP`, style: dt > new Date() ? { visibility: 'hidden' } : {} }));
        }
        cal.append(col);
      }
      return h('section.card.st-card.wide', h('h4', 'Aktivität'), h('div.st-sub2', 'XP der letzten 30 Tage – grün: Tagesziel erreicht'), svg, tip,
        h('h4', { style: { marginTop: '18px' } }, 'Die letzten 20 Wochen'), cal);
    }

    // ---------- Schwachstellen ----------
    function weakCard() {
      const wn = weakest('notes', 8), wc = weakest('chords', 8);
      const list = (mode, ws) => ws.length ? h('div.st-weak', ws.map(w => h('div.st-wrow',
        h('span.st-dot', { style: { background: mColor(w.m) } }), h('b', w.label || w.key),
        h('span.muted', `${Math.round(100 * w.ok / w.n)} % · Ø ${(w.ms / 1000 || 0).toFixed(1)} s · ${w.n}×`),
        h('span.st-tag', masteryLabel(w.m))))) : h('div.muted', 'Noch zu wenig Daten – übe ein paar Runden.');
      const practice = (mode, ws) => ws.filter(w => w.m < 0.7).length ? h('button.btn.primary', { onclick: () => go(`#/${mode}?only=${encodeURIComponent(ws.filter(w => w.m < 0.7).map(w => w.key).join(','))}&from=stats`) }, icon('sparkle'), 'Gezielt üben') : '';
      return h('section.card.st-card.wide', h('h4', 'Das sitzt noch nicht'),
        h('div.st-two',
          h('div', h('div.row', h('b', 'Noten'), h('span.spacer'), practice('notes', wn)), list('notes', wn)),
          h('div', h('div.row', h('b', 'Akkorde'), h('span.spacer'), practice('chords', wc)), list('chords', wc))),
        h('div.st-sub2', { style: { marginTop: '10px' } }, 'Beherrschung = Trefferquote beim ersten Versuch (neuere Versuche zählen mehr) × Tempo. Im Üben kommen unsichere und lange nicht geübte Objekte automatisch öfter dran.'));
    }

    // ---------- Noten-Karte ----------
    function notesCard() {
      const m = items.notes || {};
      const groups = { treble: [], bass: [] };
      for (const [k, it] of Object.entries(m)) {
        const [clef, d, a] = k.split(':');
        (groups[clef] || (groups[clef] = [])).push({ k, d: +d, a: +a, it, mas: mastery(it) });
      }
      const row = (clef, title) => {
        const list = (groups[clef] || []).sort((x, y) => x.d - y.d || x.a - y.a);
        if (!list.length) return '';
        return h('div.st-noterow', h('div.st-sub2', title), h('div.st-notes', list.map((n, i) => h('div.st-note', {
          style: { background: mColor(n.mas), '--i': i },
          title: `${n.it.label}: ${n.it.ok}/${n.it.n} richtig · Ø ${(n.it.ms / 1000 || 0).toFixed(1)} s · ${masteryLabel(n.mas)}`
        }, (n.it.label || '').replace(' (Bass)', '')))));
      };
      const any = Object.keys(m).length;
      return h('section.card.st-card.wide', h('h4', 'Noten lesen – Beherrschung je Note'),
        any ? [row('treble', 'Violinschlüssel'), row('bass', 'Bassschlüssel'), legend()] : h('div.muted', 'Noch keine Noten geübt.'));
    }
    function legend() {
      return h('div.st-legend', [[null, 'neu'], [0.2, 'übt sich'], [0.5, 'wackelt'], [0.7, 'gut'], [0.95, 'sitzt']].map(([v, l]) => h('span', h('i', { style: { background: mColor(v) } }), l)));
    }

    // ---------- Akkorde: Grundton × Typ ----------
    function chordsCard() {
      const m = items.chords || {};
      const cells = {}, types = new Set();
      for (const [k, it] of Object.entries(m)) {
        const [l, a, type] = k.split('|')[0].split(',');
        if (type == null) continue;
        const pcKey = ((({ 0: 0, 1: 2, 2: 4, 3: 5, 4: 7, 5: 9, 6: 11 })[+l] + +a) + 12) % 12;
        types.add(type);
        const key = pcKey + '|' + type;
        (cells[key] = cells[key] || []).push(it);
      }
      if (!types.size) return h('section.card.st-card', h('h4', 'Akkorde'), h('div.muted', 'Noch keine Akkorde geübt.'));
      const TYPE_LABEL = { maj: 'Dur', min: 'Moll', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', maj7: 'maj7', dom7: '7', m7: 'm7', m7b5: 'ø7', dim7: '°7', maj6: '6', m6: 'm6', mMaj7: 'm(maj7)', maj9: 'maj9', dom9: '9', m9: 'm9', dom13: '13', b9: '7♭9', s9: '7♯9', six9: '6/9' };
      const order = Object.keys(TYPE_LABEL);
      const tl = [...types].sort((x, y) => order.indexOf(x) - order.indexOf(y));
      const grid = h('div.st-chordgrid', { style: { gridTemplateColumns: `auto repeat(${tl.length}, minmax(30px, 1fr))` } },
        h('span'), tl.map(tp => h('span.st-ch', TYPE_LABEL[tp] || tp)));
      for (const c of CIRCLE) {
        const r = c.major;
        const pcR = ((({ 0: 0, 1: 2, 2: 4, 3: 5, 4: 7, 5: 9, 6: 11 })[r.l] + r.a) + 12) % 12;
        grid.append(h('span.st-ch.r', noteName(r)));
        for (const tp of tl) {
          const its = cells[pcR + '|' + tp];
          const mas = its ? Math.min(...its.map(mastery)) : null;
          const n = its ? its.reduce((a, x) => a + x.n, 0) : 0, ok = its ? its.reduce((a, x) => a + x.ok, 0) : 0;
          grid.append(h('span.st-cell', { style: { background: mColor(mas) }, title: its ? `${noteName(r)} ${TYPE_LABEL[tp] || tp}: ${ok}/${n} richtig · ${masteryLabel(mas)}` : 'noch nicht geübt' }));
        }
      }
      return h('section.card.st-card.wide', h('h4', 'Akkorde – Grundton × Akkordtyp'), h('div.st-scroll', grid), legend());
    }

    // ---------- Tonleitern ----------
    function scalesCard() {
      const m = items.scales || {};
      const entries = Object.entries(m);
      if (!entries.length) return h('section.card.st-card', h('h4', 'Tonleitern'), h('div.muted', 'Noch keine Tonleiter gespielt.'));
      return h('section.card.st-card', h('h4', 'Tonleitern'),
        h('div.st-weak', entries.sort((a, b) => b[1].last - a[1].last).slice(0, 14).map(([k, it]) => h('div.st-wrow',
          h('span.st-dot', { style: { background: it.ok ? 'var(--ok)' : 'var(--warn)' } }), h('b', it.label || k),
          h('span.muted', `${it.ok}/${it.n} fehlerfrei · ${(it.ms / 1000).toFixed(1)} s`)))));
    }

    // ---------- Quintenzirkel ----------
    function circleCard() {
      const m = items.circle || {};
      const e = Object.entries(m);
      if (!e.length) return h('section.card.st-card', h('h4', 'Quintenzirkel-Quiz'), h('div.muted', 'Noch keine Fragen beantwortet.'));
      return h('section.card.st-card', h('h4', 'Quintenzirkel-Quiz'),
        e.map(([k, it]) => { const p = Math.round(100 * it.ok / it.n); return h('div.st-barrow', h('span', it.label || k), h('div.st-hbar', h('div', { style: { width: p + '%', background: mColor(mastery(it)) } })), h('b', p + ' %')); }));
    }

    // ---------- Bereiche ----------
    function modesCard() {
      const agg = {};
      for (const d of Object.values(days)) for (const [mode, md] of Object.entries(d.modes || {})) {
        const a = agg[mode] || { xp: 0, ms: 0, ok: 0, total: 0 };
        a.xp += md.xp || 0; a.ms += md.ms || 0; a.ok += md.ok || 0; a.total += md.total || 0; agg[mode] = a;
      }
      const e = Object.entries(agg).sort((a, b) => b[1].xp - a[1].xp);
      if (!e.length) return '';
      const max = Math.max(...e.map(([, a]) => a.xp));
      return h('section.card.st-card', h('h4', 'Nach Bereich'),
        e.map(([mode, a]) => h('div.st-barrow', h('span', MODE_NAMES[mode] || mode), h('div.st-hbar', h('div', { style: { width: (100 * a.xp / max) + '%', background: `oklch(70% .14 ${MODE_HUE[mode] || 250})` } })), h('b', `${a.xp} XP`), h('span.muted', fmtMin(a.ms)))));
    }

    // ---------- Abzeichen ----------
    function badgesCard() {
      const got = game.badges || {};
      const n = BADGES.filter(b => got[b.id]).length;
      return h('section.card.st-card.wide', h('h4', `Abzeichen · ${n} von ${BADGES.length}`),
        h('div.st-badges', BADGES.map((b, i) => h('div.st-badge' + (got[b.id] ? '.got' : ''), { style: { '--i': i }, title: got[b.id] ? 'Erreicht am ' + new Date(got[b.id]).toLocaleDateString('de-DE') : 'Noch offen' },
          h('div.bi', b.icon), h('b', b.name), h('small', b.desc)))));
    }

    renderAll();
  }
};
