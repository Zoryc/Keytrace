/* MIDI Converter — 09 Brutalist prototype. Classic script, no network, opens from file://. */
(function () {
'use strict';

var M = window.MOCK;
var Q = new URLSearchParams(location.search);
var $ = function (id) { return document.getElementById(id); };
if (Q.get('clean') === '1') document.body.classList.add('clean');

// ------------------------------------------------------------------ helpers
var NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
function noteName(p) { return NAMES[p % 12] + (Math.floor(p / 12) - 1); }
function isBlack(p) { return !!BLACK[p % 12]; }
function fmtTime(t, tenths) {
  t = Math.max(0, t);
  if (tenths) {
    var d = Math.round(t * 10), m = Math.floor(d / 600), s = (d - m * 600) / 10;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  var w = Math.floor(t);
  return Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0');
}
function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function stripExt(n) { return n.replace(/\.[^.]+$/, ''); }
var ICON = {
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10v8M12 6v1.5"/></svg>'
};

// ------------------------------------------------------------------ settings model
var INST = M.info.instruments[0];
var OUT_SPECS = M.info.output_options;
var S = { engine: INST.default_engine, opts: {}, out: {} };
var JOB_SETTINGS = { engine: M.job.engine, opts: { views: 'channels', rescue: '0.3' } };

function engineById(id) { for (var i = 0; i < INST.engines.length; i++) if (INST.engines[i].id === id) return INST.engines[i]; return INST.engines[0]; }
function specOf(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }
function engVal(engId, key) {
  var spec = specOf(engineById(engId).options, key);
  var v = S.opts[engId] && S.opts[engId][key];
  return v === undefined ? (spec ? spec.default : undefined) : v;
}
function setEngVal(engId, key, v) { (S.opts[engId] = S.opts[engId] || {})[key] = v; }
function outVal(key) { var v = S.out[key]; return v === undefined ? specOf(OUT_SPECS, key).default : v; }
function outAll() { var o = {}; OUT_SPECS.forEach(function (s) { o[s.key] = outVal(s.key); }); return o; }
function choiceLabel(spec, v) { for (var i = 0; i < spec.choices.length; i++) if (String(spec.choices[i].value) === String(v)) return spec.choices[i].label; return String(v); }

var SHORT = {
  views: { none: 'Single', channels: 'Stereo 4×', full: 'Stereo+tone 6×' },
  rescue: { '0.1': 'Generous', '0.3': 'Balanced', '0.5': 'Cautious' },
  velocity_eng: { mode: 'Most likely', mean: 'Average', median: 'Median' },
  pedal: { cc: 'CC64 events', extend: 'Bake in', none: 'Leave out' },
  velocity_out: { played: 'As played', flat: 'Flat' }
};
var ENG_META = {
  ensemble: { short: 'Ensemble', sub: 'Transkun + Aria', line: 'Transkun + Aria · most accurate, 3–4× slower', f1: '98.61', speed: 'About 20–25 s per 2-minute piece on this GPU' },
  transkun: { short: 'Transkun V2', sub: 'Single model', line: 'About 4× faster, almost as accurate', f1: '98.38', speed: 'About 4× faster than Ensemble' },
  aria: { short: 'Aria-AMT', sub: 'Single model', line: 'Aria-AMT alone, for comparison', f1: '97.54', speed: 'Mainly for comparison' }
};
function viewsShort(v) { return { none: 'Single view', channels: 'Stereo views 4×', full: 'Stereo + tone views 6×' }[v] || ''; }
function engineSummary() {
  var e = ENG_META[S.engine];
  var hasViews = !!specOf(engineById(S.engine).options, 'views');
  return { name: e.short, sub: (S.engine === 'ensemble' ? 'Transkun + Aria' : e.sub) + (hasViews ? ' · ' + viewsShort(engVal(S.engine, 'views')) : '') };
}
function outSummary() {
  var o = outAll();
  return 'Output: ' + { cc: 'CC64 pedal', extend: 'pedal baked in', none: 'no pedal' }[o.pedal] +
    (o.soft_pedal ? ' · CC67 soft' : '') +
    ' · ' + (o.velocity === 'flat' ? 'flat velocity ' + o.flat_velocity : 'dynamics as played') +
    (o.min_note_ms ? ' · min ' + o.min_note_ms + ' ms' : '') +
    ' · ' + o.tempo + ' BPM';
}

function outShort() {
  var o = outAll();
  return { cc: 'CC64 pedal', extend: 'pedal baked', none: 'no pedal' }[o.pedal] +
    (o.soft_pedal ? ' · CC67' : '') +
    ' · ' + (o.velocity === 'flat' ? 'flat ' + o.flat_velocity : 'as played') +
    (o.min_note_ms ? ' · min ' + o.min_note_ms + ' ms' : '') +
    ' · ' + o.tempo + ' BPM';
}

// ------------------------------------------------------------------ app state
var app = $('app');
var ui = { view: 'home', adv: false, moreOpen: false, mix: 'both', fileName: M.file.name, playing: false, time: 12 };

// ================================================================== PIANO ROLL (own renderer)
function Roll(host, ovHost, cb) {
  var self = this;
  this.host = host; this.ovHost = ovHost; this.cb = cb || {};
  this.cv = document.createElement('canvas');
  this.tip = el('div', 'tip'); this.tip.hidden = true;
  host.appendChild(this.cv); host.appendChild(this.tip);
  this.oc = document.createElement('canvas');
  ovHost.appendChild(this.oc);
  this.keyW = 64; this.axisH = 28;
  this.pps = 60; this.sx = 0; this.time = 0; this.playing = false;
  this.hover = null; this.mix = 'both';
  this.out = outAll();
  this.notes = []; this.sus = []; this.soft = []; this.dur = 1; this.lo = 48; this.hi = 84; this.maxSpan = 1;
  this.needFit = true; this.userScrolledAt = 0; this._raf = 0;
  this.W = 0; this.H = 0;
  var ro = new ResizeObserver(function () { self.resize(); });
  ro.observe(host); ro.observe(ovHost);
  this.bind();
}
Roll.prototype.setData = function (notes, pedals, duration) {
  this.notes = notes.slice().sort(function (a, b) { return a[0] - b[0]; });
  this.sus = pedals.filter(function (p) { return p[2] === 64; });
  this.soft = pedals.filter(function (p) { return p[2] === 67; });
  var d = duration || 1, span = 0, lo = 127, hi = 0;
  this.notes.forEach(function (n) { var e = n[4] || n[1]; if (e > d) d = e; if (e - n[0] > span) span = e - n[0]; lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); });
  this.dur = d; this.maxSpan = span;
  lo = Math.max(21, lo - 1); hi = Math.min(108, hi + 1);
  this.lo = lo; this.hi = hi;
  this.needFit = true;
  this.resize();
};
Roll.prototype.viewW = function () { return Math.max(1, this.W - this.keyW); };
Roll.prototype.viewSec = function () { return this.viewW() / this.pps; };
Roll.prototype.clampScroll = function (s) { return Math.max(0, Math.min(s, Math.max(0, this.dur - this.viewSec()))); };
Roll.prototype.x = function (t) { return this.keyW + (t - this.sx) * this.pps; };
Roll.prototype.fit = function () {
  if (!this.needFit || this.W <= this.keyW + 10) return;
  this.needFit = false;
  this.pps = Math.max(this.viewW() / this.dur, Math.min(220, this.viewW() / 16));
  this.sx = this.clampScroll(this.sx);
};
Roll.prototype.resize = function () {
  var dpr = window.devicePixelRatio || 1;
  this.W = this.host.clientWidth; this.H = this.host.clientHeight;
  this.tip.hidden = true; this.hover = null;
  if (!this.W || !this.H) return;
  this.fit();
  this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
  this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
  this.OW = this.ovHost.clientWidth; this.OH = this.ovHost.clientHeight;
  this.oc.width = Math.round(this.OW * dpr); this.oc.height = Math.round(this.OH * dpr);
  this.oc.style.width = this.OW + 'px'; this.oc.style.height = this.OH + 'px';
  this.geo();
  this.sx = this.clampScroll(this.sx);
  this.draw();
  if (this.cb.onView) this.cb.onView();
};
Roll.prototype.geo = function () {
  var H = this.H;
  this.axisH = H > 340 ? 28 : 24;
  this.velH = H > 440 ? 40 : (H > 340 ? 32 : 24);
  this.susH = H > 340 ? 16 : 14;
  this.softH = H > 340 ? 10 : 9;
  this.velTop = H - this.velH;
  this.softTop = this.velTop - 1 - this.softH;
  this.susTop = this.softTop - 1 - this.susH;
  this.noteBot = this.susTop - 2;
  this.rh = (this.noteBot - this.axisH) / (this.hi - this.lo + 1);
};
Roll.prototype.rowY = function (p) { return this.axisH + (this.hi - p) * this.rh; };
Roll.prototype.requestDraw = function () {
  var self = this;
  if (this._raf) return;
  this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(); });
};
Roll.prototype.setTime = function (t, playing) {
  this.time = t; this.playing = playing;
  var vs = this.viewSec();
  var recent = performance.now() - this.userScrolledAt < 2500;
  if (playing && !recent && (t > this.sx + vs * 0.85 || t < this.sx)) this.sx = this.clampScroll(t - vs * 0.1);
  this.requestDraw();
};
Roll.prototype.reveal = function (t) {
  var vs = this.viewSec();
  if (t < this.sx || t > this.sx + vs) this.sx = this.clampScroll(t - vs * 0.15);
  this.requestDraw();
};
Roll.prototype.zoom = function (f, anchor) {
  var ax = anchor == null ? this.viewW() / 2 : anchor;
  var ta = this.sx + ax / this.pps;
  var minP = this.viewW() / this.dur;
  this.pps = Math.min(900, Math.max(minP, this.pps * f));
  this.sx = this.clampScroll(ta - ax / this.pps);
  this.requestDraw();
  if (this.cb.onView) this.cb.onView();
};
Roll.prototype.setOut = function (o) { this.out = o; this.requestDraw(); };
Roll.prototype.setMix = function (m) { this.mix = m; this.requestDraw(); };
Roll.prototype.isDropped = function (n) { return this.out.min_note_ms > 0 && (n[1] - n[0]) * 1000 < this.out.min_note_ms; };
Roll.prototype.noteEnd = function (n) { return this.out.pedal === 'extend' ? (n[4] || n[1]) : n[1]; };

