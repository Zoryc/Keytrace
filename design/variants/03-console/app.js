/* MIDI Converter — "Engineer Console" prototype. Classic script, no network, opens from file://. */
(function () {
'use strict';

const M = window.MOCK;
const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (p) => BLACK.has(p % 12);
const noteName = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1);
const FONT = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';
function fmtTime(t) { t = Math.max(0, t); const w = Math.floor(t + 1e-6); return Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0'); }
function fmtMs(sec) { return sec < 1 ? Math.round(sec * 1000) + ' ms' : sec.toFixed(2) + ' s'; }
const thin = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

if (Q.get('clean') === '1') document.body.classList.add('clean');

/* ------------------------------------------------------------------ colour ramps */
const CONF_STOPS = [[0, [255, 112, 112]], [0.45, [242, 184, 75]], [0.75, [69, 224, 160]], [1, [92, 200, 255]]];
const VEL_STOPS = [[0, [90, 104, 170]], [0.55, [92, 200, 255]], [1, [236, 250, 255]]];
function ramp(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i];
      const f = (t - t0) / ((t1 - t0) || 1);
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
    }
  }
  return 'rgb(' + stops[stops.length - 1][1].join(',') + ')';
}
// Confidence lives in 0.93..1.0, so colour on a log scale of (1 - conf): .95 red, .99 amber, .997 green, .999+ cyan.
const confT = (c) => clamp((-Math.log10(Math.max(1e-4, 1 - c)) - 1.2) / 1.8, 0, 1);
const confColor = (c) => ramp(CONF_STOPS, confT(c));
const velColor = (v) => ramp(VEL_STOPS, v / 127);

/* ------------------------------------------------------------------ data */
const INST = M.info.instruments[0];
const ENGINES = INST.engines;
const OUT = M.info.output_options;
const JOB = M.job;
const ST = JOB.stats;
const DUR = M.duration || ST.duration || 60;
const engById = (id) => ENGINES.find((e) => e.id === id);
const engShort = (e) => e.name.replace(/\s*\(.*\)$/, '');

const BASE = M.notes.map((n) => ({ s: n[0], e: n[1], p: n[2], v: n[3], snd: Math.max(n[4] || n[1], n[1]), c: n[5] == null ? 1 : n[5] }))
  .sort((a, b) => a.s - b.s || a.p - b.p);
BASE.forEach((n, i) => { n.id = i + 1; n.aria = false; n.cc = confColor(n.c); n.vc = velColor(n.v); });
// Notes that only Aria heard are the ones Transkun was least sure about: flag that many as Aria additions.
BASE.slice().sort((a, b) => a.c - b.c).slice(0, ST.notes_added_by_aria || 0).forEach((n) => { n.aria = true; });
const SUSTAIN = M.pedals.filter((p) => p[2] === 64);
const SOFT = M.pedals.filter((p) => p[2] === 67);
let PLO = 127, PHI = 0;
for (const n of BASE) { PLO = Math.min(PLO, n.p); PHI = Math.max(PHI, n.p); }

const FILE = M.file;
const fmtParts = String(FILE.format || '').split('·').map((s) => s.trim());
const DEV = M.info.device;
const GPU_SHORT = DEV.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');

/* analysis windows: 9 x 16 s, hop 5.5 s (timings line up with MOCK.log) */
const WIN_N = M.progress.windows || 9;
const WIN = Array.from({ length: WIN_N }, (_, k) => ({
  k, t0: k * 5.5, t1: Math.min(DUR, k * 5.5 + 16),
  notes: [118, 96, 131, 104, 112, 99, 121, 93, 87][k] || 100,
  ped: [3, 2, 2, 3, 3, 2, 3, 2, 2][k] || 2,
  aria: [1, 2, 0, 1, 1, 0, 2, 1, 1][k] || 0,
  tk: [0.774, 0.772, 0.771, 0.772, 0.773, 0.771, 0.772, 0.774, 0.769][k] || 0.772,
}));
const VIEWS = ST.views || ['orig', 'left', 'right', 'mid'];
const TL = { decode: 0.432, perWin: 0.772, tkEnd: 0.432 + 9 * 0.772, ariaEnd: 0.432 + 9 * 0.772 + 3.6, total: ST.seconds_total || 11.6 };
const ARIA_WIN = (TL.ariaEnd - TL.tkEnd) / WIN_N;

/* ------------------------------------------------------------------ options state */
const defaults = (specs) => { const o = {}; for (const s of specs) o[s.key] = s.default; return o; };
function freshOptions() {
  const eng = {};
  for (const e of ENGINES) eng[e.id] = defaults(e.options);
  return { engine: INST.default_engine, eng, out: defaults(OUT) };
}
const S = {
  view: 'home', adv: false, opt: freshOptions(), jobCfg: null,
  time: 12, playing: false, listen: 'both', color: 'conf', more: false, rows: 40, sel: null,
  notes: BASE, running: false, raf: 0, prf: 0, frozenP: 0.46, util: [], vram: 2.4,
};
const fmtVal = (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
const cfgKey = () => JSON.stringify([S.opt.engine, S.opt.eng[S.opt.engine]]);
function changedCount() {
  let n = S.opt.engine !== INST.default_engine ? 1 : 0;
  for (const e of ENGINES) for (const s of e.options) if (S.opt.eng[e.id][s.key] !== s.default) n++;
  for (const s of OUT) if (S.opt.out[s.key] !== s.default) n++;
  return n;
}

function cliHTML(file, out) {
  const o = S.opt, eng = engById(o.engine);
  const tok = (cls, s) => '<span class="' + cls + '">' + esc(s) + '</span>';
  const kv = (flag, k, v, d) => tok('f', flag) + ' ' + tok('v' + (v !== d ? ' ch' : ''), k + '=' + fmtVal(v));
  const parts = [tok('s', 'python -m midiconv convert'), tok('v', '"' + file + '"'), tok('f', '-o') + ' ' + tok('v', '"' + out + '"'),
    tok('f', '--instrument') + ' ' + tok('v', INST.id),
    tok('f', '--engine') + ' ' + tok('v' + (o.engine !== INST.default_engine ? ' ch' : ''), o.engine)];
  for (const s of eng.options) parts.push(kv('--set', s.key, o.eng[o.engine][s.key], s.default));
  for (const s of OUT) {
    if (s.key === 'flat_velocity' && o.out.velocity !== 'flat') continue;
    parts.push(kv('--out', s.key, o.out[s.key], s.default));
  }
  // keep "flag value" pairs together; long quoted file names may still wrap at spaces
  return parts.map((x, i) => (i === 1 || i === 2 ? x : '<span class="cp">' + x + '</span>')).join(' ');
}
const cliText = (html) => { const d = document.createElement('div'); d.innerHTML = html; return 'python -m midiconv convert' + d.textContent.slice('python -m midiconv convert'.length); };

/* ================================================================== PIANO ROLL (own renderer) */
function lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s < t) lo = m + 1; else hi = m; } return lo; }

class ConsoleRoll {
  constructor(el, cb) {
    this.el = el; this.cb = cb || {};
    this.kc = document.createElement('canvas'); this.kc.className = 'roll-keys';
    this.cv = document.createElement('canvas'); this.cv.className = 'roll-main';
    this.tip = document.createElement('div'); this.tip.className = 'roll-tip'; this.tip.hidden = true;
    this.cv.setAttribute('role', 'img');
    this.cv.setAttribute('aria-label', 'Piano roll of the transcription, coloured by confidence');
    el.append(this.kc, this.cv, this.tip);
    this.keyW = 50;
    this.notes = []; this.maxSpan = 2; this.duration = DUR; this.lo = Math.max(21, PLO - 2); this.hi = Math.min(108, PHI + 2);
    this.pps = 40; this.scrollX = 0; this.time = 0; this.playing = false;
    this.mode = 'conf'; this.listen = 'both'; this.tempo = 120; this.pedalMode = 'cc'; this.showSoft = true;
    this.hover = null; this.sel = null; this.hx = -1; this.needsFit = true; this.userScrolledAt = 0; this._raf = 0;
    const w = M.waveform; this.wave = w;
    let mx = 0; for (const v of w.peak) if (v > mx) mx = v; this.wmax = mx || 1;
    new ResizeObserver(() => this.resize()).observe(el);
    this.bind();
  }
  layout() {
    const H = this.el.clientHeight;
    const small = H < 330;
    this.rulerH = small ? 18 : 30; this.waveH = small ? 18 : 30; this.velH = small ? 22 : 34; this.pedH = small ? 18 : 24;
  }
  set(o) { Object.assign(this, o); if (o.notes) { let span = 0; for (const n of this.notes) span = Math.max(span, n.snd - n.s); this.maxSpan = span; if (this.hover && !this.notes.includes(this.hover)) this.hover = null; } this.draw(); }
  W() { return Math.max(1, this.el.clientWidth - this.keyW); }
  H() { return this.el.clientHeight; }
  nTop() { return this.rulerH + this.waveH; }
  nBot() { return this.H() - this.velH - this.pedH; }
  rowH() { return Math.max(0.5, (this.nBot() - this.nTop()) / (this.hi - this.lo + 1)); }
  rowY(p) { return this.nTop() + (this.hi - p) * this.rowH(); }
  x(t) { return (t - this.scrollX) * this.pps; }
  endOf(n) { return this.pedalMode === 'extend' ? n.snd : n.e; }
  clampScroll(s) { return clamp(s, 0, Math.max(0, this.duration - this.W() / this.pps)); }
  fit(sec) {
    const w = this.el.clientWidth;
    if (w <= this.keyW + 10) { this.needsFit = true; return; }
    this.needsFit = false;
    this.pps = clamp(this.W() / (sec || 20), 4, 1500);
    this.scrollX = this.clampScroll(this.time - (sec || 20) * 0.35);
    if (this.time < (sec || 20) * 0.7) this.scrollX = 0;
    this.cb.onView && this.cb.onView(this.pps);
    this.requestDraw();
  }
  zoom(f, ax) {
    const a = ax == null ? this.W() / 2 : ax;
    const tA = this.scrollX + a / this.pps;
    this.pps = clamp(this.pps * f, 4, 1500);
    this.scrollX = this.clampScroll(tA - a / this.pps);
    this.cb.onView && this.cb.onView(this.pps);
    this.requestDraw();
  }
  setTime(t, playing) {
    this.time = t; this.playing = playing;
    const vs = this.W() / this.pps;
    const recent = performance.now() - this.userScrolledAt < 2500;
    if (playing && !recent && (t > this.scrollX + vs * 0.85 || t < this.scrollX)) this.scrollX = this.clampScroll(t - vs * 0.12);
    this.requestDraw();
  }
  reveal(t) {
    const vs = this.W() / this.pps;
    if (t < this.scrollX || t > this.scrollX + vs * 0.9) this.scrollX = this.clampScroll(t - vs * 0.25);
    this.requestDraw();
  }
  requestDraw() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.layout();
    if (this.needsFit) this.fit(20);
    const dpr = window.devicePixelRatio || 1;
    for (const [cv, cw, left] of [[this.kc, this.keyW, 0], [this.cv, w - this.keyW, this.keyW]]) {
      cv.style.left = left + 'px'; cv.style.width = Math.max(1, cw) + 'px'; cv.style.height = h + 'px';
      cv.width = Math.max(1, Math.round(cw * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
    }
    this.scrollX = this.clampScroll(this.scrollX);
    this.draw();
  }

  colorOf(n) { return this.mode === 'vel' ? n.vc : n.cc; }

  drawKeys(lit) {
    const ctx = this.kc.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.keyW, H = this.H(), rh = this.rowH(), top = this.nTop(), bot = this.nBot();
    ctx.fillStyle = '#0f1318'; ctx.fillRect(0, 0, w, H);
    ctx.font = '10px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const lab = (t, y, c) => { ctx.fillStyle = c || '#85919f'; ctx.fillText(t, w - 7, y); };
    if (this.rulerH >= 28) { lab('sec', 8); lab('bar', 22); } else lab('sec', this.rulerH / 2);
    ctx.fillStyle = '#10151b'; ctx.fillRect(0, this.rulerH, w, this.waveH);
    lab('audio', this.rulerH + this.waveH / 2, this.listen === 'midi' ? '#5d6875' : '#a6b2c0');
    // keys
    ctx.fillStyle = '#28313c'; ctx.fillRect(0, top, w, bot - top);
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this.rowY(p);
      if (lit && lit.has(p)) {
        ctx.fillStyle = lit.get(p);
        ctx.fillRect(isBlack(p) ? 0 : 0, y, isBlack(p) ? w * 0.62 : w, rh);
        continue;
      }
      if (isBlack(p)) { ctx.fillStyle = '#0a0d11'; ctx.fillRect(0, y + 0.5, w * 0.62, Math.max(0.5, rh - 1)); }
      else if (!isBlack(p + 1) && p < this.hi) { ctx.fillStyle = '#151b22'; ctx.fillRect(0, y - 0.5, w, 1); }
    }
    for (let p = this.lo; p <= this.hi; p++) {
      if (p % 12 !== 0) continue;
      const y = this.rowY(p);
      ctx.fillStyle = '#121820'; ctx.fillRect(0, y + rh - 0.5, w, 1);
      if (rh * 12 >= 14) { ctx.fillStyle = lit && lit.has(p) ? '#03140c' : '#c4ccd6'; ctx.fillText(noteName(p), w - 6, y + rh / 2); }
    }
    ctx.fillStyle = '#10151b'; ctx.fillRect(0, bot, w, H - bot);
    ctx.fillStyle = '#1f2730'; ctx.fillRect(0, bot, w, 1); ctx.fillRect(0, H - this.pedH, w, 1);
    lab('vel', bot + this.velH / 2, this.listen === 'original' ? '#5d6875' : '#85919f');
    lab('pedal', H - this.pedH / 2);
    ctx.fillStyle = '#2a3440'; ctx.fillRect(w - 1, 0, 1, H);
  }

