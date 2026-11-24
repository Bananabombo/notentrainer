// Klangerzeugung im Browser (Web Audio): Klavier, E-Piano, Bass, Pad, Schlagzeug, Metronom
// plus ein taktgenauer Sequencer für Begleitbands.
import { input } from './input.js';
import { prefs } from './store.js';

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

class AudioEngine {
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = prefs.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    // Hall
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb).connect(this.master);
    // Busse
    this.bus = {};
    for (const name of ['piano', 'ep', 'bass', 'pad', 'drums', 'click']) {
      const g = ctx.createGain();
      g.connect(this.master);
      if (name !== 'click' && name !== 'bass') g.connect(this.reverbSend);
      this.bus[name] = g;
    }
    this.bus.drums.gain.value = 0.75; this.bus.pad.gain.value = 0.5; this.bus.bass.gain.value = 0.9;
    // Rauschen für Schlagzeug
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  /** Audio freischalten – muss aus einer echten Nutzergeste kommen (Klick, Touch-Ende, Taste) */
  unlock() {
    const ctx = this.ensure();
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch {}
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      // stummer Puffer: weckt die Ausgabe auf iOS/Android zuverlässig
      const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, 22050); b.connect(ctx.destination); b.start(0);
    }
    return ctx;
  }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get now() { return this.ensure().currentTime; }
  setVolume(v) { prefs.volume = v; if (this.master) this.master.gain.value = v; }

  impulse(seconds, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = rate * seconds;
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // ---------- Instrumente ----------
  piano(midi, t, dur = 1, vel = 0.7, bus = 'piano') {
    const ctx = this.ensure(); t = Math.max(t, ctx.currentTime);
    const f = mtof(midi);
    const out = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(Math.min(12000, f * (6 + vel * 10)), t);
    filt.frequency.setTargetAtTime(Math.min(6000, f * 2.5), t + 0.01, 0.35);
    filt.connect(out).connect(this.bus[bus]);
    const peak = 0.22 * vel;
    const tc = 0.9 * Math.pow(261.6 / f, 0.35);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.004);
    out.gain.setTargetAtTime(peak * 0.25, t + 0.004, tc * 0.35);
    out.gain.setTargetAtTime(0, t + 0.3, tc * 1.6);
    out.gain.setTargetAtTime(0, t + dur, 0.09);
    const partials = [[1, 1, 'triangle'], [2, 0.32, 'sine'], [3, 0.12, 'sine'], [4.02, 0.05, 'sine']];
    for (const [mult, amp, type] of partials) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = type; o.frequency.value = f * mult; o.detune.value = (Math.random() - 0.5) * 6;
      g.gain.value = amp;
      o.connect(g).connect(filt);
      o.start(t); o.stop(t + dur + 0.8);
    }
  }
  ep(midi, t, dur = 0.5, vel = 0.6) {
    const ctx = this.ensure(); t = Math.max(t, ctx.currentTime);
    const f = mtof(midi);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), modG = ctx.createGain(), out = ctx.createGain();
    car.frequency.value = f; mod.frequency.value = f;
    modG.gain.setValueAtTime(f * 1.4 * vel, t);
    modG.gain.setTargetAtTime(f * 0.15, t, 0.12);
    mod.connect(modG).connect(car.frequency);
    const peak = 0.13 * vel;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.006);
    out.gain.setTargetAtTime(peak * 0.3, t + 0.006, 0.4);
    out.gain.setTargetAtTime(0, t + dur, 0.08);
    car.connect(out).connect(this.bus.ep);
    car.start(t); mod.start(t); car.stop(t + dur + 0.6); mod.stop(t + dur + 0.6);
  }
  bass(midi, t, dur = 0.4, vel = 0.8) {
    const ctx = this.ensure(); t = Math.max(t, ctx.currentTime);
    const f = mtof(midi);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), filt = ctx.createBiquadFilter(), out = ctx.createGain();
    o1.type = 'triangle'; o1.frequency.value = f;
    o2.type = 'sawtooth'; o2.frequency.value = f;
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    filt.type = 'lowpass'; filt.Q.value = 2;
    filt.frequency.setValueAtTime(f * 7, t); filt.frequency.setTargetAtTime(f * 2.5, t, 0.08);
    const peak = 0.5 * vel;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.008);
    out.gain.setTargetAtTime(peak * 0.55, t + 0.01, 0.18);
    out.gain.setTargetAtTime(0, t + dur, 0.05);
    o1.connect(filt); o2.connect(g2).connect(filt); filt.connect(out).connect(this.bus.bass);
    for (const o of [o1, o2]) { o.start(t); o.stop(t + dur + 0.4); }
  }
  pad(midis, t, dur = 2, vel = 0.5) {
    const ctx = this.ensure(); t = Math.max(t, ctx.currentTime);
    const out = ctx.createGain(), filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 1500; filt.Q.value = 0.5;
    const peak = 0.05 * vel;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + Math.min(0.35, dur * 0.3));
    out.gain.setValueAtTime(peak, t + dur);
    out.gain.linearRampToValueAtTime(0, t + dur + 0.35);
    filt.connect(out).connect(this.bus.pad);
    for (const m of midis) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(filt); o.start(t); o.stop(t + dur + 0.4);
    }
  }
  noiseHit(t, { hp = 1000, bp = null, q = 1, peak = 0.3, decay = 0.1, bus = 'drums' }) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    let node = src;
    const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; node.connect(h); node = h;
    if (bp) { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = bp; b.Q.value = q; node.connect(b); node = b; }
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    node.connect(g).connect(this.bus[bus]);
    src.start(t, Math.random() * 0.5); src.stop(t + decay + 0.05);
  }
  kick(t, vel = 1) {
    const ctx = this.ensure();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9 * vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(g).connect(this.bus.drums); o.start(t); o.stop(t + 0.4);
  }
  snare(t, vel = 1) {
    this.noiseHit(t, { hp: 1200, peak: 0.42 * vel, decay: 0.17 });
    const ctx = this.ensure(), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    g.gain.setValueAtTime(0.25 * vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.bus.drums); o.start(t); o.stop(t + 0.12);
  }
  brush(t, vel = 1) { this.noiseHit(t, { hp: 2500, bp: 4500, q: 0.6, peak: 0.12 * vel, decay: 0.12 }); }
  hat(t, vel = 1, open = false) { this.noiseHit(t, { hp: 7500, peak: 0.16 * vel, decay: open ? 0.28 : 0.045 }); }
  ride(t, vel = 1) {
    this.noiseHit(t, { hp: 4000, bp: 7800, q: 1.2, peak: 0.13 * vel, decay: 0.55 });
    const ctx = this.ensure(), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 3150;
    g.gain.setValueAtTime(0.025 * vel, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
    o.connect(g).connect(this.bus.drums); o.start(t); o.stop(t + 0.55);
  }
  click(t, accent = false) {
    const ctx = this.ensure(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1180;
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.bus.click); o.start(t); o.stop(t + 0.06);
  }

  // ---------- Vorspielen (bevorzugt über das Digitalpiano) ----------
  /** Spielt Töne zur Demonstration; über MIDI-Out, falls eingestellt, sonst im Browser */
  playNotes(midis, { at = 0, dur = 0.9, vel = 0.7, arpeggio = 0 } = {}) {
    const ctx = this.unlock();
    midis.forEach((m, i) => {
      const delay = at + i * arpeggio;
      if (!input.sendNote(m, vel * 127, performance.now() + delay * 1000, dur * 1000)) this.piano(m, ctx.currentTime + delay + 0.01, dur, vel);
    });
  }
}