Roll.prototype.draw = function () {
  if (!this.W || !this.H) return;
  var ctx = this.cv.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var W = this.W, H = this.H, kw = this.keyW, ax = this.axisH, rh = this.rh;
  var t0 = this.sx, t1 = this.sx + this.viewSec();
  var o = this.out, self = this;
  var FONT = '"Bahnschrift", "Segoe UI", sans-serif';
  var ACC = '#ffe600';
  var dim = this.mix === 'original';
  var noteCol = dim ? '#a8a8a8' : '#000';

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // ---- note field rows
  ctx.save();
  ctx.beginPath(); ctx.rect(kw, ax, W - kw, this.noteBot - ax); ctx.clip();
  for (var p = this.lo; p <= this.hi; p++) {
    var y = this.rowY(p);
    if (isBlack(p)) { ctx.fillStyle = '#f0f0f0'; ctx.fillRect(kw, y, W - kw, rh); }
    if (p % 12 === 0) { ctx.fillStyle = '#000'; ctx.fillRect(kw, Math.round(y + rh) - 1, W - kw, 1); }
    else if (p % 12 === 5 && rh >= 5) { ctx.fillStyle = '#d6d6d6'; ctx.fillRect(kw, Math.round(y + rh) - 1, W - kw, 1); }
  }
  ctx.restore();

  // ---- time grid (through all lanes)
  var STEPS = [[0.1, 0.05], [0.25, 0.05], [0.5, 0.1], [1, 0.25], [2, 0.5], [5, 1], [10, 2], [15, 5], [30, 10], [60, 15]];
  var step = STEPS[STEPS.length - 1];
  for (var si = 0; si < STEPS.length; si++) if (STEPS[si][0] * this.pps >= 84) { step = STEPS[si]; break; }
  var major = step[0], minor = step[1];
  ctx.save();
  ctx.beginPath(); ctx.rect(kw, 0, W - kw, H); ctx.clip();
  for (var k = Math.floor(t0 / minor); k * minor <= t1 + minor; k++) {
    var tt = k * minor, gx = Math.round(this.x(tt));
    var isMajor = Math.abs(tt / major - Math.round(tt / major)) < 1e-6;
    if (isMajor) { ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(gx, ax, 1, H - ax); }
    else { ctx.fillStyle = '#e2e2e2'; ctx.fillRect(gx, ax, 1, this.noteBot - ax); }
  }
  ctx.restore();

  // ---- notes
  ctx.save();
  ctx.beginPath(); ctx.rect(kw, ax, W - kw, this.noteBot - ax); ctx.clip();
  var h = rh > 4 ? Math.max(2, Math.round(rh - 1)) : Math.max(1.5, rh - 0.5);
  var notes = this.notes, i = lowerBound(notes, t0 - this.maxSpan - 0.01);
  var now = this.time;
  for (; i < notes.length; i++) {
    var n = notes[i], s = n[0], e = n[1], pp = n[2], snd = n[4] || e;
    if (s > t1) break;
    if (snd < t0) continue;
    var yy = Math.round(this.rowY(pp) + (rh - h) / 2);
    var x0 = Math.round(this.x(s)), x1 = Math.round(this.x(this.noteEnd(n))), xs = this.x(snd);
    var w = Math.max(2, x1 - x0);
    if (this.isDropped(n)) {
      ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.strokeRect(x0 + 0.5, yy + 0.5, w - 1, h - 1); ctx.setLineDash([]);
      continue;
    }
    // tail held by the pedal
    if (o.pedal === 'cc' && xs > x1 + 2) {
      ctx.fillStyle = dim ? '#b5b5b5' : '#000';
      var ty = Math.round(yy + h / 2) - 1;
      ctx.fillRect(x1, ty, xs - x1, h >= 6 ? 2 : 1);
      ctx.fillRect(Math.round(xs) - 1, yy + 1, 1, Math.max(1, h - 2));
    }
    var active = now >= s && now <= this.noteEnd(n);
    var conf = n[5] == null ? 1 : n[5];
    if (this.hover === n || active) {
      ctx.fillStyle = ACC; ctx.fillRect(x0, yy, w, h);
      ctx.strokeStyle = '#000'; ctx.lineWidth = this.hover === n ? 2 : (h < 6 ? 1 : 1.5);
      ctx.strokeRect(x0 + ctx.lineWidth / 2, yy + ctx.lineWidth / 2 - (h < 4 ? 0.5 : 0), w - ctx.lineWidth, Math.max(1, h - ctx.lineWidth));
    } else if (conf < 0.6) {
      ctx.fillStyle = '#fff'; ctx.fillRect(x0, yy, w, h);
      ctx.strokeStyle = noteCol; ctx.lineWidth = 1.2; ctx.setLineDash([3, 2]);
      ctx.strokeRect(x0 + 0.6, yy + 0.6, w - 1.2, h - 1.2); ctx.setLineDash([]);
    } else {
      ctx.fillStyle = noteCol; ctx.fillRect(x0, yy, w, h);
    }
  }
  ctx.restore();

  // ---- lanes
  ctx.fillStyle = '#000';
  ctx.fillRect(0, this.noteBot, W, 2);
  ctx.fillRect(0, this.softTop - 1, W, 1);
  ctx.fillRect(0, this.velTop - 1, W, 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(kw, this.susTop, W - kw, H - this.susTop); ctx.clip();
  // sustain
  var sy = this.susTop + 3, sh = this.susH - 6;
  this.sus.forEach(function (pd) {
    if (pd[1] < t0 || pd[0] > t1) return;
    var a = Math.round(self.x(pd[0])), b = Math.round(self.x(pd[1]));
    if (o.pedal === 'cc') { ctx.fillStyle = dim ? '#8f8f8f' : '#000'; ctx.fillRect(a, sy, Math.max(2, b - a - 1), sh); }
    else if (o.pedal === 'extend') { ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.strokeRect(a + 0.5, sy + 0.5, Math.max(2, b - a - 2), sh - 1); ctx.setLineDash([]); }
  });
  // soft
  var fy = this.softTop + 2, fh = this.softH - 4;
  if (o.soft_pedal) {
    this.soft.forEach(function (pd) {
      if (pd[1] < t0 || pd[0] > t1) return;
      var a = Math.round(self.x(pd[0])), b = Math.round(self.x(pd[1]));
      ctx.fillStyle = ACC; ctx.fillRect(a, fy, Math.max(2, b - a), fh);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(a + 0.5, fy + 0.5, Math.max(1, b - a - 1), fh - 1);
    });
  }
  // velocity stems
  var vb = H - 3, vh = this.velH - 8;
  ctx.fillStyle = '#ececec';
  ctx.fillRect(kw, Math.round(vb - vh * 64 / 127), W - kw, 1);
  var sw = this.pps > 140 ? 3 : 2;
  i = lowerBound(notes, t0 - 0.05);
  for (; i < notes.length; i++) {
    var nn = notes[i];
    if (nn[0] > t1) break;
    if (this.isDropped(nn)) continue;
    var v = o.velocity === 'flat' ? o.flat_velocity : nn[3];
    var sh2 = Math.max(2, Math.round(vh * v / 127));
    var vx = Math.round(this.x(nn[0]));
    var act = now >= nn[0] && now <= this.noteEnd(nn);
    if (nn === this.hover || act) {
      ctx.fillStyle = '#000'; ctx.fillRect(vx - 1, vb - sh2 - 1, sw + 2, sh2 + 1);
      ctx.fillStyle = ACC; ctx.fillRect(vx, vb - sh2, sw, sh2);
    } else {
      ctx.fillStyle = dim ? '#a8a8a8' : '#000';
      ctx.fillRect(vx, vb - sh2, sw, sh2);
    }
  }
  ctx.restore();
  // lane state captions
  ctx.font = '600 10px ' + FONT;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  function cap(text, y) {
    var tw = ctx.measureText(text).width;
    ctx.fillStyle = '#fff'; ctx.fillRect(kw + 6, y - 7, tw + 10, 14);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(kw + 6.5, y - 6.5, tw + 9, 13);
    ctx.fillStyle = '#000'; ctx.fillText(text, kw + 11, y + 0.5);
  }
  if (o.pedal === 'extend') cap('BAKED INTO NOTE LENGTHS', this.susTop + this.susH / 2);
  if (o.pedal === 'none') cap('NOT WRITTEN TO THE FILE', this.susTop + this.susH / 2);
  if (!o.soft_pedal && this.softH >= 9) cap('OFF', this.softTop + this.softH / 2);
  if (o.velocity === 'flat' && this.velH >= 30) cap('FLAT · ' + o.flat_velocity, this.velTop + 10);

  // ---- playhead cap position (computed first so ruler labels can step aside)
  ctx.font = '700 13px ' + FONT;
  var px = Math.round(this.x(now));
  var showHead = px >= kw - 1 && px <= W + 1;
  var lbl = fmtTime(now, true);
  var lw = ctx.measureText(lbl).width + 14;
  var lx = Math.max(kw, Math.min(W - lw, px - lw / 2));

  // ---- ruler
  ctx.fillStyle = '#fff'; ctx.fillRect(kw, 0, W - kw, ax);
  ctx.save();
  ctx.beginPath(); ctx.rect(kw, 0, W - kw, ax); ctx.clip();
  ctx.fillStyle = '#000';
  for (k = Math.floor(t0 / minor); k * minor <= t1 + minor; k++) {
    tt = k * minor; gx = Math.round(this.x(tt));
    var maj = Math.abs(tt / major - Math.round(tt / major)) < 1e-6;
    if (maj) {
      ctx.fillRect(gx, 0, 2, ax);
      var rl = major < 1 ? fmtTime(tt, true) : fmtTime(tt);
      var r0 = gx + 6, r1 = r0 + ctx.measureText(rl).width;
      var underCap = showHead && r1 > lx - 4 && r0 < lx + lw + 4;
      if (r1 <= W - 4 && !underCap) ctx.fillText(rl, r0, ax / 2 + 1);
    } else {
      ctx.fillRect(gx, ax - 7, 1, 7);
    }
  }
  ctx.restore();
  ctx.fillStyle = '#000'; ctx.fillRect(0, ax - 2, W, 2);

  // ---- playhead
  if (showHead) {
    ctx.fillStyle = '#000';
    ctx.fillRect(px - 1, ax, 2, H - ax);
    ctx.fillStyle = '#000'; ctx.fillRect(lx, 1, lw, ax - 4);
    ctx.fillStyle = ACC; ctx.fillRect(lx + 2, 3, lw - 4, ax - 8);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    ctx.fillText(lbl, lx + lw / 2, ax / 2 - 0.5);
    ctx.textAlign = 'left';
  }

  // ---- keyboard column
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, kw, H);
  var activeP = {};
  var hoverP = this.hover ? this.hover[2] : -1;
  i = lowerBound(notes, now - this.maxSpan - 0.01);
  for (; i < notes.length; i++) { var q = notes[i]; if (q[0] > now) break; if (now <= this.noteEnd(q) && !this.isDropped(q)) activeP[q[2]] = 1; }
  for (p = this.lo; p <= this.hi; p++) {
    y = this.rowY(p);
    if (!isBlack(p) && (activeP[p] || p === hoverP)) { ctx.fillStyle = ACC; ctx.fillRect(0, y, kw - 2, rh); }
  }
  for (p = this.lo; p <= this.hi; p++) {
    y = this.rowY(p);
    if (isBlack(p)) {
      ctx.fillStyle = (activeP[p] || p === hoverP) ? ACC : '#000';
      ctx.fillRect(0, Math.round(y), Math.round(kw * 0.58), Math.max(1, Math.round(rh)));
      if (activeP[p] || p === hoverP) { ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(0.5, Math.round(y) + 0.5, Math.round(kw * 0.58) - 1, Math.max(1, Math.round(rh)) - 1); }
    } else if (!isBlack(p + 1) && p < this.hi) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, Math.round(y) - 0.5, kw - 2, 1);
    }
    if (p % 12 === 0) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, Math.round(y + rh) - 1, kw, 1);
      if (rh >= 3) {
        // sits on the octave line, right of the black-key bars
        ctx.font = '700 ' + Math.min(12, Math.max(9, rh + 3)) + 'px ' + FONT;
        ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(noteName(p), kw - 6, Math.round(y + rh) - 3);
        ctx.textAlign = 'left';
      }
    }
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, kw, ax);
  ctx.fillRect(0, this.noteBot, kw, H - this.noteBot);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, ax - 2, kw, 2);
  ctx.fillRect(0, this.noteBot, W, 2);
  ctx.fillRect(0, this.softTop - 1, kw, 1);
  ctx.fillRect(0, this.velTop - 1, kw, 1);
  ctx.fillRect(kw - 2, 0, 2, H);
  ctx.font = '700 10px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('M:SS', 8, ax / 2);
  ctx.fillText('SUSTAIN', 8, this.susTop + this.susH / 2 + 0.5);
  if (this.softH >= 9) ctx.fillText('SOFT', 8, this.softTop + this.softH / 2 + 0.5);
  ctx.fillText('VELOCITY', 8, this.velTop + Math.min(10, this.velH / 2));

  this.drawOverview();
};