  draw() {
    if (!this.el.clientWidth || !this.el.clientHeight || !this.rulerH) return;
    const ctx = this.cv.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.W(), H = this.H(), rh = this.rowH(), top = this.nTop(), bot = this.nBot();
    const t0 = this.scrollX, t1 = t0 + W / this.pps, pps = this.pps;
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, W, H);

    // ruler + wave lane backgrounds
    ctx.fillStyle = '#10151b'; ctx.fillRect(0, 0, W, this.rulerH);
    ctx.fillStyle = '#0d1217'; ctx.fillRect(0, this.rulerH, W, this.waveH);
    // pitch rows
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this.rowY(p);
      if (isBlack(p)) { ctx.fillStyle = '#0e1319'; ctx.fillRect(0, y, W, rh); }
      if (p % 12 === 0) { ctx.fillStyle = '#1e2731'; ctx.fillRect(0, y + rh - 0.5, W, 1); }
    }
    // bar grid (from MIDI tempo, 4/4)
    const barSec = 240 / this.tempo;
    const two = this.rulerH >= 28;
    ctx.font = '10px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (barSec * pps >= 10) {
      const labelEvery = Math.max(1, Math.ceil(26 / (barSec * pps)));
      for (let b = Math.floor(t0 / barSec); b * barSec <= t1; b++) {
        const x = Math.round(this.x(b * barSec)) + 0.5;
        ctx.fillStyle = '#131a22'; ctx.fillRect(x - 0.5, top, 1, bot - top);
        if (two) {
          ctx.fillStyle = '#26303c'; ctx.fillRect(x - 0.5, 15, 1, this.rulerH - 15);
          if (b % labelEvery === 0) { ctx.fillStyle = '#85919f'; ctx.fillText(String(b + 1), x + 3, 22.5); }
        }
      }
    }
    // seconds grid
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s * pps >= 64) || 120;
    const minor = step / 5;
    if (minor * pps >= 6) {
      ctx.fillStyle = '#2a3440';
      for (let k = Math.floor(t0 / minor); k * minor <= t1; k++) { const x = Math.round(this.x(k * minor)) + 0.5; ctx.fillRect(x - 0.5, (two ? 15 : this.rulerH) - 4, 1, 4); }
    }
    for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
      const t = k * step; const x = Math.round(this.x(t)) + 0.5;
      ctx.fillStyle = '#1a222c'; ctx.fillRect(x - 0.5, top, 1, bot - top);
      ctx.fillStyle = '#3b4756'; ctx.fillRect(x - 0.5, 0, 1, two ? 15 : this.rulerH);
      ctx.fillStyle = '#c4ccd6';
      const lbl = step < 1 ? (Math.floor(t / 60) + ':' + (t % 60).toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')) : fmtTime(t);
      ctx.fillText(lbl, x + 4, two ? 8 : this.rulerH / 2);
    }
    ctx.fillStyle = '#1a222b'; if (two) ctx.fillRect(0, 15, W, 1);
    ctx.fillStyle = '#2a3440'; ctx.fillRect(0, this.rulerH - 1, W, 1); ctx.fillRect(0, top - 1, W, 1);

    // waveform lane (original audio)
    const wv = this.wave, hop = wv.hop_seconds, pk = wv.peak, rms = wv.rms;
    const mid = this.rulerH + this.waveH / 2, amp = this.waveH / 2 - 3;
    const dimWave = this.listen === 'midi';
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass === 0 ? (dimWave ? 'rgba(92,200,255,0.12)' : 'rgba(92,200,255,0.32)') : (dimWave ? 'rgba(92,200,255,0.22)' : 'rgba(150,220,255,0.75)');
      const src = pass === 0 ? pk : rms;
      for (let px = 0; px < W; px++) {
        const ta = t0 + px / pps;
        if (ta > DUR) break;
        let ia = Math.floor(ta / hop), ib = Math.max(ia + 1, Math.ceil((ta + 1 / pps) / hop));
        ia = Math.max(0, ia); ib = Math.min(src.length, ib);
        let m = 0; for (let i = ia; i < ib; i++) if (src[i] > m) m = src[i];
        const hh = Math.max(0.5, (m / this.wmax) * amp);
        ctx.fillRect(px, mid - hh, 1, hh * 2);
      }
    }

    // pedal lane + velocity lane backgrounds
    ctx.fillStyle = '#0d1217'; ctx.fillRect(0, bot, W, H - bot);
    ctx.fillStyle = '#1f2730'; ctx.fillRect(0, bot, W, 1); ctx.fillRect(0, H - this.pedH, W, 1);
    // velocity guides 64 / 127
    const vTop = bot + 4, vH = this.velH - 7;
    ctx.fillStyle = '#151c24'; ctx.fillRect(0, Math.round(vTop + vH * (1 - 64 / 127)) + 0.5, W, 1);

    // notes
    const notes = this.notes;
    const h = Math.max(1, rh - (rh > 5 ? 1 : 0.3));
    const midiDim = this.listen === 'original';
    const lit = new Map();
    let i = lowerBound(notes, t0 - this.maxSpan - 0.01);
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.s > t1) break;
      const end = this.endOf(n);
      const tailEnd = this.pedalMode === 'cc' ? n.snd : end;
      if (n.s <= this.time && this.time < (this.pedalMode === 'none' ? n.e : tailEnd) && !lit.has(n.p)) lit.set(n.p, this.colorOf(n));
      if (tailEnd < t0 || n.p < this.lo || n.p > this.hi) continue;
      const y = this.rowY(n.p) + (rh - h) / 2;
      const x0 = this.x(n.s), x1 = this.x(end);
      const col = this.colorOf(n);
      ctx.fillStyle = col;
      if (this.pedalMode === 'cc' && n.snd > n.e + 0.01) {
        ctx.globalAlpha = midiDim ? 0.15 : 0.32;
        ctx.fillRect(x1, y + h / 2 - Math.max(0.5, h * 0.14), this.x(n.snd) - x1, Math.max(1, h * 0.28));
      }
      ctx.globalAlpha = midiDim ? 0.45 : 0.92;
      ctx.fillRect(x0, y, Math.max(1.5, x1 - x0), h);
      ctx.globalAlpha = midiDim ? 0.5 : 1;
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = midiDim ? 0.18 : 0.5;
      ctx.fillRect(x0, y, 1, h);
      ctx.globalAlpha = 1;
      if (n.aria) {
        ctx.strokeStyle = '#ff8ad8'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x0, y + h / 2, Math.max(3.5, h / 2 + 2.5), 0, Math.PI * 2); ctx.stroke();
      }
      if (n === this.hover || n === this.sel) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = n === this.sel ? 1.5 : 1;
        ctx.strokeRect(x0 - 1, y - 1, Math.max(1.5, x1 - x0) + 2, h + 2);
      }
      // velocity stem
      const vx = Math.round(x0) + 0.5, vh = (n.v / 127) * vH;
      ctx.fillStyle = col; ctx.globalAlpha = midiDim ? 0.35 : 0.9;
      ctx.fillRect(vx - 0.5, vTop + vH - vh, 1.5, vh);
      ctx.fillRect(vx - 1, vTop + vH - vh - 1, 2.5, 2);
      ctx.globalAlpha = 1;
    }

    // pedal lane
    const pTop = H - this.pedH;
    if (this.pedalMode === 'cc' || this.pedalMode === 'extend') {
      for (const [s, e] of this.sustain || []) {
        if (e < t0 || s > t1) continue;
        const x0 = this.x(s), x1 = this.x(e);
        if (this.pedalMode === 'cc') {
          ctx.fillStyle = 'rgba(133,146,255,0.5)'; ctx.fillRect(x0, pTop + 4, Math.max(1.5, x1 - x0 - 1), this.pedH - 11);
          ctx.fillStyle = '#8592ff'; ctx.fillRect(x0, pTop + 4, Math.max(1.5, x1 - x0 - 1), 1.5);
        } else {
          ctx.strokeStyle = 'rgba(133,146,255,0.35)'; ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, pTop + 4.5, Math.max(1, x1 - x0 - 2), this.pedH - 12);
        }
      }
    }
    if (this.showSoft) {
      ctx.fillStyle = '#c39bff';
      for (const [s, e] of this.soft || []) { if (e < t0 || s > t1) continue; ctx.fillRect(this.x(s), H - 5, Math.max(1.5, this.x(e) - this.x(s)), 2); }
    }
    if (this.pedalMode !== 'cc') {
      const msg = this.pedalMode === 'extend' ? 'sustain baked into note lengths (no CC64 written)' : 'sustain pedal left out of the file';
      ctx.font = '10px ' + FONT; ctx.textAlign = 'left';
      const tw = ctx.measureText(msg).width;
      ctx.fillStyle = 'rgba(13,18,23,0.9)'; ctx.fillRect(6, pTop + 3, tw + 10, this.pedH - 8);
      ctx.fillStyle = '#a6b2c0'; ctx.fillText(msg, 11, pTop + this.pedH / 2 - 1);
    }

    // hover crosshair
    if (this.hx >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(Math.round(this.hx), this.rulerH, 1, H - this.rulerH);
      const ht = t0 + this.hx / pps;
      const lbl = ht.toFixed(2) + ' s';
      ctx.font = '10px ' + FONT;
      const tw = ctx.measureText(lbl).width + 8;
      const lx = clamp(this.hx - tw / 2, 0, W - tw);
      ctx.fillStyle = '#2a3440'; ctx.fillRect(lx, this.rulerH - 14, tw, 13);
      ctx.fillStyle = '#dfe6ee'; ctx.textAlign = 'left'; ctx.fillText(lbl, lx + 4, this.rulerH - 7.5);
    }

    // playhead
    const px = this.x(this.time);
    if (px >= -6 && px <= W + 6) {
      ctx.fillStyle = '#f4f7fb';
      ctx.fillRect(Math.round(px) - 0.5, 0, 1.5, H);
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5.5, 0); ctx.lineTo(px + 0.25, 7); ctx.closePath(); ctx.fill();
    }
    this.drawKeys(lit);
  }

  hit(x, y) {
    if (y < this.nTop() || y > this.nBot()) return null;
    const t = this.scrollX + x / this.pps;
    const p = this.hi - Math.floor((y - this.nTop()) / this.rowH());
    const slack = 3 / this.pps;
    let i = lowerBound(this.notes, t - this.maxSpan - 0.01), best = null;
    for (; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.s > t + slack) break;
      if (n.p === p && t <= Math.max(this.endOf(n), n.s + slack) + slack) best = n;
    }
    return best;
  }

  showTip(n, x, y) {
    if (!n) { this.tip.hidden = true; return; }
    const held = n.e - n.s, sounding = n.snd - n.s;
    const lenTxt = this.pedalMode === 'extend' ? fmtMs(sounding) + ' (pedal baked in)' : fmtMs(held) + (this.pedalMode === 'cc' && sounding > held + 0.01 ? ' · sounds ' + fmtMs(sounding) : '');
    this.tip.innerHTML =
      '<div class="tt-h">' + esc(noteName(n.p)) + ' <span>#' + n.id + ' · midi ' + n.p + '</span></div>' +
      '<dl><dt>onset</dt><dd>' + n.s.toFixed(3) + ' s</dd>' +
      '<dt>length</dt><dd>' + esc(lenTxt) + '</dd>' +
      '<dt>velocity</dt><dd>' + n.v + '</dd>' +
      '<dt>confidence</dt><dd style="color:' + n.cc + '">' + n.c.toFixed(4) + '</dd>' +
      '<dt>source</dt><dd>' + (n.aria ? '<span style="color:#ff8ad8">Aria-AMT (second opinion)</span>' : 'Transkun V2') + '</dd></dl>';
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let lx = x + this.keyW + 14, ly = y + 14;
    if (lx + tw > this.el.clientWidth - 4) lx = x + this.keyW - tw - 14;
    if (ly + th > this.el.clientHeight - 4) ly = y - th - 10;
    this.tip.style.left = Math.max(this.keyW + 2, lx) + 'px';
    this.tip.style.top = Math.max(2, ly) + 'px';
  }

  bind() {
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left);
      else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scrollX = this.clampScroll(this.scrollX + (e.deltaMode === 1 ? d * 30 : d) / this.pps);
        this.userScrolledAt = performance.now(); this.requestDraw();
      }
    }, { passive: false });
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, s: this.scrollX, moved: false }; });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) { this.scrollX = this.clampScroll(drag.s - dx / this.pps); this.userScrolledAt = performance.now(); this.hx = -1; this.tip.hidden = true; cv.style.cursor = 'grabbing'; this.requestDraw(); return; }
      }
      this.hx = x;
      const n = this.hit(x, y);
      if (n !== this.hover) { this.hover = n; this.cb.onHover && this.cb.onHover(n); }
      this.showTip(n, x, y);
      cv.style.cursor = n ? 'pointer' : 'crosshair';
      this.requestDraw();
    });
    const end = (e) => {
      if (drag && !drag.moved && e.type === 'pointerup') {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const n = this.hit(x, y);
        const t = n ? n.s : this.scrollX + x / this.pps;
        this.cb.onSeek && this.cb.onSeek(clamp(t, 0, this.duration), n);
      }
      drag = null; cv.style.cursor = 'crosshair';
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.tip.hidden = true; this.hx = -1; if (this.hover) { this.hover = null; this.cb.onHover && this.cb.onHover(null); } this.requestDraw(); });
  }
}

