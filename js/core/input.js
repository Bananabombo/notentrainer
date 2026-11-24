// Eingabe: Web MIDI (USB/Bluetooth), Mikrofon (einstimmige Tonhöhenerkennung) und Bildschirm-Klaviatur.
// Alle Quellen liefern dieselben Ereignisse: noteon / noteoff { midi, vel, src }.
import { prefs } from './store.js';

class Input {
  constructor() {
    this.listeners = {};
    this.held = new Map();          // midi -> { vel, t, src }
    this.access = null;
    this.inputs = [];
    this.outputs = [];
    this.status = { midi: 'init', names: [], mic: false, micError: null };
    this.mic = null;
  }
  on(type, fn) { (this.listeners[type] ||= new Set()).add(fn); return () => this.listeners[type].delete(fn); }
  emit(type, detail) { for (const fn of this.listeners[type] || []) { try { fn(detail); } catch (e) { console.error(e); } } }

  noteOn(midi, vel = 90, src = 'tap') {
    this.held.set(midi, { vel, t: performance.now(), src });
    this.emit('noteon', { midi, vel, src });
  }
  noteOff(midi, src = 'tap') {
    if (!this.held.has(midi)) return;
    this.held.delete(midi);
    this.emit('noteoff', { midi, src });
  }
  heldNotes() { return [...this.held.keys()].sort((a, b) => a - b); }

  // ---------- MIDI ----------
  async initMIDI() {
    if (!window.isSecureContext) return this.setStatus('insecure');
    if (!navigator.requestMIDIAccess) return this.setStatus('unsupported');
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bind();
      this.bind();
    } catch { this.setStatus('denied'); }
  }
  bind() {
    this.inputs = [...this.access.inputs.values()].filter(i => i.state === 'connected');
    this.outputs = [...this.access.outputs.values()].filter(o => o.state === 'connected');
    for (const i of this.inputs) i.onmidimessage = e => this.onMessage(e);
    this.status.names = this.inputs.map(i => i.name);
    this.setStatus(this.inputs.length ? 'connected' : 'none');
  }
  setStatus(s) { this.status.midi = s; this.emit('status', this.status); }
  onMessage(e) {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) this.noteOn(d1, d2, 'midi');
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.noteOff(d1, 'midi');
    else if (cmd === 0xb0 && d1 === 64) this.emit('pedal', { down: d2 >= 64 });
  }

  /** Ausgabe an das Digitalpiano (z. B. FP-30X), falls gewünscht und verfügbar */
  get midiOut() {
    if (prefs.output === 'browser' || !this.outputs.length) return null;
    const inNames = new Set(this.status.names);
    return this.outputs.find(o => inNames.has(o.name)) || this.outputs[0];
  }
  sendNote(midi, vel, startMs, durMs, channel = 0) {
    const out = this.midiOut; if (!out) return false;
    const t0 = startMs ?? performance.now();
    out.send([0x90 | channel, midi, Math.max(1, Math.min(127, vel | 0))], t0);
    out.send([0x80 | channel, midi, 0], t0 + durMs);
    return true;
  }
  allNotesOff() {
    const out = this.midiOut; if (!out) return;
    try { out.clear && out.clear(); } catch {}
    for (let ch = 0; ch < 16; ch++) out.send([0xb0 | ch, 123, 0]);
  }

  // ---------- Mikrofon ----------
  async startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      await ac.resume();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 4096;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const st = { stable: null, count: 0, current: null, silent: 0, lastRms: 0 };
      const timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        const thr = 0.002 * Math.pow(1.6, 10 - prefs.micSens);
        const r = mpm(buf, ac.sampleRate);
        this.emit('miclevel', { level: Math.min(1, r.rms / (thr * 8)), freq: r.freq, clarity: r.clarity });
        const release = () => { if (st.current != null) { this.noteOff(st.current, 'mic'); st.current = null; } };
        if (r.rms < thr || r.freq < 0 || r.clarity < 0.85) {
          if (r.rms < thr && ++st.silent > 2) release();
          st.count = 0; st.stable = null; st.lastRms = r.rms;
          return;
        }
        st.silent = 0;
        const midi = Math.round(69 + 12 * Math.log2(r.freq / 440));
        const attack = r.rms > st.lastRms * 1.8;
        st.lastRms = r.rms;
        if (midi === st.stable) st.count++; else { st.stable = midi; st.count = 1; }
        if (st.count >= 3 && (midi !== st.current || attack)) {
          release();
          st.current = midi;
          this.noteOn(midi, 80, 'mic');
        }
      }, 50);
      this.mic = { stream, ac, timer };
      this.status.mic = true; this.status.micError = null;
    } catch (e) {
      this.status.mic = false; this.status.micError = e.name || 'Fehler';
    }
    this.emit('status', this.status);
  }
  stopMic() {
    if (!this.mic) return;
    clearInterval(this.mic.timer);
    this.mic.stream.getTracks().forEach(t => t.stop());
    this.mic.ac.close();
    this.mic = null;
    for (const [m, v] of this.held) if (v.src === 'mic') this.noteOff(m, 'mic');
    this.status.mic = false;
    this.emit('status', this.status);
  }
}

/** Tonhöhenerkennung nach McLeod (NSDF) */
export function mpm(buf, sr) {
  const N = buf.length;
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / N);
  const maxLag = Math.min(Math.floor(sr / 55), N >> 1);
  const W = N - maxLag;
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0, m = 0;
    for (let j = 0; j < W; j++) { const a = buf[j], b = buf[j + tau]; acf += a * b; m += a * a + b * b; }
    nsdf[tau] = m > 0 ? 2 * acf / m : 0;
  }
  let tau = 0;
  while (tau < maxLag && nsdf[tau] > 0) tau++;
  const maxima = []; let curMax = -1, curPos = -1;
  for (; tau < maxLag; tau++) {
    if (nsdf[tau] > 0) { if (nsdf[tau] > curMax) { curMax = nsdf[tau]; curPos = tau; } }
    else if (curPos >= 0) { maxima.push(curPos); curMax = -1; curPos = -1; }
  }
  if (curPos >= 0) maxima.push(curPos);
  if (!maxima.length) return { freq: -1, rms, clarity: 0 };
  const highest = Math.max(...maxima.map(p => nsdf[p]));
  const p = maxima.find(q => nsdf[q] >= 0.9 * highest);
  const a = nsdf[p - 1] || 0, b = nsdf[p], c = nsdf[p + 1] || 0;
  const den = a - 2 * b + c;
  const T = p + (den ? (a - c) / (2 * den) : 0);
  return { freq: sr / T, rms, clarity: b };
}

export const input = new Input();