Roll.prototype.drawOverview = function () {
  var W = this.OW, H = this.OH;
  if (!W || !H) return;
  var ctx = this.oc.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var kw = this.keyW;
  var FONT = '"Bahnschrift", "Segoe UI", sans-serif';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  var ow = W - kw, dur = this.dur;
  var ox = function (t) { return kw + t / dur * ow; };
  // viewport
  var a = ox(this.sx), b = ox(Math.min(dur, this.sx + this.viewSec()));
  ctx.fillStyle = '#ffe600'; ctx.fillRect(a, 0, b - a, H);
  // waveform
  var wf = M.waveform, pk = wf.peak, hop = wf.hop_seconds, mid = H / 2;
  ctx.fillStyle = this.mix === 'midi' ? '#a0a0a0' : '#000';
  for (var x = 0; x < ow; x += 2) {
    var ta = x / ow * dur, tb = (x + 2) / ow * dur;
    var ia = Math.floor(ta / hop), ib = Math.max(ia + 1, Math.floor(tb / hop));
    var m = 0;
    for (var j = ia; j < ib && j < pk.length; j++) if (pk[j] > m) m = pk[j];
    var hh = Math.max(1, Math.round(m * (H - 8) / 2));
    ctx.fillRect(kw + x, mid - hh, 1.4, hh * 2);
  }
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
  ctx.strokeRect(Math.round(a) + 1, 1, Math.max(2, Math.round(b - a) - 2), H - 2);
  // playhead
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.round(ox(this.time)) - 1, 0, 2, H);
  // label column
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, kw, H);
  ctx.fillStyle = '#000'; ctx.fillRect(kw - 2, 0, 2, H);
  ctx.font = '700 10px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('AUDIO', 8, H / 2);
};