/* ================================================================== small SVG charts */
function chartBox(el) { const w = el.clientWidth, h = el.clientHeight; return w > 30 && h > 30 ? { w, h } : null; }
function svg(w, h, inner) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' + inner + '</svg>'; }
const R = (v) => Math.round(v * 10) / 10;

function drawConf(el, notes) {
  const b = chartBox(el); if (!b) return;
  const { w, h } = b, L = 8, Rr = 8, T = 14, B = 16, pw = w - L - Rr, ph = h - T - B;
  const lo = 0.92, bw = 0.005, nb = 16, bins = new Array(nb).fill(0);
  let sum = 0;
  for (const n of notes) { bins[clamp(Math.floor((n.c - lo) / bw), 0, nb - 1)]++; sum += n.c; }
  const mx = Math.max(1, ...bins), lg = (v) => (v ? Math.log10(v + 1) / Math.log10(mx + 1) : 0);
  const cw = pw / nb;
  let s = '';
  for (const f of [0.5, 1]) s += '<line class="gl" x1="' + L + '" x2="' + (L + pw) + '" y1="' + R(T + ph * (1 - f)) + '" y2="' + R(T + ph * (1 - f)) + '"/>';
  bins.forEach((c, i) => {
    const bh = lg(c) * ph; if (!c) return;
    s += '<rect x="' + R(L + i * cw + 0.75) + '" y="' + R(T + ph - bh) + '" width="' + R(Math.max(1, cw - 1.5)) + '" height="' + R(bh) + '" fill="' + confColor(lo + (i + 0.5) * bw) + '"><title>' + (lo + i * bw).toFixed(3) + '–' + (lo + (i + 1) * bw).toFixed(3) + ': ' + c + ' notes</title></rect>';
  });
  const mean = notes.length ? sum / notes.length : 1;
  const mxp = L + clamp((mean - lo) / (nb * bw), 0, 1) * pw;
  s += '<line class="mk" x1="' + R(mxp) + '" x2="' + R(mxp) + '" y1="' + (T - 4) + '" y2="' + (T + ph) + '"/>';
  s += '<text class="mk-t" x="' + R(mxp - 3) + '" y="' + (T - 5) + '" text-anchor="end">μ</text>';
  s += '<line class="ax" x1="' + L + '" x2="' + (L + pw) + '" y1="' + (T + ph + 0.5) + '" y2="' + (T + ph + 0.5) + '"/>';
  s += '<text x="' + L + '" y="' + (h - 4) + '">.92</text><text x="' + R(L + pw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">.96</text><text x="' + (L + pw) + '" y="' + (h - 4) + '" text-anchor="end">1.0</text>';
  s += '<text x="' + L + '" y="' + (T - 5) + '">log n</text>';
  el.innerHTML = svg(w, h, s);
  const below = notes.filter((n) => n.c < 0.99).length;
  $('confStat').innerHTML = 'μ ' + mean.toFixed(4) + '<span class="lx"> · ' + below + ' &lt;.99</span>';
}

function drawVel(el, notes) {
  const b = chartBox(el); if (!b) return;
  const { w, h } = b, L = 8, Rr = 8, T = 14, B = 16, pw = w - L - Rr, ph = h - T - B;
  const nb = 16, bins = new Array(nb).fill(0);
  const vs = notes.map((n) => n.v).sort((a, b2) => a - b2);
  for (const v of vs) bins[clamp(Math.floor(v / 8), 0, nb - 1)]++;
  const mx = Math.max(1, ...bins), cw = pw / nb;
  let s = '';
  for (const f of [0.5, 1]) s += '<line class="gl" x1="' + L + '" x2="' + (L + pw) + '" y1="' + R(T + ph * (1 - f)) + '" y2="' + R(T + ph * (1 - f)) + '"/>';
  bins.forEach((c, i) => {
    if (!c) return; const bh = Math.max(1, (c / mx) * ph);
    s += '<rect x="' + R(L + i * cw + 0.75) + '" y="' + R(T + ph - bh) + '" width="' + R(Math.max(1, cw - 1.5)) + '" height="' + R(bh) + '" fill="' + velColor(i * 8 + 4) + '"><title>velocity ' + i * 8 + '–' + (i * 8 + 7) + ': ' + c + ' notes</title></rect>';
  });
  const med = vs.length ? vs[vs.length >> 1] : 0;
  const mxp = L + (med / 128) * pw;
  s += '<line class="mk" x1="' + R(mxp) + '" x2="' + R(mxp) + '" y1="' + (T - 4) + '" y2="' + (T + ph) + '"/>';
  s += '<text class="mk-t" x="' + R(mxp + 3) + '" y="' + (T - 5) + '">med</text>';
  s += '<line class="ax" x1="' + L + '" x2="' + (L + pw) + '" y1="' + (T + ph + 0.5) + '" y2="' + (T + ph + 0.5) + '"/>';
  s += '<text x="' + L + '" y="' + (h - 4) + '">0</text><text x="' + R(L + pw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">64</text><text x="' + (L + pw) + '" y="' + (h - 4) + '" text-anchor="end">127</text>';
  el.innerHTML = svg(w, h, s);
  $('velStat').innerHTML = vs.length ? (vs[0] === vs[vs.length - 1] ? 'flat ' + vs[0] : vs[0] + '–' + vs[vs.length - 1] + '<span class="lx"> · med ' + med + '</span>') : '—';
}

function drawPitch(el, notes) {
  const b = chartBox(el); if (!b) return;
  const { w, h } = b, L = 8, Rr = 8, T = 10, B = 24, pw = w - L - Rr, ph = h - T - B;
  const bins = new Array(88).fill(0);
  let lo = 127, hi = 0;
  for (const n of notes) { bins[clamp(n.p - 21, 0, 87)]++; lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
  const mx = Math.max(1, ...bins), cw = pw / 88;
  let s = '';
  // used-range band
  if (notes.length) s += '<rect x="' + R(L + (lo - 21) * cw) + '" y="' + T + '" width="' + R((hi - lo + 1) * cw) + '" height="' + ph + '" fill="rgba(92,200,255,0.05)"/>';
  bins.forEach((c, i) => {
    if (!c) return; const bh = Math.max(1, (c / mx) * ph);
    s += '<rect x="' + R(L + i * cw) + '" y="' + R(T + ph - bh) + '" width="' + R(Math.max(0.8, cw - 0.4)) + '" height="' + R(bh) + '" fill="#5cc8ff" opacity="' + (isBlack(i + 21) ? 0.7 : 1) + '"><title>' + noteName(i + 21) + ': ' + c + ' notes</title></rect>';
  });
  // keyboard strip
  const ky = T + ph + 2, kh = 7;
  s += '<rect class="kw" x="' + L + '" y="' + ky + '" width="' + pw + '" height="' + kh + '"/>';
  for (let i = 0; i < 88; i++) if (isBlack(i + 21)) s += '<rect class="kb" x="' + R(L + i * cw) + '" y="' + ky + '" width="' + R(Math.max(0.8, cw)) + '" height="' + (kh - 2) + '"/>';
  const c4 = L + (60 - 21 + 0.5) * cw;
  s += '<line class="ax" x1="' + R(c4) + '" x2="' + R(c4) + '" y1="' + (ky + kh) + '" y2="' + (ky + kh + 3) + '"/>';
  s += '<text x="' + L + '" y="' + (h - 3) + '">A0</text><text x="' + R(c4) + '" y="' + (h - 3) + '" text-anchor="middle">C4</text><text x="' + (L + pw) + '" y="' + (h - 3) + '" text-anchor="end">C8</text>';
  el.innerHTML = svg(w, h, s);
  $('pitchStat').innerHTML = notes.length ? noteName(lo) + '–' + noteName(hi) + '<span class="lx"> · ' + (hi - lo) + ' st</span>' : '—';
}

let NPS = null;
function drawNps(el, notes) {
  const b = chartBox(el); if (!b) return;
  const { w, h } = b, L = 8, Rr = 8, T = 14, B = 16, pw = w - L - Rr, ph = h - T - B;
  const nb = Math.ceil(DUR), bins = new Array(nb).fill(0);
  for (const n of notes) bins[clamp(Math.floor(n.s), 0, nb - 1)]++;
  const mx = Math.max(1, ...bins);
  const X = (i) => L + (i / nb) * pw, Y = (v) => T + ph - (v / mx) * ph;
  let d = '';
  bins.forEach((c, i) => { d += (i ? 'L' : 'M') + R(X(i + 0.5)) + ' ' + R(Y(c)); });
  const area = d + 'L' + R(X(nb - 0.5)) + ' ' + (T + ph) + 'L' + R(X(0.5)) + ' ' + (T + ph) + 'Z';
  const pi = bins.indexOf(mx);
  let s = '<line class="gl" x1="' + L + '" x2="' + (L + pw) + '" y1="' + R(Y(mx / 2)) + '" y2="' + R(Y(mx / 2)) + '"/>';
  s += '<path class="np-area" d="' + area + '"/><path class="np-line" d="' + d + '"/>';
  s += '<circle cx="' + R(X(pi + 0.5)) + '" cy="' + R(Y(mx)) + '" r="2.5" fill="#f2b84b"/>';
  s += '<text class="mk-t" x="' + R(clamp(X(pi + 0.5) + 5, L, L + pw - 14)) + '" y="' + (T - 4) + '">' + mx + '</text>';
  s += '<line class="ax" x1="' + L + '" x2="' + (L + pw) + '" y1="' + (T + ph + 0.5) + '" y2="' + (T + ph + 0.5) + '"/>';
  s += '<line id="npsHead" class="ph-line" x1="0" x2="0" y1="' + (T - 2) + '" y2="' + (T + ph) + '"/>';
  s += '<text x="' + L + '" y="' + (h - 4) + '">0:00</text><text x="' + R(L + pw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">' + fmtTime(DUR / 2) + '</text><text x="' + (L + pw) + '" y="' + (h - 4) + '" text-anchor="end">' + fmtTime(DUR) + '</text>';
  el.innerHTML = svg(w, h, s);
  NPS = { L, pw };
  const avg = notes.length / DUR;
  $('npsStat').innerHTML = '<span class="lx">avg ' + avg.toFixed(1) + ' · </span>peak ' + mx;
  moveNpsHead();
}
function moveNpsHead() {
  const l = document.getElementById('npsHead'); if (!l || !NPS) return;
  const x = R(NPS.L + (S.time / DUR) * NPS.pw);
  l.setAttribute('x1', x); l.setAttribute('x2', x);
}
function renderCharts() {
  if (S.view !== 'result') return;
  drawConf($('chConf'), S.notes); drawVel($('chVel'), S.notes); drawPitch($('chPitch'), S.notes); drawNps($('chNps'), S.notes);
}

/* ================================================================== shared fragments */
const ICON = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  active: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" opacity=".35"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>',
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" stroke-dasharray="2 2.2"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.1"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l6 11H2z"/><path d="M8 6.8v3M8 11.6v.1"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>',
};

function gaugeSVG(used, total) {
  const f = clamp(used / total, 0, 1), len = Math.PI * 46;
  const hot = f > 0.8;
  let ticks = '';
  for (let i = 0; i <= 4; i++) { const a = Math.PI * (1 - i / 4); ticks += '<line class="g-tick" x1="' + R(56 + Math.cos(a) * 52) + '" y1="' + R(58 - Math.sin(a) * 52) + '" x2="' + R(56 + Math.cos(a) * 55) + '" y2="' + R(58 - Math.sin(a) * 55) + '"/>'; }
  return '<svg class="gauge" viewBox="0 0 112 66" role="img" aria-label="Video memory ' + used.toFixed(1) + ' of ' + total + ' GB in use">' +
    '<path class="g-track" d="M10 58 A46 46 0 0 1 102 58"/>' +
    '<path class="g-val" d="M10 58 A46 46 0 0 1 102 58" style="stroke-dasharray:' + R(len * f) + ' 400' + (hot ? ';stroke:#f2b84b' : '') + '"/>' + ticks +
    '<text x="56" y="49" text-anchor="middle">' + used.toFixed(1) + '</text><text class="g-sub" x="56" y="62" text-anchor="middle">of ' + total + ' GB</text></svg>';
}
function sparkSVG(vals) {
  const n = Math.max(2, vals.length), w = 100, h = 34;
  let d = '';
  vals.forEach((v, i) => { d += (i ? 'L' : 'M') + R((i / (n - 1)) * w) + ' ' + R(h - 2 - (v / 100) * (h - 4)); });
  const area = d + 'L' + w + ' ' + h + 'L0 ' + h + 'Z';
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><line class="s-mid" x1="0" x2="' + w + '" y1="' + (h / 2) + '" y2="' + (h / 2) + '" vector-effect="non-scaling-stroke"/><line class="s-base" x1="0" x2="' + w + '" y1="' + (h - 0.5) + '" y2="' + (h - 0.5) + '" vector-effect="non-scaling-stroke"/><path class="s-area" d="' + area + '"/><path class="s-line" d="' + d + '" vector-effect="non-scaling-stroke"/></svg>';
}

function deviceHTML(busy) {
  const util = S.util.length ? S.util[S.util.length - 1] : 0;
  const vram = busy ? 9.7 : 2.4;
  return '<div class="dev-name"><span class="led ' + (busy ? 'busy' : 'ok') + '" aria-hidden="true"></span>' + esc(DEV.name) + '</div>' +
    '<div class="gauge-row">' + gaugeSVG(vram, DEV.vram_gb) +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">' +
        '<div class="meter"><span class="k">util</span><span class="bar"><i class="' + (busy ? 'amb' : 'acc') + '" id="utilBar' + (busy ? 'P' : 'H') + '" style="width:' + util + '%"></i></span><span class="v" id="utilVal' + (busy ? 'P' : 'H') + '">' + util + '%</span></div>' +
        '<div class="meter"><span class="k">vram</span><span class="bar"><i style="width:' + R((vram / DEV.vram_gb) * 100) + '%"></i></span><span class="v">' + Math.round((vram / DEV.vram_gb) * 100) + '%</span></div>' +
      '</div></div>' +
    '<dl class="kv tight dev-kv"><dt>device</dt><dd>cuda:0 · ' + DEV.vram_gb + ' GB · fp32</dd><dt>state</dt><dd>' + (busy ? '<span style="color:var(--amber)">busy</span> · 4 views per window' : '<span style="color:var(--acc)">idle</span> · models in memory') + '</dd>' +
    '<dt class="dk-models">models</dt><dd class="dk-models">transkun v2 <span class="ok">●</span> aria-amt <span class="ok">●</span></dd></dl>' +
    '<div class="dev-spark"><div class="spark-h"><span>util · last 20 s</span><span>100%</span></div><div class="spark-box" id="spark' + (busy ? 'P' : 'H') + '">' + sparkSVG(S.util) + '</div></div>';
}

const KEYS = [
  ['Anywhere', [[['Ctrl', 'O'], 'Choose a file'], [['O'], 'Advanced options'], [['?'], 'Keyboard shortcuts'], [['Esc'], 'Close panel · cancel conversion']]],
  ['Result', [[['Space'], 'Play / pause'], [['←', '→'], 'Seek 1 s (Shift: 5 s)'], [['Home'], 'Back to start'], [['+', '−'], 'Zoom in / out'], [['0'], 'Fit 20 seconds'], [['1', '2', '3'], 'Listen: Original / Both / MIDI'], [['C'], 'Colour: confidence / velocity'], [['Ctrl', 'S'], 'Save MIDI'], [['N'], 'New file']]],
];
function keysHTML(compact) {
  const pick = compact ? new Set(['Choose a file', 'Advanced options', 'Keyboard shortcuts', 'Play / pause', 'Seek 1 s (Shift: 5 s)', 'Zoom in / out', 'Save MIDI', 'New file']) : null;
  let s = '';
  for (const [grp, list] of KEYS) {
    if (!compact) s += '<div class="grp">' + grp + '</div>';
    for (const [keys, label] of list) {
      if (pick && !pick.has(label)) continue;
      s += '<dt>' + keys.map((k) => '<kbd>' + esc(k) + '</kbd>').join('') + '</dt><dd>' + esc(label) + '</dd>';
    }
  }
  return '<dl class="keys-list">' + s + '</dl>';
}

/* ================================================================== HOME */
function renderPipeline() {
  const o = S.opt, eng = engById(o.engine);
  const vSpec = eng.options.find((s) => s.key === 'views');
  const vLabel = vSpec ? (vSpec.choices.find((c) => c.value === o.eng[o.engine].views) || {}).label || '' : '';
  $('pipeTitle').textContent = engShort(eng) + (vLabel ? ' · ' + vLabel.replace(/\s*\((.*)\)/, ' $1') : '');
  $('pipeSpeed').textContent = o.engine === 'ensemble' ? 'about 20–25 s per 2-minute piece on this GPU' : o.engine === 'transkun' ? 'about 4× faster than Ensemble, almost as accurate' : 'Aria-AMT alone, for comparison';
  let rows = '<span class="ck">instrument</span><span class="cv"><span class="eq">= </span>' + INST.id + '</span><span class="cc"># ' + esc(INST.description) + '</span>';
  rows += '<span class="ck">engine</span><span class="cv' + (o.engine !== INST.default_engine ? ' changed' : '') + '"><span class="eq">= </span>' + o.engine + '</span><span class="cc"># ' + esc(eng.name) + '</span>';
  for (const s of eng.options) {
    const v = o.eng[o.engine][s.key];
    const lbl = s.kind === 'choice' ? ((s.choices.find((c) => c.value === v) || {}).label || '') : s.label;
    const extra = s.key === 'views' && v === 'channels' ? '  K=4: ' + VIEWS.join(' · ') : '';
    rows += '<span class="ck">' + s.key + '</span><span class="cv' + (v !== s.default ? ' changed' : '') + '"><span class="eq">= </span>' + esc(fmtVal(v)) + '</span><span class="cc"># ' + esc(lbl + extra) + '</span>';
  }
  const out = OUT.filter((s) => !(s.key === 'flat_velocity' && o.out.velocity !== 'flat')).map((s) => '<span class="' + (o.out[s.key] !== s.default ? 'changed' : '') + '">' + s.key + '=' + esc(fmtVal(o.out[s.key])) + '</span>').join(' ');
  rows += '<span class="ck">output</span><span class="cv" style="grid-column:span 2;white-space:normal">' + out + '</span>';
  $('pipeCfg').innerHTML = rows;
  $('pipeCli').innerHTML = cliHTML('recording.mp3', 'recording.mid');
}

// Transkun V2 alone (stereo views) on the same benchmark, from the README "Accuracy" table.
const TK_ALONE = { clean: 98.38, mp3: 98.37, phone: 97.37, reverb: 98.36, noise: 97.74, worst: 96.0 };
function renderBench() {
  const a = M.accuracy, f = a.onset_f1, lo = 95, hi = 100;
  let s = '';
  for (const k of Object.keys(f)) {
    const v = f[k];
    const tkv = TK_ALONE[k];
    s += '<div class="bench-row' + (k === 'worst' ? ' worst' : '') + '" title="Ensemble ' + v.toFixed(2) + ' · Transkun V2 alone ' + (tkv ? tkv.toFixed(2) : '—') + '"><span class="bk">' + esc(k) + '</span><span class="bar"><i style="width:' + R(((v - lo) / (hi - lo)) * 100) + '%"></i>' +
      (tkv ? '<b style="left:' + R(((tkv - lo) / (hi - lo)) * 100) + '%"></b>' : '') + '</span><span class="bv">' + v.toFixed(2) + '</span></div>';
  }
  s += '<div class="bench-axis"><span></span><span><span>95</span><span>97.5</span><span>100</span></span><span></span></div>';
  s += '<div class="bench-legend"><span><i class="bl-e"></i>ensemble</span><span><i class="bl-t"></i>transkun alone</span></div>';
  s += '<div class="bench-note"># ' + esc(a.note) + ' · worst = hall + noise + phone + 64 kbps</div>';
  $('bench').innerHTML = s;
  $('benchMeta').textContent = 'onset F1 %';
}

function renderRecent() {
  const rows = M.recent;
  const running = rows.filter((r) => r.status === 'running').length, queued = rows.filter((r) => r.status === 'queued').length;
  $('recentMeta').textContent = rows.length + ' jobs · ' + running + ' running · ' + queued + ' waiting';
  $('recentBody').innerHTML = rows.map((r) => {
    let st = '';
    if (r.status === 'done') st = '<span class="st done">done</span>';
    else if (r.status === 'running') st = '<span class="st running">' + Math.round(r.progress * 100) + '%</span><span class="rbar"><i style="width:' + Math.round(r.progress * 100) + '%"></i></span>';
    else if (r.status === 'queued') st = '<span class="st queued">waiting</span>';
    else st = '<span class="st error">failed</span>';
    const act = r.status === 'done' ? 'Open' : r.status === 'error' ? 'Retry' : r.status === 'queued' ? 'Remove' : 'Cancel';
    return '<tr data-id="' + r.id + '" data-status="' + r.status + '" tabindex="0" class="' + (r.status === 'error' ? 'is-error' : '') + '" aria-label="' + esc(r.filename + ', ' + (r.status === 'done' ? 'done' : r.status)) + '">' +
      '<td class="c-st">' + st + '</td><td class="c-id">' + r.id.slice(0, 8) + '</td>' +
      '<td class="c-file"><span class="fname" title="' + esc(r.filename) + '">' + esc(r.filename) + '</span>' + (r.error ? '<span class="ferr">' + esc(r.error) + '</span>' : '') + '</td>' +
      '<td class="c-num">' + (r.duration ? fmtTime(r.duration) : '—') + '</td><td class="c-num c-notes">' + (r.notes != null ? thin(r.notes) : '<span class="dim">—</span>') + '</td>' +
      '<td class="c-when">' + esc(r.when) + '</td><td class="c-act"><button type="button" class="row-act" data-act="' + act.toLowerCase() + '">' + act + '</button></td></tr>';
  }).join('');
}

/* ================================================================== PROGRESS */
function elapsedAt(p) {
  if (p <= 0.04) return (p / 0.04) * TL.decode;
  if (p <= 0.853) return TL.decode + ((p - 0.04) / 0.813) * (TL.tkEnd - TL.decode);
  if (p <= 0.96) return TL.tkEnd + ((p - 0.853) / 0.107) * (TL.ariaEnd - TL.tkEnd);
  return TL.ariaEnd + ((Math.min(1, p) - 0.96) / 0.04) * (TL.total - TL.ariaEnd);
}
const tsAt = (e) => { const a = 1.112 + e; return '14:32:' + a.toFixed(3).padStart(6, '0'); };
const LOG = [
  { at: 0, text: M.log[0] }, { at: 0.018, text: M.log[1] }, { at: 0.432, text: M.log[2] }, { at: 1.206, text: M.log[3] },
  { at: 1.978, text: M.log[4] }, { at: 2.749, text: M.log[5] }, { at: 3.521, text: M.log[6] },
];
for (let k = 5; k < WIN_N - 1; k++) {
  const at = TL.decode + k * TL.perWin, w = WIN[k - 1];
  LOG.push({ at, text: tsAt(at) + '  transkun  window ' + (k + 1) + '/' + WIN_N + '  notes+=' + w.notes + (w.notes < 100 ? ' ' : '') + '  pedal+=' + w.ped });
}
LOG.push({ at: TL.tkEnd, text: tsAt(TL.tkEnd) + '  transkun  done 9/9    notes+=' + WIN[8].notes + '   pedal+=' + WIN[8].ped + '  (' + (TL.tkEnd - TL.decode).toFixed(2) + ' s)' });
LOG.push({ at: TL.tkEnd + 0.02, text: tsAt(TL.tkEnd + 0.02) + '  aria  second opinion  9 windows  rescue=0.3' });
LOG.push({ at: TL.ariaEnd, text: tsAt(TL.ariaEnd) + '  aria  done  candidates=31  added=' + ST.notes_added_by_aria + '  (' + (TL.ariaEnd - TL.tkEnd).toFixed(2) + ' s)' });
LOG.push({ at: TL.ariaEnd + 0.03, text: tsAt(TL.ariaEnd + 0.03) + '  fuse  notes=' + ST.notes + '  pedal=' + ST.pedals + '  soft=' + ST.soft_pedals + '  mean_conf=' + ST.mean_confidence });
LOG.push({ at: TL.total, text: tsAt(TL.total) + '  write  ' + JOB.midi_name + '  done in ' + TL.total.toFixed(1) + ' s' });

function logLineHTML(line) {
  const m = /^(\S+)(\s+)(\S+)(.*)$/.exec(line);
  if (!m) return esc(line);
  const stg = m[3] === 'job' ? 'queued' : m[3];
  // the stage column has a fixed width, so drop the source's own padding to keep the message column aligned
  const rest = ' ' + esc(m[4].replace(/^\s+/, '')).replace(/(=|\+=|\b)(\d+(?:\.\d+)?)/g, (all, pre, num) => pre + '<span class="n">' + num + '</span>');
  return '<span class="ts">' + esc(m[1]) + '</span>' + m[2] + '<span class="stg ' + esc(stg) + '">' + esc(m[3]) + '</span>' + rest;
}

let lastLogCount = -1;
let logPinned = true; // the log follows new lines until the reader scrolls up
function renderProgress(p, frozen) {
  const e = elapsedAt(p);
  const pct = Math.round(p * 100);
  $('progPct').textContent = pct + '%';
  $('progFill').style.width = (p * 100).toFixed(2) + '%';
  $('progBar').setAttribute('aria-valuenow', pct);
  const stage = e < TL.decode ? 'decode' : e < TL.tkEnd ? 'transkun' : e < TL.ariaEnd ? 'aria' : p < 1 ? 'fuse' : 'done';
  const tkK = clamp(Math.floor((e - TL.decode) / TL.perWin), 0, WIN_N - 1);
  const tkF = clamp((e - TL.decode) / TL.perWin - tkK, 0, 1);
  const arK = clamp(Math.floor((e - TL.tkEnd) / ARIA_WIN), 0, WIN_N - 1);
  const msg = { decode: 'Reading audio', transkun: 'Transcribing window ' + (tkK + 1) + ' of ' + WIN_N, aria: 'Second opinion (Aria-AMT) · window ' + (arK + 1) + ' of ' + WIN_N, fuse: 'Merging and writing MIDI', done: 'Done' }[stage];
  $('progMsg').textContent = frozen ? M.progress.message : msg;
  const eta = frozen ? M.progress.eta_seconds : (p < 0.06 ? null : Math.max(1, Math.round((M.progress.eta_seconds * (1 - p)) / (1 - M.progress.progress))));
  $('progEta').innerHTML = 'elapsed <b>' + e.toFixed(1) + ' s</b> · ' + (eta == null ? 'estimating time left…' : p >= 1 ? 'finishing' : 'about <b>' + eta + ' s</b> left');
  $('progSub').textContent = 'job ' + JOB.id + ' · ' + S.opt.engine + ' · views=' + (S.opt.eng[S.opt.engine].views || 'none') + (S.opt.engine === 'ensemble' ? ' · rescue=' + S.opt.eng.ensemble.rescue : '');

  // stages
  const order = ['decode', 'transkun', 'aria', 'fuse'];
  const si = stage === 'done' ? 4 : order.indexOf(stage);
  $('stages').innerHTML = M.progress.stages.map((s, i) => {
    const st = i < si ? 'done' : i === si ? 'active' : 'pending';
    let sub = '';
    if (s.id === 'decode') sub = st === 'done' ? 'mp3 → 44.1 kHz · 0.41 s' : st === 'active' ? 'decoding…' : '—';
    if (s.id === 'transkun') sub = st === 'done' ? '9 windows · ' + (TL.tkEnd - TL.decode).toFixed(2) + ' s' : st === 'active' ? 'window ' + (tkK + 1) + '/' + WIN_N + ' · ' + (e - TL.decode).toFixed(2) + ' s' : '9 windows';
    if (s.id === 'aria') sub = st === 'done' ? '+' + ST.notes_added_by_aria + ' notes · ' + (TL.ariaEnd - TL.tkEnd).toFixed(2) + ' s' : st === 'active' ? 'window ' + (arK + 1) + '/' + WIN_N : 'after Transkun · τ=' + S.opt.eng.ensemble.rescue;
    if (s.id === 'fuse') sub = st === 'done' ? (TL.total - TL.ariaEnd).toFixed(2) + ' s' : st === 'active' ? 'stitching…' : 'stitch · pedal · write';
    return '<li class="stage ' + st + '">' + ICON[st === 'done' ? 'check' : st].replace('<svg', '<svg class="si"') + '<span class="sl">' + esc(s.label) + '</span><span class="ss">' + esc(sub) + '</span></li>';
  }).join('');

  // windows grid
  let rawSoFar = 0;
  $('windows').innerHTML = WIN.map((w) => {
    const tkDone = e >= TL.decode + (w.k + 1) * TL.perWin;
    const tkAct = !tkDone && stage === 'transkun' && w.k === tkK;
    const arDone = e >= TL.tkEnd + (w.k + 1) * ARIA_WIN;
    const arAct = !arDone && stage === 'aria' && w.k === arK;
    if (tkDone) rawSoFar += w.notes;
    const cls = tkAct || arAct ? 'active' : tkDone ? 'done' : 'pending';
    const glyph = cls === 'done' ? (arDone ? '✓✓' : '✓') : cls === 'active' ? '◐' : '·';
    let views = '';
    for (let v = 0; v < 4; v++) {
      const f = tkDone ? 1 : tkAct ? clamp(tkF * 4 - v, 0, 1) : 0;
      views += f >= 1 ? '<i class="d"></i>' : '<i>' + (f > 0 ? '<b style="width:' + Math.round(f * 100) + '%"></b>' : '') + '</i>';
    }
    const tk = tkDone ? w.tk.toFixed(2) + ' s' : tkAct ? (tkF * w.tk).toFixed(2) + ' s' : '—';
    const ar = arDone ? '+' + w.aria : arAct ? '…' : '—';
    const nn = tkDone ? '+' + w.notes : tkAct ? '…' : '—';
    return '<div class="win ' + cls + '" title="Window ' + (w.k + 1) + ': ' + w.t0.toFixed(1) + '–' + w.t1.toFixed(1) + ' s">' +
      '<div class="win-h"><span>W' + (w.k + 1) + '</span><span aria-hidden="true">' + glyph + '</span></div>' +
      '<div class="win-t"><span class="wt-l">' + w.t0.toFixed(1) + '–' + w.t1.toFixed(1) + '</span><span class="wt-s">' + Math.round(w.t0) + '–' + Math.round(w.t1) + ' s</span></div>' +
      '<div class="views4" aria-label="views">' + views + '</div>' +
      '<div class="win-r r-tk"><span class="wk">tk</span><span class="wv">' + tk + '</span></div>' +
      '<div class="win-r r-ar"><span class="wk">ar</span><span class="wv">' + ar + '</span></div>' +
      '<div class="win-r r-n"><span class="wk">n</span><span class="wv">' + nn + (tkDone ? '<span class="wk r-p"> p+' + w.ped + '</span>' : '') + '</span></div></div>';
  }).join('');

  // log
  const lines = LOG.filter((l) => l.at <= e + 1e-6);
  const logEl = $('log');
  let live = '';
  if (stage === 'transkun') live = tsAt(e) + '  transkun  window ' + (tkK + 1) + '/' + WIN_N + '  view ' + Math.min(4, Math.floor(tkF * 4) + 1) + '/4 (' + VIEWS[Math.min(3, Math.floor(tkF * 4))] + ')';
  else if (stage === 'aria') live = tsAt(e) + '  aria  window ' + (arK + 1) + '/' + WIN_N + '  decoding tokens';
  else if (stage === 'decode') live = tsAt(e) + '  decode  reading ' + FILE.name;
  else if (stage === 'fuse') live = tsAt(e) + '  fuse  stitching windows';
  logEl.innerHTML = lines.map((l) => logLineHTML(l.text)).join('\n') + (live ? '\n<span class="live">' + logLineHTML(live) + '</span> <span class="cursor"></span>' : '');
  if (logPinned) logEl.scrollTop = logEl.scrollHeight;
  lastLogCount = lines.length;
  $('logMeta').textContent = lines.length + ' lines · midiconv.pipeline';

  // internals
  const viewState = (v) => (stage !== 'transkun' ? (e >= TL.tkEnd ? 'd' : 'p') : tkF * 4 >= v + 1 ? 'd' : tkF * 4 > v ? 'a' : 'p');
  const ariaAdded = WIN.reduce((a, w) => a + (e >= TL.tkEnd + (w.k + 1) * ARIA_WIN ? w.aria : 0), 0);
  $('internals').innerHTML =
    '<div class="k" style="font-size:11px">views K=4 · current window ' + (stage === 'transkun' ? 'W' + (tkK + 1) : '—') + '</div>' +
    '<div class="int-views">' + VIEWS.map((v, i) => { const s = viewState(i); return '<div class="int-view ' + s + '"><b>' + v + '</b><span>' + (s === 'd' ? 'done' : s === 'a' ? Math.round((tkF * 4 - i) * 100) + '%' : 'wait') + '</span></div>'; }).join('') + '</div>' +
    '<dl class="kv tight" style="font-size:11.5px">' +
    '<dt>engine</dt><dd>' + esc(S.opt.engine) + ' <span class="dim">· tk → aria</span></dd>' +
    '<dt class="i-x">window</dt><dd class="i-x">16 s <span class="dim">· hop 5.5 s</span></dd>' +
    '<dt>rescue τ</dt><dd>' + esc(S.opt.eng.ensemble.rescue) + ' <span class="dim">· Balanced</span></dd>' +
    '<dt>raw notes</dt><dd class="num">' + rawSoFar + ' <span class="dim">before stitching</span></dd>' +
    '<dt>aria added</dt><dd class="num">' + (e >= TL.tkEnd ? '+' + ariaAdded : '<span class="dim">runs after Transkun</span>') + '</dd>' +
    '<dt class="i-x">merge fix</dt><dd class="i-x">on <span class="dim">· upstream #42</span></dd></dl>';

  drawWave(p, e, stage, tkK, arK, tkF);
  S.lastProgress = { p, frozen };
}

function drawWave(p, e, stage, tkK, arK, tkF) {
  const cv = $('waveCanvas'), box = cv.parentElement;
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const ganttH = 3 * 7 + 4, axisH = 14, wvH = h - ganttH - axisH - 6;
  const X = (t) => 6 + (t / DUR) * (w - 12);
  const wv = M.waveform, mid = 4 + wvH / 2;
  let mx = 0; for (const v of wv.peak) if (v > mx) mx = v;
  const procT = stage === 'transkun' ? WIN[tkK].t0 + tkF * 16 * 0 : 0;
  // processed region tint (time covered by finished windows)
  const doneTo = stage === 'decode' ? 0 : stage === 'transkun' ? (tkK > 0 ? WIN[tkK - 1].t1 : 0) : DUR;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? wv.rms : wv.peak;
    for (let px = 6; px < w - 6; px++) {
      const t = ((px - 6) / (w - 12)) * DUR;
      const ia = Math.floor(t / wv.hop_seconds), ib = Math.max(ia + 1, Math.floor((t + DUR / (w - 12)) / wv.hop_seconds));
      let m = 0; for (let i = ia; i < Math.min(ib, src.length); i++) if (src[i] > m) m = src[i];
      const hh = Math.max(0.5, (m / mx) * (wvH / 2 - 1));
      const done = t < doneTo;
      ctx.fillStyle = pass ? (done ? 'rgba(69,224,160,0.85)' : 'rgba(150,220,255,0.55)') : (done ? 'rgba(69,224,160,0.28)' : 'rgba(92,200,255,0.2)');
      ctx.fillRect(px, mid - hh, 1, hh * 2);
    }
  }
  void procT;
  // gantt of windows (3 lanes because they overlap)
  const gy = 4 + wvH + 4;
  for (const win of WIN) {
    const lane = win.k % 3, y = gy + lane * 7;
    const x0 = X(win.t0), x1 = X(win.t1);
    const tkDone = e >= TL.decode + (win.k + 1) * TL.perWin;
    const act = (stage === 'transkun' && win.k === tkK) || (stage === 'aria' && win.k === arK);
    ctx.fillStyle = act ? '#f2b84b' : tkDone ? 'rgba(69,224,160,0.7)' : '#2a3440';
    ctx.fillRect(x0, y, x1 - x0 - 1, 4);
    if (act) {
      ctx.fillStyle = 'rgba(242,184,75,0.10)'; ctx.fillRect(x0, 2, x1 - x0, wvH + 4);
      ctx.strokeStyle = 'rgba(242,184,75,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x0) + 0.5, 2.5, Math.round(x1 - x0) - 1, wvH + 3);
    }
  }
  // axis
  ctx.fillStyle = '#85919f'; ctx.font = '10px ' + FONT; ctx.textBaseline = 'alphabetic';
  for (let t = 0; t <= DUR; t += 10) {
    const x = X(t);
    ctx.fillStyle = '#2a3440'; ctx.fillRect(Math.round(x), h - axisH, 1, 3);
    ctx.fillStyle = '#85919f'; ctx.textAlign = t === 0 ? 'left' : t >= DUR ? 'right' : 'center';
    ctx.fillText(fmtTime(t), x, h - 2);
  }
}

/* ================================================================== RESULT */
let roll = null;
function ensureRoll() {
  if (roll) return roll;
  roll = new ConsoleRoll($('roll'), {
    onSeek: (t, n) => { if (n) selectNote(n, false); setTime(t); },
    onHover: (n) => { document.querySelectorAll('#noteBody tr.hov').forEach((r) => r.classList.remove('hov')); if (n) { const r = document.querySelector('#noteBody tr[data-id="' + n.id + '"]'); if (r) r.classList.add('hov'); } },
    onView: (pps) => { $('zoomLabel').textContent = Math.round(pps) + ' px/s'; },
  });
  roll.set({ sustain: SUSTAIN, soft: SOFT, duration: DUR });
  return roll;
}

function applyOutput(notify) {
  const o = S.opt.out;
  let ns = BASE;
  if (o.min_note_ms > 0) ns = ns.filter((n) => (n.e - n.s) * 1000 >= o.min_note_ms);
  if (o.velocity === 'flat') { const vc = velColor(o.flat_velocity); ns = ns.map((n) => Object.assign({}, n, { v: o.flat_velocity, vc })); }
  S.notes = ns;
  if (S.sel && !ns.some((n) => n.id === S.sel)) S.sel = null;
  ensureRoll().set({ notes: ns, pedalMode: o.pedal, showSoft: !!o.soft_pedal, tempo: o.tempo, sel: ns.find((n) => n.id === S.sel) || null });
  renderStats(); renderTable(); renderRun(); renderCharts(); setTime(S.time);
  if (notify) toastOnce('MIDI updated · ' + thin(ns.length) + ' notes · no re-conversion needed', 'ok');
}

function renderStats() {
  const o = S.opt.out, n = S.notes.length, dropped = BASE.length - n;
  const ped = o.pedal === 'cc' ? '<span class="sv">' + SUSTAIN.length + '</span> <span class="sk">pedal presses</span>' : '<span class="sv ch">' + (o.pedal === 'extend' ? 'pedal baked in' : 'no pedal') + '</span>';
  const items = [
    '<span class="sv">' + fmtTime(DUR) + '</span>',
    '<span class="sv">' + thin(n) + '</span> <span class="sk">notes</span>' + (dropped ? ' <span class="sv ch">(' + dropped + ' under ' + o.min_note_ms + ' ms dropped)</span>' : ''),
    ped + (o.soft_pedal ? ' <span class="sk">+ ' + SOFT.length + ' soft</span>' : ''),
    '<span class="sv">' + esc(ST.engine_name) + '</span>',
    '<span class="sk">converted in</span> <span class="sv hl">' + ST.seconds_total + ' s</span> <span class="sk">· ' + (DUR / ST.seconds_total).toFixed(1) + '× realtime</span>',
    '<span class="sk">' + esc(fmtParts.slice(0, 2).join(' · ')) + ' · ' + FILE.size_mb + ' MB</span>',
  ];
  const cls = ['', '', '', ' st-eng', ' st-time', ' st-fmt'];
  $('resStats').innerHTML = items.map((s, i) => '<span class="st-i' + cls[i] + '">' + s + '</span>').join('');
}

function rowHTML(n) {
  const len = S.opt.out.pedal === 'extend' ? n.snd - n.s : n.e - n.s;
  return '<tr data-id="' + n.id + '" class="' + (n.aria ? 'aria' : '') + (n.id === S.sel ? ' is-sel' : '') + '">' +
    '<td class="c-num c-idx">' + n.id + '</td><td class="c-num">' + n.s.toFixed(3) + '</td>' +
    '<td><span class="pn">' + noteName(n.p) + '</span><span class="pm">' + n.p + '</span></td>' +
    '<td class="c-num">' + n.v + '</td><td class="c-num">' + Math.round(len * 1000) + '</td>' +
    '<td class="c-conf"><span class="cbar"><i style="width:' + Math.round(confT(n.c) * 100) + '%;background:' + n.cc + '"></i></span><span style="color:' + n.cc + '">' + n.c.toFixed(4) + '</span></td>' +
    '<td class="c-src">' + (n.aria ? 'aria' : 'tk') + '</td></tr>';
}
function renderTable() {
  const rows = S.notes.slice(0, S.rows);
  $('noteBody').innerHTML = rows.map(rowHTML).join('');
  $('tableMeta').textContent = rows.length + ' of ' + thin(S.notes.length) + ' · by onset';
  const all = rows.length >= S.notes.length;
  $('tableFoot').innerHTML = '<span>' + (all ? 'all ' + thin(S.notes.length) + ' notes shown' : 'first ' + rows.length + ' of ' + thin(S.notes.length) + ' notes') + '</span>' +
    (all ? (S.rows > 40 ? '<button type="button" class="btn ghost" data-rows="40">Show first 40</button>' : '') : '<button type="button" class="btn ghost" data-rows="all">Show all ' + thin(S.notes.length) + '</button>');
  S.rowOn = new Map();
  markRows();
}
function markRows() {
  const t = S.time, body = $('noteBody');
  const pedal = S.opt.out.pedal;
  for (const tr of body.children) {
    const n = S.notes[tr.rowIndex - 1];
    if (!n) continue;
    const end = pedal === 'cc' ? n.snd : pedal === 'extend' ? n.snd : n.e;
    const on = n.s <= t && t < end;
    if (S.rowOn.get(tr) !== on) { tr.classList.toggle('on', on); S.rowOn.set(tr, on); }
  }
}
function selectNote(n, reveal) {
  S.sel = n ? n.id : null;
  if (roll) { roll.sel = n || null; if (n && reveal) roll.reveal(n.s); roll.requestDraw(); }
  document.querySelectorAll('#noteBody tr.is-sel').forEach((r) => r.classList.remove('is-sel'));
  if (!n) return;
  const r = document.querySelector('#noteBody tr[data-id="' + n.id + '"]');
  if (r) {
    r.classList.add('is-sel');
    const wrap = $('tableWrap'), top = r.offsetTop - 24, bot = r.offsetTop + r.offsetHeight;
    if (top < wrap.scrollTop) wrap.scrollTop = top; else if (bot > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bot - wrap.clientHeight;
  }
}

function renderRun() {
  const ns = S.notes;
  const mean = ns.length ? ns.reduce((a, n) => a + n.c, 0) / ns.length : 0;
  const unsure = ns.filter((n) => n.c < 0.6).length;
  const cfg = S.jobCfgObj || { engine: INST.default_engine, opts: freshOptions().eng[INST.default_engine] };
  $('runJob').textContent = JOB.id.slice(0, 8);
  $('runKv').innerHTML =
    '<dt>engine</dt><dd>' + esc(cfg.engine) + ' <span class="dim">· Transkun + Aria</span></dd>' +
    '<dt class="rv">views</dt><dd class="rv">K=' + VIEWS.length + ' <span class="dim">· ' + VIEWS.join(' ') + '</span></dd>' +
    '<dt class="rv">windows</dt><dd class="rv">9 × 16 s <span class="dim">· hop 5.5 s</span></dd>' +
    '<dt>rescue τ</dt><dd>' + esc(cfg.opts.rescue || '—') + ' <span class="ar">· +' + ST.notes_added_by_aria + ' Aria</span></dd>' +
    '<dt>time</dt><dd><span class="ok">' + ST.seconds_total + ' s</span> <span class="dim">· decode ' + ST.seconds_decode.toFixed(2) + ' s</span></dd>' +
    '<dt>conf</dt><dd>μ ' + mean.toFixed(4) + ' <span class="dim">· ' + unsure + ' &lt; 0.6</span></dd>';
}

function setTime(t) {
  S.time = clamp(t, 0, DUR);
  if (roll) roll.setTime(S.time, S.playing);
  const beats = (S.time * S.opt.out.tempo) / 60;
  $('timeLabel').textContent = fmtTime(S.time) + ' / ' + fmtTime(DUR);
  $('timeSub').textContent = S.time.toFixed(3) + ' s · bar ' + (Math.floor(beats / 4) + 1) + '.' + (Math.floor(beats % 4) + 1) + ' @ ' + S.opt.out.tempo + ' BPM';
  markRows();
  moveNpsHead();
}
function setPlaying(on) {
  if (on && S.time >= DUR - 0.05) S.time = 0;
  S.playing = on;
  $('playBtn').classList.toggle('playing', on);
  $('playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
  cancelAnimationFrame(S.prf);
  if (on) {
    let last = performance.now();
    const tick = (now) => {
      if (!S.playing) return;
      S.time = Math.min(DUR, S.time + (now - last) / 1000); last = now;
      setTime(S.time);
      if (S.time >= DUR) { setPlaying(false); return; }
      S.prf = requestAnimationFrame(tick);
    };
    S.prf = requestAnimationFrame(tick);
  } else if (roll) roll.setTime(S.time, false);
  updateChrome();
}
function setListen(v) {
  S.listen = v;
  for (const b of $('listenSeg').children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  if (roll) roll.set({ listen: v });
}
function setColor(v) {
  S.color = v;
  for (const b of $('colorSeg').children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  document.body.classList.toggle('c-vel', v === 'vel');
  document.querySelector('#legend .lg-k').textContent = v === 'vel' ? 'velocity' : 'conf';
  $('lgLo').textContent = v === 'vel' ? '1' : '.95';
  $('lgHi').textContent = v === 'vel' ? '127' : '.999+';
  $('lgRamp').title = v === 'vel' ? 'Velocity 1–127' : 'Log scale · ticks at .99 and .997';
  if (roll) { roll.set({ mode: v }); roll.cv.setAttribute('aria-label', 'Piano roll of the transcription, coloured by ' + (v === 'vel' ? 'velocity' : 'confidence')); }
}
function save() {
  toast('Saved ' + JOB.midi_name, 'ok', { label: 'Show in folder', run: () => toast('Opened Music\\MIDI Converter in Explorer', 'info') });
}

/* ================================================================== OPTIONS INSPECTOR */
function specFor(scope, key) {
  if (scope === 'out') return OUT.find((s) => s.key === key);
  if (scope === 'eng:transkun') return engById('transkun').options.find((s) => s.key === key);
  if (scope === 'engine') return { key: 'engine', label: 'Engine', kind: 'engine', default: INST.default_engine, help: 'Which transcription model runs. Ensemble is the most accurate and the default. Transkun V2 is about 4× faster and almost as accurate. Aria-AMT alone is for comparison.' };
  if (scope === 'instrument') return { key: 'instrument', label: 'Instrument', kind: 'static', default: INST.id, help: INST.description + ' More instruments are on the way: engines are plug-ins and the list is built from them.' };
  return engById(S.opt.engine).options.find((s) => s.key === key);
}
function valFor(scope, key) {
  if (scope === 'out') return S.opt.out[key];
  if (scope === 'eng:transkun') return S.opt.eng.transkun[key];
  if (scope === 'engine') return S.opt.engine;
  if (scope === 'instrument') return INST.id;
  return S.opt.eng[S.opt.engine][key];
}

function optRow(scope, spec, disabled, note) {
  const v = valFor(scope, spec.key);
  const id = 'opt-' + scope.replace(':', '-') + '-' + spec.key;
  const changed = spec.kind !== 'static' && v !== spec.default;
  let ctrl = '';
  if (spec.kind === 'engine') {
    ctrl = '<div class="seg" role="radiogroup" aria-labelledby="' + id + '-l">' + ENGINES.map((e) => '<button type="button" role="radio" data-engine="' + e.id + '" aria-checked="' + (e.id === v) + '" class="' + (e.id === v ? 'on' : '') + '"' + (e.available ? '' : ' disabled') + ' title="' + esc(e.name) + '"' + (e.id === v ? ' id="' + id + '"' : '') + '>' + e.id + '</button>').join('') + '</div>';
  } else if (spec.kind === 'static') {
    ctrl = '<span class="eq">=</span><span id="' + id + '">piano</span><span class="tag">more soon</span>';
  } else if (spec.kind === 'choice') {
    ctrl = '<span class="sel"><select id="' + id + '" data-scope="' + scope + '" data-key="' + spec.key + '"' + (disabled ? ' disabled' : '') + '>' +
      spec.choices.map((c) => '<option value="' + esc(c.value) + '"' + (c.value === v ? ' selected' : '') + '>' + esc(c.value) + ' · ' + esc(c.label) + '</option>').join('') + '</select></span>';
  } else if (spec.kind === 'bool') {
    ctrl = '<button type="button" class="boolf" role="switch" id="' + id + '" data-scope="' + scope + '" data-key="' + spec.key + '" aria-checked="' + !!v + '"' + (disabled ? ' disabled' : '') + '><span class="box" aria-hidden="true"></span>' + (v ? 'true' : 'false') + '</button>';
  } else if (spec.kind === 'number') {
    ctrl = '<span class="numf"><button type="button" data-step="-1" data-scope="' + scope + '" data-key="' + spec.key + '" aria-label="Decrease ' + esc(spec.label) + '"' + (disabled || v <= spec.min ? ' disabled' : '') + '>−</button>' +
      '<input type="number" id="' + id + '" data-scope="' + scope + '" data-key="' + spec.key + '" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + v + '" inputmode="numeric"' + (disabled ? ' disabled' : '') + '>' +
      '<button type="button" data-step="1" data-scope="' + scope + '" data-key="' + spec.key + '" aria-label="Increase ' + esc(spec.label) + '"' + (disabled || v >= spec.max ? ' disabled' : '') + '>+</button></span>' +
      (spec.unit ? '<span class="unit">' + esc(spec.unit) + '</span>' : '') + '<span class="range-hint">' + (note || spec.min + '–' + spec.max) + '</span>';
  }
  return '<div class="opt' + (changed ? ' changed' : '') + (disabled ? ' off' : '') + '" data-scope="' + scope + '" data-key="' + spec.key + '">' +
    '<label class="opt-k" for="' + id + '" id="' + id + '-l"><span class="key">' + spec.key + '</span><span class="lbl">' + esc(spec.label) + '</span></label>' +
    '<div class="opt-c">' + ctrl + '</div>' +
    '<span class="opt-d"' + (changed ? ' title="Changed from default (' + esc(fmtVal(spec.default)) + ')"' : '') + '></span></div>';
}

function renderInspector() {
  const body = $('inspBody');
  const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id || null : null;
  const focusEngine = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.engine : null;
  const scrollTop = body.scrollTop;
  const o = S.opt, eng = engById(o.engine);
  const resultOpen = S.view === 'result';
  let h = '<section class="osec"><div class="osec-h"><h3>Transcription</h3><span class="scope"># used for the next conversion</span></div>';
  h += optRow('instrument', specFor('instrument'));
  h += optRow('engine', specFor('engine'));
  h += '<p class="eng-sum"><b>' + esc(eng.name) + '.</b> ' + esc(eng.summary) + '</p>';
  if (!eng.options.length) h += '<p class="no-opts"># Aria-AMT has no settings to tune.</p>';
  for (const s of eng.options) h += optRow('eng', s);
  if (o.engine !== 'transkun') {
    const extra = engById('transkun').options.filter((s) => !eng.options.some((e2) => e2.key === s.key));
    h += '<button type="button" class="more" id="moreBtn" aria-expanded="' + S.more + '" aria-controls="moreBody">' + ICON.chev + 'more · Transkun-only (' + extra.length + ')<span class="dim">engine = transkun</span></button>';
    if (S.more) h += '<div class="more-body" id="moreBody">' + extra.map((s) => optRow('eng:transkun', s)).join('') + '</div>';
  }
  if (resultOpen && S.jobCfg && cfgKey() !== S.jobCfg) h += '<button type="button" class="btn warn rerun" id="rerunBtn">Re-convert this file with these settings</button>';
  h += '</section>';

  h += '<section class="osec"><div class="osec-h"><h3>MIDI file</h3><span class="live-badge">instant</span></div>';
  h += '<p class="osec-note">' + (resultOpen ? '<b>Output options apply instantly</b> to the open result.' : '<b>Output options apply instantly</b> to an open result.') + '</p>';
  for (const s of OUT) {
    if (s.key === 'flat_velocity' && o.out.velocity !== 'flat') continue;
    h += optRow('out', s, false, s.key === 'flat_velocity' ? 'used while flat' : null);
  }
  h += '</section>';

  const file = resultOpen || S.view === 'progress' ? JOB.filename : 'recording.mp3';
  const out = resultOpen || S.view === 'progress' ? JOB.midi_name : 'recording.mid';
  h += '<section class="osec"><div class="cli-h"><h3>Command line</h3><button type="button" class="btn ghost" id="copyCli">Copy</button></div><div class="cli" id="inspCli">' + cliHTML(file, out) + '</div></section>';
  body.innerHTML = h;
  body.scrollTop = scrollTop;
  if (focusEngine) { const b = body.querySelector('[data-engine="' + focusEngine + '"]'); if (b) b.focus(); }
  else if (focusId) { const el = document.getElementById(focusId); if (el) el.focus(); }
  const n = changedCount();
  $('optsMeta').textContent = n ? n + ' changed from default' : 'all defaults';
}

function setOpt(scope, key, value, quiet) {
  if (scope === 'engine') S.opt.engine = value;
  else if (scope === 'out') S.opt.out[key] = value;
  else if (scope === 'eng:transkun') S.opt.eng.transkun[key] = value;
  else S.opt.eng[S.opt.engine][key] = value;
  renderInspector();
  renderPipeline();
  showDoc(scope, key);
  if (scope === 'out' && S.view === 'result') applyOutput(!quiet);
  if (scope === 'out' && key === 'tempo') setTime(S.time);
}

function showDoc(scope, key) {
  const spec = scope ? specFor(scope, key) : null;
  const d = $('inspDoc');
  d.classList.toggle('empty', !spec);
  if (!spec) {
    d.innerHTML = '<div class="dh">' + ICON.info.replace('<svg', '<svg style="width:14px;height:14px;flex:none;color:var(--cyan)"') + '<span>Focus or hover an option to see what it does.</span></div><div class="dd">Amber keys differ from the default · <kbd>Esc</kbd> closes this panel.</div>';
    return;
  }
  let meta = 'default ' + fmtVal(spec.default);
  if (spec.kind === 'number') meta += ' · range ' + spec.min + '–' + spec.max + (spec.unit ? ' ' + spec.unit : '') + ' · step ' + spec.step;
  if (spec.kind === 'choice') meta += ' · ' + spec.choices.map((c) => c.value).join(' | ');
  if (spec.kind === 'engine') meta += ' · ' + ENGINES.map((e) => e.id).join(' | ');
  d.innerHTML = '<div class="dh"><span class="key">' + esc(spec.key) + '</span><span>' + esc(spec.label) + '</span></div><div>' + esc(spec.help || '') + '</div><div class="dd">' + esc(meta) + '</div>';
}

function setAdv(open) {
  S.adv = open;
  $('inspector').hidden = !open;
  document.body.classList.toggle('adv', open);
  $('btnOptions').setAttribute('aria-expanded', String(open));
  if (open) { renderInspector(); showDoc(null); }
  updateChrome();
}

/* ================================================================== navigation + chrome */
function go(view) {
  if (view !== 'result' && S.playing) setPlaying(false);
  if (view !== 'progress') { S.running = false; cancelAnimationFrame(S.raf); }
  S.view = view;
  document.body.dataset.view = view;
  $('viewHome').hidden = view !== 'home';
  $('viewProgress').hidden = view !== 'progress';
  $('viewResult').hidden = view !== 'result';
  if (view === 'result') {
    ensureRoll();
    applyOutput(false);
    requestAnimationFrame(() => { renderCharts(); if (roll) roll.resize(); });
  }
  if (view === 'home') renderPipeline();
  if (S.adv) renderInspector();
  updateChrome();
}

function updateChrome() {
  const v = S.view;
  const order = ['home', 'progress', 'result'];
  document.querySelectorAll('.crumbs li').forEach((li) => {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(v);
    li.classList.toggle('on', i === cur); li.classList.toggle('done', i < cur);
    if (i === cur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  const busy = v === 'progress';
  const led = $('sbState').querySelector('.led');
  led.className = 'led ' + (busy ? 'busy' : 'ok');
  const pct = S.lastProgress ? Math.round(S.lastProgress.p * 100) : 46;
  $('sbStateText').textContent = v === 'home' ? 'ready' : v === 'progress' ? 'converting · ' + pct + '%' : S.playing ? 'playing' : 'result loaded';
  $('sbInfo').textContent = v === 'home' ? 'queue: 1 running · 1 waiting' : 'job ' + JOB.id + (v === 'result' ? ' · ' + thin(S.notes.length) + ' notes' : '');
  const hints = {
    home: [['Ctrl+O', 'choose file'], ['O', 'options'], ['?', 'all shortcuts']],
    progress: [['Esc', 'cancel'], ['O', 'options'], ['?', 'all shortcuts']],
    result: [['Space', S.playing ? 'pause' : 'play'], ['←/→', 'seek'], ['+/−', 'zoom'], ['C', 'colour'], ['Ctrl+S', 'save'], ['?', 'all shortcuts']],
  }[v].filter((h, i, arr) => window.innerWidth >= 1000 || arr.length <= 3 || i < 2 || i === arr.length - 1 || h[0] === 'Ctrl+S');
  $('sbHints').innerHTML = hints.map(([k, l]) => '<b>' + esc(k) + '</b> ' + esc(l)).join('  ·  ');
  document.querySelectorAll('#switcher button').forEach((b) => b.classList.toggle('on', b.dataset.state === (S.adv && v === 'result' ? 'advanced' : v)));
}

function startConversion() {
  cancelAnimationFrame(S.raf);
  go('progress');
  S.running = true;
  lastLogCount = -1; logPinned = true;
  const t0 = performance.now(), DURMS = 3000;
  const step = (now) => {
    if (!S.running) return;
    const p = Math.min(1, (now - t0) / DURMS);
    renderProgress(p, false);
    $('sbStateText').textContent = 'converting · ' + Math.round(p * 100) + '%';
    if (p < 1) { S.raf = requestAnimationFrame(step); return; }
    S.running = false;
    setTimeout(() => {
      if (S.view !== 'progress') return;
      S.jobCfg = cfgKey(); S.jobCfgObj = { engine: S.opt.engine, opts: Object.assign({}, S.opt.eng[S.opt.engine]) };
      S.time = 0; S.sel = null;
      go('result');
      toast('Converted in ' + ST.seconds_total + ' s · ' + ST.notes + ' notes · ready to save', 'ok');
    }, 280);
  };
  renderProgress(0, false);
  S.raf = requestAnimationFrame(step);
}
function showFrozenProgress() {
  go('progress');
  S.running = false;
  lastLogCount = -1; logPinned = true;
  renderProgress(S.frozenP, true);
  updateChrome();
}
function cancelConversion() {
  S.running = false; cancelAnimationFrame(S.raf);
  go('home');
  toast('Conversion cancelled', 'warn');
}

function setState(name) {
  closeKeys();
  if (name === 'home') { setAdv(false); go('home'); }
  else if (name === 'progress') { setAdv(false); showFrozenProgress(); }
  else if (name === 'result' || name === 'advanced') {
    S.jobCfg = cfgKey(); S.jobCfgObj = { engine: S.opt.engine, opts: Object.assign({}, S.opt.eng[S.opt.engine]) };
    S.time = 12;
    if (name === 'advanced') S.more = true;
    setAdv(name === 'advanced');
    go('result');
  }
}

/* ================================================================== toasts */
function toast(msg, kind, action) {
  kind = kind || 'ok';
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = '<span class="tk">' + (kind === 'ok' ? ICON.check : kind === 'warn' ? ICON.warn : ICON.info).replace('<svg', '<svg style="width:15px;height:15px;display:block"') + '</span><span class="tmsg"></span>';
  t.querySelector('.tmsg').textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ghost'; b.textContent = action.label;
    b.onclick = () => { t.remove(); action.run(); };
    t.append(b);
  }
  const box = $('toasts');
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), action ? 6000 : 3800);
}
let toastTimer = 0;
function clearDedupe() { clearTimeout(toastTimer); document.querySelectorAll('.toast.dedupe').forEach((x) => x.remove()); }
function toastOnce(msg, kind) { clearTimeout(toastTimer); toastTimer = setTimeout(() => { clearDedupe(); toast(msg, kind); $('toasts').lastChild.classList.add('dedupe'); }, 250); }

/* ================================================================== keyboard overlay */
let keysReturn = null;
function openKeys() { keysReturn = document.activeElement; $('keysDialogBody').innerHTML = keysHTML(false); $('keysOverlay').hidden = false; $('closeKeys').focus(); }
function closeKeys() { if ($('keysOverlay').hidden) return; $('keysOverlay').hidden = true; if (keysReturn && keysReturn.focus) keysReturn.focus(); }

/* ================================================================== GPU telemetry (simulated) */
function tickGpu() {
  const busy = S.view === 'progress';
  const last = S.util.length ? S.util[S.util.length - 1] : 0;
  const target = busy ? 91 + Math.random() * 7 : Math.random() < 0.15 ? 3 : 0;
  const v = Math.round(clamp(last + (target - last) * (busy ? 0.6 : 0.5) + (busy ? (Math.random() - 0.5) * 6 : 0), 0, 100));
  S.util.push(v); if (S.util.length > 50) S.util.shift();
  const vram = busy ? 9.7 : 2.4;
  $('gpuChipUtil').textContent = v + '%';
  $('gpuChipVram').textContent = vram + '/' + DEV.vram_gb + ' GB';
  $('gpuChipBar').style.width = R((vram / DEV.vram_gb) * 100) + '%';
  const sfx = busy ? 'P' : 'H';
  const bar = $('utilBar' + sfx), val = $('utilVal' + sfx), sp = $('spark' + sfx);
  if (bar) bar.style.width = v + '%';
  if (val) val.textContent = v + '%';
  if (sp) sp.innerHTML = sparkSVG(S.util);
  if (busy !== S.lastBusy) { $('gpuProg').innerHTML = deviceHTML(true); $('deviceHome').innerHTML = deviceHTML(false); S.lastBusy = busy; }
}

/* ================================================================== events */
function bind() {
  $('drop').addEventListener('click', startConversion);
  $('brandHome').addEventListener('click', (e) => { e.preventDefault(); if (S.view === 'progress' && S.running) return; go('home'); });
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (S.view === 'home') $('drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.remove('over'); if (t === 'drop' && S.view === 'home') startConversion(); }));

  $('btnOptions').addEventListener('click', () => setAdv(!S.adv));
  $('pipeAdvanced').addEventListener('click', () => setAdv(true));
  $('closeOptions').addEventListener('click', () => { setAdv(false); $('btnOptions').focus(); });
  $('btnKeys').addEventListener('click', openKeys);
  $('closeKeys').addEventListener('click', closeKeys);
  $('keysOverlay').addEventListener('click', (e) => { if (e.target === $('keysOverlay')) closeKeys(); });
  $('cancelBtn').addEventListener('click', cancelConversion);
  $('newBtn').addEventListener('click', () => go('home'));
  $('saveBtn').addEventListener('click', save);
  $('playBtn').addEventListener('click', () => setPlaying(!S.playing));
  $('listenSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setListen(b.dataset.v); });
  $('colorSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setColor(b.dataset.v); });
  $('zoomIn').addEventListener('click', () => roll && roll.zoom(1.4));
  $('zoomOut').addEventListener('click', () => roll && roll.zoom(1 / 1.4));
  $('zoomFit').addEventListener('click', () => roll && roll.fit(20));
  $('resetBtn').addEventListener('click', () => {
    S.opt = freshOptions();
    renderInspector(); renderPipeline(); showDoc(null);
    if (S.view === 'result') applyOutput(false);
    setTime(S.time);
    clearDedupe();
    toast('Options reset to defaults' + (S.view === 'result' ? ' · MIDI updated' : ''), 'info');
  });

  // recent table
  $('recentBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const st = tr.dataset.status, act = e.target.closest('[data-act]');
    const r = M.recent.find((x) => x.id === tr.dataset.id);
    if (act && act.dataset.act === 'retry') { startConversion(); return; }
    if (act && act.dataset.act === 'cancel') { toast('Cancelled ' + r.filename, 'warn'); return; }
    if (act && act.dataset.act === 'remove') { toast('Removed ' + r.filename + ' from the queue', 'info'); return; }
    if (st === 'done') { setState('result'); }
    else if (st === 'running') toast(r.filename + ' is converting · ' + Math.round(r.progress * 100) + '% done', 'info');
    else if (st === 'queued') toast(r.filename + ' starts when the current conversion finishes', 'info');
    else if (st === 'error') toast(r.error + ' Try another copy of the file.', 'warn');
  });
  $('recentBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr')) { e.preventDefault(); e.target.click(); } });

  // note table
  $('noteBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const n = S.notes.find((x) => x.id === +tr.dataset.id); if (!n) return;
    selectNote(n, true); setTime(n.s);
  });
  $('tableWrap').setAttribute('tabindex', '0');
  $('tableWrap').setAttribute('aria-label', 'Note table. Up and Down arrows move the selection.');
  $('tableWrap').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); e.stopPropagation();
    const shown = S.notes.slice(0, S.rows);
    let i = shown.findIndex((n) => n.id === S.sel);
    i = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, shown.length - 1);
    selectNote(shown[i], true); setTime(shown[i].s);
  });
  $('tableFoot').addEventListener('click', (e) => { const b = e.target.closest('[data-rows]'); if (!b) return; S.rows = b.dataset.rows === 'all' ? Infinity : 40; renderTable(); });

  // inspector
  const ib = $('inspBody');
  ib.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset.scope) return;
    const spec = specFor(t.dataset.scope, t.dataset.key);
    if (t.tagName === 'SELECT') setOpt(t.dataset.scope, t.dataset.key, t.value);
    else if (t.type === 'number') {
      let v = Number(t.value); if (!isFinite(v)) v = spec.default;
      v = clamp(Math.round(v / spec.step) * spec.step, spec.min, spec.max);
      setOpt(t.dataset.scope, t.dataset.key, v);
    }
  });
  ib.addEventListener('click', (e) => {
    const eb = e.target.closest('[data-engine]');
    if (eb) { setOpt('engine', 'engine', eb.dataset.engine); return; }
    const bf = e.target.closest('.boolf');
    if (bf) { setOpt(bf.dataset.scope, bf.dataset.key, bf.getAttribute('aria-checked') !== 'true'); return; }
    const sb = e.target.closest('[data-step]');
    if (sb) {
      const spec = specFor(sb.dataset.scope, sb.dataset.key), cur = valFor(sb.dataset.scope, sb.dataset.key);
      setOpt(sb.dataset.scope, sb.dataset.key, clamp(cur + spec.step * +sb.dataset.step, spec.min, spec.max));
      const again = ib.querySelector('[data-step="' + sb.dataset.step + '"][data-key="' + sb.dataset.key + '"][data-scope="' + sb.dataset.scope + '"]');
      if (again && !again.disabled) again.focus(); else { const inp = document.getElementById('opt-' + sb.dataset.scope.replace(':', '-') + '-' + sb.dataset.key); if (inp) inp.focus(); }
      return;
    }
    if (e.target.closest('#moreBtn')) { S.more = !S.more; renderInspector(); $('moreBtn').focus(); return; }
    if (e.target.closest('#rerunBtn')) { setAdv(false); startConversion(); return; }
    if (e.target.closest('#copyCli')) {
      const txt = $('inspCli').textContent;
      const done = () => toast('Command copied to the clipboard', 'info');
      try { navigator.clipboard.writeText(txt).then(done, done); } catch (err) { done(); }
    }
  });
  const docFrom = (e) => { const o = e.target.closest('.opt'); if (o) { ib.querySelectorAll('.opt.focus').forEach((x) => x.classList.remove('focus')); o.classList.add('focus'); showDoc(o.dataset.scope, o.dataset.key); } };
  ib.addEventListener('focusin', docFrom);
  ib.addEventListener('mouseover', docFrom);

  // review switcher
  $('switcher').addEventListener('click', (e) => { const b = e.target.closest('[data-state]'); if (b) setState(b.dataset.state); });

  // charts follow their boxes
  const ro = new ResizeObserver(() => { cancelAnimationFrame(S.chRaf); S.chRaf = requestAnimationFrame(renderCharts); });
  ro.observe($('histRow'));
  const ro2 = new ResizeObserver(() => { if (S.view === 'progress' && S.lastProgress) renderProgress(S.lastProgress.p, S.lastProgress.frozen); });
  ro2.observe($('waveCanvas').parentElement);
  const logEl = $('log');
  logEl.addEventListener('scroll', () => { logPinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24; });
  new ResizeObserver(() => { if (logPinned) logEl.scrollTop = logEl.scrollHeight; }).observe(logEl);

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (!$('keysOverlay').hidden) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeKeys(); }
      else if (e.key === 'Tab') { e.preventDefault(); $('closeKeys').focus(); }
      return;
    }
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    const k = e.key;
    if (k === 'Escape') {
      if (S.adv) { e.preventDefault(); setAdv(false); $('btnOptions').focus(); }
      else if (S.view === 'progress') { e.preventDefault(); cancelConversion(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') { e.preventDefault(); if (S.view === 'result') save(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') { e.preventDefault(); if (S.view === 'home') startConversion(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === '?') { e.preventDefault(); openKeys(); return; }
    if (k === 'o' || k === 'O') { e.preventDefault(); setAdv(!S.adv); return; }
    if (S.view !== 'result') return;
    const onButton = e.target.closest && e.target.closest('button, [role="radio"], a');
    switch (k) {
      case ' ': if (onButton && e.target !== $('playBtn')) return; e.preventDefault(); if (e.target !== $('playBtn')) setPlaying(!S.playing); break;
      case 'ArrowLeft': case 'ArrowRight': e.preventDefault(); setTime(S.time + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)); if (roll) roll.reveal(S.time); break;
      case 'Home': e.preventDefault(); setTime(0); if (roll) roll.reveal(0); break;
      case 'End': e.preventDefault(); setTime(DUR); if (roll) roll.reveal(DUR); break;
      case '+': case '=': roll && roll.zoom(1.4); break;
      case '-': case '_': roll && roll.zoom(1 / 1.4); break;
      case '0': roll && roll.fit(20); break;
      case '1': setListen('original'); break;
      case '2': setListen('both'); break;
      case '3': setListen('midi'); break;
      case 'c': case 'C': setColor(S.color === 'conf' ? 'vel' : 'conf'); break;
      case 'n': case 'N': go('home'); break;
      default: break;
    }
  });
}

