// Bildschirm wach halten, solange Tonika geöffnet ist.
// 1) Screen Wake Lock API (Chrome/Android, Safari ≥ 16.4) – wird nach jedem Verlust neu angefordert.
// 2) Rückfallebene: ein winziges, stummes Video in Endlosschleife (hält ältere Browser/WebViews wach).
import { prefs } from './store.js';

let lock = null, video = null, wantFallback = false;
const listeners = new Set();
export const wake = {
  get active() { return !!lock || (!!video && !video.paused); },
  get mode() { return lock ? 'api' : video && !video.paused ? 'video' : 'off'; },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
};
const emit = () => listeners.forEach(fn => { try { fn(wake); } catch {} });

async function requestLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      lock = null; emit();
      // Chrome gibt die Sperre z. B. bei Tab-Wechsel frei – sobald sichtbar, neu anfordern
      if (document.visibilityState === 'visible' && prefs.keepAwake !== false) setTimeout(ensure, 500);
    });
    emit();
    return true;
  } catch { lock = null; return false; }
}

function startVideo() {
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.loop = true;
    video.setAttribute('aria-hidden', 'true');
    Object.assign(video.style, { position: 'fixed', left: '0', bottom: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
    for (const [src, type] of [['media/wake.webm', 'video/webm'], ['media/wake.mp4', 'video/mp4']]) {
      const s = document.createElement('source'); s.src = src; s.type = type; video.append(s);
    }
    video.addEventListener('playing', emit); video.addEventListener('pause', emit);
    document.body.append(video);
  }
  return video.play().then(() => true).catch(() => false);
}

/** Wach halten aktivieren (idempotent) – am besten aus einer Nutzergeste aufrufen */
export async function ensure() {
  if (prefs.keepAwake === false) return release();
  if (document.visibilityState !== 'visible') return;
  if (lock) return;
  const ok = await requestLock();
  if (!ok || wantFallback) await startVideo();
  else if (video && !video.paused) video.pause();
}
export function release() {
  if (lock) { try { lock.release(); } catch {} lock = null; }
  if (video) video.pause();
  emit();
}

export function initWake() {
  // ohne API (oder wenn sie scheitert) gleich die Rückfallebene nutzen
  wantFallback = !('wakeLock' in navigator);
  const kick = () => ensure();
  document.addEventListener('visibilitychange', kick);
  for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, kick, { capture: true, passive: true });
  addEventListener('focus', kick);
  // Sicherheitsnetz: alle 30 s prüfen (manche Geräte geben die Sperre still frei)
  setInterval(() => { if (!wake.active) ensure(); }, 30000);
  ensure();
}