Roll.prototype.hit = function (x, y) {
  if (x < this.keyW || y < this.axisH || y > this.noteBot) return null;
  var t = this.sx + (x - this.keyW) / this.pps;
  var p = this.hi - Math.floor((y - this.axisH) / this.rh);
  var best = null, notes = this.notes;
  var tol = 3 / this.pps;
  for (var i = lowerBound(notes, t - this.maxSpan - 0.01); i < notes.length; i++) {
    var n = notes[i];
    if (n[0] > t + tol) break;
    if (n[2] === p && t <= Math.max(this.noteEnd(n), n[0] + 2 / this.pps) + tol && !this.isDropped(n)) best = n;
  }
  return best;
};
Roll.prototype.showTip = function (n, x, y) {
  if (!n) { this.tip.hidden = true; return; }
  var dur = n[1] - n[0];
  var conf = n[5] == null ? 1 : n[5];
  var v = this.out.velocity === 'flat' ? this.out.flat_velocity : n[3];
  this.tip.innerHTML = '<b>' + noteName(n[2]) + '</b>' +
    '<span class="k">START </span>' + fmtTime(n[0], true) + '<span class="k">  LENGTH </span>' + (dur < 1 ? Math.round(dur * 1000) + ' ms' : dur.toFixed(2) + ' s') + '<br>' +
    '<span class="k">VELOCITY </span>' + v + '<span class="k">  SURE </span>' + (conf * 100).toFixed(conf < 0.995 ? 0 : 1) + '%' +
    ((n[4] || n[1]) - n[1] > 0.05 && this.out.pedal === 'cc' ? '<br><span class="k">PEDAL HOLDS IT ' + ((n[4] - n[1])).toFixed(2) + ' s LONGER</span>' : '');
  this.tip.hidden = false;
  var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
  var lx = x + 16, ly = y + 16;
  if (lx + tw > this.W - 4) lx = x - tw - 16;
  if (ly + th > this.H - 4) ly = y - th - 16;
  this.tip.style.left = Math.max(this.keyW + 4, lx) + 'px';
  this.tip.style.top = Math.max(4, ly) + 'px';
};
Roll.prototype.bind = function () {
  var self = this, cv = this.cv;
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { self.zoom(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left - self.keyW); return; }
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    self.sx = self.clampScroll(self.sx + (e.deltaMode === 1 ? d * 30 : d) / self.pps);
    self.userScrolledAt = performance.now();
    self.requestDraw();
  }, { passive: false });
  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, sx: self.sx, moved: false };
  });
  cv.addEventListener('pointermove', function (e) {
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag) {
      var dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        self.sx = self.clampScroll(drag.sx - dx / self.pps);
        self.userScrolledAt = performance.now();
        self.tip.hidden = true;
        cv.style.cursor = 'grabbing';
        self.requestDraw();
        return;
      }
    }
    var n = self.hit(x, y);
    if (n !== self.hover) { self.hover = n; self.requestDraw(); }
    self.showTip(n, x, y);
    cv.style.cursor = n ? 'pointer' : (x > self.keyW ? 'crosshair' : 'default');
  });
  function end(e) {
    if (drag && !drag.moved && e.type === 'pointerup') {
      var r = cv.getBoundingClientRect(), x = e.clientX - r.left;
      if (x > self.keyW && self.cb.onSeek) self.cb.onSeek(Math.max(0, Math.min(self.dur, self.sx + (x - self.keyW) / self.pps)));
    }
    drag = null;
    cv.style.cursor = 'crosshair';
  }
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', function () { self.tip.hidden = true; if (self.hover) { self.hover = null; self.requestDraw(); } });

  // overview: click / drag to jump
  var oc = this.oc, odrag = false;
  function ovSeek(e) {
    var r = oc.getBoundingClientRect(), x = e.clientX - r.left - self.keyW;
    var t = Math.max(0, Math.min(self.dur, x / (self.OW - self.keyW) * self.dur));
    self.sx = self.clampScroll(t - self.viewSec() / 2);
    self.userScrolledAt = performance.now();
    if (self.cb.onSeek) self.cb.onSeek(t);
    self.requestDraw();
  }
  oc.addEventListener('pointerdown', function (e) { oc.setPointerCapture(e.pointerId); odrag = true; ovSeek(e); });
  oc.addEventListener('pointermove', function (e) { if (odrag) ovSeek(e); });
  oc.addEventListener('pointerup', function () { odrag = false; });
  oc.addEventListener('pointercancel', function () { odrag = false; });
};
function lowerBound(a, t) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; } return lo; }

// ================================================================== VIEWS
var roll = new Roll($('roll'), $('overview'), {
  onSeek: function (t) { ui.time = t; roll.setTime(t, ui.playing); updateTime(); },
  onView: function () { updateZoomLabel(); }
});
roll.setData(M.notes, M.pedals, M.duration || M.job.stats.duration);
roll.time = ui.time;

