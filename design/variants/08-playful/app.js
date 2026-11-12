/* MIDI Converter — "Playful" prototype. Classic script, no backend: everything runs on window.MOCK. */
(function () {
  'use strict';

  var M = window.MOCK;
  var R = window.MCRoll;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var CLEAN = params.get('clean') === '1';
  var REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  var INSTR = M.info.instruments[0];
  var ENGINES = INSTR.engines;
  var OUT = M.info.output_options;
  var ENGINE_COPY = {
    ensemble: { short: 'Ensemble', badge: 'Default', desc: 'Most accurate. Transkun transcribes, Aria double-checks.', tagline: 'Our most accurate setting' },
    transkun: { short: 'Transkun V2', badge: '', desc: 'About 4x faster and almost as accurate.', tagline: 'About 4x faster, almost as accurate' },
    aria: { short: 'Aria-AMT', badge: '', desc: 'Aria-AMT on its own, for comparison.', tagline: 'On its own, for comparison' }
  };

  // ------------------------------------------------------------------ helpers
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = R.fmtTime;
  var splitLabel = function (label) {
    var m = /^(.*?)\s*\((.*)\)\s*$/.exec(label);
    return m ? { main: m[1], sub: m[2] } : { main: label, sub: '' };
  };
  var engineById = function (id) { for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i]; return ENGINES[0]; };
  var optSpec = function (key) {
    for (var i = 0; i < ENGINES.length; i++) for (var j = 0; j < ENGINES[i].options.length; j++) if (ENGINES[i].options[j].key === key) return ENGINES[i].options[j];
    return null;
  };
  var outSpec = function (key) { for (var i = 0; i < OUT.length; i++) if (OUT[i].key === key) return OUT[i]; return null; };
  var engineHas = function (eng, key) { return eng.options.some(function (o) { return o.key === key; }); };
  var stripName = function (f) { return f.replace(/\.[^.]+$/, ''); };

  // Velocity -> pleasant hue ramp (sky -> indigo -> violet -> pink -> apricot)
  var STOPS = [[0, [56, 189, 248]], [0.3, [111, 124, 246]], [0.55, [164, 110, 240]], [0.8, [236, 95, 164]], [1, [251, 138, 76]]];
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    for (var i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        var a = STOPS[i - 1], b = STOPS[i], k = (t - a[0]) / (b[0] - a[0]);
        return 'rgb(' + [0, 1, 2].map(function (j) { return Math.round(a[1][j] + (b[1][j] - a[1][j]) * k); }).join(',') + ')';
      }
    }
    return 'rgb(251,138,76)';
  }
  var VEL = [];
  for (var v = 0; v < 128; v++) VEL.push(ramp((v - 30) / (92 - 30)));

  // ------------------------------------------------------------------ state
  function defaults() {
    var s = { engine: INSTR.default_engine, opts: {}, out: {} };
    ENGINES.forEach(function (e) { e.options.forEach(function (o) { if (!(o.key in s.opts)) s.opts[o.key] = o.default; }); });
    OUT.forEach(function (o) { s.out[o.key] = o.default; });
    return s;
  }
  var S = {
    view: 'home',
    adv: false,
    more: false,
    settings: defaults(),
    jobSettings: null,
    job: { name: M.job.filename, duration: M.job.stats.duration, notes: M.job.stats.notes },
    mix: 'both',
    time: 12,
    playing: false,
    progTimer: 0
  };
  var transcriptionKey = function (s) { return JSON.stringify([s.engine, s.opts]); };
  S.jobSettings = transcriptionKey(S.settings);

  // ------------------------------------------------------------------ piano roll (themed subclass of the shared renderer)
  function lowerBound(notes, t) {
    var lo = 0, hi = notes.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (notes[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  function dynMark(v) { return v < 32 ? 'pp' : v < 48 ? 'p' : v < 64 ? 'mp' : v < 80 ? 'mf' : v < 96 ? 'f' : 'ff'; }

  class PlayRoll extends R.PianoRoll {
    constructor(el, opts) {
      super(el, opts);
      this.keyW = 58;
      this.axisH = 28;
      this.pedalH = 26;
      this.mix = 'both';
      this.pedalMode = 'cc';
      this.wave = M.waveform;
      this.active = new Map();
      this._activeSig = '';
      // Runs after the shared renderer's own pointermove: friendlier wording + keep the tip inside the roll.
      var self = this;
      this.canvas.addEventListener('pointermove', function (e) {
        var n = self.hover;
        if (self.tip.hidden || !n) return;
        var dur = n[1] - n[0], conf = n[5] == null ? 1 : n[5];
        self.tip.textContent = R.noteName(n[2]) + '  \u00b7  ' + (dur < 1 ? Math.round(dur * 1000) + ' ms' : dur.toFixed(2) + ' s') +
          '\nVelocity ' + n[3] + ' (' + dynMark(n[3]) + ')' + (conf < 0.995 ? '  \u00b7  ' + Math.round(conf * 100) + '% sure' : '');
        var r = self.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        self.tip.style.transform = 'translate(' + (x > r.width - 200 ? 'calc(-100% - 14px)' : '14px') + ', ' + (y < 64 ? '18px' : 'calc(-100% - 10px)') + ')';
      });
    }
    _readColors() {
      super._readColors();
      var cs = getComputedStyle(document.documentElement);
      this.c.wave = cs.getPropertyValue('--wave').trim();
      this.c.soft = cs.getPropertyValue('--soft-pedal').trim();
    }
    _drawKeys() {
      var ctx = this.keys.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var w = this.keyW, h = this.el.clientHeight, rh = this._rowH(), c = this.c;
      var font = getComputedStyle(document.body).fontFamily;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = c.keyW; ctx.fillRect(0, this.axisH, w, this._noteH());
      var p, y;
      // pressed white keys
      for (p = this.lo; p <= this.hi; p++) {
        if (BLACK[p % 12] || !this.active.has(p)) continue;
        y = this._rowY(p);
        ctx.fillStyle = this.active.get(p);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, y - rh * 0.25, w - 1, rh * 1.5);
        ctx.globalAlpha = 1;
      }
      for (p = this.lo; p <= this.hi; p++) {
        y = this._rowY(p);
        if (BLACK[p % 12]) {
          ctx.fillStyle = this.active.get(p) || c.keyB;
          ctx.beginPath();
          ctx.roundRect(0, y + 0.5, w * 0.6, Math.max(1, rh - 1), [0, 3, 3, 0]);
          ctx.fill();
        } else if (!BLACK[(p + 1) % 12] && p < this.hi) {
          ctx.fillStyle = c.keyLine;
          ctx.fillRect(0, y - 0.5, w, 1);
        }
        if (p % 12 === 0 && rh >= 5) {
          ctx.fillStyle = this.active.has(p) ? '#fff' : c.text;
          ctx.font = '600 ' + Math.min(11, Math.max(8, rh + 1)) + 'px ' + font;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'right';
          ctx.fillText(R.noteName(p), w - 7, y + rh / 2);
        }
      }
      ctx.fillStyle = c.keyLine;
      ctx.fillRect(w - 1, this.axisH, 1, this._noteH());
      ctx.fillStyle = c.grid;
      ctx.fillRect(0, this.axisH - 1, w, 1);
      ctx.fillRect(0, h - this.pedalH, w, 1);
      ctx.fillStyle = c.text;
      ctx.font = '600 10.5px ' + font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('Pedal', w - 7, h - this.pedalH / 2);
    }
    _drawWave(ctx, W, top, bottom, alpha) {
      var wf = this.wave; if (!wf) return;
      var hop = wf.hop_seconds, cy = (top + bottom) / 2, amp = (bottom - top) / 2 * 0.92, step = 2;
      var self = this;
      var col = function (arr, gain) {
        var out = [];
        for (var x = 0; x <= W + step; x += step) {
          var ta = self.scrollX + x / self.pxPerSec, tb = self.scrollX + (x + step) / self.pxPerSec;
          var i0 = Math.max(0, Math.floor(ta / hop)), i1 = Math.max(i0 + 1, Math.ceil(tb / hop)), m = 0;
          for (var i = i0; i < i1 && i < arr.length; i++) m = Math.max(m, arr[i]);
          out.push(Math.min(1, m * gain));
        }
        return out;
      };
      var shape = function (vals) {
        ctx.beginPath();
        ctx.moveTo(0, cy);
        for (var k = 0; k < vals.length; k++) ctx.lineTo(k * step, cy - vals[k] * amp);
        for (k = vals.length - 1; k >= 0; k--) ctx.lineTo(k * step, cy + vals[k] * amp);
        ctx.closePath();
        ctx.fill();
      };
      ctx.fillStyle = this.c.wave;
      ctx.globalAlpha = alpha * 0.55; shape(col(wf.peak, 0.95));
      ctx.globalAlpha = alpha; shape(col(wf.rms, 1.9));
      ctx.globalAlpha = 1;
    }
    _draw() {
      var ctx = this.canvas.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var W = this._viewW(), H = this.el.clientHeight, rh = this._rowH(), c = this.c;
      var t0 = this.scrollX, t1 = this.scrollX + W / this.pxPerSec;
      var font = getComputedStyle(document.body).fontFamily;
      var laneTop = H - this.pedalH;
      ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);

      var p, y;
      for (p = this.lo; p <= this.hi; p++) {
        y = this._rowY(p);
        if (BLACK[p % 12]) { ctx.fillStyle = c.black; ctx.fillRect(0, y, W, rh); }
        if (p % 12 === 0) { ctx.fillStyle = c.octave; ctx.fillRect(0, y + rh - 0.5, W, 1); }
      }

      if (this.mix !== 'midi') this._drawWave(ctx, W, this.axisH + 6, laneTop - 6, this.mix === 'original' ? 0.42 : 0.13);

      // time grid
      var steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      var pps = this.pxPerSec;
      var step = steps.find(function (s) { return s * pps >= 72; }) || 600;
      ctx.font = '600 11px ' + font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      var headX = this._x(this.time);
      for (var k = Math.floor(t0 / step); k * step <= t1; k++) {
        var t = k * step, x = Math.round(this._x(t)) + 0.5;
        ctx.fillStyle = c.grid;
        ctx.fillRect(x - 0.5, this.axisH, 1, H - this.axisH);
        var label = step < 1 ? fmt(t, true) : fmt(t), tw = ctx.measureText(label).width;
        if (x + 5 + tw > W - 4) continue;
        ctx.globalAlpha = (headX > x - 6 && headX < x + tw + 16) ? 0.22 : 1;
        ctx.fillStyle = c.text;
        ctx.fillText(label, x + 5, this.axisH / 2);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = c.grid;
      ctx.fillRect(0, this.axisH - 1, W, 1);
      ctx.fillRect(0, laneTop, W, 1);

      // pedal lane
      ctx.fillStyle = 'rgba(248,244,252,.8)';
      ctx.fillRect(0, laneTop + 1, W, this.pedalH - 1);
      var softShown = false;
      for (var i = 0; i < this.pedals.length; i++) {
        var pd = this.pedals[i];
        if (pd[1] < t0 || pd[0] > t1) continue;
        var x0 = this._x(pd[0]), x1 = this._x(pd[1]);
        if (pd[2] === 64) {
          ctx.fillStyle = c.pedal;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.roundRect(x0, laneTop + 5, Math.max(4, x1 - x0 - 1), this.pedalH - 13, 6);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          softShown = true;
          ctx.fillStyle = c.soft;
          ctx.beginPath();
          ctx.roundRect(x0, H - 6, Math.max(4, x1 - x0), 3.5, 2);
          ctx.fill();
        }
      }
      if (this.pedalMode !== 'cc') {
        ctx.fillStyle = c.text;
        ctx.font = '600 11.5px ' + font;
        ctx.textAlign = 'left';
        ctx.fillText(this.pedalMode === 'extend' ? 'Sustain pedal is baked into the note lengths' : 'Sustain pedal is left out of the file', 10, laneTop + this.pedalH / 2 - (softShown ? 2 : 0));
      }

      // notes
      var notes = this.notes, now = this.time;
      var nh = Math.max(1, rh - (rh > 6 ? 1.5 : 0.5));
      var radius = Math.min(4, nh / 2);
      var dim = this.mix === 'original' ? 0.32 : 1;
      var active = new Map();
      i = lowerBound(notes, t0 - (this.maxSpan || 0) - 0.01);
      for (; i < notes.length; i++) {
        var n = notes[i];
        var s = n[0], e = n[1], pitch = n[2], vel = n[3], sound = n[4] || n[1];
        if (s > t1) break;
        if (sound < t0 || pitch < this.lo || pitch > this.hi) continue;
        var colr = VEL[Math.max(0, Math.min(127, vel))];
        y = this._rowY(pitch) + (rh - nh) / 2;
        var nx0 = this._x(s), nx1 = this._x(e), xs = this._x(sound);
        var on = s <= now && now < e;
        if (on) active.set(pitch, colr);
        if (xs > nx1 + 1) {
          ctx.fillStyle = colr;
          ctx.globalAlpha = 0.24 * dim;
          ctx.beginPath();
          ctx.roundRect(nx1 - 2, y + nh * 0.22, xs - nx1 + 2, nh * 0.56, nh * 0.28);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.roundRect(nx0, y, Math.max(3, nx1 - nx0), nh, radius);
        var conf = n[5] == null ? 1 : n[5];
        if (conf < 0.6) {
          ctx.globalAlpha = 0.9 * dim;
          ctx.strokeStyle = colr;
          ctx.lineWidth = 1.3;
          ctx.setLineDash([3, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.globalAlpha = dim;
          ctx.fillStyle = colr;
          if (on && dim === 1) { ctx.shadowColor = colr; ctx.shadowBlur = 12; }
          ctx.fill();
          ctx.shadowBlur = 0;
          if (on && dim === 1) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1; ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
        if (this.hover === n) {
          ctx.strokeStyle = c.ink;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // playhead with a friendly round knob
      var px = this._x(now);
      if (px >= -8 && px <= W + 8) {
        ctx.fillStyle = c.playhead;
        ctx.fillRect(Math.round(px) - 1, this.axisH - 2, 2, H - this.axisH + 2);
        ctx.beginPath();
        ctx.arc(px, this.axisH - 9, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px, this.axisH - 9, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      var sig = Array.from(active.keys()).sort().join(',');
      if (sig !== this._activeSig) { this._activeSig = sig; this.active = active; this._drawKeys(); }
    }
  }

  var roll = new PlayRoll($('roll'), {
    onSeek: function (t) { S.time = t; roll.setTime(t, S.playing); renderTime(); }
  });

  function outputData() {
    var o = S.settings.out, minS = (o.min_note_ms || 0) / 1000;
    var notes = [];
    M.notes.forEach(function (n) {
      if (minS > 0 && n[1] - n[0] < minS) return;
      var s = n[0], e = n[1], p = n[2], v = n[3], snd = n[4] || n[1], conf = n[5];
      if (o.velocity === 'flat') v = o.flat_velocity;
      if (o.pedal === 'extend') { e = Math.max(e, snd); snd = e; } else if (o.pedal === 'none') snd = e;
      notes.push([s, e, p, v, snd, conf]);
    });
    var pedals = M.pedals.filter(function (p) { return (p[2] === 64 && o.pedal === 'cc') || (p[2] === 67 && o.soft_pedal); });
    return { notes: notes, pedals: pedals, duration: M.duration };
  }
  var dataSig = '';
  function applyOutput(first) {
    var sig = JSON.stringify(S.settings.out);
    if (sig === dataSig && !first) return;
    var changedCount = dataSig !== '';
    dataSig = sig;
    var d = outputData();
    roll.pedalMode = S.settings.out.pedal;
    roll.setData(d, { keepView: !first });
    if (first) roll.setTime(S.time, false);
    renderStats(d, changedCount && !first);
  }

  // ------------------------------------------------------------------ views
  var VIEW_EL = { home: 'viewHome', progress: 'viewProgress', result: 'viewResult' };
  var booted = false;
  function show(view) {
    var changed = view !== S.view;
    S.view = view;
    $('viewHome').hidden = view !== 'home';
    $('viewProgress').hidden = view !== 'progress';
    $('viewResult').hidden = view !== 'result';
    if (booted && changed && !REDUCED) {
      // Entrance animation only on real view changes (never on first paint).
      var el = $(VIEW_EL[view]);
      el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    }
    if (view !== 'progress') stopProgress();
    if (view !== 'result') stopPlay();
    markSwitch();
    window.scrollTo(0, 0);
  }

  // ---- home
  function engineSummary() {
    var eng = engineById(S.settings.engine);
    var txt = ENGINE_COPY[eng.id].short;
    if (engineHas(eng, 'views')) {
      var spec = optSpec('views');
      var ch = spec.choices.find(function (c) { return c.value === S.settings.opts.views; }) || spec.choices[0];
      txt += ' · ' + ch.label.replace(/\s*\(paper settings\)/, '').replace(/[()]/g, '');
    }
    $('engineSummary').textContent = txt;
    $('engineTagline').textContent = ENGINE_COPY[eng.id].tagline;
  }

  var ICON = {
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6.5l10-2.2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>',
    retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
    dur: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    notes: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="9" height="4" rx="2"/><rect x="8.5" y="11" width="12" height="4" rx="2"/><rect x="5.5" y="17" width="7" height="3" rx="1.5"/></svg>',
    pedal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20h10M9 20l1.5-9h3L15 20M12 11V4"/></svg>',
    chip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>',
    tempo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20h8l-3-15h-2zM12 14l5-6"/></svg>'
  };
  var HUES = [265, 330, 160, 205, 15, 45];

  function renderRecent() {
    var list = $('recentList');
    list.innerHTML = '';
    $('recentCount').textContent = M.recent.length;
    $('recentEmpty').hidden = M.recent.length > 0;
    M.recent.forEach(function (job, idx) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'recent-item';
      b.style.setProperty('--h', HUES[idx % HUES.length]);
      b.title = job.filename;
      var isVideo = /\.(mp4|mkv|mov|webm)$/i.test(job.filename);
      var meta, status, label;
      if (job.status === 'done') {
        meta = esc(job.when) + ' · ' + fmt(job.duration) + ' · ' + job.notes.toLocaleString('en-US') + ' notes';
        status = '<span class="st-done" title="Done">' + ICON.check + '</span>';
        label = 'Open ' + job.filename;
      } else if (job.status === 'running') {
        var pct = Math.round(job.progress * 100), C = 2 * Math.PI * 14;
        meta = 'Converting now · ' + fmt(job.duration) + ' long';
        status = '<span class="st-ring" title="' + pct + '% done"><svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="14" fill="none" stroke="#ece5fa" stroke-width="3.5"/>' +
          '<circle cx="17" cy="17" r="14" fill="none" stroke="#7b5cf6" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="' + (C * job.progress).toFixed(1) + ' ' + C.toFixed(1) + '"/></svg><span>' + pct + '%</span></span>';
        label = 'Show progress of ' + job.filename;
      } else if (job.status === 'queued') {
        meta = 'Up next · ' + fmt(job.duration) + ' long';
        status = '<span class="st-pill st-queued" title="Waiting">' + ICON.clock + '<span class="st-txt">Waiting</span></span>';
        label = job.filename + ', waiting';
      } else {
        meta = esc(job.error || 'The conversion failed.');
        status = '<span class="st-pill st-retry" title="Retry">' + ICON.retry + '<span class="st-txt">Retry</span></span>';
        label = 'Retry ' + job.filename;
      }
      b.setAttribute('aria-label', label);
      b.innerHTML = '<span class="r-icon" aria-hidden="true">' + (isVideo ? ICON.video : ICON.note) + '</span>' +
        '<span class="r-text"><span class="r-name">' + esc(stripName(job.filename)) + '</span>' +
        '<span class="r-meta' + (job.status === 'error' ? ' err' : '') + '">' + meta + '</span></span>' +
        '<span class="r-status">' + status + '</span>';
      b.addEventListener('click', function () { openRecent(job); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }
  function openRecent(job) {
    if (job.status === 'done') {
      S.job = { name: job.filename, duration: job.duration, notes: job.notes };
      openResult(false);
    } else if (job.status === 'running') {
      startConversion(job.filename, job.progress);
    } else if (job.status === 'queued') {
      toast('<b>' + esc(stripName(job.filename)) + '</b> starts as soon as the current one is done.', { icon: 'clock' });
    } else {
      startConversion(job.filename, 0);
    }
  }

  // ---- progress
  var KEY_SEQ = 24, STEP = 0.1;
  function buildKeyboard() {
    var kbd = $('kbd'), rise = $('rise');
    var whites = [0, 2, 4, 5, 7, 9, 11];
    var dur = (KEY_SEQ * STEP + 0.5).toFixed(2) + 's';
    var wi = 0, html = '', bhtml = '', rhtml = '';
    for (var semi = 0; semi < KEY_SEQ; semi++) {
      var pc = semi % 12, col = ramp(semi / (KEY_SEQ - 1));
      var style = '--c:' + col + ';--delay:' + (semi * STEP).toFixed(2) + 's;--dur:' + dur;
      var cx;
      if (whites.indexOf(pc) >= 0) {
        html += '<i class="wk" style="' + style + '"></i>';
        cx = (wi + 0.5) / 14 * 100;
        wi++;
      } else {
        cx = wi / 14 * 100;
        bhtml += '<i class="bk" style="' + style + ';left:calc(' + cx.toFixed(3) + '% - (100% - 52px) / 14 * .29)"></i>';
      }
      rhtml += '<i style="' + style + ';position:absolute;left:' + cx.toFixed(3) + '%;width:' + (100 / 14 * 0.7).toFixed(2) + '%;transform:translateX(-50%);height:100%"></i>';
    }
    kbd.innerHTML = html + bhtml;
    rise.innerHTML = rhtml;
  }

  function stageList(engineId, viewsVal) {
    var nViews = { none: 1, channels: 4, full: 6 }[viewsVal] || 4;
    var tk = 'Transkun V2 · ' + nViews + (nViews === 1 ? ' view' : ' views');
    if (engineId === 'transkun') return [{ id: 'decode', label: 'Read audio' }, { id: 'transkun', label: tk }, { id: 'fuse', label: 'Write MIDI' }];
    if (engineId === 'aria') return [{ id: 'decode', label: 'Read audio' }, { id: 'aria', label: 'Aria-AMT' }, { id: 'fuse', label: 'Write MIDI' }];
    return M.progress.stages.map(function (s) { return { id: s.id, label: s.id === 'transkun' ? tk : s.label }; });
  }
  function renderStages(stages, states) {
    var ol = $('stages');
    ol.style.gridTemplateColumns = 'repeat(' + stages.length + ', 1fr)';
    ol.innerHTML = stages.map(function (s, i) {
      var st = states[i];
      var inner = st === 'done' ? ICON.check : (i + 1);
      var sr = st === 'done' ? ' (done)' : st === 'active' ? ' (in progress)' : '';
      return '<li class="stage ' + st + '"' + (st === 'active' ? ' aria-current="step"' : '') + '><span class="st-dot" aria-hidden="true">' + inner + '</span><span>' + esc(s.label) + '<span class="sr" style="position:absolute;left:-9999px">' + sr + '</span></span></li>';
    }).join('');
  }
  function setProgress(p, step, eta) {
    var pct = Math.round(p * 100);
    $('progPct').textContent = pct + '%';
    $('progFill').style.width = Math.max(2, pct) + '%';
    $('progBar').setAttribute('aria-valuenow', pct);
    $('progStep').textContent = step;
    $('progEta').textContent = eta;
  }
  function setProgFile(name) {
    $('progName').textContent = name;
    $('progName').title = name;
    var ext = (name.split('.').pop() || '').toUpperCase();
    $('progFormat').textContent = name === M.file.name ? M.file.format + ' · ' + M.file.size_mb + ' MB' : ext + ' recording';
  }
  function showStaticProgress() {
    setProgFile(M.file.name);
    var P = M.progress;
    setProgress(P.progress, P.message, 'About ' + P.eta_seconds + ' seconds left');
    renderStages(P.stages, P.stages.map(function (s) { return s.state; }));
    show('progress');
  }
  function stopProgress() { if (S.progTimer) { cancelAnimationFrame(S.progTimer); S.progTimer = 0; } }
  function startConversion(name, from) {
    closeAdvanced(true);
    stopProgress();
    S.job = { name: name, duration: M.job.stats.duration, notes: null };
    setProgFile(name);
    var stages = stageList(S.settings.engine, S.settings.opts.views);
    var idx = function (id) { for (var i = 0; i < stages.length; i++) if (stages[i].id === id) return i; return -1; };
    var hasAria = idx('aria') >= 0 && idx('transkun') >= 0;
    var bounds = hasAria ? { decode: 0.04, main: 0.8, aria: 0.93 } : { decode: 0.04, main: 0.93, aria: 0.93 };
    var total = 3000 * (1 - (from || 0)) + 200, t0 = performance.now(), p0 = from || 0;
    show('progress');
    var tick = function (now) {
      var p = Math.min(1, p0 + (1 - p0) * (now - t0) / total);
      var states, step;
      if (p < bounds.decode) { step = 'Reading the audio'; states = stages.map(function (s, i) { return i === 0 ? 'active' : 'pending'; }); }
      else if (p < bounds.main) {
        var mainId = idx('transkun') >= 0 ? 'transkun' : 'aria';
        var w = Math.min(9, Math.max(1, Math.ceil((p - bounds.decode) / (bounds.main - bounds.decode) * 9)));
        step = 'Transcribing window ' + w + ' of 9';
        states = stages.map(function (s, i) { return i < idx(mainId) ? 'done' : i === idx(mainId) ? 'active' : 'pending'; });
      } else if (p < bounds.aria) {
        step = 'Getting a second opinion from Aria-AMT';
        states = stages.map(function (s, i) { return i < idx('aria') ? 'done' : i === idx('aria') ? 'active' : 'pending'; });
      } else {
        step = 'Writing your MIDI file';
        states = stages.map(function (s, i) { return i < stages.length - 1 ? 'done' : 'active'; });
      }
      var left = Math.round((1 - p) * 26);
      setProgress(p, step, left <= 2 ? 'Almost done' : 'About ' + left + ' seconds left');
      renderStages(stages, states);
      if (p >= 1) { S.progTimer = 0; S.jobSettings = transcriptionKey(S.settings); setTimeout(function () { openResult(true); }, 250); return; }
      S.progTimer = requestAnimationFrame(tick);
    };
    S.progTimer = requestAnimationFrame(tick);
  }

  // ---- result
  function renderStats(d, flash) {
    d = d || outputData();
    var o = S.settings.out, st = M.job.stats;
    var notes = S.job.notes != null && S.job.name !== M.job.filename ? S.job.notes : d.notes.length;
    var pedalTxt = o.pedal === 'cc' ? '<b>' + st.pedals + '</b> pedal presses' : o.pedal === 'extend' ? 'Pedal <b>baked in</b>' : 'Pedal <b>left out</b>';
    if (o.soft_pedal && st.soft_pedals) pedalTxt += ' · ' + st.soft_pedals + ' soft';
    var items = [
      ['dur', '<b>' + fmt(S.job.duration) + '</b> long', 'dur'],
      ['notes', '<b>' + notes.toLocaleString('en-US') + '</b> notes', 'notes'],
      ['pedal', pedalTxt, 'pedal'],
      ['chip', esc(st.engine_name), 'engine'],
      ['bolt', 'Converted in <b>' + st.seconds_total + ' s</b>', 'time']
    ];
    var prev = {};
    Array.prototype.forEach.call($('statChips').children, function (li) { prev[li.dataset.k] = li.innerHTML; });
    $('statChips').innerHTML = items.map(function (it) { return '<li data-k="' + it[2] + '">' + ICON[it[0]] + '<span>' + it[1] + '</span></li>'; }).join('');
    if (flash) Array.prototype.forEach.call($('statChips').children, function (li) { if (prev[li.dataset.k] && prev[li.dataset.k] !== li.innerHTML) li.classList.add('changed'); });
  }
  function openResult(celebrate) {
    var name = stripName(S.job.name);
    $('resultTitle').textContent = name;
    $('resultTitle').title = name + '.mid';
    renderStats();
    show('result');
    $('timeTotal').textContent = fmt(M.duration);
    if (celebrate) {
      S.time = 0;
      var c = $('celebrate');
      c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
    }
    roll.setTime(S.time, false);
    renderTime();
  }
  function renderTime() { $('timeNow').textContent = fmt(S.time); }

  var lastFrame = 0;
  function frame(now) {
    if (!S.playing) return;
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    S.time += dt;
    if (S.time >= M.duration) { S.time = M.duration; stopPlay(); S.time = 0; roll.setTime(0, false); renderTime(); return; }
    roll.setTime(S.time, true);
    renderTime();
    requestAnimationFrame(frame);
  }
  function startPlay() {
    if (S.playing) return;
    S.playing = true;
    lastFrame = performance.now();
    $('playBtn').classList.add('playing');
    $('playBtn').setAttribute('aria-label', 'Pause');
    requestAnimationFrame(frame);
  }
  function stopPlay() {
    if (!S.playing) return;
    S.playing = false;
    $('playBtn').classList.remove('playing');
    $('playBtn').setAttribute('aria-label', 'Play');
    roll.setTime(S.time, false);
  }
  var MIX_NOTE = { original: 'Your recording', both: 'Your recording + MIDI piano', midi: 'MIDI piano only' };
  function setMix(m) {
    S.mix = m;
    roll.mix = m;
    Array.prototype.forEach.call($('mixSeg').children, function (b) { b.setAttribute('aria-checked', String(b.dataset.mix === m)); b.tabIndex = b.dataset.mix === m ? 0 : -1; });
    $('listenNote').textContent = MIX_NOTE[m];
    roll.requestDraw();
  }

  // ------------------------------------------------------------------ advanced options
  var CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  function tilesHtml(fid, spec, value) {
    return '<div class="tiles" role="radiogroup" aria-labelledby="' + fid + '-l">' + spec.choices.map(function (c) {
      var l = splitLabel(c.label), on = String(c.value) === String(value);
      return '<button type="button" class="tile" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-fid="' + fid + ':' + esc(c.value) + '" data-set="' + fid + '" data-value="' + esc(c.value) + '">' +
        '<span class="t-main">' + esc(l.main) + '</span>' + (l.sub ? '<span class="t-sub">' + esc(l.sub) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function choiceField(fid, spec, value, helpOverride) {
    return '<div class="field"><div class="field-label" id="' + fid + '-l">' + esc(spec.label) + '</div>' +
      '<p class="help">' + esc(helpOverride || spec.help) + '</p>' + tilesHtml(fid, spec, value) + '</div>';
  }
  function boolField(fid, spec, value) {
    return '<div class="field toggle-row"><div class="field-label" id="' + fid + '-l">' + esc(spec.label) + '</div>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + !!value + '" aria-labelledby="' + fid + '-l" data-fid="' + fid + '" data-toggle="' + fid + '"></button>' +
      '<p class="help">' + esc(spec.help) + '</p></div>';
  }
  function numDisplay(key, v) {
    if (key === 'min_note_ms') return v ? v + ' ms' : 'Off';
    if (key === 'tempo') return v + ' BPM';
    return String(v);
  }
  function sliderField(fid, spec, value, extraClass) {
    var pct = (value - spec.min) / (spec.max - spec.min) * 100;
    return '<div class="field' + (extraClass ? ' ' + extraClass : '') + '"><div class="field-label"><label for="in-' + fid + '">' + esc(spec.label) + '</label><span class="val" id="val-' + fid + '">' + numDisplay(spec.key, value) + '</span></div>' +
      '<input type="range" id="in-' + fid + '" data-fid="' + fid + '" data-range="' + fid + '" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + value + '" style="--p:' + pct + '%">' +
      '<p class="help">' + esc(spec.help) + '</p></div>';
  }
  function stepperField(fid, spec, value) {
    return '<div class="field"><div class="field-label field-label-row"><label for="in-' + fid + '">' + esc(spec.label) + '</label>' +
      '<span class="slider-row"><span class="stepper"><button type="button" class="icon-btn" data-fid="' + fid + ':-" data-step="' + fid + '" data-dir="-1" aria-label="Slower"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>' +
      '<input type="number" id="in-' + fid + '" data-fid="' + fid + '" data-num="' + fid + '" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + value + '">' +
      '<button type="button" class="icon-btn" data-fid="' + fid + ':+" data-step="' + fid + '" data-dir="1" aria-label="Faster"><svg viewBox="0 0 24 24"><path d="M6 12h12M12 6v12"/></svg></button></span>' +
      '<span class="unit">' + esc(spec.unit) + '</span></span></div>' +
      '<p class="help">' + esc(spec.help) + '</p></div>';
  }

  function renderAdvanced() {
    var focusId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fid : null;
    var s = S.settings, eng = engineById(s.engine);

    $('engineList').innerHTML = ENGINES.map(function (e) {
      var on = e.id === s.engine, cp = ENGINE_COPY[e.id];
      var na = !e.available;
      return '<button type="button" class="engine-opt" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-fid="eng:' + e.id + '" data-engine="' + e.id + '" title="' + esc(e.summary) + '"' + (na ? ' aria-disabled="true"' : '') + '>' +
        '<span class="radio" aria-hidden="true"></span><span class="eo-name">' + esc(e.name) + (cp.badge ? '<span class="eo-badge">' + cp.badge + '</span>' : '') + '</span>' +
        '<span class="eo-desc">' + esc(na ? e.unavailable_reason : cp.desc) + '</span></button>';
    }).join('');

    var vf = '';
    if (engineHas(eng, 'views')) vf = choiceField('views', optSpec('views'), s.opts.views);
    else vf = '<div class="note-box">' + esc(eng.name) + ' has no extra settings.</div>';
    $('viewsField').innerHTML = vf;

    var tf = '';
    if (engineHas(eng, 'rescue')) tf += choiceField('rescue', optSpec('rescue'), s.opts.rescue);
    else tf += '<div class="field dim"><div class="field-label">Second opinion</div><p class="help">Only used by the Ensemble engine, where Aria-AMT adds notes Transkun was unsure about.</p></div>';
    var tk = engineById('transkun');
    var tkFields = choiceField('velocity', optSpec('velocity'), s.opts.velocity) + boolField('merge_fix', optSpec('merge_fix'), s.opts.merge_fix);
    if (s.engine === 'transkun') {
      tf += tkFields;
    } else {
      tf += '<button type="button" class="disclosure" id="moreBtn" data-fid="more" aria-expanded="' + S.more + '" aria-controls="moreArea">' + CHEV + 'More Transkun V2 settings</button>';
      if (S.more) tf += '<div class="more-area" id="moreArea"><p class="help">Used when Transkun V2 runs on its own.</p>' + tkFields + '</div>';
    }
    $('tuneFields').innerHTML = tf;
    $('rerunBox').hidden = !(S.view === 'result' && transcriptionKey(s) !== S.jobSettings);
    void tk;

    var of = '';
    of += '<p class="help col-note">' + (S.view === 'result' ? 'Changes update the open result right away, no need to convert again.' : 'Applied when your MIDI file is written. You can still change them after converting.') + '</p>';
    of += choiceField('pedal', outSpec('pedal'), s.out.pedal);
    of += boolField('soft_pedal', outSpec('soft_pedal'), s.out.soft_pedal);
    of += choiceField('dyn', outSpec('velocity'), s.out.velocity);
    if (s.out.velocity === 'flat') of += '<div class="sub-panel">' + sliderField('flat_velocity', outSpec('flat_velocity'), s.out.flat_velocity).replace(/^<div class="field">|<\/div>$/g, '') + '</div>';
    of += sliderField('min_note_ms', outSpec('min_note_ms'), s.out.min_note_ms);
    of += stepperField('tempo', outSpec('tempo'), s.out.tempo);
    $('outFields').innerHTML = of;

    if (focusId) {
      var el = document.querySelector('.advanced [data-fid="' + focusId.replace(/"/g, '\\"') + '"]');
      if (el) el.focus();
    }
  }

  var OPT_KEYS = { views: 'views', rescue: 'rescue', velocity: 'velocity', merge_fix: 'merge_fix' };
  var OUT_KEYS = { pedal: 'pedal', soft_pedal: 'soft_pedal', dyn: 'velocity', flat_velocity: 'flat_velocity', min_note_ms: 'min_note_ms', tempo: 'tempo' };
  function setValue(fid, value) {
    if (fid in OPT_KEYS) S.settings.opts[OPT_KEYS[fid]] = value;
    else if (fid in OUT_KEYS) {
      var spec = outSpec(OUT_KEYS[fid]);
      if (spec.kind === 'number') value = Math.max(spec.min, Math.min(spec.max, Math.round(Number(value) / spec.step) * spec.step || spec.min));
      S.settings.out[OUT_KEYS[fid]] = value;
      applyOutput(false);
    }
    engineSummary();
  }

  function wireAdvanced() {
    var adv = $('advanced');
    adv.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t || !adv.contains(t)) return;
      if (t.dataset.engine) {
        S.settings.engine = t.dataset.engine;
        renderAdvanced(); engineSummary();
      } else if (t.dataset.set) {
        setValue(t.dataset.set, t.dataset.value);
        renderAdvanced();
      } else if (t.dataset.toggle) {
        var k = t.dataset.toggle;
        var cur = k in OPT_KEYS ? S.settings.opts[OPT_KEYS[k]] : S.settings.out[OUT_KEYS[k]];
        setValue(k, !cur);
        renderAdvanced();
      } else if (t.dataset.step) {
        var f = t.dataset.step, sp = outSpec(OUT_KEYS[f]);
        setValue(f, S.settings.out[OUT_KEYS[f]] + sp.step * Number(t.dataset.dir));
        var inp = $('in-' + f); if (inp) inp.value = S.settings.out[OUT_KEYS[f]];
      } else if (t.id === 'moreBtn') {
        S.more = !S.more;
        renderAdvanced();
      }
    });
    adv.addEventListener('input', function (e) {
      var t = e.target;
      if (t.dataset.range) {
        var f = t.dataset.range, sp = outSpec(OUT_KEYS[f]);
        setValue(f, Number(t.value));
        t.style.setProperty('--p', ((t.value - sp.min) / (sp.max - sp.min) * 100) + '%');
        $('val-' + f).textContent = numDisplay(sp.key, Number(t.value));
      }
    });
    adv.addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.num) { setValue(t.dataset.num, t.value); t.value = S.settings.out[OUT_KEYS[t.dataset.num]]; }
    });
    adv.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeAdvanced(); return; }
      if (e.key === 'Tab') {
        var f = adv.querySelectorAll('button:not([tabindex="-1"]), input, [tabindex="0"]');
        f = Array.prototype.filter.call(f, function (el) { return el.offsetParent !== null; });
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    $('closeAdvanced').addEventListener('click', function () { closeAdvanced(); });
    $('doneBtn').addEventListener('click', function () { closeAdvanced(); });
    $('scrim').addEventListener('click', function () { closeAdvanced(); });
    $('resetBtn').addEventListener('click', function () {
      S.settings = defaults();
      applyOutput(false);
      renderAdvanced(); engineSummary();
      toast('Options are back to their defaults.', { icon: 'retry' });
    });
    $('rerunBtn').addEventListener('click', function () { startConversion(S.job.name, 0); });
  }
  var opener = null;
  function setInert(on) {
    // Everything behind the dialog is inert while it is open (the reviewers' switcher stays usable).
    [document.querySelector('.topbar'), document.querySelector('.page')].forEach(function (el) {
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
  }
  function openAdvanced(expandMore) {
    if (S.adv) return;
    opener = document.activeElement;
    S.adv = true;
    if (expandMore) S.more = true;
    stopPlay();
    renderAdvanced();
    $('scrim').hidden = false;
    $('advanced').hidden = false;
    setInert(true);
    $('openAdvanced').setAttribute('aria-expanded', 'true');
    markSwitch();
    // Focus the dialog itself so Tab starts inside it (no ring until the user moves).
    setTimeout(function () { $('advanced').focus({ preventScroll: true }); }, 30);
  }
  function closeAdvanced(silent) {
    if (!S.adv) return;
    S.adv = false;
    $('scrim').hidden = true;
    $('advanced').hidden = true;
    setInert(false);
    $('openAdvanced').setAttribute('aria-expanded', 'false');
    markSwitch();
    if (!silent && opener && opener.focus && document.contains(opener)) opener.focus();
  }

  // ------------------------------------------------------------------ toast + burst
  var toastTimer = 0;
  function toast(html, opts) {
    opts = opts || {};
    var t = $('toast');
    var icon = opts.icon === 'clock' ? ICON.clock : opts.icon === 'retry' ? ICON.retry : ICON.check;
    t.innerHTML = '<span class="t-ico' + (opts.icon ? ' info' : '') + '" aria-hidden="true">' + icon + '</span><span class="t-msg">' + html + '</span>' + (opts.action ? '<button type="button" id="toastAct">' + esc(opts.action) + '</button>' : '');
    if (opts.action) $('toastAct').addEventListener('click', function () { t.classList.remove('show'); if (opts.run) opts.run(); });
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, opts.ms || 4200);
  }
  function burst(el) {
    if (REDUCED) return;
    var r = el.getBoundingClientRect(), b = $('burst');
    b.style.left = (r.left + r.width / 2) + 'px';
    b.style.top = (r.top + r.height / 2) + 'px';
    b.innerHTML = '';
    for (var i = 0; i < 16; i++) {
      var a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, d = 50 + Math.random() * 40;
      var it = document.createElement('i');
      it.style.setProperty('--c', ramp(i / 15));
      it.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      it.style.setProperty('--dy', (Math.sin(a) * d * 0.7).toFixed(1) + 'px');
      if (i % 3 === 0) it.style.borderRadius = '50%';
      b.appendChild(it);
    }
    setTimeout(function () { b.innerHTML = ''; }, 900);
  }

  // ------------------------------------------------------------------ state switcher (reviewers)
  function markSwitch() {
    var cur = S.adv ? 'advanced' : S.view;
    Array.prototype.forEach.call(document.querySelectorAll('#stateSwitch button'), function (b) { b.classList.toggle('on', b.dataset.state === cur); });
  }
  function applyState(name) {
    stopProgress();
    closeAdvanced(true);
    S.job = { name: M.job.filename, duration: M.job.stats.duration, notes: M.job.stats.notes };
    if (name === 'progress') showStaticProgress();
    else if (name === 'result' || name === 'advanced') {
      S.time = 12;
      openResult(false);
      if (name === 'advanced') openAdvanced(true);
    } else show('home');
  }

  // ------------------------------------------------------------------ wiring
  function wire() {
    var dz = $('dropzone');
    dz.addEventListener('click', function () { startConversion(M.file.name, 0); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startConversion(M.file.name, 0); } });

    // real drag & drop anywhere on the window
    var depth = 0;
    window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; $('dropOverlay').hidden = false; dz.classList.add('over'); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; $('dropOverlay').hidden = true; dz.classList.remove('over'); } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; $('dropOverlay').hidden = true; dz.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      startConversion(f ? f.name : M.file.name, 0);
    });

    $('brand').addEventListener('click', function (e) { e.preventDefault(); closeAdvanced(true); show('home'); });
    $('openAdvanced').addEventListener('click', function () { openAdvanced(false); });
    $('engineCard').addEventListener('click', function () { openAdvanced(false); });
    $('cancelBtn').addEventListener('click', function () { stopProgress(); show('home'); toast('Conversion cancelled. Nothing was saved.', { icon: 'retry' }); });
    $('newBtn').addEventListener('click', function () { show('home'); $('dropzone').focus({ preventScroll: true }); });
    $('saveBtn').addEventListener('click', function () {
      burst($('saveBtn'));
      toast('Saved <b>' + esc(stripName(S.job.name)) + '.mid</b> to Downloads', { action: 'Show in folder' });
    });
    $('playBtn').addEventListener('click', function () { S.playing ? stopPlay() : startPlay(); });
    $('zoomIn').addEventListener('click', function () { roll.zoom(1.3); });
    $('zoomOut').addEventListener('click', function () { roll.zoom(1 / 1.3); });
    $('mixSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setMix(b.dataset.mix); });

    // arrow keys inside any radiogroup
    document.addEventListener('keydown', function (e) {
      var g = e.target.closest && e.target.closest('[role="radiogroup"]');
      if (g && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        var items = Array.prototype.slice.call(g.querySelectorAll('[role="radio"]'));
        var i = items.indexOf(e.target);
        if (i < 0) return;
        e.preventDefault();
        var n = items[(i + (/Right|Down/.test(e.key) ? 1 : items.length - 1)) % items.length];
        n.focus(); n.click();
        return;
      }
      if (e.key === ' ' && S.view === 'result' && !S.adv && !/INPUT|BUTTON|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); S.playing ? stopPlay() : startPlay(); }
      if (e.key === 'Escape' && S.adv) closeAdvanced();
    });

    if (CLEAN) $('stateSwitch').hidden = true;
    $('stateSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var u = new URL(location.href);
      u.searchParams.set('state', b.dataset.state);
      history.replaceState(null, '', u);
      applyState(b.dataset.state);
    });
    wireAdvanced();
  }

  // ------------------------------------------------------------------ boot
  buildKeyboard();
  renderRecent();
  engineSummary();
  $('factNum').textContent = M.accuracy.onset_f1.clean.toFixed(1) + '%';
  var F1 = M.accuracy.onset_f1;
  $('factGrid').innerHTML = [['Studio', F1.clean], ['MP3', F1.mp3], ['Phone', F1.phone], ['Big hall', F1.reverb], ['Noisy room', F1.noise], ['All combined', F1.worst]]
    .map(function (r) { return '<li><span>' + r[0] + '</span><b>' + r[1].toFixed(1) + '%</b></li>'; }).join('');
  $('factSrc').textContent = 'Measured on ' + M.accuracy.note.replace('MAESTRO test, 12 pieces', '12 MAESTRO test pieces');
  $('aboutLine').textContent = M.info.app + ' ' + M.info.version + ' · ' + M.info.device.name + ', ' + M.info.device.vram_gb + ' GB';
  $('gpuChip').title = 'Running on ' + M.info.device.name + ' (' + M.info.device.vram_gb + ' GB)';
  setMix('both');
  applyOutput(true);
  wire();
  applyState(params.get('state') || 'home');
  // Entry animations only for later view changes, so the first paint is always complete.
  booted = true;
})();