export const audio = new AudioEngine();

/**
 * Sequencer im Achtelraster mit Swing.
 * onStep(step, time, beatDur) wird mit Vorlauf aufgerufen (time = AudioContext-Zeit).
 */
export class Sequencer {
  constructor({ bpm = 100, swing = 0.5, onStep }) {
    this.bpm = bpm; this.swing = swing; this.onStep = onStep;
    this.running = false;
  }
  get beatDur() { return 60 / this.bpm; }
  timeOf(step) { return this.t0 + Math.floor(step / 2) * this.beatDur + (step % 2) * this.swing * this.beatDur; }
  start() {
    const ctx = audio.unlock();
    this.running = true;
    this.step = 0;
    this.t0 = ctx.currentTime + 0.15;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }
  setBpm(bpm) {
    if (this.running) {
      const beat = Math.floor(this.step / 2);
      const tBeat = this.t0 + beat * this.beatDur;
      this.bpm = bpm;
      this.t0 = tBeat - beat * this.beatDur;
    } else this.bpm = bpm;
  }
  tick() {
    const ctx = audio.ctx;
    while (this.running && this.timeOf(this.step) < ctx.currentTime + 0.12) {
      this.onStep(this.step, this.timeOf(this.step), this.beatDur);
      this.step++;
    }
  }
  stop() { this.running = false; clearInterval(this.timer); }
  /** Führt fn ungefähr zur AudioContext-Zeit t aus (für Anzeigen) */
  static at(t, fn) {
    const ms = (t - audio.ctx.currentTime) * 1000;
    return setTimeout(fn, Math.max(0, ms));
  }
}