function setView(v) {
  ui.view = v;
  app.setAttribute('data-view', v);
  $('viewHome').hidden = v !== 'home';
  $('viewProgress').hidden = v !== 'progress';
  $('viewResult').hidden = v !== 'result';
  if (v !== 'result') stopPlay();
  var order = ['home', 'progress', 'result'];
  var idx = order.indexOf(v);
  document.querySelectorAll('.steps li').forEach(function (li) {
    var i = order.indexOf(li.getAttribute('data-step'));
    li.classList.toggle('on', i === idx);
    li.classList.toggle('done', i < idx);
    if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  $('gpuState').textContent = v === 'progress' ? 'Busy' : 'Ready';
  if (v === 'result') requestAnimationFrame(function () { roll.resize(); });
  $('main').scrollTop = 0;
  renderStatus();
  renderAdv();
  syncSwitcher();
}

function renderStatus() {
  var l = $('statusL'), r = $('statusR');
  var es = engineSummary();
  if (ui.view === 'home') {
    l.innerHTML = '<b>Ready</b> · Drop a file anywhere in this window';
    r.innerHTML = 'Piano · ' + esc(es.name) + ' · <span class="long">' + esc(outSummary().replace('Output: ', 'out: ')) + '</span><span class="short">' + esc(es.sub.split(' · ').slice(1).join(' · ') || es.sub) + '</span>';
  } else if (ui.view === 'progress') {
    l.innerHTML = '<b>Converting</b> · ' + esc($('pPct').textContent) + '% · ' + esc(ui.etaText || '') + ' left';
    r.textContent = 'Piano · ' + es.name + ' · ' + es.sub.split(' · ').slice(1).join(' · ');
  } else {
    l.innerHTML = '<b>Space</b> play · <b>Click</b> seek · <b>Drag / wheel</b> scroll · <b>Ctrl + wheel</b> zoom<span class="wide"> · <b>Hover</b> a note for details</span>';
    r.innerHTML = '<span class="long">' + esc(outSummary()) + '</span><span class="short">MIDI: ' + esc(outShort()) + '</span>';
  }
}

// ------------------------------------------------------------------ home
function renderHome() {
  var es = engineSummary(), meta = ENG_META[S.engine];
  $('homeEngName').textContent = es.name;
  $('homeEngSub').textContent = es.sub;
  $('homeEngF1').textContent = meta.f1;
  $('homeEngSpeed').textContent = meta.speed;
  $('pCfg').textContent = es.name + ' · ' + es.sub + ' · RTX 5070 Ti';
}
function renderRecent() {
  var body = $('recentBody');
  body.innerHTML = '';
  var running = 0;
  M.recent.forEach(function (j, idx) {
    var tr = el('tr', 'row');
    tr.dataset.id = j.id;
    var st = '';
    if (j.status === 'done') st = '<span class="st-pill st-done">Done · Open</span>';
    else if (j.status === 'running') { running++; st = '<span class="st-run"><span class="bar"><i style="width:' + Math.round(j.progress * 100) + '%"></i><b>Converting</b></span><span class="pct">' + Math.round(j.progress * 100) + '%</span></span>'; }
    else if (j.status === 'queued') st = '<span class="st-pill st-queued"><span>Waiting</span></span>';
    else if (j.status === 'error') st = '<span class="st-pill st-error">' + ICON.x.replace('<svg', '<svg style="width:12px;height:12px;stroke:currentColor;stroke-width:3.5;fill:none"') + 'Failed</span>';
    var fileHtml = j.status === 'error'
      ? '<button type="button" class="r-open has-err"><span class="r-file">' + esc(j.filename) + '</span><span class="r-err">' + esc(j.error) + '</span></button>'
      : '<button type="button" class="r-open"><span class="r-file" style="line-height:46px">' + esc(j.filename) + '</span></button>';
    tr.innerHTML =
      '<td class="c-n">' + String(idx + 1).padStart(2, '0') + '</td>' +
      '<td class="c-f">' + fileHtml + '</td>' +
      '<td class="c-l">' + fmtTime(j.duration) + '</td>' +
      '<td class="c-no">' + (j.notes != null ? j.notes.toLocaleString('en-US') : '—') + '</td>' +
      '<td class="c-w">' + esc(j.when) + '</td>' +
      '<td class="c-s">' + st + '</td>';
    var btn = tr.querySelector('.r-open');
    btn.setAttribute('aria-label', j.filename + ', ' + ({ done: 'done, open result', running: Math.round((j.progress || 0) * 100) + '% converted, show progress', queued: 'waiting, show queue', error: 'failed: ' + j.error })[j.status]);
    var open = function () { openRecent(j); };
    tr.addEventListener('click', function (e) { if (e.target.closest('button') !== btn) open(); });
    btn.addEventListener('click', open);
    body.appendChild(tr);
  });
  $('recentCount').textContent = M.recent.length + ' files · ' + running + ' converting · ' + M.recent.filter(function (j) { return j.status === 'queued'; }).length + ' waiting';
}
function openRecent(j) {
  if (j.status === 'done') { ui.fileName = j.id === M.job.id ? M.file.name : j.filename; openResult(); return; }
  if (j.status === 'error') { toast({ title: 'Conversion failed', sub: j.filename + ' — ' + j.error, mark: 'x' }); return; }
  if (j.status === 'running') { startConversion(j.filename, j.progress, j.duration); return; }
  toast({ title: 'Waiting in line', sub: j.filename + ' starts after the current conversion', mark: 'info' });
}

// ------------------------------------------------------------------ progress
var STAGE_RANGES = { decode: [0, 0.06], transkun: [0.06, 0.8], aria: [0.8, 0.94], fuse: [0.94, 1] };
var conv = { raf: 0, t0: 0, from: 0, ms: 3200, name: '' };
var TOTAL_EST = 26; // seconds for this file on the user's GPU

function progressAt(f) {
  var stage = 'fuse';
  ['decode', 'transkun', 'aria', 'fuse'].some(function (id) { if (f < STAGE_RANGES[id][1]) { stage = id; return true; } return false; });
  var wins = M.progress.windows;
  var win = stage === 'decode' ? 0 : stage === 'transkun' ? Math.min(wins, Math.floor((f - 0.06) / 0.74 * wins) + 1) : wins + 1;
  var msg = { decode: 'Reading audio', transkun: 'Transcribing window ' + win + ' of ' + wins, aria: 'Getting a second opinion from Aria-AMT', fuse: 'Merging notes and writing MIDI' }[stage];
  return { f: f, stage: stage, win: win, msg: msg, eta: Math.max(1, Math.round((1 - f) * TOTAL_EST)) };
}
function renderProgress(p) {
  var pct = Math.min(100, Math.round(p.f * 100));
  $('pFile').textContent = ui.fileName;
  $('pPct').textContent = pct;
  $('pFill').style.width = pct + '%';
  // keep "window 5 of 9" on one line so the step never breaks as "...WINDOW 5 / OF 9"
  $('pStep').textContent = p.msg.replace(/window (\d+) of (\d+)/, 'window\u00a0$1\u00a0of\u00a0$2');
  $('pEta').innerHTML = p.f >= 1 ? 'Done' : '~' + p.eta + '<span class="u">s</span>';
  ui.etaText = p.f >= 1 ? 'done' : '~' + p.eta + ' sec';
  var bar = $('pBar');
  bar.setAttribute('aria-valuenow', pct);
  bar.setAttribute('aria-valuetext', pct + '%, ' + p.msg);
  // running tally (matches the log: notes+= per finished window; Aria adds its 9 at the merge)
  var CUM = [0, 118, 214, 345, 449, 512, 557, 590, 611];
  var nw = M.progress.windows, dur = M.job.stats.duration;
  var doneWins = p.stage === 'decode' ? 0 : p.stage === 'transkun' ? Math.max(0, p.win - 1) : nw;
  var found = p.f >= 1 ? M.job.stats.notes : CUM[Math.min(doneWins, CUM.length - 1)];
  $('tyNotes').textContent = found.toLocaleString('en-US');
  $('tyAudio').innerHTML = fmtTime(doneWins / nw * dur) + '<span class="u">/ ' + fmtTime(dur) + '</span>';
  // windows
  var wins = M.progress.windows, ol = $('pWin');
  if (ol.children.length !== wins) { ol.innerHTML = ''; for (var i = 0; i < wins; i++) ol.appendChild(el('li')); }
  for (i = 0; i < wins; i++) {
    var li = ol.children[i];
    li.className = (i + 1 < p.win) ? 'done' : (i + 1 === p.win && p.stage === 'transkun') ? 'active' : (p.win > wins ? 'done' : '');
  }
  $('pWinCount').textContent = Math.min(p.win, wins) + ' / ' + wins;
  // stages
  var order = ['decode', 'transkun', 'aria', 'fuse'];
  var cur = order.indexOf(p.stage);
  var stEl = $('pStages');
  stEl.innerHTML = '';
  M.progress.stages.forEach(function (s, idx) {
    var state = p.f >= 1 ? 'done' : idx < cur ? 'done' : idx === cur ? 'active' : 'pending';
    var label = s.id === 'transkun' ? 'Transkun V2 · ' + ({ none: '1 view', channels: '4 views', full: '6 views' }[engVal('ensemble', 'views')] || '4 views') : s.label;
    var tag = state === 'done' ? '<span class="tag tag-ink">Done</span>' : state === 'active' ? '<span class="tag">Running</span>' : '<span class="tag" style="color:#4a4a4a;border-color:#4a4a4a">Next</span>';
    var li = el('li', state, '<div class="stg-top"><span class="stg-n">' + String(idx + 1).padStart(2, '0') + '</span>' + tag + '</div><div class="stg-name">' + esc(label) + '</div>');
    if (state === 'active') li.setAttribute('aria-current', 'step');
    stEl.appendChild(li);
  });
  // log
  var lines = M.log.slice(0, Math.max(2, Math.min(M.log.length, p.win + 2)));
  var extra = [];
  var ADD = { 6: 63, 7: 45, 8: 33, 9: 21 };
  for (var w = 6; w <= Math.min(p.win, wins); w++) extra.push('14:32:0' + (4 + w - 5) + '.' + (400 + w * 37) + '  transkun  window ' + w + '/9  notes+=' + ADD[w] + (ADD[w] < 100 ? ' ' : '') + '   pedal+=' + (2 + w % 2));
  if (p.stage === 'aria' || p.stage === 'fuse') extra.push('14:32:09.870  aria  second opinion  candidates=31  added=9');
  if (p.stage === 'fuse') extra.push('14:32:12.700  fuse  620 notes  53 pedal  2 soft  → writing MIDI');
  var all = lines.concat(extra).slice(-6);
  $('pLog').innerHTML = all.map(function (s, k) { return k === all.length - 1 ? '<span class="cur">' + esc(s) + '</span>' : esc(s); }).join('\n');
  renderStatus();
}
function fileMeta(name, dur, sizeBytes) {
  if (name === M.file.name) return M.file.size_mb + ' MB · ' + M.file.format;
  var ext = (/\.([^.]+)$/.exec(name) || [, 'audio'])[1].toUpperCase();
  var bits = [];
  if (sizeBytes) bits.push((sizeBytes / 1048576).toFixed(1) + ' MB');
  bits.push(ext);
  if (dur) bits.push(fmtTime(dur) + ' long');
  return bits.join(' · ');
}
function startConversion(name, from, dur, sizeBytes) {
  cancelConversion(true);
  $('toast').hidden = true;
  ui.fileName = name || M.file.name;
  $('pMeta').textContent = fileMeta(ui.fileName, dur, sizeBytes);
  conv.from = from || 0;
  conv.ms = 3200 * (1 - conv.from);
  conv.t0 = performance.now();
  setView('progress');
  renderProgress(progressAt(conv.from));
  var step = function (now) {
    var f = conv.from + (1 - conv.from) * Math.min(1, (now - conv.t0) / conv.ms);
    renderProgress(progressAt(f));
    if (f >= 1) { conv.raf = 0; setTimeout(function () { if (ui.view === 'progress') openResult(true); }, 260); return; }
    conv.raf = requestAnimationFrame(step);
  };
  conv.raf = requestAnimationFrame(step);
}
function cancelConversion(silent) {
  if (conv.raf) cancelAnimationFrame(conv.raf);
  conv.raf = 0;
  if (!silent) { setView('home'); toast({ title: 'Conversion cancelled', sub: ui.fileName, mark: 'x' }); }
}
function showStaticProgress() {
  ui.fileName = M.file.name;
  $('pMeta').textContent = fileMeta(M.file.name);
  setView('progress');
  var p = progressAt(M.progress.progress);
  p.msg = M.progress.message; p.eta = M.progress.eta_seconds; p.win = M.progress.window;
  renderProgress(p);
}

// ------------------------------------------------------------------ result
function openResult(fresh) {
  setView('result');
  $('rTitle').textContent = stripExt(M.job.filename);
  $('rTitle').title = M.job.filename;
  $('rOut').textContent = '→ ' + M.job.midi_name + '   ·   from ' + M.file.format;
  ui.time = fresh ? 0 : ui.time;
  roll.time = ui.time;
  roll.needFit = true;
  roll.sx = 0;
  roll.resize();
  updateTime();
  renderStats();
  if (fresh) toast({ title: 'Converted in ' + M.job.stats.seconds_total + ' s', sub: M.job.stats.notes + ' notes · ' + M.job.stats.pedals + ' pedal presses · ready to save', mark: 'check' });
}
function renderStats(flashKey) {
  var st = M.job.stats, o = outAll();
  var kept = M.notes.filter(function (n) { return !(o.min_note_ms > 0 && (n[1] - n[0]) * 1000 < o.min_note_ms); }).length;
  $('stLen').textContent = fmtTime(st.duration);
  $('stNotes').textContent = kept.toLocaleString('en-US');
  $('stNotesSub').textContent = kept < M.notes.length ? (M.notes.length - kept) + ' shorter than ' + o.min_note_ms + ' ms dropped' : st.notes_added_by_aria + ' added by Aria';
  $('stPedal').textContent = o.pedal === 'cc' ? st.pedals : o.pedal === 'extend' ? 'Baked' : 'Off';
  $('stPedalSub').textContent = (o.pedal === 'extend' ? st.pedals + ' presses in note lengths' : o.pedal === 'none' ? 'Not in the file' : 'Sustain, CC64') + (o.soft_pedal ? ' · + ' + st.soft_pedals + ' soft' : '');
  $('stEng').textContent = ENG_META[M.job.engine].short;
  $('stTime').innerHTML = st.seconds_total + '<span class="u">s</span>';
  $('stConf').innerHTML = (st.mean_confidence * 100).toFixed(1) + '<span class="u">%</span>';
  $('stConfSub').textContent = st.uncertain_notes ? st.uncertain_notes + ' unsure notes' : 'No unsure notes';
  if (flashKey) {
    var cell = { min_note_ms: 'stNotes', pedal: 'stPedal', soft_pedal: 'stPedal' }[flashKey];
    if (cell) { var c = $(cell).parentNode; c.classList.add('flash'); setTimeout(function () { c.classList.remove('flash'); }, 650); }
  }
}
function updateTime() {
  $('tNow').textContent = fmtTime(ui.time);
  $('tDur').textContent = fmtTime(roll.dur > 0 ? M.job.stats.duration : 0);
}
function updateZoomLabel() {
  var vs = roll.viewSec();
  $('zoomLbl').textContent = (vs >= 10 ? Math.round(vs) : vs.toFixed(1)) + ' s';
  $('zoomLbl').title = 'Visible: ' + fmtTime(roll.sx) + '–' + fmtTime(Math.min(roll.dur, roll.sx + vs));
}

// playback (visual only)
var play = { raf: 0, last: 0 };
function startPlay() {
  if (ui.time >= roll.dur - 0.05) ui.time = 0;
  ui.playing = true;
  $('playBtn').classList.add('playing');
  $('playBtn').setAttribute('aria-label', 'Pause');
  roll.reveal(ui.time);
  play.last = performance.now();
  var tick = function (now) {
    if (!ui.playing) return;
    ui.time += (now - play.last) / 1000; play.last = now;
    if (ui.time >= roll.dur) { ui.time = roll.dur; stopPlay(); }
    roll.setTime(ui.time, ui.playing);
    updateTime();
    if (ui.playing) play.raf = requestAnimationFrame(tick);
  };
  play.raf = requestAnimationFrame(tick);
}
function stopPlay() {
  ui.playing = false;
  if (play.raf) cancelAnimationFrame(play.raf);
  play.raf = 0;
  $('playBtn').classList.remove('playing');
  $('playBtn').setAttribute('aria-label', 'Play');
  roll.setTime(ui.time, false);
}
function togglePlay() { if (ui.playing) stopPlay(); else startPlay(); }

// ================================================================== ADVANCED PANEL
function segControl(spec, value, shortMap, onChange, labelId) {
  var seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', labelId);
  spec.choices.forEach(function (c) {
    var b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    var on = String(c.value) === String(value);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    b.textContent = (shortMap && shortMap[c.value]) || c.label;
    b.title = c.label + (String(c.value) === String(spec.default) ? ' (default)' : '');
    b.dataset.focus = spec.key + ':' + c.value;
    b.addEventListener('click', function () { onChange(c.value); });
    seg.appendChild(b);
  });
  seg.addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
    e.preventDefault();
    var idx = spec.choices.findIndex(function (c) { return String(c.value) === String(value); });
    var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
    var next = spec.choices[(idx + d + spec.choices.length) % spec.choices.length];
    pendingFocus = spec.key + ':' + next.value;
    onChange(next.value);
  });
  return seg;
}
function toggleControl(spec, value, onChange, labelId) {
  var b = el('button', 'toggle', '<span class="t-on">On</span><span class="t-off">Off</span>');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', value ? 'true' : 'false');
  b.setAttribute('aria-labelledby', labelId);
  b.dataset.focus = spec.key + ':toggle';
  b.addEventListener('click', function () { pendingFocus = spec.key + ':toggle'; onChange(!value); });
  return b;
}
function stepperControl(spec, value, onChange, labelId, disabled) {
  var w = el('div', 'stepper' + (disabled ? ' off' : ''));
  var minus = el('button', '', ICON.minus), plus = el('button', '', ICON.plus);
  minus.type = plus.type = 'button';
  minus.setAttribute('aria-label', 'Decrease ' + spec.label);
  plus.setAttribute('aria-label', 'Increase ' + spec.label);
  var inp = el('input');
  inp.type = 'number'; inp.min = spec.min; inp.max = spec.max; inp.step = spec.step; inp.value = value;
  inp.setAttribute('aria-labelledby', labelId);
  inp.dataset.focus = spec.key + ':input';
  minus.dataset.focus = spec.key + ':minus';
  plus.dataset.focus = spec.key + ':plus';
  [minus, plus, inp].forEach(function (x) { x.disabled = !!disabled; });
  function clamp(v) { v = Number(v); if (!isFinite(v)) v = spec.default; return Math.max(spec.min, Math.min(spec.max, Math.round(v / spec.step) * spec.step)); }
  minus.addEventListener('click', function () { pendingFocus = spec.key + ':minus'; onChange(clamp(value - spec.step)); });
  plus.addEventListener('click', function () { pendingFocus = spec.key + ':plus'; onChange(clamp(value + spec.step)); });
  inp.addEventListener('change', function () { pendingFocus = spec.key + ':input'; onChange(clamp(inp.value)); });
  minus.disabled = minus.disabled || value <= spec.min;
  plus.disabled = plus.disabled || value >= spec.max;
  w.appendChild(minus); w.appendChild(inp);
  if (spec.unit) w.appendChild(el('span', 'unit', esc(spec.unit)));
  w.appendChild(plus);
  return w;
}
var optSeq = 0;
function optBlock(spec, value, onChange, opts) {
  opts = opts || {};
  var id = 'ol' + (++optSeq);
  var changed = String(value) !== String(spec.default);
  var box = el('div', 'opt' + (changed ? ' changed' : '') + (opts.dep ? ' dep' : '') + (opts.disabled ? ' disabled' : ''));
  box.dataset.key = spec.key;
  var row = el('div', 'opt-row');
  var lab = el('span', 'opt-lbl', esc(spec.label));
  lab.id = id;
  row.appendChild(lab);
  if (spec.kind === 'choice') {
    var ov = el('span', 'opt-val', esc(choiceLabel(spec, value)));
    ov.title = choiceLabel(spec, value) + (changed ? ' (changed)' : ' (default)');
    row.appendChild(ov);
    box.appendChild(row);
    box.appendChild(segControl(spec, value, opts.short, onChange, id));
  } else if (spec.kind === 'bool') {
    row.appendChild(toggleControl(spec, value, onChange, id));
    box.appendChild(row);
  } else {
    lab.classList.add('opt-lbl-wrap');
    row.appendChild(stepperControl(spec, value, onChange, id, opts.disabled));
    box.appendChild(row);
  }
  var help = opts.help || spec.help;
  if (help) box.appendChild(el('p', 'opt-help', esc(help)));
  return box;
}
function secHead(letter, title, note, live) {
  var h = el('div', 'sec-head' + (live ? ' live' : ''));
  h.innerHTML = '<div class="lbl cell-lbl"><span><b>' + letter + '</b>&nbsp; ' + esc(title) + '</span>' + (live ? '<span class="tag tag-acc">Applies instantly</span>' : '<span class="tag">Next conversion</span>') + '</div>' +
    '<p class="sec-note">' + esc(note) + '</p>';
  return h;
}
var pendingFocus = null;
function renderAdv() {
  var panel = $('adv');
  panel.hidden = !ui.adv;
  $('advToggle').setAttribute('aria-expanded', ui.adv ? 'true' : 'false');
  if (!ui.adv) return;
  var focusKey = pendingFocus || (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focus);
  pendingFocus = null;
  var body = $('advBody');
  var scroll = body.scrollTop;
  body.innerHTML = '';
  optSeq = 0;

  // ---- column A: transcription
  var A = el('div', 'adv-col');
  A.appendChild(secHead('A', 'Transcription', 'Used for the next conversion of a file.'));
  var engBox = el('div', 'opt');
  engBox.innerHTML = '<div class="opt-row"><span class="opt-lbl" id="engLbl">Engine</span><span class="opt-val">' + (S.engine === INST.default_engine ? 'Default' : esc(engineById(S.engine).name)) + '</span></div>';
  if (S.engine !== INST.default_engine) engBox.classList.add('changed');
  var list = el('div', 'eng-list');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-labelledby', 'engLbl');
  INST.engines.forEach(function (e) {
    var on = e.id === S.engine;
    var b = el('button', 'eng-opt',
      '<span class="box" aria-hidden="true"></span><b>' + esc(e.name.replace(/\s*\(.*\)/, '')) + '</b>' +
      (e.id === INST.default_engine ? '<span class="tag">Default</span>' : '<span></span>') +
      '<small>' + esc(ENG_META[e.id].line) + '</small>');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    b.title = e.name + ': ' + e.summary;
    b.setAttribute('aria-label', e.name + '. ' + ENG_META[e.id].line + (e.id === INST.default_engine ? '. Default.' : '.'));
    b.dataset.focus = 'engine:' + e.id;
    b.addEventListener('click', function () { pendingFocus = 'engine:' + e.id; S.engine = e.id; settingsChanged('engine'); });
    list.appendChild(b);
  });
  list.addEventListener('keydown', function (ev) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(ev.key) < 0) return;
    ev.preventDefault();
    var ids = INST.engines.map(function (e) { return e.id; });
    var d = (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') ? 1 : -1;
    S.engine = ids[(ids.indexOf(S.engine) + d + ids.length) % ids.length];
    pendingFocus = 'engine:' + S.engine;
    settingsChanged('engine');
  });
  engBox.appendChild(list);
  A.appendChild(engBox);

  var eng = engineById(S.engine);
  if (!eng.options.length) A.appendChild(el('p', 'empty-note', esc(eng.name) + ' has no settings of its own.'));
  eng.options.forEach(function (spec) {
    var shortMap = spec.key === 'velocity' ? SHORT.velocity_eng : SHORT[spec.key];
    A.appendChild(optBlock(spec, engVal(S.engine, spec.key), function (v) { setEngVal(S.engine, spec.key, v); settingsChanged(spec.key); }, { short: shortMap }));
  });
  if (S.engine !== 'transkun') {
    var tk = engineById('transkun');
    var shown = eng.options.map(function (o) { return o.key; });
    var extra = tk.options.filter(function (o) { return shown.indexOf(o.key) < 0 || S.engine === 'aria'; }).filter(function (o) { return o.key !== 'views' || S.engine === 'aria'; });
    var more = el('button', 'more-btn', '<span>More: Transkun V2 alone<small>' + extra.length + ' settings</small></span>' + ICON.chev);
    more.type = 'button';
    more.setAttribute('aria-expanded', ui.moreOpen ? 'true' : 'false');
    more.setAttribute('aria-controls', 'moreBox');
    more.dataset.focus = 'more';
    more.addEventListener('click', function () { ui.moreOpen = !ui.moreOpen; pendingFocus = 'more'; renderAdv(); });
    A.appendChild(more);
    if (ui.moreOpen) {
      var mb = el('div');
      mb.id = 'moreBox';
      extra.forEach(function (spec) {
        var shortMap = spec.key === 'velocity' ? SHORT.velocity_eng : SHORT[spec.key];
        mb.appendChild(optBlock(spec, engVal('transkun', spec.key), function (v) { setEngVal('transkun', spec.key, v); settingsChanged(spec.key); }, { short: shortMap }));
      });
      A.appendChild(mb);
    }
  }
  if (ui.view === 'result' && engineDiffers()) {
    var rc = el('button', 'reconvert', '<span>Re-convert this file with these settings</span>' + ICON.arrow);
    rc.type = 'button';
    rc.addEventListener('click', function () { ui.adv = false; startConversion(M.file.name, 0); });
    A.appendChild(rc);
  }

  // ---- column B: MIDI file
  var B = el('div', 'adv-col');
  var live = ui.view === 'result';
  B.appendChild(secHead('B', 'MIDI file', live ? 'Updates the open result right away. No re-conversion.' : 'Applied when the MIDI file is written.', live));
  var o = outAll();
  OUT_SPECS.forEach(function (spec) {
    var opts = {};
    if (spec.key === 'pedal') opts.short = SHORT.pedal;
    if (spec.key === 'velocity') opts.short = SHORT.velocity_out;
    if (spec.key === 'flat_velocity') { opts.dep = true; opts.disabled = o.velocity !== 'flat'; if (opts.disabled) opts.help = 'Used when Dynamics is Flat.'; }
    if (spec.key === 'min_note_ms' && o.min_note_ms > 0) {
      var dropped = M.notes.filter(function (n) { return (n[1] - n[0]) * 1000 < o.min_note_ms; }).length;
      opts.help = spec.help + ' Drops ' + dropped + ' of ' + M.notes.length + ' notes here.';
    }
    B.appendChild(optBlock(spec, o[spec.key], function (v) { S.out[spec.key] = v; settingsChanged(spec.key, true); }, opts));
  });

  B.appendChild(el('p', 'about mono', 'MIDI Converter ' + M.info.version + ' · ' + esc(M.info.device.name) + ' · ' + M.info.device.vram_gb + ' GB'));
  body.appendChild(A);
  body.appendChild(B);
  body.scrollTop = scroll;
  if (focusKey) {
    var f = body.querySelector('[data-focus="' + focusKey + '"]');
    if (f && !f.disabled) f.focus();
  }
}
function engineDiffers() {
  if (S.engine !== JOB_SETTINGS.engine) return true;
  return engVal('ensemble', 'views') !== JOB_SETTINGS.opts.views || String(engVal('ensemble', 'rescue')) !== JOB_SETTINGS.opts.rescue;
}
var outToastTimer = 0;
function settingsChanged(key, isOutput) {
  renderAdv();
  renderHome();
  renderStatus();
  if (isOutput) {
    roll.setOut(outAll());
    if (ui.view === 'result') {
      renderStats(key);
      clearTimeout(outToastTimer);
      outToastTimer = setTimeout(function () { toast({ title: 'MIDI updated', sub: M.job.midi_name + ' · ' + outSummary().replace('Output: ', ''), mark: 'check' }); }, 450);
    }
  }
}
function resetDefaults() {
  S.engine = INST.default_engine; S.opts = {}; S.out = {};
  pendingFocus = null;
  renderAdv(); renderHome(); renderStatus();
  roll.setOut(outAll());
  if (ui.view === 'result') renderStats();
  toast({ title: 'Options reset', sub: 'Ensemble · Stereo views 4× · CC64 pedal · as played · 120 BPM', mark: 'check' });
  $('resetBtn').focus();
}
function setAdv(open) {
  ui.adv = open;
  renderAdv();
  if (ui.view === 'result') requestAnimationFrame(function () { roll.resize(); });
  if (open) { var first = $('advBody').querySelector('[aria-checked="true"]'); if (first && !CLEAN_FOCUS) first.focus(); }
  else $('advToggle').focus();
  syncSwitcher();
}
var CLEAN_FOCUS = false;

