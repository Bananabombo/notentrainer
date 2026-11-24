// Kleine UI-Helfer: Elemente bauen, Partikel, Toasts, Bottom-Sheets

/** h('div.card#id', {onclick}, ...children) */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Partikel-Explosion an einer Bildschirmposition (oder Element-Mitte) */
export function burst(target, { count = 14, color = 'var(--ok)', spread = 70 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let x, y;
  if (target instanceof Element) { const r = target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
  else ({ x, y } = target);
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = spread * (0.5 + Math.random() * 0.7);
    p.style.cssText = `left:${x}px;top:${y}px;--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;--c:${color};--s:${4 + Math.random() * 5}px`;
    document.body.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}

let toastEl;
export function toast(text, ms = 2200) {
  if (!toastEl) { toastEl = h('div.toast'); document.body.appendChild(toastEl); }
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/** Bottom-Sheet / Seitenpanel für Einstellungen */
export function sheet(title, content) {
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 350); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const wrap = h('div.sheet-wrap', { onclick: e => { if (e.target === wrap) close(); } },
    h('div.sheet', { role: 'dialog', 'aria-label': title },
      h('div.sheet-head', h('h3', title), h('button.icon-btn', { onclick: close, 'aria-label': 'Schließen' }, icon('x'))),
      h('div.sheet-body', content)));
  document.body.appendChild(wrap);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { close, el: wrap };
}

/** Segmented Control */
export function segmented(options, value, onChange) {
  const el = h('div.seg');
  const render = v => el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === String(v)));
  for (const [v, label] of options) {
    el.appendChild(h('button', { type: 'button', dataset: { v }, onclick: () => { render(v); onChange(v); } }, label));
  }
  render(value);
  return el;
}
export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.toggle', h('span', label), h('span.switch', input, h('span.knob')));
}
export const field = (label, control, hint) => h('div.field', h('div.field-label', label), control, hint && h('div.field-hint', hint));

/** Animierter Zahlenwechsel */
export function setNum(el, value) {
  if (el.textContent === String(value)) return;
  el.textContent = value;
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}

// ---------- Icons (Linien-Icons, 24er Raster) ----------
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  midi: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="11" r=".8" fill="currentColor"/><circle cx="16" cy="11" r=".8" fill="currentColor"/><circle cx="10" cy="15" r=".8" fill="currentColor"/><circle cx="14" cy="15" r=".8" fill="currentColor"/><circle cx="12" cy="8" r=".8" fill="currentColor"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  note: '<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  chord: '<circle cx="8" cy="17" r="2.5"/><circle cx="8" cy="11" r="2.5"/><circle cx="8" cy="5" r="2.5"/><path d="M10.5 5v12M14 7h6M14 12h6M14 17h4"/>',
  circle: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21"/>',
  scale: '<path d="M3 20h4v-4h4v-4h4V8h4V4h2"/>',
  wave: '<path d="M2 12c2.5 0 2.5-6 5-6s2.5 12 5 12 2.5-12 5-12 2.5 6 5 6"/>',
  sax: '<path d="M14 3h4M16 3v7c0 4-2 8-6 8a4 4 0 0 1-4-4v-2"/><circle cx="16" cy="8" r=".6" fill="currentColor"/><circle cx="16" cy="11" r=".6" fill="currentColor"/><path d="M4 12h4"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20"/><path d="M9 7h7M9 10.5h5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  skip: '<path d="M5 5l9 7-9 7zM17 5v14"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7S5 18 4.5 15l-1-3a1.5 1.5 0 0 1 2.7-1.2L8 13"/>',
  metronome: '<path d="M8 21l3-17h2l3 17z"/><path d="M12 15l6-8"/><path d="M6 21h12"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'icon ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/** Lädt ein klassisches Skript (für große Bibliotheken nur bei Bedarf) */
const loaded = {};
export function loadScript(src) {
  return loaded[src] || (loaded[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(new Error('Konnte ' + src + ' nicht laden')); };
    document.head.appendChild(s);
  }));
}