/* ================================================================== init */
function init() {
  $('appVersion').textContent = M.info.version;
  $('aboutLine').textContent = M.info.app + ' ' + M.info.version;
  $('gpuName').textContent = GPU_SHORT;
  $('gpuChip').title = 'Running on ' + DEV.name + ' · ' + DEV.vram_gb + ' GB';
  $('sbRight').textContent = 'cuda:0 · ' + GPU_SHORT + ' · ' + DEV.vram_gb + ' GB · midiconv ' + M.info.version;
  $('progName').textContent = JOB.filename;
  $('resName').textContent = JOB.filename; $('resName').title = JOB.filename;
  $('metaMeta').textContent = fmtParts.join(' · ');
  $('metaKv').innerHTML =
    '<dt class="m-x">file</dt><dd class="m-x">' + esc(FILE.name) + '</dd>' +
    '<dt class="m-x">size</dt><dd class="m-x">' + FILE.size_mb + ' MB</dd>' +
    '<dt>codec</dt><dd>' + esc((fmtParts[0] || '').toLowerCase()) + ' · ' + esc(fmtParts[1] || '') + '</dd>' +
    '<dt>sample rate</dt><dd>' + (fmtParts[2] === '44.1 kHz' ? '44 100 Hz' : esc(fmtParts[2] || '')) + '</dd>' +
    '<dt>channels</dt><dd>' + (fmtParts[3] === 'stereo' ? '2 · stereo' : esc(fmtParts[3] || '')) + '</dd>' +
    '<dt>duration</dt><dd>' + DUR.toFixed(2) + ' s · ' + thin(Math.round(DUR * 44100)) + ' samples</dd>';
  $('keysHome').innerHTML = keysHTML(true);
  for (let i = 0; i < 40; i++) S.util.push(Math.random() < 0.1 ? 2 : 0);
  $('deviceHome').innerHTML = deviceHTML(false);
  $('gpuProg').innerHTML = deviceHTML(true);
  S.lastBusy = false;
  renderPipeline(); renderBench(); renderRecent(); showDoc(null);
  bind();
  setInterval(tickGpu, 500);
  window.addEventListener('resize', () => updateChrome());

  const state = (Q.get('state') || 'home').toLowerCase();
  if (['home', 'progress', 'result', 'advanced'].includes(state)) setState(state); else setState('home');
  if (state === 'progress') for (let i = 0; i < 30; i++) S.util.push(88 + Math.round(Math.random() * 9));
  if (state === 'progress') { $('gpuProg').innerHTML = deviceHTML(true); }
}

init();
})();