// ================================================================== TOAST
var toastTimer = 0;
function toast(t) {
  var box = $('toast');
  var mark = { check: ICON.check, x: ICON.x, info: ICON.info }[t.mark || 'check'];
  box.innerHTML = '<span class="t-mark">' + mark + '</span><div class="t-body"><div class="t-title">' + esc(t.title) + '</div>' + (t.sub ? '<div class="t-sub">' + esc(t.sub) + '</div>' : '') + '</div>';
  if (t.action) {
    var a = el('button', 't-act', esc(t.action.label));
    a.type = 'button';
    a.addEventListener('click', function () { box.hidden = true; t.action.run(); });
    box.appendChild(a);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { box.hidden = true; }, t.action ? 6000 : 3000);
}

// ================================================================== WIRING
$('drop').addEventListener('click', function () { startConversion(M.file.name, 0); });
$('changeEngine').addEventListener('click', function () { setAdv(true); });
$('advToggle').addEventListener('click', function () { setAdv(!ui.adv); });
$('advClose').addEventListener('click', function () { setAdv(false); });
$('resetBtn').addEventListener('click', resetDefaults);
$('brand').addEventListener('click', function (e) { e.preventDefault(); cancelConversion(true); setView('home'); });
$('cancelBtn').addEventListener('click', function () { cancelConversion(false); });
$('newBtn').addEventListener('click', function () { setView('home'); $('drop').focus(); });
$('saveBtn').addEventListener('click', function () {
  toast({ title: 'Saved ' + M.job.midi_name, sub: 'Music\\MIDI Converter\\' + M.job.midi_name + ' · ' + outSummary().replace('Output: ', ''), mark: 'check', action: { label: 'Show in folder', run: function () { toast({ title: 'Opened in File Explorer', sub: 'Music\\MIDI Converter', mark: 'check' }); } } });
});
$('playBtn').addEventListener('click', togglePlay);
$('zoomIn').addEventListener('click', function () { roll.zoom(1.5); });
$('zoomOut').addEventListener('click', function () { roll.zoom(1 / 1.5); });
document.querySelectorAll('#listenSeg button').forEach(function (b) {
  b.addEventListener('click', function () { setMix(b.dataset.mix); });
});
$('listenSeg').addEventListener('keydown', function (e) {
  if (['ArrowLeft', 'ArrowRight'].indexOf(e.key) < 0) return;
  e.preventDefault();
  var order = ['original', 'both', 'midi'];
  var n = order[(order.indexOf(ui.mix) + (e.key === 'ArrowRight' ? 1 : -1) + 3) % 3];
  setMix(n);
  document.querySelector('#listenSeg [data-mix="' + n + '"]').focus();
});
function setMix(m) {
  ui.mix = m;
  document.querySelectorAll('#listenSeg button').forEach(function (b) {
    var on = b.dataset.mix === m;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  roll.setMix(m);
}
setMix('both');
$('instPiano').addEventListener('click', function () { toast({ title: 'Piano selected', sub: 'More instruments are coming soon', mark: 'info' }); });

$('roll').addEventListener('keydown', function (e) {
  var d = e.shiftKey ? 5 : 1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    ui.time = Math.max(0, Math.min(roll.dur, ui.time + (e.key === 'ArrowRight' ? d : -d)));
    roll.setTime(ui.time, ui.playing); roll.reveal(ui.time); updateTime();
  } else if (e.key === '+' || e.key === '=') { roll.zoom(1.5); }
  else if (e.key === '-') { roll.zoom(1 / 1.5); }
  else if (e.key === 'Home') { ui.time = 0; roll.setTime(0, ui.playing); roll.reveal(0); updateTime(); }
});
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && ui.adv) { setAdv(false); return; }
  var tag = (e.target.tagName || '').toLowerCase();
  var typing = tag === 'input' || tag === 'textarea';
  var onButton = tag === 'button';
  if (e.code === 'Space' && ui.view === 'result' && !typing && !onButton) { e.preventDefault(); togglePlay(); }
});

