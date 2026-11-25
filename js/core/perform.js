// Auswertung eines gespielten Stücks: Tempo & Gleichmäßigkeit, Dynamik (p/f, Crescendo/Diminuendo) und Pedal.
// Die Vorgaben (Dynamik-, Gabel- und Pedalzeichen) kommen direkt aus der MusicXML-Datei.

const RANK = { pppp: 0, ppp: 1, pp: 2, p: 3, mp: 4, mf: 5, f: 6, ff: 7, fff: 8, ffff: 9 };
const key = (mi, w) => mi * 64 + Math.max(0, Math.min(63.9, w));
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Math.round(n));

/** Dynamik-, Gabel- und Pedalzeichen aus MusicXML (erste Stimme/Part) – Positionen als Takt-Index + Ganze-Noten-Offset */
export function scoreMarks(xmlText) {
  const out = { dyn: [], wedges: [], pedal: [] };
  let doc;
  try { doc = new DOMParser().parseFromString(xmlText, 'application/xml'); } catch { return out; }
  const part = doc.querySelector('part'); if (!part) return out;
  let div = 1;
  const openWedge = {};
  const words = [];
  [...part.children].filter(m => m.tagName === 'measure').forEach((m, mi) => {
    let pos = 0, lastDur = 0;
    for (const el of m.children) {
      const tag = el.tagName;
      if (tag === 'attributes') { const d = el.querySelector('divisions'); if (d) div = +d.textContent || div; }
      else if (tag === 'note') {
        if (el.querySelector('grace')) continue;
        const d = +(el.querySelector(':scope > duration')?.textContent || 0);
        if (el.querySelector(':scope > chord')) continue;
        pos += d; lastDur = d;
      }
      else if (tag === 'backup') pos -= +(el.querySelector('duration')?.textContent || 0);
      else if (tag === 'forward') pos += +(el.querySelector('duration')?.textContent || 0);
      else if (tag === 'direction') {
        const off = +(el.querySelector(':scope > offset')?.textContent || 0);
        const w = Math.max(0, (pos + off) / (4 * div));
        for (const dt of el.querySelectorAll('direction-type')) {
          for (const dyn of dt.querySelectorAll('dynamics > *')) {
            const v = dyn.tagName === 'other-dynamics' ? dyn.textContent.trim() : dyn.tagName;
            if (v in RANK) out.dyn.push({ mi, w, val: v, k: key(mi, w) });
          }
          const wg = dt.querySelector('wedge');
          if (wg) {
            const type = wg.getAttribute('type'), num = wg.getAttribute('number') || '1';
            if (type === 'crescendo' || type === 'diminuendo') openWedge[num] = { type: type === 'crescendo' ? 'cresc' : 'dim', from: { mi, w }, k0: key(mi, w) };
            else if (type === 'stop' && openWedge[num]) { const o = openWedge[num]; out.wedges.push({ ...o, to: { mi, w }, k1: key(mi, w) }); delete openWedge[num]; }
          }
          const pd = dt.querySelector('pedal');
          if (pd) { const type = pd.getAttribute('type'); if (['start', 'stop', 'change', 'resume', 'discontinue'].includes(type)) out.pedal.push({ mi, w, type: type === 'resume' ? 'start' : type === 'discontinue' ? 'stop' : type, k: key(mi, w) }); }
          const wd = dt.querySelector('words');
          if (wd) {
            const t = wd.textContent.trim().toLowerCase();
            if (/^cresc/.test(t)) words.push({ type: 'cresc', from: { mi, w }, k0: key(mi, w) });
            else if (/^(dim|decresc)/.test(t)) words.push({ type: 'dim', from: { mi, w }, k0: key(mi, w) });
          }
        }
      }
    }
    void lastDur;
  });
  out.dyn.sort((a, b) => a.k - b.k);
  out.pedal.sort((a, b) => a.k - b.k);
  // „cresc.“/„dim.“ als Text: gilt bis zum nächsten Dynamikzeichen, höchstens 4 Takte
  for (const wd of words) {
    const next = out.dyn.find(d => d.k > wd.k0);
    const k1 = Math.min(next ? next.k : Infinity, key(wd.from.mi + 4, 0));
    const toMi = Math.floor(k1 / 64);
    out.wedges.push({ ...wd, to: { mi: toMi, w: k1 - toMi * 64 }, k1, text: true });
  }
  out.wedges.sort((a, b) => a.k0 - b.k0);
  return out;
}

