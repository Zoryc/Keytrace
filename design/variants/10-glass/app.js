/* MIDI Converter — "Glass" prototype. Classic script, no backend: everything runs on window.MOCK. */
(function () {
  'use strict';

  var M = window.MOCK;
  var R = window.MCRoll;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var D = M.duration || M.job.stats.duration || 60;
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  var isBlack = function (p) { return !!BLACK[p % 12]; };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var fmtTime = R.fmtTime;
  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function lowerBound(notes, t) {
    var lo = 0, hi = notes.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (notes[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* ================================================================== luminous piano roll
     Extends the app's real PianoRoll (interaction, hit-testing, zoom, seek) and replaces the
     drawing: transparent canvas over a frosted card, pitch-tinted glowing notes, lit keys,
     an optional waveform layer for the Original / Both listening modes. */
  class GlassRoll extends R.PianoRoll {
    constructor(el, opts) {
      opts = opts || {};
      super(el, opts);
      this.mini = !!opts.mini;
      this.fitSec = opts.fitSec || 0;
      this.keyW = this.mini ? 0 : 52;
      this.axisH = this.mini ? 0 : 26;
      this.pedalH = this.mini ? 12 : 26;
      this.wave = opts.wave || null;
      this.mix = 'both';
      this.showPlayhead = !this.mini;
      if (!this.mini) this.canvas.addEventListener('pointermove', (e) => this._richTip(e));
      this._readColors();
    }

    refreshTheme() { this._readColors(); this._resize(); }

    // Resizing a canvas clears it. Repaint in the same frame instead of waiting for the next
    // animation frame, so the roll never flashes empty (or captures empty in a screenshot).
    _resize() { super._resize(); if (this.c && this.keyW != null) this._draw(); }
    setMix(m) { this.mix = m; this.requestDraw(); }

    _fit() {
      var w = this.el.clientWidth;
      if (!this._needsFit || w <= this.keyW + 10) return;
      this._needsFit = false;
      var viewW = w - this.keyW;
      this.pxPerSec = this.fitSec ? viewW / this.fitSec : Math.min(160, Math.max(viewW / Math.min(this.duration, 24), 20));
    }

    _readColors() {
      var cs = getComputedStyle(document.documentElement);
      var v = function (n) { return cs.getPropertyValue(n).trim(); };
      var num = function (n) { return parseFloat(v(n)); };
      this.c = {
        row: v('--r-row'), octave: v('--r-octave'), grid: v('--r-grid'), text: v('--r-text'),
        keyW: v('--r-key-w'), keyB: v('--r-key-b'), keyLine: v('--r-key-line'),
        pedalA: v('--r-pedal-a'), pedalB: v('--r-pedal-b'), soft: v('--r-soft'),
        playhead: v('--r-playhead'), ink: v('--r-ink'), wave: v('--r-wave'), waveA: num('--r-wave-a'),
        glow: num('--r-glow'), glowBlur: num('--r-glow-blur'), tail: num('--r-tail'),
      };
      var lo = num('--r-hue-lo'), hi = num('--r-hue-hi'), sat = num('--r-sat'), lum = num('--r-lum');
      this.pc = []; this.pcHi = []; this.pcGlow = [];
      for (var p = 0; p < 128; p++) {
        var f = Math.max(0, Math.min(1, (p - 30) / 70));
        var h = lo + (hi - lo) * f;
        this.pc[p] = 'hsl(' + h + ' ' + sat + '% ' + lum + '%)';
        this.pcHi[p] = 'hsl(' + h + ' ' + Math.min(100, sat + 6) + '% ' + Math.min(90, lum + 14) + '%)';
        this.pcGlow[p] = 'hsla(' + h + ', ' + sat + '%, ' + lum + '%, ' + this.c.glow + ')';
      }
      this.font = getComputedStyle(document.body).fontFamily;
    }

    _active() {
      var m = new Map();
      var notes = this.notes, t = this.time;
      if (!notes.length || !this.showPlayhead) return m;
      for (var i = lowerBound(notes, t - this.maxSpan - 0.01); i < notes.length; i++) {
        var n = notes[i];
        if (n[0] > t) break;
        if (t <= n[1]) m.set(n[2], 2);
        else if (t <= (n[4] || n[1]) && !m.has(n[2])) m.set(n[2], 1);
      }
      return m;
    }

    _drawKeys() {
      if (!this.c) return;
      var ctx = this.keys.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var w = this.keyW, h = this.el.clientHeight;
      ctx.clearRect(0, 0, Math.max(1, w) + 1, h);
      if (w < 4) return;
      var c = this.c, rh = this._rowH(), top = this.axisH, nh = this._noteH();
      var act = this._active();
      ctx.fillStyle = c.keyW;
      ctx.fillRect(0, top, w - 1, nh);
      var p, y, a;
      for (p = this.lo; p <= this.hi; p++) {
        if (isBlack(p)) continue;
        y = this._rowY(p);
        a = act.get(p);
        if (a) {
          ctx.save();
          ctx.globalAlpha = a === 2 ? 0.92 : 0.38;
          ctx.fillStyle = this.pc[p];
          ctx.shadowColor = this.pcGlow[p];
          ctx.shadowBlur = 10;
          ctx.fillRect(0, y, w - 1, rh);
          ctx.restore();
        }
        if (!isBlack(p + 1) && p < this.hi) { ctx.fillStyle = c.keyLine; ctx.fillRect(0, y - 0.5, w - 1, 1); }
      }
      for (p = this.lo; p <= this.hi; p++) {
        if (!isBlack(p)) continue;
        y = this._rowY(p);
        a = act.get(p);
        ctx.save();
        if (a) { ctx.fillStyle = this.pc[p]; ctx.globalAlpha = a === 2 ? 1 : 0.6; ctx.shadowColor = this.pcGlow[p]; ctx.shadowBlur = 10; }
        else ctx.fillStyle = c.keyB;
        ctx.beginPath();
        ctx.roundRect(0, y + 0.5, w * 0.6, Math.max(1, rh - 1), [0, 3, 3, 0]);
        ctx.fill();
        ctx.restore();
      }
      if (rh >= 3) { // only every C is labelled, so small rows still have room
        ctx.fillStyle = c.text;
        ctx.font = '600 ' + Math.min(10.5, Math.max(8.5, rh + 1)) + 'px ' + this.font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        for (p = this.lo; p <= this.hi; p++) if (p % 12 === 0) ctx.fillText(R.noteName(p), w - 6, this._rowY(p) + rh / 2);
      }
      ctx.fillStyle = c.keyLine;
      ctx.fillRect(w - 1, top, 1, nh);
      ctx.fillStyle = c.text;
      ctx.font = '600 10px ' + this.font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('Pedal', w - 6, h - this.pedalH / 2);
    }

    _draw() {
      if (!this.c) return;
      var ctx = this.canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var W = this._viewW(), H = this.el.clientHeight, rh = this._rowH(), c = this.c;
      var t0 = this.scrollX, t1 = t0 + W / this.pxPerSec;
      var top = this.axisH, laneTop = H - this.pedalH;
      ctx.clearRect(0, 0, W + 2, H);
      var p, y, k, t, x;

      // pitch rows
      for (p = this.lo; p <= this.hi; p++) {
        y = this._rowY(p);
        if (isBlack(p)) { ctx.fillStyle = c.row; ctx.fillRect(0, y, W, rh); }
        if (p % 12 === 0 && p > this.lo && !this.mini) { ctx.fillStyle = c.octave; ctx.fillRect(0, Math.round(y + rh) - 0.5, W, 1); }
      }

      // time grid
      if (!this.mini) {
        var steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
        var step = 600;
        for (k = 0; k < steps.length; k++) if (steps[k] * this.pxPerSec >= 84) { step = steps[k]; break; }
        ctx.font = '500 11px ' + this.font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        for (k = Math.floor(t0 / step); k * step <= t1; k++) {
          t = k * step;
          x = Math.round(this._x(t)) + 0.5;
          ctx.fillStyle = c.grid;
          ctx.fillRect(x - 0.5, top, 1, laneTop - top);
          ctx.fillStyle = c.text;
          ctx.fillRect(x - 0.5, top - 5, 1, 5);
          var lbl = step < 1 ? fmtTime(t, true) : fmtTime(t);
          // never draw a label that would be cut off by the card edge
          if (x + 5 + ctx.measureText(lbl).width <= W - 4) ctx.fillText(lbl, x + 5, top / 2);
        }
        ctx.fillStyle = c.grid;
        ctx.fillRect(0, top - 1, W, 1);
      }

      // original recording (waveform) layer
      var noteK = 1;
      if (this.wave && this.mix !== 'midi' && !this.mini) {
        var wv = this.wave, hop = wv.hop_seconds, pk = wv.peak;
        var orig = this.mix === 'original';
        var mid = top + (laneTop - top) / 2, amp = (laneTop - top) * (orig ? 0.47 : 0.42);
        var alpha = orig ? c.waveA * 2.4 : c.waveA;
        var g = ctx.createLinearGradient(0, mid - amp, 0, mid + amp);
        g.addColorStop(0, 'rgba(' + c.wave + ',' + (alpha * 0.25) + ')');
        g.addColorStop(0.5, 'rgba(' + c.wave + ',' + alpha + ')');
        g.addColorStop(1, 'rgba(' + c.wave + ',' + (alpha * 0.25) + ')');
        var pts = [];
        for (x = 0; x <= W; x += 2) {
          var ta = t0 + x / this.pxPerSec, tb = t0 + (x + 2) / this.pxPerSec;
          var i0 = Math.max(0, Math.floor(ta / hop)), i1 = Math.min(pk.length - 1, Math.floor(tb / hop));
          var val = 0;
          for (var ii = i0; ii <= i1; ii++) if (pk[ii] > val) val = pk[ii];
          if (ta > D) val = 0;
          pts.push([x, val]);
        }
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (k = 0; k < pts.length; k++) ctx.lineTo(pts[k][0], mid - pts[k][1] * amp);
        for (k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], mid + pts[k][1] * amp);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
        if (orig) noteK = 0.42;
      }

      // pedal lane
      if (!this.mini) { ctx.fillStyle = c.grid; ctx.fillRect(0, laneTop, W, 1); }
      var pg = ctx.createLinearGradient(0, 0, W, 0);
      pg.addColorStop(0, c.pedalA);
      pg.addColorStop(1, c.pedalB);
      var pads = this.mini ? 2 : 6;
      for (k = 0; k < this.pedals.length; k++) {
        var pd = this.pedals[k];
        if (pd[1] < t0 || pd[0] > t1) continue;
        var px0 = this._x(pd[0]), px1 = this._x(pd[1]);
        if (pd[2] === 64) {
          ctx.fillStyle = pg;
          ctx.beginPath();
          ctx.roundRect(px0, laneTop + pads, Math.max(3, px1 - px0 - 1), this.pedalH - pads * 2 - (this.mini ? 0 : 2), 99);
          ctx.fill();
        } else {
          ctx.fillStyle = c.soft;
          ctx.fillRect(px0, H - (this.mini ? 1.5 : 4), Math.max(2, px1 - px0), this.mini ? 1.5 : 2);
        }
      }

      // notes
      var notes = this.notes;
      var nh = this.mini ? Math.max(1.6, rh * 0.9) : Math.max(1, rh - (rh > 6 ? 2 : rh > 3 ? 1 : 0.3));
      var rad = Math.min(nh / 2, 4);
      var tNow = this.time;
      var glowOn = c.glowBlur > 0 && !this.mini;
      ctx.save();
      for (var i = lowerBound(notes, t0 - this.maxSpan - 0.01); i < notes.length; i++) {
        var n = notes[i];
        var s = n[0], e = n[1], pp = n[2], vel = n[3];
        if (s > t1) break;
        var sound = n[4] || e;
        if (sound < t0 || pp < this.lo || pp > this.hi) continue;
        y = this._rowY(pp) + (rh - nh) / 2;
        var x0 = this._x(s), x1 = this._x(e), xs = this._x(sound);
        var col = this.pc[pp];
        if (xs > x1 + 1) {
          ctx.shadowBlur = 0;
          ctx.globalAlpha = c.tail * noteK;
          ctx.fillStyle = col;
          var th = Math.max(1, Math.min(2, nh * 0.28));
          ctx.fillRect(x1, y + nh / 2 - th / 2, xs - x1, th);
        }
        var conf = n[5] == null ? 1 : n[5];
        var active = this.showPlayhead && tNow >= s && tNow <= e;
        var a = (this.mini ? 0.6 + 0.4 * Math.min(1, vel / 100) : 0.34 + 0.66 * Math.min(1, vel / 100)) * noteK;
        ctx.beginPath();
        ctx.roundRect(x0, y, Math.max(2.5, x1 - x0), nh, rad);
        if (conf < 0.6) {
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 0.9 * noteK;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.globalAlpha = active ? Math.max(noteK, 0.9) : a;
          if (glowOn) { ctx.shadowColor = this.pcGlow[pp]; ctx.shadowBlur = active ? c.glowBlur * 2.2 : c.glowBlur * a; }
          ctx.fillStyle = active ? this.pcHi[pp] : col;
          ctx.fill();
          ctx.shadowBlur = 0;
          if (nh >= 6 && x1 - x0 > 8) {
            ctx.globalAlpha = 0.5 * (active ? 1 : a);
            ctx.fillStyle = '#fff';
            ctx.fillRect(x0 + rad * 0.7, y + 1, x1 - x0 - rad * 1.4, 1);
          }
        }
        if (this.hover === n) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = c.ink;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.restore();

      // playhead with a soft trailing beam
      if (this.showPlayhead) {
        var ph = this._x(this.time);
        if (ph >= -60 && ph <= W + 2) {
          ctx.save();
          var beam = ctx.createLinearGradient(ph - 56, 0, ph, 0);
          beam.addColorStop(0, 'rgba(' + c.wave + ',0)');
          beam.addColorStop(1, 'rgba(' + c.wave + ',' + (this.playing ? 0.16 : 0.08) + ')');
          ctx.fillStyle = beam;
          ctx.fillRect(ph - 56, top, 56, laneTop - top);
          ctx.shadowColor = c.playhead;
          ctx.shadowBlur = 10;
          ctx.fillStyle = c.playhead;
          ctx.fillRect(Math.round(ph) - 0.75, top, 1.5, H - top);
          ctx.beginPath();
          ctx.roundRect(ph - 5, top - 9, 10, 10, [5, 5, 2, 2]);
          ctx.fill();
          ctx.restore();
        }
      }
      this._drawKeys();
    }

    _richTip(e) {
      var n = this.hover;
      if (!n || this.tip.hidden) return;
      var rect = this.canvas.getBoundingClientRect();
      var x = e.clientX - rect.left + this.keyW, y = e.clientY - rect.top;
      var s = n[0], end = n[1], p = n[2], v = n[3], snd = n[4] || end, conf = n[5] == null ? 1 : n[5];
      var dur = end - s, held = Math.max(0, snd - end);
      var len = function (d) { return d < 1 ? Math.round(d * 1000) + ' ms' : d.toFixed(2) + ' s'; };
      this.tip.innerHTML =
        '<div class="tip-head"><b>' + R.noteName(p) + '</b><span>MIDI ' + p + ' &middot; at ' + fmtTime(s, true) + '</span></div>' +
        '<div class="tip-row"><span>Velocity</span><span><i class="tip-bar"><i style="width:' + Math.round(v / 127 * 100) + '%"></i></i><b>' + v + '</b></span></div>' +
        '<div class="tip-row"><span>Key held</span><b>' + len(dur) + '</b></div>' +
        (held > 0.01 ? '<div class="tip-row"><span>Pedal holds it</span><b>+' + len(held) + '</b></div>' : '') +
        '<div class="tip-row"><span>Confidence</span><b>' + (conf >= 0.995 ? 'Sure' : Math.round(conf * 100) + '% sure') + '</b></div>';
      var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      var lx = x + 16;
      if (lx + tw > this.el.clientWidth - 6) lx = x - 16 - tw;
      var ty = Math.max(4, Math.min(y - th / 2, this.el.clientHeight - th - 4));
      this.tip.style.left = lx + 'px';
      this.tip.style.top = ty + 'px';
    }
  }

  /* ================================================================== settings */
  var inst = M.info.instruments[0];
  var engines = inst.engines;
  var outSpecs = M.info.output_options;
  var DEPENDS = { flat_velocity: function (o) { return o.velocity === 'flat'; } };
  var ACC = { ensemble: 98.61, transkun: 98.38, aria: 97.54 }; // README: onset F1, clean audio
  var TAG = {
    ensemble: 'Most accurate. Transkun and Aria together.',
    transkun: 'About 4× faster, almost as accurate.',
    aria: 'Alone, for comparison.',
  };
  var SPEED = {
    ensemble: 'About 20–25 s for a 2-minute piece on this GPU',
    transkun: 'About 4× faster than Ensemble on this GPU',
    aria: 'Aria-AMT alone, for comparison',
  };

  var S = {
    view: 'home',
    engine: inst.default_engine,
    eopts: {},
    out: {},
    mix: 'both',
    time: 0,
    playing: false,
    job: null, // the result on screen: { filename, midi, engine, eopts }
    recent: M.recent.map(function (r) { return Object.assign({}, r); }),
    sim: null,
  };

  function engineById(id) { return engines.find(function (e) { return e.id === id; }) || engines[0]; }
  function shortName(e) { return e.name.replace(/\s*\(.*\)\s*$/, ''); }
  function eVals(id) {
    var e = engineById(id), o = {}, ov = S.eopts[id] || {};
    e.options.forEach(function (s) { o[s.key] = ov[s.key] != null ? ov[s.key] : s.default; });
    return o;
  }
  function oVals() {
    var o = {};
    outSpecs.forEach(function (s) { o[s.key] = S.out[s.key] != null ? S.out[s.key] : s.default; });
    return o;
  }
  function splitLabel(label) {
    var m = String(label).match(/^(.*?)\s*\((.*)\)$/);
    return m ? { main: m[1], sub: m[2] } : { main: label, sub: '' };
  }
  function viewsLabel(id) {
    var e = engineById(id), spec = e.options.find(function (o) { return o.key === 'views'; });
    if (!spec) return '';
    var ch = spec.choices.find(function (c) { return c.value === eVals(id).views; });
    var sl = splitLabel(ch ? ch.label : '');
    return sl.sub && /x$/.test(sl.sub) ? sl.main + ' ' + sl.sub : sl.main;
  }
  function engineSummary() {
    var e = engineById(S.engine), vl = viewsLabel(S.engine);
    return shortName(e) + (vl ? ' · ' + vl : '');
  }

  /* ================================================================== derived result data */
  function derive() {
    var o = oVals();
    var notes = M.notes.filter(function (n) { return !(o.min_note_ms > 0) || (n[1] - n[0]) * 1000 >= o.min_note_ms; })
      .map(function (n) { return n.slice(); });
    if (o.pedal === 'extend') notes.forEach(function (n) { n[1] = Math.max(n[1], n[4] || n[1]); n[4] = n[1]; });
    else if (o.pedal === 'none') notes.forEach(function (n) { n[4] = n[1]; });
    if (o.velocity === 'flat') notes.forEach(function (n) { n[3] = o.flat_velocity; });
    var pedals = M.pedals.filter(function (p) { return p[2] === 64 ? o.pedal === 'cc' : !!o.soft_pedal; });
    return {
      notes: notes, pedals: pedals, duration: D, o: o,
      sustain: pedals.filter(function (p) { return p[2] === 64; }).length,
      soft: pedals.filter(function (p) { return p[2] === 67; }).length,
    };
  }

  /* ================================================================== views */
  var app = $('app');
  function show(view) {
    S.view = view;
    app.dataset.view = view;
    ['home', 'progress', 'result'].forEach(function (v) {
      var el = $('view' + v[0].toUpperCase() + v.slice(1));
      var hide = v !== view;
      if (el.hidden !== hide) {
        el.hidden = hide;
        el.classList.remove('enter');
        if (!hide && app.classList.contains('ready')) { void el.offsetWidth; el.classList.add('enter'); }
      }
    });
    if (view !== 'result') setPlaying(false);
    if (view !== 'progress') stopSim();
    markSwitcher();
  }

  /* ================================================================== toast */
  var toastTimer = 0;
  function toast(msg, action, ok) {
    var t = $('toast');
    t.innerHTML = '';
    if (ok !== false) {
      var i = document.createElement('span');
      i.className = 'ok';
      i.innerHTML = CHECK_SVG;
      t.append(i);
    }
    var s = document.createElement('span');
    s.id = 'toastText';
    s.textContent = msg;
    t.append(s);
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.onclick = function () { t.classList.remove('show'); action.run(); };
      t.append(b);
    }
    t.classList.toggle('has-action', !!action);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, action ? 6000 : 2800);
  }

  /* ================================================================== home */
  function renderHomeEngine() {
    $('engineSummary').textContent = engineSummary();
    $('engSpeed').textContent = SPEED[S.engine] || '';
  }

  function ringSvg(frac) {
    var r = 15, c = 2 * Math.PI * r;
    return '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="' + r + '"/>' +
      '<circle class="ring-fg" cx="18" cy="18" r="' + r + '" stroke-dasharray="' + (c * frac).toFixed(1) + ' 999" style="stroke:var(--accent);stroke-width:3"/></svg>';
  }
  var ICON = {
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    queued: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 2"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
    del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  function renderRecent() {
    var list = $('recentList');
    list.innerHTML = '';
    var items = S.recent;
    $('recentEmpty').hidden = items.length > 0;
    $('recentFoot').hidden = items.length === 0;
    list.hidden = items.length === 0;
    var active = items.filter(function (j) { return j.status === 'running' || j.status === 'queued'; }).length;
    $('recentCount').textContent = items.length ? (active ? active + ' in progress' : items.length + (items.length === 1 ? ' file' : ' files')) : '';
    items.forEach(function (job) {
      var li = document.createElement('li');
      li.dataset.id = job.id;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'r-main';
      var icon, meta, side, metaCls = 'r-meta';
      if (job.status === 'done') {
        icon = '<span class="r-icon done">' + ICON.done + '</span>';
        meta = fmtTime(job.duration) + ' · ' + Number(job.notes).toLocaleString('en-US') + ' notes';
        side = '<span class="r-when">' + esc(job.when || '') + '</span>';
      } else if (job.status === 'running') {
        icon = '<span class="r-icon running">' + ringSvg(job.progress) + '</span>';
        meta = fmtTime(job.duration) + ' · Converting';
        side = '<span class="pill running"><i class="dot"></i>' + Math.round(job.progress * 100) + '%</span>';
      } else if (job.status === 'queued') {
        icon = '<span class="r-icon queued">' + ICON.queued + '</span>';
        meta = fmtTime(job.duration) + ' · Starts next';
        side = '<span class="pill queued">Waiting</span>';
      } else {
        icon = '<span class="r-icon error">' + ICON.error + '</span>';
        meta = job.error || 'The conversion failed.';
        metaCls += ' err';
        side = '<span class="pill error">Failed</span>';
      }
      // in a narrow window the date moves into the meta line so the name keeps its room
      var inlineWhen = job.status === 'done' && job.when ? '<span class="r-when-inline"> · ' + esc(job.when) + '</span>' : '';
      b.innerHTML = icon + '<span class="r-text"><span class="r-name">' + esc(job.filename) + '</span><span class="' + metaCls + '">' + esc(meta) + inlineWhen + '</span></span>' + side;
      b.title = job.filename;
      b.onclick = function () { openRecent(job); };
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'r-del';
      del.setAttribute('aria-label', 'Remove ' + job.filename + ' from Recent');
      del.innerHTML = ICON.del;
      del.onclick = function (e) { e.stopPropagation(); removeRecent(job.id); };
      li.append(b, del);
      list.append(li);
    });
  }

  function removeRecent(id) {
    var idx = S.recent.findIndex(function (j) { return j.id === id; });
    if (idx < 0) return;
    var job = S.recent.splice(idx, 1)[0];
    renderRecent();
    toast('Removed “' + job.filename + '”', {
      label: 'Undo',
      run: function () { S.recent.splice(Math.min(idx, S.recent.length), 0, job); renderRecent(); },
    });
  }

  function openRecent(job) {
    if (job.status === 'done') {
      if (job.id === M.job.id) openResult({ time: 0 });
      else toast('This prototype includes one example result: the Schubert Impromptu.', null, false);
      return;
    }
    if (job.status === 'running') {
      var windows = windowsFor(job.duration);
      var w = Math.max(1, Math.min(windows, Math.round((job.progress - 0.06) / 0.64 * windows) + 1));
      showProgress({
        name: job.filename, meta: metaFor(job.filename), status: 'running', progress: job.progress,
        message: 'Transcribing window ' + w + ' of ' + windows, eta: Math.round((1 - job.progress) * job.duration * 0.42),
        window: w, windows: windows, stages: stageStates(S.engine, 1),
      });
    } else if (job.status === 'queued') {
      showProgress({
        name: job.filename, meta: metaFor(job.filename), status: 'queued', progress: 0,
        message: 'Waiting · 1 conversion ahead', eta: null, etaText: 'Starts when the current conversion finishes',
        window: 0, windows: windowsFor(job.duration), stages: stageStates(S.engine, 0, true),
      });
    } else {
      showProgress({ name: job.filename, meta: metaFor(job.filename), status: 'error', error: job.error, id: job.id });
    }
  }

  function metaFor(name) {
    if (name === M.file.name) return M.file.format + ' · ' + M.file.size_mb + ' MB';
    var ext = (name.split('.').pop() || '').toUpperCase();
    var kind = { MP4: 'Video · AAC audio', M4A: 'M4A · AAC', WAV: 'WAV · 44.1 kHz · stereo', FLAC: 'FLAC · lossless', MP3: 'MP3' }[ext];
    return kind || ext;
  }
  function windowsFor(dur) { return Math.max(1, Math.ceil((dur - 16) / 5.5) + 1); }

  /* ================================================================== progress */
  function stageDefs(engine) {
    var v = { none: '1 view', channels: '4 views', full: '6 views' }[eVals(engine).views] || '';
    if (engine === 'ensemble') return [['decode', 'Read audio'], ['transkun', 'Transkun V2 · ' + v], ['aria', 'Aria-AMT second opinion'], ['fuse', 'Merge + write MIDI']];
    if (engine === 'transkun') return [['decode', 'Read audio'], ['transkun', 'Transkun V2 · ' + v], ['write', 'Write MIDI']];
    return [['decode', 'Read audio'], ['aria', 'Aria-AMT'], ['write', 'Write MIDI']];
  }
  function stageStates(engine, activeIdx, allPending) {
    return stageDefs(engine).map(function (d, i) {
      return { id: d[0], label: d[1], state: allPending ? 'pending' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending' };
    });
  }

  var P = null; // current progress model
  function showProgress(pr) {
    P = pr;
    show('progress');
    renderProgress();
    startWaveLoop();
  }

  function renderProgress() {
    var pr = P;
    $('pName').textContent = pr.name;
    $('pName').title = pr.name;
    $('pMeta').textContent = pr.meta || '';
    var st = $('pStatus');
    st.className = 'status-pill ' + pr.status;
    st.lastChild.textContent = { running: 'Converting', queued: 'Waiting', error: 'Failed', done: 'Done' }[pr.status];
    var err = pr.status === 'error';
    $('pLive').hidden = err;
    $('pError').hidden = !err;
    $('cancelBtn').hidden = err;
    $('retryBtn').hidden = !err;
    $('removeFailedBtn').hidden = !err;
    $('pEngine').textContent = engineById(S.engine).name + ' · ' + M.info.device.name.replace(/^NVIDIA\s+GeForce\s+/i, '');
    if (err) { $('pErrorText').textContent = pr.error || 'The conversion failed.'; return; }

    var queued = pr.status === 'queued';
    var pct = Math.round(pr.progress * 100);
    $('pPct').hidden = queued;
    $('pPctNum').textContent = pct;
    $('pMsg').textContent = pr.message;
    $('pEta').textContent = pr.etaText || (pr.eta == null ? '' : pr.eta <= 3 ? 'Almost done' : 'About ' + pr.eta + ' s left');
    var ww = $('pWaveWrap');
    ww.classList.toggle('indeterminate', queued);
    if (queued) ww.removeAttribute('aria-valuenow'); else ww.setAttribute('aria-valuenow', String(pct));

    var wl = $('pWindows');
    if (wl.children.length !== pr.windows) {
      wl.innerHTML = '';
      for (var i = 0; i < pr.windows; i++) wl.append(document.createElement('li'));
    }
    Array.prototype.forEach.call(wl.children, function (li, i) {
      li.className = i + 1 < pr.window ? 'done' : i + 1 === pr.window ? 'active' : '';
    });
    wl.style.gap = pr.windows > 24 ? '2px' : '4px';
    $('pWinCount').textContent = (pr.window || 0) + ' / ' + pr.windows;

    var sl = $('pStages');
    sl.style.gridTemplateColumns = 'repeat(' + pr.stages.length + ', minmax(0, 1fr))';
    sl.innerHTML = '';
    var firstPending = true;
    pr.stages.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'stage ' + s.state;
      var sub;
      if (s.state === 'done') sub = s.id === 'decode' ? 'Done in ' + M.job.stats.seconds_decode + ' s' : 'Done';
      else if (s.state === 'active') sub = (s.id === 'transkun' || (s.id === 'aria' && pr.stages.length === 3)) && pr.window ? 'Window ' + pr.window + ' of ' + pr.windows : 'Working…';
      else { sub = queued ? 'Waiting' : firstPending ? 'Up next' : 'Then'; firstPending = false; }
      li.innerHTML = '<span class="st-ico">' + (s.state === 'done' ? CHECK_SVG : s.state === 'active' ? '' : (i + 1)) + '</span>' +
        '<span class="st-text"><span class="st-label">' + esc(s.label) + '</span><span class="st-sub">' + esc(sub) + '</span></span>';
      if (s.state === 'active') li.setAttribute('aria-current', 'step');
      sl.append(li);
    });
  }

  var waveRaf = 0;
  function startWaveLoop() {
    cancelAnimationFrame(waveRaf);
    var loop = function (now) {
      if (S.view !== 'progress') return;
      drawWave(now);
      waveRaf = requestAnimationFrame(loop);
    };
    waveRaf = requestAnimationFrame(loop);
  }

  function drawWave(now) {
    var cv = $('pWave');
    if (!P || P.status === 'error' || !cv.clientWidth) return;
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var cs = getComputedStyle(document.documentElement);
    var lo = parseFloat(cs.getPropertyValue('--r-hue-lo')), hi = parseFloat(cs.getPropertyValue('--r-hue-hi'));
    var sat = parseFloat(cs.getPropertyValue('--r-sat')), lum = parseFloat(cs.getPropertyValue('--r-lum'));
    var glow = parseFloat(cs.getPropertyValue('--r-glow'));
    var pend = cs.getPropertyValue('--fill-2').trim();
    var pad = 14, bw = 3, gap = 2.2;
    var bars = Math.floor((w - pad * 2 + gap) / (bw + gap));
    var pk = M.waveform.peak, rms = M.waveform.rms, per = pk.length / bars;
    var frac = P.status === 'queued' ? 0 : P.progress;
    var grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
    grad.addColorStop(0, 'hsl(' + lo + ' ' + sat + '% ' + lum + '%)');
    grad.addColorStop(1, 'hsl(' + hi + ' ' + sat + '% ' + lum + '%)');
    var winLo = P.window ? (P.window - 1) / P.windows : -1, winHi = P.window ? P.window / P.windows : -1;
    var shimmer = P.status === 'running' ? (Math.sin((now || 0) / 260) + 1) / 2 : 0;
    var mid = h / 2, maxH = h - 22;
    for (var b = 0; b < bars; b++) {
      var a0 = Math.floor(b * per), a1 = Math.floor((b + 1) * per), val = 0, rv = 0;
      for (var i = a0; i < a1; i++) { if (pk[i] > val) val = pk[i]; if (rms[i] > rv) rv = rms[i]; }
      var bh = Math.max(3, Math.min(1, val * 0.55 + rv * 1.1) * maxH);
      var x = pad + b * (bw + gap), fx = (b + 0.5) / bars;
      ctx.beginPath();
      ctx.roundRect(x, mid - bh / 2, bw, bh, 1.5);
      if (fx <= frac) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.shadowColor = 'hsla(' + (lo + (hi - lo) * fx) + ', ' + sat + '%, ' + lum + '%, ' + glow + ')';
        ctx.shadowBlur = 8;
      } else {
        var inWin = fx >= winLo && fx < winHi;
        ctx.shadowBlur = 0;
        ctx.globalAlpha = inWin ? 0.35 + 0.4 * shimmer : 1;
        ctx.fillStyle = inWin ? grad : pend;
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (frac > 0 && frac < 1) {
      var sx = pad + frac * (w - pad * 2);
      ctx.save();
      ctx.shadowColor = 'hsla(' + hi + ', ' + sat + '%, ' + lum + '%, .9)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'hsl(' + (lo + (hi - lo) * frac) + ' ' + sat + '% ' + Math.min(92, lum + 10) + '%)';
      ctx.fillRect(sx - 1, 8, 2, h - 16);
      ctx.restore();
    }
  }

  // Simulated conversion: 0 → 100 % in about 3 s, then the result.
  function startConversion(name) {
    closeSheet(true);
    stopSim();
    var engine = S.engine;
    var defs = stageDefs(engine);
    var weights = engine === 'ensemble' ? [0.06, 0.64, 0.2, 0.1] : [0.08, 0.82, 0.1];
    var windows = windowsFor(D), total = 3200, t0 = performance.now();
    var fileName = name || M.file.name;
    var midiName = fileName.replace(/\.[^.]+$/, '') + '.mid';
    var tick = function () {
      var f = Math.min(1, (performance.now() - t0) / total);
      var acc = 0, idx = 0;
      for (idx = 0; idx < weights.length; idx++) { if (f < acc + weights[idx] || idx === weights.length - 1) break; acc += weights[idx]; }
      var local = Math.min(1, (f - acc) / weights[idx]);
      var id = defs[idx][0];
      var modelStage = idx === 1;
      var w = modelStage ? Math.min(windows, Math.floor(local * windows) + 1) : idx > 1 ? windows : 0;
      var msg = id === 'decode' ? 'Reading the audio' : modelStage ? 'Transcribing window ' + w + ' of ' + windows
        : id === 'aria' ? 'Getting a second opinion from Aria-AMT' : 'Writing the MIDI file';
      P = {
        name: fileName, meta: metaFor(fileName), status: 'running', progress: f, message: msg,
        eta: Math.max(1, Math.round((1 - f) * 26)), window: w, windows: windows, stages: stageStates(engine, idx),
      };
      renderProgress();
      if (f >= 1) {
        S.sim = null;
        S.recent = S.recent.filter(function (j) { return j.filename !== fileName; });
        S.recent.unshift({ id: fileName === M.file.name ? M.job.id : 'new' + Date.now(), filename: fileName, status: 'done', duration: D, notes: M.notes.length, when: 'Just now' });
        openResult({ time: 0, filename: fileName, midi: midiName });
        toast('Converted in ' + M.job.stats.seconds_total + ' s');
        return;
      }
      S.sim = setTimeout(tick, 60);
    };
    P = { name: fileName, meta: metaFor(fileName), status: 'running', progress: 0, message: 'Reading the audio', eta: 26, window: 0, windows: windows, stages: stageStates(engine, 0) };
    show('progress');
    renderProgress();
    startWaveLoop();
    S.sim = setTimeout(tick, 60);
  }
  function stopSim() { if (S.sim) { clearTimeout(S.sim); S.sim = null; } }

  function showStaticProgress() {
    var pr = M.progress;
    showProgress({
      name: M.file.name, meta: metaFor(M.file.name), status: 'running', progress: pr.progress, message: pr.message,
      eta: pr.eta_seconds, window: pr.window, windows: pr.windows,
      stages: pr.stages.map(function (s) { return { id: s.id, label: s.label, state: s.state }; }),
    });
  }

  /* ================================================================== result */
  var roll = null, preview = null;
  function ensureRoll() {
    if (roll) return;
    roll = new GlassRoll($('roll'), {
      wave: M.waveform,
      onSeek: function (t) { S.time = t; roll.setTime(t, S.playing); syncTime(); },
    });
    roll.setMix(S.mix);
  }

  var STAT_ICON = {
    time: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    notes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    pedal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20h10M9 20l1.5-9h3L15 20M10 11V5.5a2 2 0 0 1 4 0V11"/></svg>',
    engine: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2.4-2-.8 2-.8z"/></svg>',
    speed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/></svg>',
  };
  var lastStats = {};
  function renderStats(d, flash) {
    var st = M.job.stats;
    var pedalText = d.o.pedal === 'cc' ? '<b>' + d.sustain + '</b> pedal presses' : d.o.pedal === 'extend' ? 'Pedal baked into notes' : 'No pedal';
    var items = [
      ['time', STAT_ICON.time, '<b>' + fmtTime(d.duration) + '</b>', 'Length'],
      ['notes', STAT_ICON.notes, '<b>' + d.notes.length.toLocaleString('en-US') + '</b> notes', st.notes_added_by_aria + ' of them added by the Aria-AMT second opinion'],
      ['pedal', STAT_ICON.pedal, pedalText, d.soft ? d.soft + ' soft-pedal presses too' : ''],
      ['engine', STAT_ICON.engine, '<span class="long">' + esc(st.engine_name) + '</span><span class="short">' + esc(st.engine_name.replace(/\s*\(.*\)\s*$/, '')) + '</span>', st.engine_name + ', analysed with ' + st.views.length + ' stereo views'],
      ['speed', STAT_ICON.speed, 'Converted in <b>' + st.seconds_total + ' s</b>', 'On ' + M.info.device.name],
    ];
    var ul = $('rStats');
    ul.innerHTML = '';
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.innerHTML = it[1] + '<span>' + it[2] + '</span>';
      if (it[3]) li.title = it[3];
      if (flash && lastStats[it[0]] != null && lastStats[it[0]] !== it[2]) li.classList.add('flash');
      lastStats[it[0]] = it[2];
      ul.append(li);
    });
    $('lgPedal').hidden = d.o.pedal !== 'cc';
    $('lgSoft').hidden = !d.soft;
  }

  function applyOutput(announce) {
    var d = derive();
    if (roll && S.job) {
      roll.setData({ notes: d.notes, pedals: d.pedals, duration: d.duration }, { keepView: true });
      roll.setTime(S.time, S.playing);
      renderStats(d, true);
    }
    if (preview) preview.setData({ notes: d.notes, pedals: d.pedals, duration: d.duration }, { keepView: true });
    if (announce && S.job) toast('MIDI updated');
  }

  function openResult(opt) {
    opt = opt || {};
    var filename = opt.filename || M.job.filename;
    S.job = { filename: filename, midi: opt.midi || M.job.midi_name, engine: S.engine, eopts: JSON.stringify(eVals(S.engine)) };
    show('result');
    ensureRoll();
    $('rName').textContent = filename;
    $('rName').title = filename;
    var d = derive();
    lastStats = {};
    roll.setData({ notes: d.notes, pedals: d.pedals, duration: d.duration });
    renderStats(d, false);
    S.time = opt.time || 0;
    roll.setTime(S.time, false);
    $('scrub').max = String(D);
    $('timeDur').textContent = fmtTime(D);
    syncTime();
    $('saveBtn').classList.remove('saved');
    $('saveBtn').lastElementChild.textContent = 'Save MIDI';
  }

  function goHome() {
    closeSheet(true);
    S.job = null;
    show('home');
    renderRecent();
  }

  /* transport */
  function setPlaying(on) {
    S.playing = on;
    var b = $('playBtn');
    b.classList.toggle('playing', on);
    b.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (roll) roll.setTime(S.time, on);
  }
  function togglePlay() {
    if (S.view !== 'result') return;
    if (!S.playing && S.time >= D - 0.05) S.time = 0;
    setPlaying(!S.playing);
  }
  function syncTime() {
    $('timeNow').textContent = fmtTime(S.time);
    var sc = $('scrub');
    sc.value = String(S.time);
    sc.style.setProperty('--pct', (S.time / D * 100).toFixed(2) + '%');
  }
  var lastFrame = performance.now();
  function frame(now) {
    var dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (S.playing && roll) {
      S.time += dt;
      if (S.time >= D) { S.time = D; setPlaying(false); }
      roll.setTime(S.time, S.playing);
      syncTime();
    }
    requestAnimationFrame(frame);
  }

  function saveMidi() {
    if (!S.job) return;
    var b = $('saveBtn');
    b.classList.add('saved');
    b.lastElementChild.textContent = 'Saved';
    setTimeout(function () { b.classList.remove('saved'); b.lastElementChild.textContent = 'Save MIDI'; }, 2600);
    toast('Saved “' + S.job.midi + '” to Music', { label: 'Show in folder', run: function () { toast('Opened the Music folder in File Explorer'); } });
  }

  /* ================================================================== advanced sheet */
  var uid = 0;
  function optControl(spec, value, onChange, onInput) {
    var wrap = document.createElement('div');
    wrap.className = 'opt';
    wrap.dataset.key = spec.key;
    var id = 'o-' + spec.key + '-' + (++uid);
    var changed = String(value) !== String(spec.default);
    var dot = changed ? '<i class="changed" title="Changed from the default"></i>' : '';
    var head = document.createElement('div');
    head.className = 'opt-head';
    wrap.append(head);

    if (spec.kind === 'bool') {
      wrap.classList.add('opt-inline');
      head.innerHTML = '<label for="' + id + '">' + esc(spec.label) + dot + '</label>';
      var tg = document.createElement('span');
      tg.className = 'toggle';
      tg.innerHTML = '<input type="checkbox" role="switch" id="' + id + '"' + (value ? ' checked' : '') + '><span></span>';
      tg.firstChild.onchange = function (e) { onChange(e.target.checked); };
      head.append(tg);
    } else if (spec.kind === 'choice') {
      head.innerHTML = '<span class="lbl" id="' + id + '">' + esc(spec.label) + dot + '</span>';
      var seg = document.createElement('div');
      seg.className = 'seg';
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-labelledby', id);
      spec.choices.forEach(function (ch) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        var on = String(ch.value) === String(value);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on) b.className = 'on';
        b.dataset.value = ch.value;
        var sl = splitLabel(ch.label);
        b.innerHTML = '<span>' + esc(sl.main) + '</span>' + (sl.sub ? '<span class="sub">' + esc(sl.sub) + '</span>' : '');
        b.title = ch.label;
        b.onclick = function () { if (!on) onChange(ch.value); };
        seg.append(b);
      });
      wrap.append(seg);
    } else {
      head.innerHTML = '<label for="' + id + '">' + esc(spec.label) + dot + '</label>';
      var row = document.createElement('div');
      row.className = 'num-row';
      var rg = document.createElement('input');
      rg.type = 'range';
      rg.min = spec.min; rg.max = spec.max; rg.step = spec.step || 1; rg.value = value;
      rg.setAttribute('aria-label', spec.label + (spec.unit ? ' (' + spec.unit + ')' : ''));
      rg.dataset.role = 'range';
      var box = document.createElement('span');
      box.className = 'num-box';
      box.innerHTML = '<input type="number" id="' + id + '" min="' + spec.min + '" max="' + spec.max + '" step="' + (spec.step || 1) + '" value="' + value + '">' +
        (spec.unit ? '<span class="unit">' + esc(spec.unit) + '</span>' : '');
      var nb = box.firstChild;
      var setPct = function (v) { rg.style.setProperty('--pct', ((v - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + '%'); };
      setPct(value);
      var clamp = function (v) {
        v = Number(v);
        if (!isFinite(v)) v = spec.default;
        return Math.max(spec.min, Math.min(spec.max, v));
      };
      rg.oninput = function () { nb.value = rg.value; setPct(rg.value); if (onInput) onInput(clamp(rg.value)); };
      rg.onchange = function () { onChange(clamp(rg.value)); };
      nb.onchange = function () { var v = clamp(nb.value); nb.value = v; rg.value = v; setPct(v); onChange(v); };
      row.append(rg, box);
      wrap.append(row);
    }
    if (spec.help) {
      var p = document.createElement('p');
      p.className = 'help';
      p.textContent = spec.help;
      wrap.append(p);
    }
    return wrap;
  }

  function focusToken() {
    var a = document.activeElement;
    if (!a || !$('sheet').contains(a)) return null;
    var opt = a.closest('.opt');
    if (a.classList.contains('eng')) return { eng: a.dataset.id };
    if (!opt) return { id: a.id };
    return { key: opt.dataset.key, col: opt.parentElement.id, role: a.dataset.role || a.type || 'btn', value: a.dataset.value };
  }
  function restoreFocus(tok) {
    if (!tok) return;
    var el = null;
    if (tok.eng) el = document.querySelector('.eng[data-id="' + tok.eng + '"]');
    else if (tok.id) el = $(tok.id);
    else {
      var opt = document.querySelector('#' + tok.col + ' .opt[data-key="' + tok.key + '"]');
      if (opt) {
        if (tok.role === 'range') el = opt.querySelector('input[type=range]');
        else if (tok.role === 'number') el = opt.querySelector('input[type=number]');
        else if (tok.role === 'checkbox') el = opt.querySelector('input[type=checkbox]');
        else el = opt.querySelector('button[data-value="' + tok.value + '"]') || opt.querySelector('button.on');
      }
    }
    if (el) el.focus();
  }

  function setEngineOpt(engineId, key, v) {
    S.eopts[engineId] = S.eopts[engineId] || {};
    S.eopts[engineId][key] = v;
    renderSheet();
    renderHomeEngine();
  }
  function setOut(key, v, announce) {
    S.out[key] = v;
    renderSheet();
    applyOutput(announce !== false);
  }

  function renderSheet() {
    var tok = focusToken();
    // engines
    var box = $('engineCards');
    box.innerHTML = '';
    engines.forEach(function (e) {
      var on = e.id === S.engine;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'eng' + (on ? ' on' : '');
      b.dataset.id = e.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      var acc = ACC[e.id];
      b.innerHTML = (e.id === inst.default_engine ? '<span class="eng-badge">Default</span>' : '') +
        '<span class="eng-radio" aria-hidden="true"></span>' +
        '<span class="eng-name">' + esc(shortName(e)) + '</span>' +
        '<span class="eng-tag">' + esc(TAG[e.id] || '') + '</span>' +
        (acc ? '<span class="eng-acc" title="Note accuracy (onset F1) on 12 MAESTRO test excerpts, clean audio"><span class="bar"><i style="width:' + Math.round((acc - 96) / 3 * 100) + '%"></i></span>' + acc.toFixed(1) + '%</span>' : '');
      b.setAttribute('aria-label', e.name + '. ' + (TAG[e.id] || '') + (acc ? ' Accuracy ' + acc.toFixed(1) + ' percent.' : ''));
      b.onclick = function () {
        if (!e.available) { toast(e.unavailable_reason || 'This engine is not installed.', null, false); return; }
        if (S.engine === e.id) return;
        S.engine = e.id;
        renderSheet();
        renderHomeEngine();
      };
      box.append(b);
    });
    var cur = engineById(S.engine);
    $('engineDesc').textContent = cur.summary;

    var eo = $('engineOpts');
    eo.innerHTML = '';
    var vals = eVals(S.engine);
    if (!cur.options.length) {
      var p = document.createElement('p');
      p.className = 'help';
      p.style.marginTop = '14px';
      p.textContent = 'Aria-AMT has no settings of its own.';
      eo.append(p);
    }
    cur.options.forEach(function (spec) {
      eo.append(optControl(spec, vals[spec.key], function (v) { setEngineOpt(S.engine, spec.key, v); }));
    });

    // options that belong to the other engines
    var seen = {};
    cur.options.forEach(function (o) { seen[o.key] = 1; });
    var more = $('moreOpts');
    more.innerHTML = '';
    var groups = 0, groupNames = [];
    engines.forEach(function (e) {
      if (e.id === S.engine) return;
      var specs = e.options.filter(function (o) { return !seen[o.key]; });
      if (!specs.length) return;
      specs.forEach(function (o) { seen[o.key] = 1; });
      groups++;
      groupNames.push(shortName(e));
      var gl = document.createElement('div');
      gl.className = 'group-label';
      gl.style.marginTop = groups > 1 ? '16px' : '4px';
      gl.textContent = shortName(e);
      more.append(gl);
      var ev = eVals(e.id);
      specs.forEach(function (spec) {
        more.append(optControl(spec, ev[spec.key], function (v) { setEngineOpt(e.id, spec.key, v); }));
      });
    });
    $('moreBox').hidden = !groups;
    if (groups === 1) {
      more.querySelector('.group-label').remove();
      $('moreTitle').textContent = groupNames[0] + ' settings';
      $('moreNote').textContent = 'Used when ' + groupNames[0] + ' is the engine';
    } else {
      $('moreTitle').textContent = 'Settings for other engines';
      $('moreNote').textContent = 'Used when that engine is selected';
    }

    // MIDI file options
    var oo = oVals();
    var out = $('outOpts');
    out.innerHTML = '';
    outSpecs.forEach(function (spec) {
      if (DEPENDS[spec.key] && !DEPENDS[spec.key](oo)) return;
      var ctl = optControl(spec, oo[spec.key],
        function (v) { setOut(spec.key, v); },
        function (v) { S.out[spec.key] = v; applyOutput(false); });
      if (DEPENDS[spec.key]) ctl.classList.add('sub');
      out.append(ctl);
    });
    var live = !!S.job && S.view === 'result';
    var note = $('outNote');
    note.classList.toggle('idle', !live);
    note.lastChild.textContent = live ? 'Changes update the open result instantly' : 'Applied when the file is written';
    $('previewWrap').hidden = !live;

    // re-run when the transcription settings differ from the open result
    var differs = live && (S.job.engine !== S.engine || S.job.eopts !== JSON.stringify(eVals(S.engine)));
    $('rerunBtn').hidden = !differs;
    restoreFocus(tok);
    updateSheetScroll();
  }

  // soft fade at the edges of the sheet body when there is more to scroll to
  function updateSheetScroll() {
    var b = $('sheetBody');
    if (!b || $('sheet').hidden) return;
    b.classList.toggle('more-above', b.scrollTop > 2);
    b.classList.toggle('more-below', b.scrollHeight - b.scrollTop - b.clientHeight > 2);
  }

  var sheetCloseTimer = 0, lastFocus = null;
  function openSheet(quiet) {
    clearTimeout(sheetCloseTimer);
    renderSheet();
    var sh = $('sheet'), sc = $('scrim');
    sh.hidden = false;
    sc.hidden = false;
    lastFocus = document.activeElement;
    // force layout so the transition runs
    void sh.offsetWidth;
    sh.classList.add('open');
    sc.classList.add('open');
    $('advBtn').setAttribute('aria-expanded', 'true');
    if (S.job && S.view === 'result') {
      if (!preview) preview = new GlassRoll($('preview'), { mini: true, fitSec: 20 });
      var d = derive();
      preview.setData({ notes: d.notes, pedals: d.pedals, duration: d.duration });
    }
    if (!quiet) setTimeout(function () { $('closeSheet').focus(); }, 80);
    updateSheetScroll();
    markSwitcher();
  }
  function closeSheet(instant) {
    var sh = $('sheet'), sc = $('scrim');
    if (sh.hidden) return;
    sh.classList.remove('open');
    sc.classList.remove('open');
    $('advBtn').setAttribute('aria-expanded', 'false');
    var done = function () { sh.hidden = true; sc.hidden = true; markSwitcher(); };
    if (instant) done(); else sheetCloseTimer = setTimeout(done, 280);
    if (lastFocus && document.contains(lastFocus) && sh.contains(document.activeElement)) lastFocus.focus();
  }
  function sheetOpen() { return !$('sheet').hidden && $('sheet').classList.contains('open'); }

  /* ================================================================== theme */
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var pref = document.documentElement.getAttribute('data-theme-pref') || 'auto';
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var label = { auto: 'Theme: automatic, follows Windows', light: 'Theme: light', dark: 'Theme: dark' }[pref];
    $('themeBtn').setAttribute('aria-label', label);
    $('themeBtn').title = label;
    if (roll) roll.refreshTheme();
    if (preview) preview.refreshTheme();
  }
  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var pref = document.documentElement.getAttribute('data-theme-pref') || 'auto';
    var next = order[(order.indexOf(pref) + 1) % 3];
    document.documentElement.setAttribute('data-theme-pref', next);
    try { localStorage.setItem('mc-glass-theme', next); } catch (e) { /* private mode */ }
    applyTheme();
    toast({ auto: 'Theme follows Windows', light: 'Light theme', dark: 'Dark theme' }[next], null, false);
  }

  /* ================================================================== reviewer state switcher */
  function markSwitcher() {
    var cur = S.view === 'result' && !$('sheet').hidden ? 'advanced' : S.view;
    Array.prototype.forEach.call(document.querySelectorAll('#switcher a'), function (a) {
      a.classList.toggle('on', a.dataset.state === cur);
      if (a.dataset.state === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function goState(st, quiet) {
    closeSheet(true);
    stopSim();
    if (st === 'progress') showStaticProgress();
    else if (st === 'result') openResult({ time: 12 });
    else if (st === 'advanced') { openResult({ time: 12 }); openSheet(quiet); }
    else goHome();
    markSwitcher();
  }

  /* ================================================================== wiring */
  function bind() {
    var drop = $('drop'), input = $('fileInput');
    drop.addEventListener('click', function (e) {
      if (e.target.closest('.link')) { input.click(); return; }
      startConversion(M.file.name);
    });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startConversion(M.file.name); }
    });
    input.addEventListener('change', function () { if (input.files[0]) startConversion(input.files[0].name); input.value = ''; });

    var depth = 0;
    var hasFiles = function (e) { return Array.prototype.indexOf.call((e.dataTransfer && e.dataTransfer.types) || [], 'Files') >= 0; };
    window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; depth++; drop.classList.add('over'); });
    window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('over'); });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (f) startConversion(f.name);
    });

    $('brand').onclick = function (e) { e.preventDefault(); if (S.view === 'progress' && S.sim) return; goHome(); };
    $('advBtn').onclick = function () { if (sheetOpen()) closeSheet(); else openSheet(); };
    $('enginePill').onclick = function () { openSheet(); };
    $('closeSheet').onclick = function () { closeSheet(); };
    $('doneBtn').onclick = function () { closeSheet(); };
    $('scrim').onclick = function () { closeSheet(); };
    $('themeBtn').onclick = cycleTheme;
    mq.addEventListener('change', applyTheme);

    $('resetBtn').onclick = function () {
      S.engine = inst.default_engine;
      S.eopts = {};
      S.out = {};
      renderSheet();
      renderHomeEngine();
      applyOutput(false);
      toast('Options reset to defaults');
    };
    $('rerunBtn').onclick = function () { if (S.job) startConversion(S.job.filename); };

    $('cancelBtn').onclick = function () { stopSim(); goHome(); toast('Conversion cancelled', null, false); };
    $('retryBtn').onclick = goHome;
    $('removeFailedBtn').onclick = function () { var id = P && P.id; goHome(); if (id) removeRecent(id); };

    $('newBtn').onclick = goHome;
    $('saveBtn').onclick = saveMidi;
    $('playBtn').onclick = togglePlay;
    $('scrub').addEventListener('input', function (e) {
      S.time = Number(e.target.value);
      if (roll) { roll.revealTime(S.time); roll.setTime(S.time, S.playing); }
      syncTime();
    });
    Array.prototype.forEach.call($('mixSeg').querySelectorAll('button'), function (b) {
      b.tabIndex = b.classList.contains('on') ? 0 : -1; // roving focus: arrows move within the group
      b.onclick = function () {
        Array.prototype.forEach.call($('mixSeg').querySelectorAll('button'), function (x) {
          var on = x === b;
          x.setAttribute('aria-checked', String(on));
          x.classList.toggle('on', on);
          x.tabIndex = on ? 0 : -1;
        });
        S.mix = b.dataset.mix;
        if (roll) roll.setMix(S.mix);
      };
    });
    $('zoomIn').onclick = function () { if (roll) roll.zoom(1.5); };
    $('zoomOut').onclick = function () { if (roll) roll.zoom(1 / 1.5); };

    // arrow keys inside radio groups (segmented controls, engine cards)
    document.addEventListener('keydown', function (e) {
      var g = e.target.closest && e.target.closest('[role=radiogroup]');
      if (!g || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      var items = Array.prototype.filter.call(g.querySelectorAll('[role=radio]'), function (x) { return !x.disabled; });
      var i = items.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      var next = items[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
      var val = next.dataset.value, gid = g.id, eng = next.dataset.id;
      next.click();
      // the group may have re-rendered: focus the new selection
      var target = eng ? document.querySelector('.eng[data-id="' + eng + '"]') : gid ? $(gid).querySelector('[aria-checked=true]') : null;
      if (!target && val != null) {
        var opt = document.querySelector('.opt [data-value="' + val + '"]');
        target = opt;
      }
      (target || next).focus();
    });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeSheet(); return; }
      if (e.key === 'Tab' && sheetOpen()) {
        var f = Array.prototype.filter.call($('sheet').querySelectorAll('button, input, summary, [tabindex="0"]'), function (x) { return !x.disabled && x.offsetParent !== null && x.tabIndex >= 0; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (!$('sheet').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      var tag = document.activeElement && document.activeElement.tagName;
      var typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.code === 'Space' && !typing && S.view === 'result' && !sheetOpen()) {
        if (tag === 'BUTTON' && document.activeElement !== $('playBtn')) return; // let buttons handle Space
        e.preventDefault();
        togglePlay();
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('#switcher a'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var q = new URLSearchParams(location.search);
        q.set('state', a.dataset.state);
        history.replaceState(null, '', '?' + q.toString());
        goState(a.dataset.state);
      });
    });
  }

  /* ================================================================== init */
  function init() {
    $('gpuName').textContent = M.info.device.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');
    $('gpuPill').title = 'Running on ' + M.info.device.name + ' · ' + M.info.device.vram_gb + ' GB';
    $('aboutLine').textContent = M.info.app + ' ' + M.info.version;
    bind();
    applyTheme();
    renderHomeEngine();
    renderRecent();
    requestAnimationFrame(frame);
    var qm = params.get('mix');
    if (qm === 'original' || qm === 'both' || qm === 'midi') {
      var mb = $('mixSeg').querySelector('[data-mix="' + qm + '"]');
      if (mb) mb.click();
    }
    var st = params.get('state') || 'home';
    if (['home', 'progress', 'result', 'advanced'].indexOf(st) < 0) st = 'home';
    document.documentElement.classList.add('no-anim');
    goState(st, true);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { app.classList.add('ready'); document.documentElement.classList.remove('no-anim'); });
    });
    window.addEventListener('resize', function () { if (S.view === 'progress') drawWave(performance.now()); updateSheetScroll(); });
    $('sheetBody').addEventListener('scroll', updateSheetScroll, { passive: true });
    $('moreBox').addEventListener('toggle', updateSheetScroll);
  }

  init();
})();
