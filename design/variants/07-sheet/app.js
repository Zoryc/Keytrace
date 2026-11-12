/* MIDI Converter — "Sheet & Ink" prototype. Classic script, no network, no backend. */
(function () {
  'use strict';

  var M = window.MOCK;
  var fmtTime = window.MCRoll.fmtTime;
  var noteName = window.MCRoll.noteName;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  if (params.get('clean') === '1') document.documentElement.classList.add('is-clean');

  var INST = M.info.instruments[0];
  var ENGINES = INST.engines;
  var OUT = M.info.output_options;
  var engineById = function (id) { return ENGINES.find(function (e) { return e.id === id; }); };
  function specOf(key) {
    for (var i = 0; i < ENGINES.length; i++) {
      var o = ENGINES[i].options.find(function (x) { return x.key === key; });
      if (o) return o;
    }
    return null;
  }
  var ENG_DEFAULTS = { engine: INST.default_engine };
  ENGINES.forEach(function (e) { e.options.forEach(function (o) { if (!(o.key in ENG_DEFAULTS)) ENG_DEFAULTS[o.key] = o.default; }); });
  var OUT_DEFAULTS = {};
  OUT.forEach(function (o) { OUT_DEFAULTS[o.key] = o.default; });

  // Plain-language engine notes (README wording).
  var ENGINE_NOTES = {
    ensemble: 'Most accurate; about 3–4× slower.',
    transkun: 'About 4× faster, almost as accurate.',
    aria: 'On its own, for comparison.'
  };
  var HELP = {
    views: 'Heard several ways, then averaged.',
    rescue: 'Lower adds more of the notes only Aria heard.',
    velocity: 'How loudness is read from the model.',
    merge_fix: 'Fixes bug #42 with long pedal presses.',
    pedal: 'Bake it in for apps that ignore the pedal.',
    velocity_out: 'Keep each note’s loudness, or give every note the same one.',
    min_note_ms: 'Drops very short notes. 0 keeps everything.',
    tempo: 'Only changes how bars line up in a DAW or notation app.'
  };
  var ENGINE_TIME = { ensemble: 11.6, transkun: 3.1, aria: 7.8 };

  var state = {
    view: 'home',
    adv: false,
    eng: Object.assign({}, ENG_DEFAULTS),
    out: Object.assign({}, OUT_DEFAULTS),
    jobEng: Object.assign({}, ENG_DEFAULTS),
    fileName: M.job.filename,
    mix: 'both',
    playing: false,
    time: 12,
    lastFrame: 0
  };

  // ------------------------------------------------------------------ helpers
  function h(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function prime(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + '′' + String(sec % 60).padStart(2, '0') + '″';
  }
  function parseName(filename) {
    var m = filename.match(/\.([^.]+)$/);
    var ext = m ? m[1].toUpperCase() : '';
    var base = filename.replace(/\.[^.]+$/, '');
    var i = base.indexOf(' - ');
    if (i > 0) {
      var comp = base.slice(0, i).trim(), work = base.slice(i + 3).trim();
      if (/^[A-ZÀ-Ý]/.test(comp) && comp.split(/\s+/).length <= 3) return { composer: comp, work: work, ext: ext };
      return { composer: '', work: base.replace(' - ', ' – '), ext: ext };
    }
    return { composer: '', work: base, ext: ext };
  }
  var SEP = '<span class="sep" aria-hidden="true">·</span>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  var toastTimer = 0;
  function toast(msg, actionLabel, onAction) {
    var t = $('toast');
    t.innerHTML = '';
    var seal = h('span', 'toast-seal', CHECK_SVG);
    var m = h('span', 'toast-msg');
    m.textContent = msg;
    t.append(seal, m);
    if (actionLabel) {
      var b = h('button', 'textlink');
      b.type = 'button';
      b.textContent = actionLabel;
      b.onclick = function () { hideToast(); if (onAction) onAction(); };
      t.append(b);
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4200);
  }
  function hideToast() { $('toast').classList.remove('show'); }

  // ------------------------------------------------------------------ graphic score renderer
  var F_SMALL = '"Sitka Small", "Sitka Text", Georgia, serif';
  var F_TEXT = '"Sitka Text", Georgia, serif';
  var F_DISP = '"Sitka Display", "Sitka Text", Georgia, serif';
  var DYN = [[45, 'pp'], [56, 'p'], [66, 'mp'], [76, 'mf'], [86, 'f'], [999, 'ff']];
  function dynOf(v) { for (var i = 0; i < DYN.length; i++) if (v < DYN[i][0]) return { mark: DYN[i][1], level: i }; return { mark: 'ff', level: 5 }; }
  function lowerBound(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function ScoreRoll(el, opts) {
    this.el = el;
    this.onSeek = (opts && opts.onSeek) || function () {};
    this.cv = document.createElement('canvas');
    this.tip = h('div', 'tip');
    this.tip.hidden = true;
    el.append(this.cv, this.tip);
    this.mL = 70; this.axisH = 26; this.waveH = 28; this.dynH = 28; this.pedH = 44;
    this.pps = 50; this.scrollX = 0; this.time = 0; this.playing = false; this.userScrolledAt = 0;
    this.opt = { pedal: 'cc', soft: true, flat: false, flatVel: 80, minMs: 0, tempo: 120, mix: 'both' };
    this.all = []; this.notes = []; this.pedals = []; this.dyn = [];
    this.hover = null; this._raf = 0; this._needsFit = true;
    var cs = getComputedStyle(document.documentElement);
    this.inkRGB = cs.getPropertyValue('--ink-rgb').trim() || '30,26,21';
    this.redRGB = cs.getPropertyValue('--red-rgb').trim() || '168,56,31';
    var self = this;
    new ResizeObserver(function () { self.resize(); }).observe(el);
    this.bind();
  }
  ScoreRoll.prototype.ink = function (a) { return 'rgba(' + this.inkRGB + ',' + a + ')'; };
  ScoreRoll.prototype.red = function (a) { return 'rgba(' + this.redRGB + ',' + a + ')'; };

  ScoreRoll.prototype.setData = function (d) {
    this.all = d.notes.slice().sort(function (a, b) { return a[0] - b[0]; });
    this.pedals = d.pedals || [];
    var sus = this.pedals.filter(function (q) { return q[2] === 64; }).sort(function (a, b) { return a[0] - b[0]; });
    this.sus = sus;
    this.wave = d.wave;
    this.duration = d.duration;
    var lo = 127, hi = 0;
    this.all.forEach(function (n) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); });
    this.lo = Math.max(21, lo - 2); this.hi = Math.min(108, hi + 2);
    var mx = 0;
    if (this.wave) for (var i = 0; i < this.wave.peak.length; i++) mx = Math.max(mx, this.wave.peak[i]);
    this.waveMax = mx || 1;
    this.derive();
    this._needsFit = true;
    this.resize();
  };
  ScoreRoll.prototype.setOptions = function (o) {
    Object.assign(this.opt, o);
    this.derive();
    this.requestDraw();
  };
  ScoreRoll.prototype.derive = function () {
    var minS = this.opt.minMs / 1000;
    this.notes = this.all.filter(function (n) { return n[1] - n[0] >= minS - 1e-9; });
    var span = 0;
    this.notes.forEach(function (n) { span = Math.max(span, (n[4] || n[1]) - n[0]); });
    this.maxSpan = span;
    this.dyn = this.opt.flat ? [] : this.computeDyn();
  };
  ScoreRoll.prototype.computeDyn = function () {
    var out = [], win = 4, notes = this.notes, i = 0;
    for (var t = 0; t < this.duration; t += win) {
      var vs = [], first = null;
      while (i < notes.length && notes[i][0] < t + win) { if (notes[i][0] >= t) { vs.push(notes[i][3]); if (first === null) first = notes[i][0]; } i++; }
      if (vs.length < 4) continue;
      vs.sort(function (a, b) { return b - a; });
      var top = vs.slice(0, Math.ceil(vs.length / 2));
      var mean = top.reduce(function (a, b) { return a + b; }, 0) / top.length;
      var d = dynOf(mean);
      if (!out.length || out[out.length - 1].mark !== d.mark) out.push({ t: first, mark: d.mark, level: d.level });
    }
    return out;
  };
  ScoreRoll.prototype.noteCount = function () { return this.notes.length; };

  ScoreRoll.prototype.geo = function () {
    var W = this.el.clientWidth, H = this.el.clientHeight;
    var top = this.axisH + this.waveH, bot = H - this.dynH - this.pedH;
    var rows = this.hi - this.lo + 1;
    return { W: W, H: H, top: top, bot: bot, rh: Math.max(1, (bot - top) / rows), vw: Math.max(1, W - this.mL) };
  };
  ScoreRoll.prototype.rowMid = function (p, g) { return g.top + (this.hi - p + 0.5) * g.rh; };
  ScoreRoll.prototype.X = function (t) { return this.mL + (t - this.scrollX) * this.pps; };
  ScoreRoll.prototype.clampScroll = function (s) {
    var viewSec = this.geo().vw / this.pps;
    return Math.max(0, Math.min(s, Math.max(0, this.duration - viewSec * 0.5)));
  };
  ScoreRoll.prototype.resize = function () {
    var g = this.geo();
    if (this._needsFit && g.W > this.mL + 50 && this.duration) {
      this._needsFit = false;
      this.pps = clamp(g.vw / Math.min(this.duration, 24), 20, 160);
    }
    var dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(g.W * dpr));
    this.cv.height = Math.max(1, Math.round(g.H * dpr));
    this.scrollX = this.clampScroll(this.scrollX);
    this.requestDraw();
  };
  ScoreRoll.prototype.zoom = function (f, anchorPx) {
    var g = this.geo();
    var ax = anchorPx == null ? g.vw / 2 : anchorPx;
    var tA = this.scrollX + ax / this.pps;
    this.pps = clamp(this.pps * f, 8, 1200);
    this.scrollX = this.clampScroll(tA - ax / this.pps);
    this.requestDraw();
  };
  ScoreRoll.prototype.setTime = function (t, playing) {
    this.time = t; this.playing = playing;
    var viewSec = this.geo().vw / this.pps;
    var recent = performance.now() - this.userScrolledAt < 2500;
    if (playing && !recent && (t > this.scrollX + viewSec * 0.85 || t < this.scrollX)) this.scrollX = this.clampScroll(t - viewSec * 0.12);
    this.requestDraw();
  };
  ScoreRoll.prototype.reveal = function (t) {
    var viewSec = this.geo().vw / this.pps;
    if (t < this.scrollX || t > this.scrollX + viewSec) this.scrollX = this.clampScroll(t - viewSec * 0.12);
    this.requestDraw();
  };
  ScoreRoll.prototype.requestDraw = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(); });
  };

  ScoreRoll.prototype.drawBrace = function (ctx, x, y, w, hh) {
    var P = function (u, v) { return [x + u * w, y + v * hh]; };
    var m = function (a) { ctx.moveTo(a[0], a[1]); };
    var l = function (a) { ctx.lineTo(a[0], a[1]); };
    var c = function (a, b, d) { ctx.bezierCurveTo(a[0], a[1], b[0], b[1], d[0], d[1]); };
    ctx.beginPath();
    m(P(1, 0));
    c(P(0.3, 0.012), P(0.4, 0.15), P(0.4, 0.29));
    l(P(0.4, 0.4));
    c(P(0.4, 0.47), P(0.2, 0.494), P(0, 0.5));
    c(P(0.2, 0.506), P(0.4, 0.53), P(0.4, 0.6));
    l(P(0.4, 0.71));
    c(P(0.4, 0.85), P(0.3, 0.988), P(1, 1));
    c(P(0.56, 0.975), P(0.66, 0.85), P(0.66, 0.72));
    l(P(0.66, 0.61));
    c(P(0.66, 0.535), P(0.42, 0.506), P(0, 0.5));
    c(P(0.42, 0.494), P(0.66, 0.465), P(0.66, 0.39));
    l(P(0.66, 0.28));
    c(P(0.66, 0.15), P(0.56, 0.025), P(1, 0));
    ctx.closePath();
    ctx.fill();
  };
  ScoreRoll.prototype.drawStar = function (ctx, x, y, a) {
    ctx.strokeStyle = this.ink(a);
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.arc(x, y, 1.7, 0, Math.PI * 2);
    for (var k = 0; k < 8; k++) {
      var an = k * Math.PI / 4 + Math.PI / 8;
      ctx.moveTo(x + Math.cos(an) * 2.9, y + Math.sin(an) * 2.9);
      ctx.lineTo(x + Math.cos(an) * 5.2, y + Math.sin(an) * 5.2);
    }
    ctx.stroke();
  };

  ScoreRoll.prototype.draw = function () {
    var g = this.geo();
    var ctx = this.cv.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.W, g.H);
    if (!this.all.length) return;
    var self = this, o = this.opt, mL = this.mL;
    var t0 = this.scrollX, t1 = t0 + g.vw / this.pps;
    var noteK = o.mix === 'original' ? 0.3 : 1;
    var waveA = o.mix === 'original' ? 0.5 : o.mix === 'midi' ? 0.09 : 0.22;
    var markK = o.mix === 'original' ? 0.45 : 1;

    // ---- margin: brace, system line, pitch names
    ctx.fillStyle = this.ink(0.85);
    this.drawBrace(ctx, 9, g.top + 1, 11, g.bot - g.top - 2);
    ctx.fillStyle = this.ink(0.8);
    ctx.fillRect(mL - 1.5, g.top, 1.2, g.bot - g.top);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var p = this.lo; p <= this.hi; p++) {
      if (p % 12 !== 0) continue;
      var y = this.rowMid(p, g);
      ctx.font = (p === 60 ? '600 ' : '') + 'italic 11.5px ' + F_SMALL;
      ctx.fillStyle = this.ink(p === 60 ? 0.92 : 0.74);
      ctx.fillText('C' + (p / 12 - 1), mL - 9, y);
    }
    ctx.font = 'italic 11px ' + F_SMALL;
    ctx.fillStyle = this.ink(0.72);
    ctx.fillText('audio', mL - 9, this.axisH + this.waveH / 2);
    if (o.pedal === 'cc' || o.soft) {
      ctx.fillText('pedal', mL - 9, g.H - this.pedH / 2);
    }

    // ---- plot (clipped)
    ctx.save();
    ctx.beginPath();
    ctx.rect(mL, 0, g.vw, g.H);
    ctx.clip();

    // ruler
    var steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    var step = steps.find(function (s) { return s * self.pps >= 64; }) || 120;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'italic 11.5px ' + F_SMALL;
    for (var k = Math.floor(t0 / step); k * step <= t1; k++) {
      var tt = k * step, x = Math.round(this.X(tt));
      ctx.fillStyle = this.ink(0.4);
      ctx.fillRect(x, this.axisH - 6, 1, 6);
      var lbl = step < 1 ? fmtTime(tt, true) : fmtTime(tt);
      // Only whole labels: none cut by the left margin or the right edge.
      if (x < mL || x + 4 + ctx.measureText(lbl).width > g.W - 3) continue;
      ctx.fillStyle = this.ink(0.72);
      ctx.fillText(lbl, x + 4, this.axisH / 2 - 1);
    }
    ctx.fillStyle = this.ink(0.3);
    ctx.fillRect(mL, this.axisH - 0.5, g.vw, 1);

    // recording silhouette
    if (this.wave) {
      var hop = this.wave.hop_seconds, pk = this.wave.peak;
      var wy = this.axisH + this.waveH / 2 + 1, amp = this.waveH / 2 - 5;
      var pts = [];
      for (var px = mL; px <= g.W + 2; px += 2) {
        var ta = this.scrollX + (px - mL) / this.pps, tb = ta + 2 / this.pps;
        var i0 = Math.max(0, Math.floor(ta / hop)), i1 = Math.min(pk.length, Math.max(i0 + 1, Math.ceil(tb / hop)));
        var mx = 0;
        for (var ii = i0; ii < i1; ii++) mx = Math.max(mx, pk[ii]);
        pts.push([px, (mx / this.waveMax) * amp]);
      }
      ctx.beginPath();
      ctx.moveTo(mL, wy);
      pts.forEach(function (q) { ctx.lineTo(q[0], wy - q[1] - 0.4); });
      for (var j = pts.length - 1; j >= 0; j--) ctx.lineTo(pts[j][0], wy + pts[j][1] + 0.4);
      ctx.closePath();
      ctx.fillStyle = this.ink(waveA);
      ctx.fill();
    }

    // bar lines at the MIDI tempo (4/4)
    var barSec = 240 / o.tempo;
    var bstep = 1;
    while (barSec * bstep * this.pps < 26) bstep *= 2;
    for (var b = Math.floor(t0 / barSec / bstep) * bstep; b * barSec <= t1; b += bstep) {
      var bx = Math.round(this.X(b * barSec));
      ctx.fillStyle = this.ink(b % 4 === 0 ? 0.13 : 0.075);
      ctx.fillRect(bx, g.top, 1, g.bot - g.top);
    }

    // staff-like lines at every C and F
    for (p = this.lo; p <= this.hi; p++) {
      var pc = p % 12;
      if (pc !== 0 && pc !== 5) continue;
      y = this.rowMid(p, g);
      if (pc === 0) { ctx.fillStyle = this.ink(p === 60 ? 0.42 : 0.27); ctx.fillRect(mL, y - (p === 60 ? 0.6 : 0.4), g.vw, p === 60 ? 1.2 : 0.8); }
      else { ctx.fillStyle = this.ink(0.12); ctx.fillRect(mL, y - 0.4, g.vw, 0.8); }
    }
    ctx.fillStyle = this.ink(0.16);
    ctx.fillRect(mL, g.bot + 0.5, g.vw, 0.8);

    // notes: notehead at the onset, ink stroke while the key is held, hairline while the pedal holds it
    var rh = g.rh;
    var rx = clamp(rh * 0.8, 2.4, 6.4), ry = clamp(rh * 0.56, 1.7, 4.4), bh = clamp(rh * 0.36, 1, 3.2);
    var notes = this.notes;
    for (var n_i = lowerBound(notes, t0 - this.maxSpan - 0.05); n_i < notes.length; n_i++) {
      var n = notes[n_i];
      var s = n[0], e = n[1], pp = n[2], v = n[3], snd = n[4] || n[1], conf = n[5] == null ? 1 : n[5];
      if (s > t1 + 0.2) break;
      var bodyEnd = o.pedal === 'extend' ? Math.max(e, snd) : e;
      var tailEnd = o.pedal === 'cc' ? Math.max(snd, bodyEnd) : bodyEnd;
      if (tailEnd < t0 - 0.1) continue;
      var cy = this.rowMid(pp, g);
      var xs = this.X(s), xe = this.X(bodyEnd), xt = this.X(tailEnd);
      var vel = o.flat ? o.flatVel : v;
      var a = (0.16 + 0.84 * clamp((vel - 22) / 82, 0, 1)) * noteK;
      if (xt > xe + 2) { ctx.fillStyle = this.ink(a * 0.5); ctx.fillRect(xe, cy - 0.45, xt - xe, 0.9); }
      var hx = xs + rx * 0.9;
      if (xe > hx) { ctx.fillStyle = this.ink(a * 0.82); ctx.fillRect(hx, cy - bh / 2, xe - hx, bh); }
      ctx.beginPath();
      ctx.ellipse(hx, cy, rx, ry, -0.38, 0, Math.PI * 2);
      if (conf < 0.6) { ctx.strokeStyle = this.ink(Math.max(0.5, a)); ctx.lineWidth = 1.1; ctx.stroke(); }
      else { ctx.fillStyle = this.ink(Math.min(1, a + 0.08)); ctx.fill(); }
      if (this.hover === n) {
        ctx.strokeStyle = this.red(1);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.fillStyle = this.red(0.9);
        ctx.fillRect(hx, cy + ry + 1.5, Math.max(4, xt - hx), 1.2);
      }
    }

    // dynamics, read from velocity
    var dy = g.bot + this.dynH / 2 + 2;
    if (o.flat) {
      ctx.font = 'italic 12.5px ' + F_TEXT;
      ctx.fillStyle = this.ink(0.76 * markK);
      ctx.textAlign = 'left';
      ctx.fillText('Flat dynamics: every note at velocity ' + o.flatVel, mL + 10, dy);
    } else {
      ctx.font = 'italic 700 15.5px ' + F_DISP;
      ctx.textAlign = 'left';
      var marks = this.dyn;
      for (var di = 0; di < marks.length; di++) {
        var mk = marks[di], mx0 = this.X(mk.t);
        var w = ctx.measureText(mk.mark).width;
        var nx = di + 1 < marks.length ? this.X(marks[di + 1].t) : null;
        if (mx0 > g.W + 10) break;
        if (nx !== null && nx < mL - 20) continue;
        ctx.fillStyle = this.ink(0.88 * markK);
        ctx.fillText(mk.mark, mx0, dy);
        if (nx !== null) {
          var hs = Math.max(mx0 + w + 10, nx - 10 - 110), he = nx - 10;
          if (he - hs > 26) {
            var cresc = marks[di + 1].level > mk.level;
            ctx.strokeStyle = this.ink(0.62 * markK);
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            if (cresc) { ctx.moveTo(he, dy - 4); ctx.lineTo(hs, dy); ctx.lineTo(he, dy + 4); }
            else { ctx.moveTo(hs, dy - 4); ctx.lineTo(he, dy); ctx.lineTo(hs, dy + 4); }
            ctx.stroke();
          }
        }
      }
    }

    // pedal markings: "Ped. ___ *" for sustain, "una corda ... tre corde" for the soft pedal
    var pedY = g.H - 13, ucY = g.H - this.pedH + 11;
    if (o.pedal === 'cc') {
      ctx.font = 'italic 600 13.5px ' + F_DISP;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      var pw = ctx.measureText('Ped.').width;
      var ly = pedY + 3.6, pa = 0.86 * markK, la = 0.55 * markK;
      // Each roomy press gets its own "Ped. ___ *"; quick re-pedals that have no room for
      // their own marking continue the previous one as a notch: Ped. ___^___^___ *
      var marks = [], cur = null, prevEnd = -1;
      for (var qi = 0; qi < this.sus.length; qi++) {
        var q = this.sus[qi];
        if (q[1] < t0 - 30) { prevEnd = q[1]; continue; }
        if (q[0] > t1 + 1) break;
        var roomy = (q[1] - q[0]) * this.pps >= pw + 22;
        if (!cur || roomy || q[0] - prevEnd >= 0.4) {
          cur = { start: q[0], end: q[1], notches: [] };
          marks.push(cur);
        } else {
          cur.notches.push((prevEnd + q[0]) / 2);
          cur.end = q[1];
        }
        prevEnd = q[1];
      }
      var minX = -1e9;
      marks.forEach(function (mk) {
        if (mk.end < t0) return;
        var gx0 = self.X(mk.start), gx1 = self.X(mk.end);
        var carried = mk.start < t0 - 0.02;
        var label = carried ? '(Ped.)' : 'Ped.';
        var tx = Math.max(carried ? mL + 6 : gx0, minX);
        var tw = ctx.measureText(label).width;
        minX = gx1 + 5;
        if (carried && gx1 < tx + tw + 16) {   // only the tail is in view: line and release mark
          ctx.fillStyle = self.ink(la);
          ctx.fillRect(mL, ly, Math.max(0, gx1 - 10 - mL), 0.9);
          self.drawStar(ctx, gx1 - 4, pedY, pa);
          return;
        }
        ctx.fillStyle = self.ink(pa);
        ctx.fillText(label, tx, pedY + 4.5);
        var lx0 = tx + tw + 4, lx1 = gx1 - 10;
        ctx.strokeStyle = self.ink(la);
        ctx.lineWidth = 0.95;
        ctx.beginPath();
        ctx.moveTo(lx0, ly);
        mk.notches.forEach(function (tn) {
          var nx = self.X(tn);
          if (nx < lx0 + 5 || nx > lx1 - 5) return;
          ctx.lineTo(nx - 3.2, ly); ctx.lineTo(nx, ly - 6); ctx.lineTo(nx + 3.2, ly);
        });
        if (lx1 > lx0) ctx.lineTo(lx1, ly);
        ctx.stroke();
        self.drawStar(ctx, gx1 - 4, pedY, pa);
      });
    } else {
      ctx.font = 'italic 12.5px ' + F_TEXT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.ink(0.76);
      ctx.fillText(o.pedal === 'extend' ? 'Sustain pedal baked into note lengths' : 'Sustain pedal left out of the file', mL + 10, pedY);
    }
    if (o.soft) {
      ctx.textBaseline = 'middle';
      this.pedals.forEach(function (pd) {
        if (pd[2] !== 67 || pd[1] < t0 - 1 || pd[0] > t1 + 1) return;
        var x0 = self.X(pd[0]), x1 = self.X(pd[1]);
        ctx.font = 'italic 12.5px ' + F_TEXT;
        var a1 = 'una corda', a2 = 'tre corde';
        var w1 = ctx.measureText(a1).width, w2 = ctx.measureText(a2).width;
        if (x1 - x0 < w1 + w2 + 24) { a1 = 'u.c.'; a2 = 't.c.'; w1 = ctx.measureText(a1).width; w2 = ctx.measureText(a2).width; }
        ctx.fillStyle = self.ink(0.86 * markK);
        ctx.textAlign = 'left';
        ctx.fillText(a1, x0, ucY);
        ctx.textAlign = 'right';
        ctx.fillText(a2, x1, ucY);
        ctx.strokeStyle = self.ink(0.42 * markK);
        ctx.lineWidth = 0.9;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x0 + w1 + 6, ucY + 0.5);
        ctx.lineTo(x1 - w2 - 6, ucY + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    // playhead
    var phx = this.X(this.time);
    if (phx >= mL - 6 && phx <= g.W + 6) {
      ctx.fillStyle = this.red(1);
      ctx.fillRect(Math.round(phx) - 0.65, this.axisH - 1, 1.3, g.H - this.axisH + 1);
      ctx.beginPath();
      ctx.moveTo(phx - 5, this.axisH - 9); ctx.lineTo(phx + 5, this.axisH - 9); ctx.lineTo(phx, this.axisH - 1.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  ScoreRoll.prototype.hit = function (x, y) {
    var g = this.geo();
    if (x < this.mL || y < g.top || y > g.bot) return null;
    var t = this.scrollX + (x - this.mL) / this.pps;
    var p = this.hi - Math.floor((y - g.top) / g.rh);
    var o = this.opt, best = null, pad = 7 / this.pps;
    for (var i = lowerBound(this.notes, t - this.maxSpan - 0.05); i < this.notes.length; i++) {
      var n = this.notes[i];
      if (n[0] - pad > t) break;
      var end = o.pedal === 'cc' || o.pedal === 'extend' ? Math.max(n[1], n[4] || n[1]) : n[1];
      if (n[2] === p && t <= end + pad) best = n;
    }
    return best;
  };
  ScoreRoll.prototype.bind = function () {
    var self = this, cv = this.cv, drag = null;
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) self.zoom(Math.exp(-e.deltaY * 0.0022), Math.max(0, e.clientX - r.left - self.mL));
      else {
        var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        self.scrollX = self.clampScroll(self.scrollX + (e.deltaMode === 1 ? d * 30 : d) / self.pps);
        self.userScrolledAt = performance.now();
        self.requestDraw();
      }
    }, { passive: false });
    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, scroll: self.scrollX, moved: false };
    });
    cv.addEventListener('pointermove', function (e) {
      var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag) {
        var dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) {
          self.scrollX = self.clampScroll(drag.scroll - dx / self.pps);
          self.userScrolledAt = performance.now();
          self.tip.hidden = true;
          cv.style.cursor = 'grabbing';
          self.requestDraw();
          return;
        }
      }
      var n = self.hit(x, y);
      if (n !== self.hover) { self.hover = n; self.requestDraw(); }
      if (n) {
        var dur = n[1] - n[0], conf = n[5] == null ? 1 : n[5];
        var vel = self.opt.flat ? self.opt.flatVel : n[3];
        self.tip.innerHTML = '<b>' + noteName(n[2]) + '</b> · velocity ' + vel + ' <i>' + dynOf(vel).mark + '</i> · ' +
          (dur < 1 ? Math.round(dur * 1000) + ' ms' : dur.toFixed(2) + ' s') +
          (conf < 0.995 ? ' · ' + Math.round(conf * 100) + '% sure' : '');
        self.tip.hidden = false;
        var tw = self.tip.offsetWidth, th = self.tip.offsetHeight;
        var lx = x + 14, ly = y - th - 10;
        if (lx + tw > r.width - 4) lx = x - tw - 14;
        if (ly < 4) ly = y + 16;
        self.tip.style.left = lx + 'px';
        self.tip.style.top = ly + 'px';
        cv.style.cursor = 'pointer';
      } else {
        self.tip.hidden = true;
        cv.style.cursor = 'crosshair';
      }
    });
    var end = function (e) {
      if (drag && !drag.moved && e.type === 'pointerup') {
        var r = cv.getBoundingClientRect();
        var x = e.clientX - r.left;
        if (x >= self.mL) self.onSeek(clamp(self.scrollX + (x - self.mL) / self.pps, 0, self.duration));
      }
      drag = null;
      cv.style.cursor = 'crosshair';
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', function () { self.tip.hidden = true; if (self.hover) { self.hover = null; self.requestDraw(); } });
  };

  // ------------------------------------------------------------------ views
  var score = null;
  function ensureScore() {
    if (score) return score;
    score = new ScoreRoll($('score'), { onSeek: function (t) { seek(t); } });
    score.setData({ notes: M.notes, pedals: M.pedals, duration: M.duration, wave: M.waveform });
    applyOutputToScore();
    return score;
  }

  function showView(name) {
    if (name !== 'result') stopPlay();
    if (name !== 'progress') stopProgress();
    state.view = name;
    document.body.classList.toggle('is-result', name === 'result');
    $('vHome').hidden = name !== 'home';
    $('vProgress').hidden = name !== 'progress';
    $('vResult').hidden = name !== 'result';
    $('main').scrollTop = 0;
    // If focus was on something that just disappeared, hand it to the new page's heading.
    var a = document.activeElement;
    if (!a || a === document.body || a.closest('[hidden]')) {
      var hd = { home: 'homeTitle', progress: 'progTitle', result: 'workTitle' }[name];
      if (hd && !(state.adv && overlayMode())) $(hd).focus({ preventScroll: true });
    }
    updateOutNote();
    updateReconvert();
    if (state.adv) { syncSheetMode(); if (score) requestAnimationFrame(function () { score.resize(); }); }
    var nm = parseName(state.fileName), label = (nm.composer ? nm.composer + ' · ' : '') + nm.work;
    $('runheadMid').textContent = name === 'home' ? '' : name === 'progress' ? 'Converting · ' + label : label + ' · ' + prime(M.job.stats.duration);
    markSwitcher();
  }
  function markSwitcher() {
    var cur = state.view === 'result' && state.adv ? 'advanced' : state.view;
    Array.prototype.forEach.call(document.querySelectorAll('#switcher button'), function (b) {
      b.setAttribute('aria-current', String(b.dataset.go === cur));
    });
  }

  // ---- home
  function renderHome() {
    var eng = engineById(state.eng.engine);
    var detail = 'Its own settings only';
    var views = specOf('views');
    if (eng.options.some(function (o) { return o.key === 'views'; })) {
      var c = views.choices.find(function (x) { return x.value === state.eng.views; });
      if (c) detail = c.label;
    }
    if (state.eng.engine === 'ensemble') {
      var r = specOf('rescue').choices.find(function (x) { return x.value === state.eng.rescue; });
      if (r) detail += ' · ' + r.label.replace(/\s*\(.*\)$/, '').toLowerCase() + ' second opinion';
    }
    $('engineSummary').innerHTML = '<span class="eng-name">' + esc(eng.name) + '</span><span class="eng-detail">' + esc(detail) + '</span>';

    var ol = $('recentList');
    ol.innerHTML = '';
    M.recent.forEach(function (job) {
      var nm = parseName(job.filename);
      var li = h('li', 'is-' + job.status);
      var b = h('button', 'entry');
      b.type = 'button';
      var line = h('span', 'e-line');
      if (nm.composer) line.append(h('span', 'e-comp', esc(nm.composer)));
      var title = h('span', 'e-title' + (nm.composer ? '' : ' upright'), esc(nm.work));
      title.title = job.filename;
      line.append(title, h('span', 'leader'), h('span', 'e-dur', prime(job.duration)));
      var meta = h('span', 'e-meta');
      var bits = [];
      if (job.status === 'done') bits.push(job.notes.toLocaleString('en-US') + ' notes', esc(nm.ext));
      else if (job.status === 'running') bits.push('<span class="st-run">Converting · ' + Math.round(job.progress * 100) + '%</span> <span class="minibar" aria-hidden="true"><i style="width:' + Math.round(job.progress * 100) + '%"></i></span>');
      else if (job.status === 'queued') bits.push('<span class="st-wait">Waiting · starts next</span>');
      else if (job.status === 'error') bits.push('<span class="st-fail">Failed</span> ' + esc(job.error));
      bits.push(esc(job.when));
      meta.innerHTML = bits.join(SEP);
      b.append(line, meta);
      b.onclick = function () { openRecent(job); };
      li.append(b);
      ol.append(li);
    });
  }
  function openRecent(job) {
    var nm = parseName(job.filename);
    var label = (nm.composer ? nm.composer + ' – ' : '') + nm.work;
    if (job.status === 'done') {
      if (job.id === M.job.id) { state.fileName = M.job.filename; openResult(true); }
      else toast('This preview only includes the Schubert result.');
    } else if (job.status === 'running') {
      toast(label + ' is converting (' + Math.round(job.progress * 100) + '%). It opens here when it is ready.');
    } else if (job.status === 'queued') {
      toast(label + ' is waiting. It starts when the current conversion finishes.');
    } else if (job.status === 'error') {
      toast(job.error + ' Try exporting the recording again, then drop it here.');
    }
  }

  // ---- progress
  var progRaf = 0, progT0 = 0;
  function stagesFor(engId) {
    var vc = { none: '1 view', channels: '4 views', full: '6 views' }[state.eng.views] || '4 views';
    if (engId === 'transkun') return [{ id: 'decode', label: 'Read audio' }, { id: 'transkun', label: 'Transkun V2 · ' + vc }, { id: 'fuse', label: 'Write MIDI' }];
    if (engId === 'aria') return [{ id: 'decode', label: 'Read audio' }, { id: 'aria', label: 'Aria-AMT' }, { id: 'fuse', label: 'Write MIDI' }];
    return M.progress.stages.map(function (s) { return { id: s.id, label: s.id === 'transkun' ? 'Transkun V2 · ' + vc : s.label }; });
  }
  function phase(p, nStages, windows) {
    if (p < 0.06) return { stage: 0, msg: 'Reading the audio', win: 0, wf: 0 };
    var mainEnd = nStages === 4 ? 0.86 : 0.95;
    if (p < mainEnd) {
      var x = (p - 0.06) / (mainEnd - 0.06) * windows;
      var w = Math.min(windows, Math.floor(x) + 1);
      return { stage: 1, msg: 'Transcribing window ' + w + ' of ' + windows, win: w, wf: x - Math.floor(x) };
    }
    if (nStages === 4 && p < 0.95) return { stage: 2, msg: 'Asking Aria-AMT for a second opinion', win: windows + 1, wf: 0 };
    return { stage: nStages - 1, msg: 'Merging and writing the MIDI file', win: windows + 1, wf: 0 };
  }
  var ROMAN = ['I.', 'II.', 'III.', 'IV.', 'V.'];
  function setProgress(p, opts) {
    opts = opts || {};
    var stages = stagesFor(state.eng.engine);
    var windows = M.progress.windows;
    var ph = phase(p, stages.length, windows);
    var pct = Math.round(p * 100);
    $('pctNum').textContent = pct;
    $('progBar').setAttribute('aria-valuenow', pct);
    $('progFill').style.width = (p * 100) + '%';
    $('progNib').style.left = (p * 100) + '%';
    $('progStep').textContent = opts.msg || ph.msg;
    var eta = opts.eta != null ? opts.eta : Math.round((1 - p) * 26);
    $('progEta').textContent = p >= 0.97 ? 'Almost done' : 'About ' + eta + ' s left';
    var ol = $('stages');
    ol.style.setProperty('--n', stages.length);
    ol.innerHTML = '';
    stages.forEach(function (s, i) {
      var st = i < ph.stage ? 'done' : i === ph.stage ? 'active' : 'pending';
      var li = h('li', 'is-' + st);
      var stateText = st === 'done' ? CHECK_SVG + 'Done'
        : st === 'active' ? (i === 1 && ph.win <= windows ? 'Window ' + ph.win + ' of ' + windows : 'In progress')
        : (i === ph.stage + 1 ? 'Next' : 'Waiting');
      li.innerHTML = '<span class="st-num">' + ROMAN[i] + '</span><span class="st-label">' + esc(s.label) + '</span><span class="st-state">' + stateText + '</span>';
      ol.append(li);
    });
    drawBars(ph, windows);
  }
  function drawBars(ph, windows) {
    var cv = $('barsCanvas');
    var W = cv.clientWidth, H = cv.clientHeight;
    if (!W) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var ink = function (a) { return 'rgba(30,26,21,' + a + ')'; };
    // A piano system: brace, treble and bass staves split at middle C; one bar per analysis window.
    var x0 = 16, x1 = W - 2, top = 22, bot = H - 3, midGap = 10;
    var staffH = (bot - top - midGap) / 2, lg = staffH / 4;
    var trebleTop = top, bassTop = bot - staffH;
    ctx.fillStyle = ink(0.85);
    var brace = ScoreRoll.prototype.drawBrace;
    brace.call(null, ctx, 2, top, 9, bot - top);
    ctx.fillStyle = ink(0.4);
    for (var k = 0; k < 5; k++) {
      ctx.fillRect(x0, Math.round(trebleTop + k * lg) - 0.4, x1 - x0, 0.8);
      ctx.fillRect(x0, Math.round(bassTop + k * lg) - 0.4, x1 - x0, 0.8);
    }
    var bw = (x1 - 6 - x0) / windows;
    var len = M.duration / windows;
    // system line, bar lines through both staves, final double bar
    ctx.fillStyle = ink(0.8);
    ctx.fillRect(x0, top, 1.4, bot - top);
    for (var b = 1; b < windows; b++) {
      var bx = Math.round(x0 + b * bw);
      ctx.fillRect(bx, trebleTop, 1, staffH);
      ctx.fillRect(bx, bassTop, 1, staffH);
    }
    ctx.fillRect(x1 - 5, top, 1, bot - top);
    ctx.fillRect(x1 - 2.6, top, 2.8, bot - top);
    // bar numbers
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (b = 0; b < windows; b++) {
      var cur = b + 1 === ph.win;
      ctx.fillStyle = cur ? 'rgb(168,56,31)' : ink(0.72);
      ctx.font = (cur ? '600 ' : '') + 'italic 11.5px ' + F_SMALL;
      ctx.fillText(String(b + 1), x0 + b * bw + 5, 11);
    }
    // the transcribed notes, bar by bar: middle C and up on the upper staff, below it on the lower
    var lo = 39, hi = 97;
    var py = function (p) {
      if (p >= 60) return trebleTop + staffH + 2 - (p - 60) / (hi - 60) * (staffH + 1);
      return bassTop - 2 + (59 - p) / (59 - lo) * (staffH + 1);
    };
    var notes = M.notes;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var bi = Math.min(windows - 1, Math.floor(n[0] / len));
      var within = (n[0] - bi * len) / len;
      if (bi + 1 > ph.win) continue;
      if (bi + 1 === ph.win && within > ph.wf) continue;
      var x = x0 + bi * bw + 7 + within * (bw - 13);
      var a = 0.3 + 0.66 * clamp((n[3] - 22) / 82, 0, 1);
      ctx.fillStyle = ink(a);
      ctx.beginPath();
      ctx.ellipse(x, py(n[2]), 2.4, 1.65, -0.38, 0, Math.PI * 2);
      ctx.fill();
    }
    // the pen
    if (ph.win >= 1 && ph.win <= windows) {
      var px = x0 + (ph.win - 1) * bw + 7 + ph.wf * (bw - 13);
      ctx.fillStyle = 'rgba(168,56,31,0.95)';
      ctx.fillRect(Math.round(px) - 0.6, top - 5, 1.2, bot - top + 7);
      ctx.beginPath();
      ctx.arc(px, top - 5, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function fillProgressHeader(filename) {
    var nm = parseName(filename);
    $('progTitle').innerHTML = (nm.composer ? '<span class="t-comp">' + esc(nm.composer) + '</span>' : '') + '<em>' + esc(nm.work) + '</em>';
    $('progFile').textContent = filename === M.file.name
      ? M.file.name + ' · ' + M.file.size_mb + ' MB · ' + M.file.format
      : filename;
  }
  function showProgressStatic() {
    state.fileName = M.job.filename;
    fillProgressHeader(M.file.name);
    showView('progress');
    $('progEyebrow').textContent = 'Now transcribing';
    requestAnimationFrame(function () {
      setProgress(M.progress.progress, { msg: M.progress.message, eta: M.progress.eta_seconds });
    });
  }
  function startConversion(filename, opts) {
    opts = opts || {};
    state.fileName = filename;
    fillProgressHeader(filename);
    showView('progress');
    $('progEyebrow').textContent = opts.rerun ? 'Converting again' : 'Now transcribing';
    stopProgress();
    progT0 = Date.now();
    var DUR = 3100;
    // A timer, not requestAnimationFrame: progress must keep moving while the window is hidden.
    var tick = function () {
      var p = clamp((Date.now() - progT0) / DUR, 0, 1);
      setProgress(p);
      if (p >= 1) {
        stopProgress();
        setTimeout(function () {
          if (state.view !== 'progress') return;
          state.jobEng = Object.assign({}, state.eng);
          openResult(true);
          toast('Converted in ' + ENGINE_TIME[state.jobEng.engine] + ' s. Your MIDI file is ready to save.');
        }, 380);
      }
    };
    tick();
    progRaf = setInterval(tick, 40);
    $('cancelBtn').focus({ preventScroll: true });
  }
  function stopProgress() { if (progRaf) clearInterval(progRaf); progRaf = 0; }

  // ---- result
  function openResult(resetTime) {
    showView('result');
    var nm = parseName(state.fileName);
    $('composer').textContent = nm.composer || 'Recording';
    $('workName').textContent = nm.work;
    $('workDur').textContent = prime(M.job.stats.duration);
    $('sourceName').textContent = state.fileName;
    ensureScore();
    if (resetTime) state.time = 0;
    renderMeta(false);
    requestAnimationFrame(function () {
      score.resize();
      seek(state.time, true);
    });
  }
  function renderMeta(flash) {
    var st = M.job.stats, o = state.out, bits = [];
    var count = score ? score.noteCount() : st.notes;
    bits.push('<span' + (flash && count !== st.notes ? ' class="flash"' : '') + '>' + count.toLocaleString('en-US') + ' notes</span>');
    if (o.pedal === 'cc') bits.push(st.pedals + ' pedal presses');
    else bits.push(o.pedal === 'extend' ? 'pedal baked into note lengths' : 'no sustain pedal');
    if (o.soft_pedal) bits.push(st.soft_pedals + ' una corda');
    bits.push(engineById(state.jobEng.engine).name);
    bits.push('converted in ' + ENGINE_TIME[state.jobEng.engine] + ' s');
    $('resultMeta').innerHTML = bits.map(function (b) { return '<span class="mbit">' + b + '</span>'; }).join(' ' + SEP + ' ');
  }
  function updateTime() {
    $('timeLabel').textContent = fmtTime(state.time) + ' / ' + fmtTime(M.duration);
  }
  function seek(t, reveal) {
    state.time = clamp(t, 0, M.duration);
    if (score) { score.setTime(state.time, state.playing); if (reveal) score.reveal(state.time); }
    updateTime();
  }
  var playRaf = 0;
  function togglePlay() { if (state.playing) stopPlay(); else startPlay(); }
  function startPlay() {
    if (state.view !== 'result') return;
    if (state.time >= M.duration - 0.05) state.time = 0;
    state.playing = true;
    $('playBtn').classList.add('is-playing');
    $('playBtn').setAttribute('aria-label', 'Pause');
    state.lastFrame = performance.now();
    var loop = function (now) {
      var dt = (now - state.lastFrame) / 1000;
      state.lastFrame = now;
      state.time = Math.min(M.duration, state.time + dt);
      score.setTime(state.time, true);
      updateTime();
      if (state.time >= M.duration) { stopPlay(); return; }
      playRaf = requestAnimationFrame(loop);
    };
    playRaf = requestAnimationFrame(loop);
  }
  function stopPlay() {
    if (playRaf) cancelAnimationFrame(playRaf);
    playRaf = 0;
    state.playing = false;
    $('playBtn').classList.remove('is-playing');
    $('playBtn').setAttribute('aria-label', 'Play');
    if (score) score.setTime(state.time, false);
  }
  function setMix(mix) {
    state.mix = mix;
    Array.prototype.forEach.call($('mixSeg').querySelectorAll('button'), function (b) { b.setAttribute('aria-checked', String(b.dataset.mix === mix)); });
    if (score) score.setOptions({ mix: mix });
  }

  // ------------------------------------------------------------------ advanced options (the form)
  var fieldNo = 0;
  function radioGroup(name, choices, value, onChange, opts) {
    opts = opts || {};
    var wrap = h('div', 'choices' + (opts.inline ? ' inline' : ''));
    wrap.setAttribute('role', 'radiogroup');
    choices.forEach(function (c) {
      var lab = h('label', 'choice');
      var inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = name;
      inp.value = c.value;
      inp.checked = String(c.value) === String(value);
      inp.disabled = !!opts.disabled;
      inp.dataset.fid = name + ':' + c.value;
      inp.onchange = function () { if (inp.checked) onChange(c.value); };
      var txt = h('span', 'c-text');
      var tag = c.isDefault && opts.markDefault ? '<span class="c-default" title="Default">\u2020</span>' : '';
      txt.innerHTML = '<span class="c-name">' + esc(c.label) + '</span>' + tag +
        (c.desc ? '<span class="c-desc">' + esc(c.desc) + '</span>' : '');
      lab.append(inp, txt);
      wrap.append(lab);
    });
    return wrap;
  }
  function fieldset(label, applies, off) {
    fieldNo++;
    var fs = h('div', 'field' + (off ? ' is-off' : ''));
    fs.setAttribute('role', 'group');
    var id = 'fl' + fieldNo;
    fs.setAttribute('aria-labelledby', id);
    var lg = h('div', 'flabel');
    lg.id = id;
    lg.innerHTML = '<span class="fno" aria-hidden="true">' + fieldNo + '</span><span>' + esc(label) + '</span>' + (applies ? '<span class="applies">' + esc(applies) + '</span>' : '');
    fs.append(lg);
    return fs;
  }
  function helpLine(text) { var p = h('p', 'help'); p.textContent = text; return p; }
  function checkbox(fid, label, checked, onChange, disabled) {
    var wrap = h('div', 'choices');
    var lab = h('label', 'choice');
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.dataset.fid = fid;
    inp.checked = !!checked;
    inp.disabled = !!disabled;
    inp.onchange = function () { onChange(inp.checked); };
    var txt = h('span', 'c-text');
    txt.innerHTML = '<span class="c-name">' + esc(label) + '</span>';
    lab.append(inp, txt);
    wrap.append(lab);
    return wrap;
  }
  var MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>';
  function numberFill(spec, value, onChange, opts) {
    opts = opts || {};
    var row = h('div', 'fill');
    if (opts.prefix) row.append(h('span', 'prefix', esc(opts.prefix)));
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.min = spec.min; inp.max = spec.max; inp.step = spec.step;
    inp.value = value;
    inp.disabled = !!opts.disabled;
    inp.setAttribute('aria-label', opts.aria || spec.label);
    inp.dataset.fid = spec.key;
    var commit = function (v) {
      v = Math.round(clamp(Number(v), spec.min, spec.max) / spec.step) * spec.step;
      if (!isFinite(v)) v = spec.default;
      inp.value = v;
      onChange(v);
    };
    inp.onchange = function () { commit(inp.value); };
    inp.onkeydown = function (e) { if (e.key === 'Enter') commit(inp.value); };
    row.append(inp);
    if (spec.unit) row.append(h('span', 'unit', esc(spec.unit)));
    var steps = h('span', 'steps');
    [[-1, MINUS, 'Decrease'], [1, PLUS, 'Increase']].forEach(function (d) {
      var b = h('button', 'step', d[1]);
      b.type = 'button';
      b.disabled = !!opts.disabled;
      b.dataset.fid = spec.key + ':' + d[0];
      b.setAttribute('aria-label', d[2] + ' ' + (opts.aria || spec.label).toLowerCase());
      b.onclick = function () { commit(Number(inp.value) + d[0] * spec.step * (spec.key === 'min_note_ms' ? 2 : 1)); };
      steps.append(b);
    });
    row.append(steps);
    if (opts.suffix) row.append(h('span', 'suffix', esc(opts.suffix)));
    return row;
  }

  function renderForm() {
    fieldNo = 0;
    var e = state.eng, o = state.out;
    var engBox = $('engineFields');
    engBox.innerHTML = '';

    // 1. Engine
    var f1 = fieldset('Engine');
    f1.append(radioGroup('engine', ENGINES.map(function (x) {
      return { value: x.id, label: x.name, desc: ENGINE_NOTES[x.id], isDefault: x.id === INST.default_engine };
    }), e.engine, function (v) { setEng('engine', v); }, { markDefault: true }));
    if (e.engine === 'aria') { var en = h('p', 'engine-note'); en.textContent = 'Aria-AMT has no settings of its own.'; f1.append(en); }
    engBox.append(f1);

    // 2. Analysis views (Ensemble and Transkun)
    var vs = specOf('views');
    var viewsOff = e.engine === 'aria';
    var f2 = fieldset(vs.label, 'Ensemble, Transkun', viewsOff);
    f2.append(radioGroup('views', vs.choices.map(function (c) { return { value: c.value, label: c.label, isDefault: c.value === vs.default }; }),
      e.views, function (v) { setEng('views', v); }, { disabled: viewsOff, markDefault: true }));
    f2.append(helpLine(HELP.views));
    engBox.append(f2);

    // 3. Second opinion (Ensemble)
    var rs = specOf('rescue');
    var rescueOff = e.engine !== 'ensemble';
    var f3 = fieldset(rs.label, 'Ensemble only', rescueOff);
    f3.append(radioGroup('rescue', rs.choices.map(function (c) { return { value: c.value, label: c.label, isDefault: c.value === rs.default }; }),
      e.rescue, function (v) { setEng('rescue', v); }, { inline: true, disabled: rescueOff, markDefault: true }));
    f3.append(helpLine(HELP.rescue));
    engBox.append(f3);

    // Transkun V2's own settings
    var tkOff = e.engine !== 'transkun';
    var sub = h('div', 'subgroup');
    sub.append(h('p', 'subgroup-title', 'Transkun V2 only'));
    var vr = specOf('velocity');
    var f4 = fieldset(vr.label, '', tkOff);
    f4.append(radioGroup('velocity_read', vr.choices.map(function (c) { return { value: c.value, label: c.label, isDefault: c.value === vr.default }; }),
      e.velocity, function (v) { setEng('velocity', v); }, { inline: true, disabled: tkOff, markDefault: true }));
    f4.append(helpLine(HELP.velocity));
    sub.append(f4);
    var mf = specOf('merge_fix');
    var f5 = fieldset(mf.label, '', tkOff);
    f5.append(checkbox('merge_fix', 'On', e.merge_fix, function (v) { setEng('merge_fix', v); }, tkOff));
    f5.append(helpLine(HELP.merge_fix));
    sub.append(f5);
    engBox.append(sub);

    // ---- MIDI file
    var outBox = $('outputFields');
    outBox.innerHTML = '';
    var spec = function (k) { return OUT.find(function (x) { return x.key === k; }); };

    var ps = spec('pedal');
    var f6 = fieldset(ps.label);
    f6.append(radioGroup('pedal', ps.choices.map(function (c) { return { value: c.value, label: c.label, isDefault: c.value === ps.default }; }),
      o.pedal, function (v) { setOut('pedal', v); }, { markDefault: true }));
    f6.append(helpLine(HELP.pedal));
    outBox.append(f6);

    var ss = spec('soft_pedal');
    var f7 = fieldset(ss.label);
    f7.append(checkbox('soft_pedal', 'Include una corda events', o.soft_pedal, function (v) { setOut('soft_pedal', v); }));
    outBox.append(f7);

    var ds = spec('velocity');
    var f8 = fieldset(ds.label);
    f8.append(radioGroup('dynamics', ds.choices.map(function (c) { return { value: c.value, label: c.label, isDefault: c.value === ds.default }; }),
      o.velocity, function (v) { setOut('velocity', v); }, { inline: true, markDefault: true }));
    var fv = spec('flat_velocity');
    var flatOff = o.velocity !== 'flat';
    var fillRow = numberFill(fv, o.flat_velocity, function (v) { setOut('flat_velocity', v); }, { prefix: 'If Flat, velocity', disabled: flatOff, aria: 'Flat velocity' });
    if (flatOff) fillRow.style.color = 'var(--ink-3)';
    f8.append(fillRow);
    f8.append(helpLine(HELP.velocity_out));
    outBox.append(f8);

    var ms = spec('min_note_ms');
    var f9 = fieldset(ms.label);
    f9.append(numberFill(ms, o.min_note_ms, function (v) { setOut('min_note_ms', v); }));
    f9.append(helpLine(HELP.min_note_ms));
    outBox.append(f9);

    var ts = spec('tempo');
    var f10 = fieldset(ts.label);
    f10.append(numberFill(ts, o.tempo, function (v) { setOut('tempo', v); }));
    f10.append(helpLine(HELP.tempo));
    outBox.append(f10);

    updateOutNote();
    updateReconvert();
  }
  function rerenderForm() {
    var a = document.activeElement;
    var fid = a && a.dataset ? a.dataset.fid : null;
    renderForm();
    if (fid) {
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }
  function setEng(k, v) {
    state.eng[k] = v;
    rerenderForm();
    renderHome();
  }
  var noteTimer = 0;
  function setOut(k, v) {
    state.out[k] = v;
    rerenderForm();
    applyOutputToScore();
    if (state.view === 'result') {
      renderMeta(true);
      var note = $('outNote');
      $('outNoteText').textContent = 'Updated the open result.';
      note.classList.add('is-updated');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { note.classList.remove('is-updated'); updateOutNote(); }, 1800);
    }
  }
  function applyOutputToScore() {
    if (!score) return;
    var o = state.out;
    score.setOptions({ pedal: o.pedal, soft: !!o.soft_pedal, flat: o.velocity === 'flat', flatVel: o.flat_velocity, minMs: o.min_note_ms, tempo: o.tempo, mix: state.mix });
  }
  function updateOutNote() {
    if ($('outNote').classList.contains('is-updated')) return;
    $('outNoteText').textContent = state.view === 'result' ? 'Changes update the open result instantly.' : 'Applied when the MIDI file is written.';
  }
  function engDiffers() {
    var a = state.eng, b = state.jobEng;
    return Object.keys(a).some(function (k) { return String(a[k]) !== String(b[k]); });
  }
  function updateReconvert() {
    var show = state.view === 'result' && engDiffers();
    $('reconvertBtn').hidden = !show;
    $('reconvertBtn').closest('.sheet-foot').classList.toggle('has-action', show);
  }

  var lastOpener = null;
  function overlayMode() { return !(state.view === 'result' && window.matchMedia('(min-width: 1100px)').matches); }
  // Over the page (home, progress, narrow windows) the form is a modal leaf; beside the result it is a panel.
  function syncSheetMode() {
    var sheet = $('sheet'), modal = state.adv && overlayMode();
    $('scrim').hidden = !modal;
    document.body.classList.toggle('adv-side', state.adv && !modal);
    document.body.classList.toggle('adv-modal', modal);
    if (modal) { sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); }
    else { sheet.removeAttribute('role'); sheet.removeAttribute('aria-modal'); }
    return modal;
  }
  function setAdv(open) {
    state.adv = open;
    $('sheet').hidden = !open;
    $('openAdv').setAttribute('aria-expanded', String(open));
    var modal = syncSheetMode();
    if (open) {
      lastOpener = document.activeElement;
      // Focus the leaf itself, so the first Tab reaches Close without a ring flashing on open.
      if (modal) $('sheet').focus({ preventScroll: true });
    } else if (lastOpener && lastOpener.focus && document.body.contains(lastOpener)) {
      lastOpener.focus({ preventScroll: true });
    }
    markSwitcher();
    if (score) requestAnimationFrame(function () { score.resize(); });
  }
  function trapTab(e) {
    if (e.key !== 'Tab' || !state.adv || !overlayMode()) return;
    var items = Array.prototype.filter.call($('sheet').querySelectorAll('button, input, [tabindex="0"]'), function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1], a = document.activeElement;
    if (e.shiftKey && (a === first || a === $('sheet'))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    else if (!$('sheet').contains(a)) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------------ wiring
  function goHome() { stopPlay(); setAdv(false); showView('home'); }
  $('homeLink').onclick = function (e) { e.preventDefault(); goHome(); };
  $('drop').onclick = function () { startConversion(M.file.name); };
  $('changeEngine').onclick = function () { setAdv(true); };
  $('openAdv').onclick = function () { setAdv(!state.adv); };
  $('closeAdv').onclick = function () { setAdv(false); };
  $('scrim').onclick = function () { setAdv(false); };
  $('cancelBtn').onclick = function () { stopProgress(); showView('home'); toast('Conversion cancelled.'); };
  $('newBtn').onclick = goHome;
  $('saveBtn').onclick = function () {
    var mid = state.fileName.replace(/\.[^.]+$/, '') + '.mid';
    toast('Saved “' + mid + '”', 'Show in folder', function () { toast('Opened Music › MIDI Converter in File Explorer.'); });
  };
  $('playBtn').onclick = togglePlay;
  $('zoomIn').onclick = function () { if (score) score.zoom(1.3); };
  $('zoomOut').onclick = function () { if (score) score.zoom(1 / 1.3); };
  Array.prototype.forEach.call($('mixSeg').querySelectorAll('button'), function (b) {
    b.onclick = function () { setMix(b.dataset.mix); };
    b.onkeydown = function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var all = Array.prototype.slice.call($('mixSeg').querySelectorAll('button'));
      var i = all.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1);
      var nb = all[(i + all.length) % all.length];
      nb.focus(); setMix(nb.dataset.mix);
      e.preventDefault();
    };
  });
  $('resetBtn').onclick = function () {
    state.eng = Object.assign({}, ENG_DEFAULTS);
    state.out = Object.assign({}, OUT_DEFAULTS);
    renderForm(); renderHome(); applyOutputToScore();
    if (state.view === 'result') renderMeta(true);
    toast('Options reset to the defaults.');
  };
  $('reconvertBtn').onclick = function () { setAdv(false); startConversion(state.fileName, { rerun: true }); };

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape' && state.adv) { setAdv(false); return; }
    trapTab(e);
    if (state.view !== 'result' || typing) return;
    if (e.key === ' ' && (e.target === document.body || e.target === $('score'))) { e.preventDefault(); togglePlay(); }
    if (e.target === $('score') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      seek(state.time + (e.key === 'ArrowRight' ? 5 : -5), true);
    }
    if (e.target === $('score') && (e.key === '+' || e.key === '=' || e.key === '-')) score.zoom(e.key === '-' ? 1 / 1.3 : 1.3);
  });

  // dragging a file onto the window
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { dragDepth++; $('dropVeil').hidden = false; } });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropVeil').hidden = true; });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    $('dropVeil').hidden = true;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    setAdv(false);
    startConversion(f ? f.name : M.file.name);
  });
  window.addEventListener('resize', function () { if (state.adv) syncSheetMode(); });

  // reviewer state switcher
  function go(name) {
    stopProgress();
    if (name === 'home') { setAdv(false); showView('home'); }
    else if (name === 'progress') { setAdv(false); showProgressStatic(); }
    else if (name === 'result') { setAdv(false); state.fileName = M.job.filename; state.time = 12; openResult(false); }
    else if (name === 'advanced') { state.fileName = M.job.filename; state.time = 12; openResult(false); setAdv(true); }
    markSwitcher();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#switcher button'), function (b) { b.onclick = function () { go(b.dataset.go); }; });

  // ------------------------------------------------------------------ boot
  // No transitions while the first state is laid out, so nothing fades in on load.
  document.documentElement.classList.add('booting');
  setTimeout(function () { document.documentElement.classList.remove('booting'); }, 300);
  renderHome();
  renderForm();
  updateTime();
  var initial = params.get('state');
  go(['home', 'progress', 'result', 'advanced'].indexOf(initial) >= 0 ? initial : 'home');
})();