/**
 * steps: Abspielreihenfolge [{ t, mi, w, notes }]; rec[i] = { t: ms der ersten richtigen Taste, vels: [] } für eigene Schritte;
 * pedal: [{ t (ms), down }]; marks: scoreMarks(); bpm: notiertes Tempo
 */
export function analyze({ steps, rec, pedal = [], marks, bpm = 100, setting = 1 }) {
  const own = [];
  steps.forEach((s, i) => { if (rec[i] && rec[i].t) own.push(i); });
  const res = { notes: own.length, tempo: null, dyn: null, ped: null };
  if (own.length < 4) return res;
  const mNum = i => steps[i].mi + 1;

  // ---------- Tempo ----------
  const iv = [];
  for (let j = 1; j < own.length; j++) {
    const a = own[j - 1], b = own[j];
    const exp = steps[b].t - steps[a].t, act = (rec[b].t - rec[a].t) / 1000;
    if (exp >= 0.06 && act > 0) iv.push({ exp, act, b, r: act / exp });
  }
  if (iv.length >= 3) {
    const m = median(iv.map(x => x.r));
    const hes = iv.filter(x => x.r > 2.2 * m && x.act - x.exp * m > 0.5);
    const flow = iv.filter(x => !hes.includes(x));
    const se = flow.reduce((a, x) => a + x.exp, 0), sa = flow.reduce((a, x) => a + x.act, 0);
    const eff = sa ? se / sa : 0;
    const dev = median(flow.map(x => Math.abs(x.r / m - 1)));
    const count = {};
    for (const x of hes) count[mNum(x.b)] = (count[mNum(x.b)] || 0) + 1;
    res.tempo = {
      pct: Math.round(eff * 100),
      bpm: Math.round(bpm * eff),
      target: Math.round(setting * 100),
      steady: Math.max(0, Math.round(100 * (1 - Math.min(1, dev * 2)))),
      hesitations: hes.length,
      hesMeasures: Object.entries(count).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map(e => +e[0]).sort((a, b) => a - b),
      seconds: Math.round((rec[own[own.length - 1]].t - rec[own[0]].t) / 1000)
    };
  }

  // ---------- Dynamik ----------
  const vel = i => rec[i].vels.length ? rec[i].vels.reduce((a, v) => a + v, 0) / rec[i].vels.length : null;
  const ownV = own.filter(i => vel(i) != null);
  if (ownV.length >= 6) {
    const vs = ownV.map(vel);
    const d = { items: [], checks: 0, good: 0, range: Math.round(quant(vs, 0.9) - quant(vs, 0.1)), mean: Math.round(vs.reduce((a, v) => a + v, 0) / vs.length) };
    const k = i => key(steps[i].mi, steps[i].w || 0);
    if (marks && marks.dyn.length) {
      // Abschnitte gleicher Vorgabe (in Spielreihenfolge)
      const level = i => { let r = null; for (const m of marks.dyn) { if (m.k <= k(i) + 1e-6) r = m; else break; } return r; };
      const secs = [];
      for (const i of ownV) {
        const lv = level(i); const val = lv ? lv.val : null;
        const last = secs[secs.length - 1];
        if (last && last.val === val) last.v.push(vel(i)); else secs.push({ val, v: [vel(i)], mi: steps[i].mi });
      }
      const real = secs.filter(s => s.val && s.v.length >= 3);
      for (let j = 1; j < real.length; j++) {
        const a = real[j - 1], b = real[j];
        const rd = RANK[b.val] - RANK[a.val]; if (!rd) continue;
        const delta = median(b.v) - median(a.v);
        const ok = Math.sign(delta) === Math.sign(rd) && Math.abs(delta) >= 3 * Math.min(3, Math.abs(rd));
        d.checks++; if (ok) d.good++;
        const dir = rd > 0 ? 'lauter' : 'leiser';
        d.items.push({ ok, text: `T. ${b.mi + 1}: ${a.val} → ${b.val} ` + (ok ? `– deutlich ${dir} (${signed(delta)})` : Math.sign(delta) !== Math.sign(rd) && Math.abs(delta) >= 3 ? `– eher ${rd > 0 ? 'leiser' : 'lauter'} geworden (${signed(delta)})` : `– kaum ${dir} (${signed(delta)})`) });
      }
    }
    if (marks && marks.wedges.length) {
      for (const wg of marks.wedges) {
        // jede gespielte Stelle (bei Wiederholungen mehrfach) einzeln
        let run = [];
        const flush = () => {
          if (run.length >= 3) {
            const xs = run.map(i => steps[i].t), ys = run.map(vel);
            const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
            let num = 0, den = 0; xs.forEach((x, n) => { num += (x - mx) * (ys[n] - my); den += (x - mx) ** 2; });
            const change = den ? num / den * (xs[xs.length - 1] - xs[0]) : 0;
            const want = wg.type === 'cresc' ? 1 : -1;
            const ok = change * want >= 6;
            const name = wg.type === 'cresc' ? 'Crescendo' : 'Diminuendo';
            const span = wg.from.mi === wg.to.mi ? `T. ${wg.from.mi + 1}` : `T. ${wg.from.mi + 1}–${wg.to.mi + 1}`;
            d.checks++; if (ok) d.good++;
            d.items.push({ ok, text: `${name} ${span}: ` + (ok ? `gut gestaltet (${signed(change)})` : change * want > 1 ? `nur angedeutet (${signed(change)})` : `nicht hörbar (${signed(change)})`) });
          }
          run = [];
        };
        let prev = -1;
        for (const i of ownV) {
          const inside = k(i) >= wg.k0 - 1e-6 && k(i) <= wg.k1 + 1e-6;
          if (inside && (prev < 0 || i - prev < 6)) run.push(i);
          else if (inside) { flush(); run.push(i); }
          else if (run.length) flush();
          if (inside) prev = i;
        }
        flush();
      }
    }
    d.score = d.checks ? Math.round(100 * d.good / d.checks) : null;
    if (!d.checks) d.note = d.range < 14 ? `Sehr gleichförmige Lautstärke (Spanne ${d.range}) – probier, Phrasen lauter und leiser zu gestalten.` : `Lautstärke-Spanne ${d.range} von 127 – die Noten enthalten keine prüfbaren Dynamikangaben.`;
    // Wiederholte Stellen nur einmal melden (gleiche Stelle, gleiches Ergebnis); Fehler zuerst
    const seen = new Set();
    d.items = d.items.filter(it => { const id = it.text.split(/ – |: (?=gut|nur|nicht)/)[0] + it.ok; if (seen.has(id)) return false; seen.add(id); return true; });
    d.items.sort((a, b) => a.ok - b.ok);
    res.dyn = d;
  }

  // ---------- Pedal ----------
  const pev = pedal.filter(p => p.t >= rec[own[0]].t - 3000);
  const downAt = t => { let s = false; for (const p of pedal) { if (p.t <= t) s = p.down; else break; } return s; };
  const hasMarks = marks && marks.pedal.length > 0;
  if (hasMarks || pev.length) {
    const p = { items: [], used: pev.length > 0 };
    const k = i => key(steps[i].mi, steps[i].w || 0);
    const next = j => (j + 1 < own.length ? rec[own[j + 1]].t : rec[own[j]].t + 600);
    // Pedalwechsel rund um einen Anschlag (Lösen und wieder Treten)
    const changeAround = j => {
      const t = rec[own[j]].t, from = j ? rec[own[j - 1]].t + 30 : t - 800, to = Math.min(next(j), t + 900);
      const ups = pedal.filter(e => !e.down && e.t >= from && e.t <= to);
      const up = ups[ups.length - 1]; if (!up) return null;
      const dn = pedal.find(e => e.down && e.t > up.t && e.t <= to + 400);
      return dn ? { up: up.t, down: dn.t, sync: up.t >= t - 60 } : null;
    };
    if (hasMarks) {
      const expDown = i => { let s = false; for (const e of marks.pedal) { if (e.k <= k(i) + 1e-6) s = e.type !== 'stop'; else break; } return s; };
      let wantDown = 0, wasDown = 0, wantUp = 0, wasUp = 0;
      own.forEach((i, j) => {
        const sample = (rec[i].t + Math.min(next(j), rec[i].t + 700)) / 2;
        const act = downAt(sample);
        if (expDown(i)) { wantDown++; if (act) wasDown++; } else { wantUp++; if (!act) wasUp++; }
      });
      // geforderte Wechsel: erster eigener Schritt ab dem Zeichen (je Durchgang)
      let chk = 0, hit = 0, sync = 0; const missed = [];
      for (const e of marks.pedal.filter(e => e.type === 'change' || e.type === 'start')) {
        own.forEach((i, j) => {
          const prevK = j ? k(own[j - 1]) : -1;
          if (k(i) >= e.k - 1e-6 && (prevK < e.k - 1e-6 || prevK > k(i))) {
            if (e.type === 'start' && !(j && downAt(rec[own[j - 1]].t + 100))) { // erstes Treten
              const dn = pedal.find(x => x.down && x.t >= rec[i].t - 400 && x.t <= next(j) + 300);
              chk++; if (dn) { hit++; if (dn.t >= rec[i].t - 60) sync++; } else missed.push(steps[i].mi + 1);
              return;
            }
            const c = changeAround(j); chk++;
            if (c) { hit++; if (c.sync) sync++; } else missed.push(steps[i].mi + 1);
          }
        });
      }
      const cov = wantDown ? wasDown / wantDown : 1, clean = wantUp ? wasUp / wantUp : 1;
      const chg = chk ? hit / chk : 1;
      p.score = Math.round(100 * (cov * 0.4 + clean * 0.2 + chg * 0.4));
      if (!p.used) p.items.push({ ok: false, text: 'Kein Pedal gespielt – ist das Pedal am Piano angeschlossen?' });
      else {
        if (wantDown) p.items.push({ ok: cov >= 0.8, text: `Pedal bei ${Math.round(cov * 100)} % der Stellen mit Pedalzeichen getreten` });
        if (wantUp >= 4) p.items.push({ ok: clean >= 0.8, text: clean >= 0.8 ? 'Ohne Pedal, wo keins steht – sauber' : `An ${Math.round((1 - clean) * 100)} % der Stellen ohne Pedalzeichen trotzdem Pedal` });
        if (chk) p.items.push({ ok: chg >= 0.8, text: `${hit} von ${chk} Pedalwechseln erwischt` + (missed.length ? ` – verpasst in T. ${[...new Set(missed)].slice(0, 6).join(', ')}` : '') });
        if (hit >= 3) p.items.push({ ok: sync / hit >= 0.6, text: sync / hit >= 0.6 ? 'Pedal meist nach dem Anschlag gewechselt (legato) – gut' : 'Pedal oft vor dem Anschlag gewechselt – erst Taste, dann Pedal lösen und neu treten, sonst entstehen Lücken' });
      }
    } else {
      // keine Pedalzeichen: Nutzung und lange, ungewechselte Pedalstrecken
      let downSince = null, longHolds = [];
      const t0 = rec[own[0]].t, t1 = rec[own[own.length - 1]].t;
      let downMs = 0, last = t0, state = downAt(t0);
      for (const e of pev.filter(e => e.t >= t0 && e.t <= t1)) { if (state) downMs += e.t - last; state = e.down; last = e.t; }
      if (state) downMs += t1 - last;
      const mAt = t => { let m = steps[own[0]].mi; for (const i of own) { if (rec[i].t <= t) m = steps[i].mi; else break; } return m + 1; };
      for (const e of pedal) { if (e.down && downSince == null) downSince = e.t; else if (!e.down && downSince != null) { const a = mAt(downSince), b = mAt(e.t); if (b - a >= 3) longHolds.push(`T. ${a}–${b}`); downSince = null; } }
      let syncN = 0, chN = 0;
      own.forEach((i, j) => { if (j) { const c = changeAround(j); if (c) { chN++; if (c.sync) syncN++; } } });
      const share = t1 > t0 ? downMs / (t1 - t0) : 0;
      p.score = null;
      p.note = 'In den Noten stehen keine Pedalzeichen – hier nur, wie du das Pedal benutzt hast.';
      p.items.push({ ok: true, text: `Pedal ${Math.round(share * 100)} % der Zeit getreten, ${chN} Wechsel` });
      if (longHolds.length) p.items.push({ ok: false, text: `Lange ohne Wechsel gehalten (${longHolds.slice(0, 4).join(', ')}) – bei Harmoniewechseln neu treten, sonst verschwimmt es` });
      if (chN >= 3) p.items.push({ ok: syncN / chN >= 0.6, text: syncN / chN >= 0.6 ? 'Pedal meist nach dem Anschlag gewechselt (legato) – gut' : 'Pedal oft vor dem Anschlag gewechselt – erst Taste, dann Pedal wechseln' });
    }
    p.items.sort((a, b) => a.ok - b.ok);
    res.ped = p;
  }
  return res;
}