// drag & drop a real file anywhere
var dragDepth = 0;
window.addEventListener('dragenter', function (e) { e.preventDefault(); if (ui.view === 'progress') return; dragDepth++; $('dragover').hidden = false; });
window.addEventListener('dragover', function (e) { e.preventDefault(); });
window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dragover').hidden = true; });
window.addEventListener('drop', function (e) {
  e.preventDefault(); dragDepth = 0; $('dragover').hidden = true;
  if (ui.view === 'progress') return;
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  ui.adv = false; renderAdv();
  startConversion(f ? f.name : M.file.name, 0, 0, f ? f.size : 0);
});

// state switcher
function syncSwitcher() {
  var cur = ui.view === 'result' && ui.adv ? 'advanced' : ui.view;
  document.querySelectorAll('#switcher button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === cur); });
}
document.querySelectorAll('#switcher button').forEach(function (b) {
  b.addEventListener('click', function () { goState(b.dataset.go); });
});

function goState(s) {
  cancelConversion(true);
  ui.adv = false;
  ui.moreOpen = false;
  if (s === 'progress') showStaticProgress();
  else if (s === 'result') { ui.time = 12; openResult(false); }
  else if (s === 'advanced') { ui.time = 12; ui.adv = true; ui.moreOpen = true; openResult(false); }
  else setView('home');
  renderAdv();
  syncSwitcher();
}

// ================================================================== INIT
renderHome();
renderRecent();
var initial = Q.get('state') || 'home';
if (['home', 'progress', 'result', 'advanced'].indexOf(initial) < 0) initial = 'home';
CLEAN_FOCUS = true;
goState(initial);
CLEAN_FOCUS = false;
if (initial === 'advanced' || initial === 'result') requestAnimationFrame(function () { roll.resize(); });
})();
