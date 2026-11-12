// A/B player: the original recording and the transcription (sampled grand piano) on one AudioContext clock.
import { SplendidGrandPiano } from './vendor/smplr.mjs';

const LOOKAHEAD = 0.25; // seconds of notes handed to the sampler ahead of time
const TICK_MS = 40;
const LONG_AUDIO_SECONDS = 20 * 60; // above this, stream the original instead of decoding it to memory

export class Player {
  constructor({ onStatus, onEnded } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onEnded = onEnded || (() => {});
    this.ctx = null;
    this.notes = [];
    this.duration = 0;
    this.mix = 'both';
    this.playing = false;
    this.offset = 0;
    this.startCtx = 0;
    this.nextIdx = 0;
    this.pending = [];
    this.timer = 0;
    this.buffer = null;
    this.media = null;
    this.source = null;
    this.audioUrl = null;
    this.audioPromise = null;
  }

  async _init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.origGain = this.ctx.createGain();
    this.midiGain = this.ctx.createGain();
    this.origGain.connect(this.master);
    this.midiGain.connect(this.master);
    this._applyMix(true);
    this.pianoPromise = this._loadPiano();
  }

  async _loadPiano() {
    try {
      this.onStatus('Loading piano sounds…');
      const piano = SplendidGrandPiano(this.ctx, {
        destination: this.midiGain,
        decayTime: 0.3,
        volume: 105,
        onLoadProgress: ({ loaded, total }) => this.onStatus(`Loading piano sounds ${Math.round((100 * loaded) / Math.max(1, total))}%`),
      });
      await Promise.race([piano.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
      this.piano = piano;
      this.onStatus('');
    } catch (e) {
      this.piano = new BasicSynth(this.ctx, this.midiGain);
      this.onStatus('Piano samples unavailable (offline?) — using a basic synth');
    }
  }

  setNotes(notes, duration) {
    this.stop();
    this.notes = [...notes].sort((a, b) => a[0] - b[0]);
    this.duration = duration;
    this.offset = 0;
  }

  setAudio(url, duration) {
    if (url === this.audioUrl) return;
    this.stop();
    this.audioUrl = url;
    this.buffer = null;
    if (this.media) { this.media.pause(); this.media.src = ''; this.media = null; }
    this.audioPromise = null;
    this.longAudio = duration > LONG_AUDIO_SECONDS;
  }

  async _loadAudio() {
    if (!this.audioUrl) return;
    if (this.audioPromise) return this.audioPromise;
    const url = this.audioUrl;
    this.audioPromise = (async () => {
      if (this.longAudio) {
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.src = url;
        this.ctx.createMediaElementSource(el).connect(this.origGain);
        if (url === this.audioUrl) this.media = el;
        return;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('audio ' + res.status);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      if (url === this.audioUrl) this.buffer = buf;
    })();
    return this.audioPromise;
  }

  get time() {
    if (!this.playing) return this.offset;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startCtx) - lat));
  }

  async play() {
    await this._init();
    await this.ctx.resume();
    this.onStatus(this.piano ? '' : 'Loading piano sounds…');
    await Promise.all([this.pianoPromise, this._loadAudio().catch(() => this.onStatus('Could not load the original audio'))]);
    if (this.playing) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.playing = true;
    this.startCtx = this.ctx.currentTime + 0.06;
    this.nextIdx = lowerBound(this.notes, this.offset);
    this.midiGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this._applyMix(true);
    if (this.buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.origGain);
      src.start(this.startCtx, Math.min(this.offset, this.buffer.duration));
      this.source = src;
    } else if (this.media) {
      this.media.currentTime = this.offset;
      this.media.play().catch(() => {});
    }
    this._tick();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time;
    this.stop(false);
  }

  stop(resetOffset = false) {
    clearInterval(this.timer);
    this.timer = 0;
    if (resetOffset) this.offset = 0;
    if (!this.ctx) { this.playing = false; return; }
    const now = this.ctx.currentTime;
    for (const s of this.pending) { try { s({ time: now }); } catch { /* already ended */ } }
    this.pending = [];
    try { this.piano?.stop(); } catch { /* ignore */ }
    if (this.source) { try { this.source.stop(); } catch { /* ignore */ } this.source = null; }
    if (this.media) this.media.pause();
    this.playing = false;
  }

  seek(t) {
    const was = this.playing;
    if (was) this.stop();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (was) this.play();
  }

  setMix(mix) {
    this.mix = mix;
    if (this.ctx) this._applyMix(false);
  }

  _applyMix(immediate) {
    const [o, m] = { original: [1, 0], both: [0.85, 0.85], midi: [0, 1] }[this.mix];
    const now = this.ctx.currentTime;
    for (const [g, v] of [[this.origGain.gain, o], [this.midiGain.gain, m]]) {
      if (immediate) g.setValueAtTime(v, now);
      else g.setTargetAtTime(v, now, 0.04);
    }
  }

  _tick() {
    if (!this.playing) return;
    const ctxNow = this.ctx.currentTime;
    const songNow = this.offset + (ctxNow - this.startCtx);
    const horizon = songNow + LOOKAHEAD;
    const notes = this.notes;
    while (this.nextIdx < notes.length && notes[this.nextIdx][0] < horizon) {
      const [s, e, p, v, snd] = notes[this.nextIdx++];
      if (s < this.offset - 0.01) continue;
      const when = this.startCtx + (s - this.offset);
      const dur = Math.max(0.03, (snd || e) - s);
      try {
        const stopFn = this.piano.start({ note: p, velocity: v, time: Math.max(when, ctxNow), duration: dur });
        if (typeof stopFn === 'function') this.pending.push(stopFn);
      } catch { /* sampler not ready */ }
    }
    if (this.pending.length > 512) this.pending = this.pending.slice(-256);
    if (songNow >= this.duration + 0.3) {
      this.offset = this.duration;
      this.stop();
      this.onEnded();
    }
  }
}

// Minimal additive piano-like voice, used only if the sampled piano cannot be downloaded.
class BasicSynth {
  constructor(ctx, out) { this.ctx = ctx; this.out = out; this.voices = new Set(); }
  start({ note, velocity = 80, time, duration = 0.5 }) {
    const ctx = this.ctx;
    const t = Math.max(time ?? ctx.currentTime, ctx.currentTime);
    const f = 440 * 2 ** ((note - 69) / 12);
    const g = ctx.createGain();
    const peak = 0.18 * (velocity / 127) ** 1.6;
    const decay = Math.max(0.4, 3.5 - (note - 21) / 30);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.005);
    g.gain.setTargetAtTime(0, t + 0.01, decay / 3);
    const oscs = [[1, 1], [2, 0.35], [3, 0.12]].map(([h, a]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.value = f * h;
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      return o;
    });
    g.connect(this.out);
    const voice = { g, oscs };
    this.voices.add(voice);
    const stop = ({ time: st } = {}) => {
      const at = Math.max(st ?? ctx.currentTime, ctx.currentTime);
      g.gain.cancelScheduledValues(at);
      g.gain.setTargetAtTime(0, at, 0.06);
      for (const o of oscs) o.stop(at + 0.5);
      this.voices.delete(voice);
    };
    oscs[0].onended = () => this.voices.delete(voice);
    stop({ time: t + duration });
    this.voices.add(voice);
    return stop;
  }
  stop() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setTargetAtTime(0, now, 0.03);
      for (const o of v.oscs) { try { o.stop(now + 0.2); } catch { /* ignore */ } }
    }
    this.voices.clear();
  }
}

function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid][0] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
