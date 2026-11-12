/* MIDI Converter · variant 06 "Hardware Rack" — clickable prototype (no backend). Classic script. */
(function () {
  'use strict';

  var M = window.MOCK, MC = window.MCRoll;
  if (!M || !MC) throw new Error('Shared files did not load (../../shared/mock-data.js, roll.js).');

  var qs = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var fmtTime = MC.fmtTime;
  if (qs.get('clean') === '1') document.body.classList.add('clean');

  // ------------------------------------------------------------------ schema + state
  var PIANO = M.info.instruments[0];
  var ENGINES = PIANO.engines;
  var ENG = {}; ENGINES.forEach(function (e) { ENG[e.id] = e; });
  var OUTO = {}; M.info.output_options.forEach(function (o) { OUTO[o.key] = o; });
  var optOf = function (engine, key) { return (ENG[engine].options || []).filter(function (o) { return o.key === key; })[0]; };

  var SHORT_ENGINE = { ensemble: 'Ensemble', transkun: 'Transkun V2', aria: 'Aria-AMT' };
  var SHORT_VIEWS = { none: 'Single view', channels: 'Stereo views 4×', full: 'Stereo + tone 6×' };
  var VIEW_COUNT = { none: 1, channels: 4, full: 6 };
  var WINDOWS = M.progress.windows || 9;

  function defaults() {
    var eopt = {};
    ENGINES.forEach(function (e) { eopt[e.id] = {}; (e.options || []).forEach(function (o) { eopt[e.id][o.key] = o.default; }); });
    var out = {};
    M.info.output_options.forEach(function (o) { out[o.key] = o.default; });
    return { engine: PIANO.default_engine, eopt: eopt, out: out };
  }

  var S = Object.assign({
    view: 'home', adv: false, mix: 'both', time: 0, playing: false,
    file: M.file.name, progress: 0, runEngine: null, used: null, anim: 0,
  }, defaults());

  var transSig = function () { return JSON.stringify([S.engine, S.eopt[S.engine]]); };

  // ------------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function polar(cx, cy, r, deg) { var a = deg * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
  function arc(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }
  var nf = function (n) { return Number(n).toLocaleString('en-US'); };
  var stripExt = function (name) { return name.replace(/\.[^.]+$/, ''); };

  function engineSummary(engine) {
    engine = engine || S.engine;
    var v = S.eopt[engine].views;
    return v ? SHORT_ENGINE[engine] + ' · ' + SHORT_VIEWS[v] : SHORT_ENGINE[engine];
  }

  // ------------------------------------------------------------------ toast
  var toastTimer = 0;
  function toast(msg, action) {
    var t = $('toast'), a = $('toastAction');
    $('toastText').textContent = msg;
    if (action) {
      a.hidden = false; a.textContent = action.label;
      a.onclick = function () { t.hidden = true; if (action.run) action.run(); };
    } else a.hidden = true;
    t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, action ? 5200 : 2600);
  }

  // ------------------------------------------------------------------ VFD
  var announceTimer = 0;
  function announce(text) {
    // the VFD redraws constantly, so screen readers get short messages from a separate live region
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { $('announce').textContent = text; }, 120);
  }
  var flashTimer = 0, flashText = '';
  function flash(text, ms) {
    flashText = text;
    announce(text);
    clearTimeout(flashTimer);
    renderVfd();
    flashTimer = setTimeout(function () { flashText = ''; renderVfd(); }, ms || 1800);
  }

  function buildMeter() {
    var m = $('vfdMeter');
    for (var i = 0; i < 40; i++) m.append(el('i'));
  }

  function outputStats() {
    var d = derived();
    var sustain = d.pedals.filter(function (p) { return p[2] === 64; }).length;
    var soft = d.pedals.filter(function (p) { return p[2] === 67; }).length;
    var pedalText = S.out.pedal === 'cc' ? sustain + ' pedal presses' : S.out.pedal === 'extend' ? 'pedal baked into notes' : 'pedal left out';
    return { notes: d.notes.length, sustain: sustain, soft: soft, pedalText: pedalText };
  }

  function setRow(node, left, right, rightCls) {
    node.textContent = '';
    node.append(typeof left === 'string' ? el('span', '', left) : left);
    if (right) node.append(el('span', 'dim ' + (rightCls || ''), right));
  }

  function renderVfd() {
    var mode = $('vfdMode'), aside = $('vfdAside'), big = $('vfdBig'), sub = $('vfdSub');
    var meter = $('vfdMeter'), ro = $('vfdReadout');
    var dotBlink = false, modeText = '', asideText = '', bigText = '', subL = '', subR = '', subRCls = '';
    var showMeter = false, showRo = false, roNum = '', roUnit = '';

    if (S.view === 'home') {
      modeText = document.body.classList.contains('dragging') ? 'Release to convert' : 'Ready';
      asideText = 'GPU ready';
      bigText = 'Waiting for a recording';
      subL = 'Piano · ' + engineSummary();
      subR = S.engine === 'transkun' ? '~6 sec per 2-min piece' : '~20–25 sec per 2-min piece';
      subRCls = 'opt';
    } else if (S.view === 'progress') {
      var pm = progModel(S.progress);
      dotBlink = true;
      modeText = 'Converting';
      asideText = pm.eta > 0 ? '~' + pm.eta + ' sec left' : 'finishing';
      bigText = S.file;
      subL = pm.msg;
      subR = SHORT_ENGINE[S.runEngine || S.engine];
      showMeter = true; showRo = true;
      roNum = Math.round(S.progress * 100) + '%'; roUnit = 'done';
      var lit = Math.round(S.progress * 40);
      Array.prototype.forEach.call(meter.children, function (seg, i) { seg.classList.toggle('on', i < lit); });
    } else {
      var st = outputStats();
      modeText = 'Done';
      asideText = 'converted in ' + M.job.stats.seconds_total + ' sec';
      bigText = S.file;
      var eng = S.runEngine || M.job.engine;
      subL = el('span');
      subL.append(el('span', 'nar', fmtTime(M.job.stats.duration) + ' · '),
        document.createTextNode(nf(st.notes) + ' notes · ' + st.pedalText + ' · '),
        el('span', 'wide-only', ENG[eng].name), el('span', 'nar', SHORT_ENGINE[eng]));
      showRo = true; roNum = fmtTime(M.job.stats.duration); roUnit = 'length';
    }
    if (flashText) { modeText = flashText; dotBlink = false; }

    mode.textContent = '';
    var dot = el('i', 'vfd-dot' + (dotBlink ? ' blink' : ''));
    mode.append(dot, document.createTextNode(modeText));
    aside.textContent = asideText;
    big.textContent = bigText; big.title = bigText;
    setRow(sub, subL, subR, subRCls);
    meter.hidden = !showMeter;
    ro.hidden = !showRo;
    $('roNum').textContent = roNum; $('roUnit').textContent = roUnit;
    if (S.view === 'progress') ro.setAttribute('aria-valuenow', Math.round(S.progress * 100)); else ro.removeAttribute('aria-valuenow');
  }

  // ------------------------------------------------------------------ signal path
  function stagesFor(engine) {
    var v = S.eopt[engine].views || S.eopt.ensemble.views;
    var n = VIEW_COUNT[v] || 4;
    return [
      { id: 'decode', label: 'Read audio', short: 'Read audio' },
      { id: 'transkun', label: 'Transkun V2 · ' + n + (n === 1 ? ' view' : ' views'), short: 'Transkun ×' + n, bypass: engine === 'aria' },
      { id: 'aria', label: engine === 'aria' ? 'Aria-AMT' : 'Aria-AMT second opinion', short: 'Aria-AMT', bypass: engine === 'transkun' },
      { id: 'fuse', label: engine === 'ensemble' ? 'Merge + write MIDI' : 'Write MIDI', short: engine === 'ensemble' ? 'Merge + write' : 'Write MIDI' },
    ];
  }

  function renderPath() {
    var engine = S.view === 'home' ? S.engine : (S.runEngine || S.engine);
    var stages = stagesFor(engine);
    var active = S.view === 'progress' ? progModel(S.progress).stage : null;
    var order = stages.map(function (s) { return s.id; });
    var ol = $('spList');
    ol.textContent = '';
    stages.forEach(function (s, i) {
      var state;
      if (s.bypass) state = 'bypass';
      else if (S.view === 'home') state = 'idle';
      else if (S.view === 'result') state = 'done';
      else {
        var ai = order.indexOf(active);
        state = i < ai ? 'done' : i === ai ? 'active' : 'pending';
      }
      var li = el('li', 'sp-step ' + state);
      var led = el('i', 'led ' + (state === 'active' ? 'amber on blink' : state === 'done' ? 'green on' : ''));
      led.setAttribute('aria-hidden', 'true');
      li.append(led, el('span', 'wide-only', s.label + (s.bypass ? ' (bypassed)' : '')), el('span', 'nar', s.short));
      var label = s.label + ': ' + ({ idle: 'ready', done: 'done', active: 'in progress', pending: 'waiting', bypass: 'not used by this engine' })[state];
      li.setAttribute('aria-label', label);
      li.title = label;
      ol.append(li);
      if (i < stages.length - 1) { var ar = el('li', 'sp-arrow'); ar.setAttribute('aria-hidden', 'true'); ol.append(ar); }
    });
  }

  // ------------------------------------------------------------------ progress model + analysis screen
  var T_DECODE = 0.06, T_WINDOWS = 0.82, T_SECOND = 0.94;
  function progModel(p) {
    var e = S.runEngine || S.engine;
    var stage, win = 0, msg;
    if (p < T_DECODE) { stage = 'decode'; msg = 'Reading audio'; }
    else if (p < T_WINDOWS) {
      win = clamp(1 + Math.floor((p - T_DECODE) / (T_WINDOWS - T_DECODE) * WINDOWS), 1, WINDOWS);
      stage = e === 'aria' ? 'aria' : 'transkun';
      msg = (e === 'aria' ? 'Aria-AMT · window ' : 'Transcribing window ') + win + ' of ' + WINDOWS;
    } else if (p < T_SECOND && e === 'ensemble') { stage = 'aria'; win = WINDOWS + 1; msg = 'Second opinion from Aria-AMT'; }
    else { stage = 'fuse'; win = WINDOWS + 1; msg = e === 'ensemble' ? 'Merging and writing MIDI' : 'Writing MIDI'; }
    return { stage: stage, win: win, msg: msg, eta: Math.max(0, Math.round((1 - p) * 26)) };
  }

  var LOG_EXTRA = [
    '14:32:05.404  transkun  window 6/9  notes+=62   pedal+=3',
    '14:32:06.176  transkun  window 7/9  notes+=51   pedal+=2',
    '14:32:06.949  transkun  window 8/9  notes+=33   pedal+=3',
    '14:32:07.721  transkun  window 9/9  notes+=16   pedal+=1',
    '14:32:09.884  aria  second opinion  notes+=9  (rescue 0.3)',
    '14:32:12.590  fuse  620 notes  53 sustain  2 soft',
    '14:32:12.712  done  wrote MIDI in 11.6 s',
  ];
  function logUntil(p) {
    var wp = function (w) { return T_DECODE + (w - 1) / WINDOWS * (T_WINDOWS - T_DECODE); };
    var L = [[0, M.log[0]], [0.03, M.log[1]]];
    for (var w = 1; w <= WINDOWS; w++) {
      var line = w <= 5 ? M.log[w + 1] : LOG_EXTRA[w - 6];
      if (line) L.push([wp(w), line]);
    }
    L.push([T_WINDOWS, LOG_EXTRA[4]], [T_SECOND, LOG_EXTRA[5]], [0.999, LOG_EXTRA[6]]);
    return L.filter(function (x) { return p >= x[0]; }).map(function (x) { return x[1]; });
  }

  function buildWindows() {
    var box = $('anWindows');
    for (var i = 1; i <= WINDOWS; i++) {
      var w = el('div', 'an-win');
      w.append(el('span', '', String(i)));
      box.append(w);
    }
  }

  function renderProgress() {
    var pm = progModel(S.progress);
    $('anFile').textContent = S.file;
    $('anFile').title = S.file;
    $('anFmt').textContent = M.file.format + ' · ' + M.file.size_mb + ' MB';
    Array.prototype.forEach.call($('anWindows').children, function (w, i) {
      var n = i + 1;
      w.className = 'an-win ' + (pm.win === 0 ? 'pending' : n < pm.win ? 'done' : n === pm.win ? 'active' : 'pending');
    });
    var lines = logUntil(S.progress);
    var log = $('anLog');
    if (log.childElementCount !== lines.length) {
      log.textContent = '';
      lines.forEach(function (l) { log.append(el('div', '', l)); });
    }
    if (S.view === 'progress') {
      $('monAside').textContent = pm.win >= 1 && pm.win <= WINDOWS ? 'Window ' + pm.win + ' of ' + WINDOWS + ' · ' + (VIEW_COUNT[S.eopt[S.runEngine || S.engine].views] || 1) + ' views per window' : pm.msg;
    }
  }

  function drawWave() {
    var cv = $('waveCanvas');
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var rms = M.waveform.rms, pk = M.waveform.peak, N = rms.length, mid = h / 2;
    var maxPk = 0; for (var i = 0; i < N; i++) if (pk[i] > maxPk) maxPk = pk[i];
    ctx.fillStyle = 'rgba(124,244,226,.07)';
    ctx.fillRect(0, mid - 0.5, w, 1);
    for (var x = 0; x < w; x++) {
      var i0 = Math.floor(x / w * N), i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * N));
      var p = 0, r = 0;
      for (var j = i0; j < i1; j++) { if (pk[j] > p) p = pk[j]; if (rms[j] > r) r = rms[j]; }
      var ph = p / maxPk * mid * 0.94, rh = r / maxPk * mid * 0.94;
      ctx.fillStyle = 'rgba(124,244,226,.30)';
      ctx.fillRect(x, mid - ph, 1, ph * 2);
      ctx.fillStyle = '#7cf4e2';
      ctx.fillRect(x, mid - rh, 1, rh * 2);
    }
  }

  // ------------------------------------------------------------------ recent conversions (home screen)
  function renderRecent() {
    var ul = $('recentList');
    ul.textContent = '';
    if (!M.recent.length) { ul.append(el('li', 'crt-empty', 'Nothing converted yet. Your files will appear here.')); return; }
    M.recent.forEach(function (j) {
      var li = el('li');
      var b = el('button', 'crt-row st-' + j.status);
      b.type = 'button';
      var statusText = ({ done: 'Done', running: 'Converting', queued: 'Waiting', error: 'Failed' })[j.status] || j.status;
      var info = el('span', 'c-info');
      if (j.status === 'done') info.textContent = nf(j.notes) + ' notes';
      else if (j.status === 'running') {
        var bar = el('span', 'mini-bar');
        for (var i = 0; i < 8; i++) bar.append(el('i', i < Math.round(j.progress * 8) ? 'on' : ''));
        info.append(bar, document.createTextNode(Math.round(j.progress * 100) + '%'));
      } else if (j.status === 'queued') info.textContent = 'Next in line';
      else info.textContent = j.error || 'Could not convert';
      var stat = el('span', 'c-stat');
      b.append(stat, el('span', 'c-name', j.filename), el('span', 'c-dur', fmtTime(j.duration)), info, el('span', 'c-badge', statusText), el('span', 'c-when', j.when));
      b.title = j.filename;
      b.setAttribute('aria-label', j.filename + ', ' + statusText + ', ' + info.textContent + ', ' + j.when);
      b.addEventListener('click', function () { openRecent(j); });
      li.append(b);
      ul.append(li);
    });
    var running = M.recent.filter(function (j) { return j.status === 'running'; }).length;
    var queued = M.recent.filter(function (j) { return j.status === 'queued'; }).length;
    var acc = M.accuracy.onset_f1;
    var spec = $('specLine');
    spec.textContent = 'Measured note accuracy: ';
    [['clean', acc.clean], ['phone', acc.phone], ['worst case', acc.worst]].forEach(function (a, i) {
      if (i) spec.append(document.createTextNode(' · '));
      spec.append(el('b', '', a[1].toFixed(1) + '%'), document.createTextNode(' ' + a[0]));
    });
    spec.title = M.accuracy.note + ', note-onset F1';
    S.recentAside = M.recent.length + ' files' + (running ? ' · ' + running + ' converting' : '') + (queued ? ' · ' + queued + ' waiting' : '');
  }

  function openRecent(j) {
    if (j.status === 'done') { cancelAnim(); S.file = j.filename; S.runEngine = M.job.engine; S.used = transSig(); S.time = 0; setView('result'); }
    else if (j.status === 'running') startConversion(j.filename, j.progress);
    else if (j.status === 'queued') toast('“' + stripExt(j.filename) + '” starts when the current conversion finishes.');
    else toast(j.error + ' Try another recording.', { label: 'Choose file', run: function () { startConversion(); } });
  }

  // ------------------------------------------------------------------ piano roll + output options
  function derived() {
    var o = S.out, minS = (o.min_note_ms || 0) / 1000;
    var notes = [];
    M.notes.forEach(function (n) {
      if (minS > 0 && n[1] - n[0] < minS) return;
      var s = n[0], e = n[1], p = n[2], v = n[3], snd = n[4] || n[1], c = n[5];
      if (o.pedal === 'extend') { e = Math.max(e, snd); snd = e; }
      else if (o.pedal === 'none') snd = e;
      if (o.velocity === 'flat') v = o.flat_velocity;
      notes.push([s, e, p, v, snd, c]);
    });
    var pedals = M.pedals.filter(function (p) { return p[2] === 64 ? o.pedal === 'cc' : (p[2] === 67 ? o.soft_pedal : true); });
    return { notes: notes, pedals: pedals, duration: M.duration };
  }

  var roll = new MC.PianoRoll($('roll'), {
    onSeek: function (t) { S.time = t; roll.setTime(t, S.playing); updTime(); },
  });
  // phosphor glow: every stroke the roll draws gets a soft cyan bloom.
  // Two additions on top of the shared renderer: the soft pedal (CC67) gets its own dashed trace along the
  // top of the pedal lane (the stock 2 px bar at the very bottom disappears under the screen vignette),
  // and a time label that would be cut off by the right edge of the screen is not drawn.
  var GRID_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  var baseDraw = roll._draw;
  roll._draw = function () {
    var ctx = this.canvas.getContext('2d');
    var all = this.pedals;
    var soft = all.filter(function (p) { return p[2] === 67; });
    this.pedals = all.filter(function (p) { return p[2] !== 67; });
    ctx.shadowColor = 'rgba(124,244,226,.55)';
    ctx.shadowBlur = 6;
    try { baseDraw.call(this); } finally { this.pedals = all; }

    var W = this._viewW(), H = this.el.clientHeight, c = this.c;
    var t0 = this.scrollX, t1 = t0 + W / this.pxPerSec;

    // soft pedal trace
    ctx.shadowColor = 'rgba(255,166,61,.6)';
    ctx.shadowBlur = 4;
    ctx.strokeStyle = '#ffd9a3';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    var yS = H - this.pedalH + 2;
    soft.forEach(function (p) {
      if (p[1] < t0 || p[0] > t1) return;
      var x0 = (p[0] - t0) * roll.pxPerSec, x1 = (p[1] - t0) * roll.pxPerSec;
      ctx.beginPath(); ctx.moveTo(x0, yS); ctx.lineTo(Math.max(x0 + 2, x1), yS); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // right-edge axis label: hide it if it would be clipped
    var pps = this.pxPerSec, step = 600;
    for (var i = 0; i < GRID_STEPS.length; i++) if (GRID_STEPS[i] * pps >= 72) { step = GRID_STEPS[i]; break; }
    var tl = Math.floor(t1 / step) * step;
    var xl = Math.round((tl - t0) * pps) + 0.5;
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    var label = step < 1 ? fmtTime(tl, true) : fmtTime(tl);
    if (xl + 4 + ctx.measureText(label).width > W - 3) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(xl + 1, 0, W - xl, this.axisH - 1);
      var px = (this.time - t0) * pps;  // keep the playhead cap if it sits in the patched strip
      if (px >= xl - 6 && px <= W + 2) {
        ctx.fillStyle = c.playhead;
        ctx.fillRect(Math.round(px) - 0.75, 0, 1.5, this.axisH);
        ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.closePath(); ctx.fill();
      }
    }
  };
  roll.setData(derived());

  function applyOutput(announce) {
    roll.setData(derived(), { keepView: true });
    roll.setTime(S.time, S.playing);
    if (S.view === 'result') {
      renderMonitorHead();
      if (announce) {
        flash('MIDI updated');
        var led = $('ledMidi'); led.classList.add('blink'); setTimeout(function () { led.classList.remove('blink'); }, 900);
      } else renderVfd();
    }
  }

  // transport
  var raf = 0, lastT = 0;
  function updTime() {
    $('timeLabel').textContent = fmtTime(S.time) + ' / ' + fmtTime(M.duration);
    updMeter();
  }
  function play() {
    if (S.time >= M.duration - 0.05) S.time = 0;
    S.playing = true; lastT = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    updPlay();
  }
  function pause() { S.playing = false; cancelAnimationFrame(raf); roll.setTime(S.time, false); updPlay(); }
  function tick(now) {
    S.time = Math.min(M.duration, S.time + (now - lastT) / 1000);
    lastT = now;
    roll.setTime(S.time, true);
    updTime();
    if (S.time >= M.duration) { pause(); return; }
    raf = requestAnimationFrame(tick);
  }
  function updPlay() {
    var b = $('playBtn');
    b.classList.toggle('playing', S.playing);
    b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    $('ledPlay').classList.toggle('on', S.playing);
    updMeter();
  }

  function buildMeterLR() {
    ['meterL', 'meterR'].forEach(function (id) {
      var m = $(id);
      for (var i = 0; i < 16; i++) m.append(el('i', i >= 14 ? 'r' : i >= 11 ? 'y' : ''));
    });
  }
  function updMeter() {
    var rms = M.waveform.rms, hop = M.waveform.hop_seconds;
    var i = clamp(Math.floor(S.time / hop), 0, rms.length - 1);
    var lvl = function (r) { return clamp((20 * Math.log10(r + 1e-6) + 40) / 40, 0, 1); };
    var gain = S.playing ? 1 : 0.85;
    var L = Math.round(lvl(rms[i] * 1.6 * gain) * 16), R = Math.round(lvl((rms[clamp(i + 2, 0, rms.length - 1)] || 0) * 1.5 * gain) * 16);
    Array.prototype.forEach.call($('meterL').children, function (s, k) { s.classList.toggle('on', k < L); });
    Array.prototype.forEach.call($('meterR').children, function (s, k) { s.classList.toggle('on', k < R); });
  }

  // ------------------------------------------------------------------ option controls
  var CTL = [];
  var lastParam = null;

  function showParam(name, val, help) {
    $('plName').textContent = name;
    $('plVal').textContent = val || '';
    $('plHelp').textContent = help || '';
    $('paramLcd').title = help || '';
  }
  function paramFor(c) {
    var off = c.enabled && !c.enabled();
    showParam(c.label, c.valueText(), off && c.offHelp ? c.offHelp() : (typeof c.help === 'function' ? c.help() : c.help));
  }

  function shell(c) {
    var w = el('div', 'ctl');
    var lab = el('span', 'ctl-label', c.label);
    lab.id = c.id + 'Label';
    w.append(lab);
    w.addEventListener('pointerenter', function () { lastParam = c; paramFor(c); });
    w.addEventListener('focusin', function () { lastParam = c; paramFor(c); });
    c.el = w;
    return w;
  }

  function changed(c) {
    lastParam = c;
    paramFor(c);
    if (c.kind === 'out') outputChanged(); else transcriptionChanged();
  }

  function radioKeys(group, btns, pick) {
    group.addEventListener('keydown', function (e) {
      var i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var n = (i + d + btns.length) % btns.length;
      pick(n); btns[n].focus();
    });
  }

  function makeOptList(c, cls, pick) {
    var list = el('div', cls);
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-labelledby', c.id + 'Label');
    var btns = c.choices.map(function (ch, i) {
      var b = el('button', 'sel-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      var led = el('i', 'led ' + (c.ledColor || 'teal')); led.setAttribute('aria-hidden', 'true');
      b.append(led, el('span', '', ch.label));
      if (ch.full && ch.full !== ch.label) b.title = ch.full;
      b.addEventListener('click', function () { pick(i); });
      list.append(b);
      return b;
    });
    radioKeys(list, btns, pick);
    return { list: list, btns: btns };
  }
  function syncOptList(c, btns, idx) {
    var on = !c.enabled || c.enabled();
    btns.forEach(function (b, i) {
      b.setAttribute('aria-checked', i === idx ? 'true' : 'false');
      b.tabIndex = i === idx ? 0 : -1;
      b.disabled = !on;
      b.firstChild.classList.toggle('on', i === idx && on);
    });
  }
  function idxOf(c) {
    var v = c.get();
    for (var i = 0; i < c.choices.length; i++) if (c.choices[i].value === v) return i;
    return 0;
  }

  // stepped selector: bar knob that points at lit position labels
  function selector(parent, c) {
    var w = shell(c);
    var body = el('div', 'sel-body');
    var knob = el('div', 'sel-knob');
    knob.setAttribute('aria-hidden', 'true');
    knob.append(el('span', 'sel-hub'), el('span', 'sel-bar'));
    var n = c.choices.length;
    var angle = function (i) { return 90 + (i - (n - 1) / 2) * 42; };
    var pick = function (i) {
      if (c.enabled && !c.enabled()) return;
      i = clamp(i, 0, n - 1);
      if (c.choices[i].value === c.get()) return;
      c.set(c.choices[i].value);
      changed(c);
    };
    var o = makeOptList(c, 'sel-opts', pick);
    // click the knob to step; drag up/down to turn
    var drag = null;
    knob.addEventListener('pointerdown', function (e) {
      if (c.enabled && !c.enabled()) return;
      knob.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, i: idxOf(c), moved: false };
    });
    knob.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) pick(drag.i + Math.round(dy / 22));
    });
    knob.addEventListener('pointerup', function () {
      if (drag && !drag.moved) pick((idxOf(c) + 1) % n);
      drag = null;
    });
    knob.addEventListener('wheel', function (e) {
      if (c.enabled && !c.enabled()) return;
      e.preventDefault();
      pick(idxOf(c) + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
    body.append(knob, o.list);
    w.append(body);
    parent.append(w);
    c.valueText = function () { var ch = c.choices[idxOf(c)]; return ch.full || ch.label; };
    c.update = function () {
      var i = idxOf(c);
      knob.querySelector('.sel-bar').style.setProperty('--a', angle(i) + 'deg');
      syncOptList(c, o.btns, i);
      w.classList.toggle('is-off', !!(c.enabled && !c.enabled()));
    };
    CTL.push(c);
  }

  // rotary knob with LED ring (continuous, or detented when c.detents is set)
  function knob(parent, c) {
    var w = shell(c);
    var body = el('div', 'knob-body');
    var k = el('div', 'knob');
    k.tabIndex = 0;
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-labelledby', c.id + 'Label');
    k.setAttribute('aria-valuemin', c.min);
    k.setAttribute('aria-valuemax', c.max);
    var ticks = c.detents || 11, svg = '<svg viewBox="0 0 58 58" aria-hidden="true">';
    for (var i = 0; i < ticks; i++) {
      var a = -135 + i * 270 / (ticks - 1), p0 = polar(29, 29, 26.5, a), p1 = polar(29, 29, 29.5, a);
      svg += '<line class="k-tick" x1="' + p0[0].toFixed(2) + '" y1="' + p0[1].toFixed(2) + '" x2="' + p1[0].toFixed(2) + '" y2="' + p1[1].toFixed(2) + '"/>';
    }
    svg += '<path class="k-track" d="' + arc(29, 29, 22, -135, 135) + '"/><path class="k-val" d=""/></svg>';
    k.innerHTML = svg + '<span class="knob-cap"></span><span class="knob-ptr"></span>';
    var ends = el('div', 'knob-ends');
    ends.setAttribute('aria-hidden', 'true');
    ends.append(el('span', '', c.ends[0]), el('span', '', c.ends[1]));
    var lcd = el('output', 'knob-lcd');
    body.append(k, lcd, ends);
    w.append(body);
    parent.append(w);

    var range = c.max - c.min;
    var snap = function (v) { return clamp(Math.round((v - c.min) / c.step) * c.step + c.min, c.min, c.max); };
    var setV = function (v) {
      if (c.enabled && !c.enabled()) return;
      v = snap(v);
      if (v === c.get()) return;
      c.set(v);
      changed(c);
    };
    var bigStep = c.detents ? c.step : c.step * Math.max(1, Math.round(range / c.step / 20));
    var wheelStep = c.detents ? c.step : c.step * Math.max(1, Math.round(range / c.step / 56));

    var drag = null;
    k.addEventListener('pointerdown', function (e) {
      if (c.enabled && !c.enabled()) return;
      k.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, x: e.clientX, v: c.get(), moved: false };
      k.classList.add('dragging');
    });
    k.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = drag.y - e.clientY;
      if (Math.abs(dy) > 3 || Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
      if (drag.moved) setV(drag.v + dy / (c.detents ? 70 : (e.shiftKey ? 640 : 170)) * range);
    });
    var end = function (e) {
      if (drag && !drag.moved && e.type === 'pointerup') {
        // click on the ring: jump to that position
        var r = k.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) > 6) {
          var ang = Math.atan2(dx, -dy) * 180 / Math.PI;
          setV(c.min + (clamp(ang, -135, 135) + 135) / 270 * range);
        }
      }
      drag = null;
      k.classList.remove('dragging');
    };
    k.addEventListener('pointerup', end);
    k.addEventListener('pointercancel', end);
    k.addEventListener('dblclick', function () { setV(c.def); });
    k.addEventListener('wheel', function (e) {
      if (c.enabled && !c.enabled()) return;
      e.preventDefault();
      setV(c.get() + (e.deltaY < 0 ? 1 : -1) * wheelStep);
    }, { passive: false });
    k.addEventListener('keydown', function (e) {
      var v = c.get(), map = {
        ArrowUp: v + c.step, ArrowRight: v + c.step, ArrowDown: v - c.step, ArrowLeft: v - c.step,
        PageUp: v + bigStep, PageDown: v - bigStep, Home: c.min, End: c.max,
      };
      if (!(e.key in map)) return;
      e.preventDefault();
      setV(map[e.key]);
    });

    c.valueText = function () { return c.fmt(c.get()); };
    c.update = function () {
      var v = c.get(), on = !c.enabled || c.enabled();
      var ang = -135 + (v - c.min) / range * 270;
      k.querySelector('.knob-ptr').style.setProperty('--a', ang + 'deg');
      var valPath = k.querySelector('.k-val');
      if (ang > -134) valPath.setAttribute('d', arc(29, 29, 22, -135, ang)); else valPath.setAttribute('d', '');
      lcd.textContent = c.fmt(v);
      k.setAttribute('aria-valuenow', v);
      k.setAttribute('aria-valuetext', c.fmt(v));
      k.setAttribute('aria-disabled', on ? 'false' : 'true');
      k.tabIndex = on ? 0 : -1;
      w.classList.toggle('is-off', !on);
    };
    CTL.push(c);
  }

  // lever toggle switch (2 or 3 positions) with lit position labels
  function lever(parent, c) {
    var w = shell(c);
    var body = el('div', 'tgl-body');
    var n = c.choices.length;
    var POS = n === 3 ? ['up', 'mid', 'down'] : ['up', 'down'];
    var t = el('button', 'tgl');
    t.type = 'button';
    t.tabIndex = -1;
    t.setAttribute('aria-hidden', 'true');
    t.append(el('span', 'tgl-plate'), el('span', 'tgl-nut'), el('span', 'tgl-lever'));
    var pick = function (i) {
      if (c.enabled && !c.enabled()) return;
      if (c.choices[i].value === c.get()) return;
      c.set(c.choices[i].value);
      changed(c);
    };
    t.addEventListener('click', function () {
      var i = idxOf(c);
      // 2-way flips; 3-way steps down then back up
      pick(n === 2 ? 1 - i : (i + 1) % n);
    });
    var o = makeOptList(c, 'sel-opts tgl-opts ' + (n === 3 ? 'three' : 'two'), pick);
    body.append(t, o.list);
    w.append(body);
    parent.append(w);
    c.valueText = function () { var ch = c.choices[idxOf(c)]; return ch.full || ch.label; };
    c.update = function () {
      var i = idxOf(c);
      t.dataset.pos = POS[i];
      syncOptList(c, o.btns, i);
      w.classList.toggle('is-off', !!(c.enabled && !c.enabled()));
    };
    CTL.push(c);
  }

  function choicesOf(opt, shortMap) {
    return opt.choices.map(function (ch) { return { value: ch.value, label: (shortMap && shortMap[ch.value]) || ch.label, full: ch.label }; });
  }

  function buildControls() {
    var viewsOpt = optOf('ensemble', 'views'), rescueOpt = optOf('ensemble', 'rescue');
    var velOpt = optOf('transkun', 'velocity'), mergeOpt = optOf('transkun', 'merge_fix');
    var rowT = $('rowTrans'), rowK = $('rowTranskun'), rowM = $('rowMidiA');

    selector(rowT, {
      id: 'cEngine', label: 'Engine', kind: 'trans',
      choices: ENGINES.map(function (e) { return { value: e.id, label: SHORT_ENGINE[e.id], full: e.name }; }),
      get: function () { return S.engine; }, set: function (v) { S.engine = v; },
      help: function () { return ENG[S.engine].summary; },
    });
    selector(rowT, {
      id: 'cViews', label: 'Analysis views', kind: 'trans',
      choices: choicesOf(viewsOpt, { none: 'Single view', channels: 'Stereo 4×', full: 'Stereo + tone 6×' }),
      get: function () { return (S.eopt[S.engine].views || S.eopt.ensemble.views); },
      set: function (v) { S.eopt[S.engine].views = v; },
      enabled: function () { return 'views' in S.eopt[S.engine]; },
      help: viewsOpt.help,
      offHelp: function () { return 'Aria-AMT listens to the recording once, so it has no analysis views.'; },
    });
    knob(rowT, {
      id: 'cRescue', label: 'Second opinion', kind: 'trans', detents: 3,
      min: 0, max: rescueOpt.choices.length - 1, step: 1, def: 1, ends: ['More', 'Fewer'],
      get: function () { var v = S.eopt.ensemble.rescue; for (var i = 0; i < rescueOpt.choices.length; i++) if (rescueOpt.choices[i].value === v) return i; return 1; },
      set: function (i) { S.eopt.ensemble.rescue = rescueOpt.choices[i].value; },
      fmt: function (i) { return rescueOpt.choices[i].label.replace(/ \(.*\)/, ''); },
      enabled: function () { return S.engine === 'ensemble'; },
      help: rescueOpt.help,
      offHelp: function () { return 'Only used by the Ensemble engine, where Aria-AMT checks Transkun’s work.'; },
    });
    selector(rowK, {
      id: 'cVelocity', label: 'Velocity read-out', kind: 'trans',
      choices: choicesOf(velOpt, { mode: 'Most likely', mean: 'Average', median: 'Median' }),
      get: function () { return S.eopt.transkun.velocity; }, set: function (v) { S.eopt.transkun.velocity = v; },
      enabled: function () { return S.engine === 'transkun'; },
      help: velOpt.help,
      offHelp: function () { return 'Used when Engine is set to Transkun V2. ' + velOpt.help; },
    });
    lever(rowK, {
      id: 'cMerge', label: mergeOpt.label, kind: 'trans',
      choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }],
      get: function () { return S.eopt.transkun.merge_fix; }, set: function (v) { S.eopt.transkun.merge_fix = v; },
      enabled: function () { return S.engine === 'transkun'; },
      help: mergeOpt.label + ': ' + mergeOpt.help,
      offHelp: function () { return 'Used when Engine is set to Transkun V2. ' + mergeOpt.help; },
    });

    var O = OUTO;
    lever(rowM, {
      id: 'cPedal', label: 'Sustain pedal', kind: 'out',
      choices: choicesOf(O.pedal, { cc: 'CC64 events', extend: 'Bake into notes', none: 'Leave out' }),
      get: function () { return S.out.pedal; }, set: function (v) { S.out.pedal = v; },
      help: O.pedal.help,
    });
    lever(rowM, {
      id: 'cSoft', label: O.soft_pedal.label, kind: 'out',
      choices: [{ value: true, label: 'Include', full: 'Include (CC67)' }, { value: false, label: 'Leave out' }],
      get: function () { return S.out.soft_pedal; }, set: function (v) { S.out.soft_pedal = v; },
      help: O.soft_pedal.help + ' Written as CC67.',
    });
    lever(rowM, {
      id: 'cDyn', label: 'Dynamics', kind: 'out',
      choices: choicesOf(O.velocity),
      get: function () { return S.out.velocity; }, set: function (v) { S.out.velocity = v; },
      help: O.velocity.help,
    });
    knob(rowM, {
      id: 'cFlat', label: 'Flat velocity', kind: 'out',
      min: O.flat_velocity.min, max: O.flat_velocity.max, step: O.flat_velocity.step, def: O.flat_velocity.default, ends: ['1', '127'],
      get: function () { return S.out.flat_velocity; }, set: function (v) { S.out.flat_velocity = v; },
      fmt: function (v) { return 'vel ' + v; },
      enabled: function () { return S.out.velocity === 'flat'; },
      help: O.flat_velocity.help,
      offHelp: function () { return 'Set Dynamics to Flat to use this. ' + O.flat_velocity.help; },
    });
    knob(rowM, {
      id: 'cMin', label: O.min_note_ms.label, kind: 'out',
      min: O.min_note_ms.min, max: O.min_note_ms.max, step: O.min_note_ms.step, def: O.min_note_ms.default, ends: ['0', '200'],
      get: function () { return S.out.min_note_ms; }, set: function (v) { S.out.min_note_ms = v; },
      fmt: function (v) { return v === 0 ? 'Keep all' : v + ' ms'; },
      help: O.min_note_ms.help,
    });
    knob(rowM, {
      id: 'cTempo', label: 'MIDI tempo', kind: 'out',
      min: O.tempo.min, max: O.tempo.max, step: O.tempo.step, def: O.tempo.default, ends: ['20', '300'],
      get: function () { return S.out.tempo; }, set: function (v) { S.out.tempo = v; },
      fmt: function (v) { return v + ' BPM'; },
      help: O.tempo.help,
    });
  }

  function syncControls() {
    CTL.forEach(function (c) { c.update(); });
    var tkOn = S.engine === 'transkun';
    $('ledTk').classList.toggle('on', tkOn);
    $('transkunPanel').classList.toggle('inactive', !tkOn);
    $('tkWhy').textContent = tkOn ? '' : ' · not used by ' + SHORT_ENGINE[S.engine];
    $('outputNote').textContent = S.view === 'result' ? 'Changes update the open result instantly' : 'Applied when the MIDI file is written';
    var showRerun = S.view === 'result';
    $('rerunWrap').hidden = !showRerun;
    var dirty = showRerun && S.used && S.used !== transSig();
    $('ledRerun').classList.toggle('on', !!dirty);
    $('rerunBtn').disabled = !dirty;
    $('rerunNote').textContent = dirty ? 'to use the new settings' : 'Settings match this result';
    $('engineSummary').textContent = engineSummary();
  }

  function transcriptionChanged() {
    syncControls();
    renderPath();
    renderVfd();
    if (S.view === 'result') flash('Used for the next conversion', 2200);
  }
  function outputChanged() {
    syncControls();
    applyOutput(true);
  }

  // ------------------------------------------------------------------ views
  function renderMonitorHead() {
    var t = $('monTitle'), a = $('monAside');
    if (S.view === 'home') { t.textContent = 'Recent conversions'; a.textContent = S.recentAside || ''; }
    else if (S.view === 'progress') { t.textContent = 'Analysis'; renderProgress(); }
    else {
      var st = outputStats();
      t.textContent = 'Piano roll';
      a.textContent = nf(st.notes) + ' notes · ' + (S.out.pedal === 'cc' ? st.sustain + ' sustain' : st.pedalText) + (st.soft ? ' · ' + st.soft + ' soft pedal' : '');
      // the legend only lists what the screen is currently showing
      $('legendTail').hidden = $('legendSus').hidden = S.out.pedal !== 'cc';
      $('legendSoft').hidden = !st.soft;
    }
  }

  function render() {
    var v = S.view;
    document.body.dataset.view = v;
    document.body.classList.toggle('adv', S.adv);
    $('inputUnit').hidden = v !== 'home';
    $('pageRecent').hidden = v !== 'home';
    $('pageProgress').hidden = v !== 'progress';
    $('pageRoll').hidden = v !== 'result';
    $('transport').hidden = v !== 'result';
    $('optionsUnit').hidden = !S.adv;
    $('advBtn').setAttribute('aria-expanded', S.adv ? 'true' : 'false');
    $('ledAdv').classList.toggle('on', S.adv);

    var cv = $('convertBtn'), sv = $('saveBtn');
    cv.disabled = v === 'progress';
    cv.classList.toggle('lit', v === 'home');
    cv.classList.toggle('breathe', v === 'home');
    $('convertSub').textContent = v === 'progress' ? 'Busy' : 'Choose a file';
    sv.disabled = v !== 'result';
    sv.classList.toggle('lit', v === 'result');
    sv.classList.toggle('breathe', v === 'result');
    $('saveSub').textContent = v === 'result' ? '.mid file' : 'After converting';
    $('cancelBtn').disabled = v !== 'progress';
    $('cancelBtn').querySelector('.led').classList.toggle('on', v === 'progress');
    $('newBtn').disabled = v !== 'result';

    var busy = $('ledBusy');
    busy.classList.toggle('on', v === 'progress');
    busy.classList.toggle('blink', v === 'progress');
    $('ledMidi').classList.toggle('on', v === 'result');

    renderMonitorHead();
    renderVfd();
    renderPath();
    syncControls();
    if (v === 'progress') { renderProgress(); requestAnimationFrame(drawWave); }
    if (v === 'result') { roll.setTime(S.time, S.playing); roll.requestDraw(); updTime(); updPlay(); }
    else if (S.playing) pause();

    var cur = S.adv && v === 'result' ? 'advanced' : v;
    Array.prototype.forEach.call(document.querySelectorAll('.switcher button'), function (b) { b.classList.toggle('cur', b.dataset.go === cur); });
  }

  function setView(v) {
    var changedView = v !== S.view;
    S.view = v;
    render();
    if (changedView) announce(v === 'home' ? 'Ready. Drop a recording to convert.' : v === 'progress' ? 'Converting ' + S.file : 'Done. ' + outputStats().notes + ' notes. Save MIDI is ready.');
  }

  function setAdv(open, opts) {
    S.adv = open;
    render();
    if (open) {
      if (!lastParam) showParam('Help', '', 'Point at a control, or turn it, to read what it does.');
      if (opts && opts.reveal) {
        var u = $('optionsUnit');
        var r = u.getBoundingClientRect();
        if (r.bottom > innerHeight || r.top < 0) u.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function cancelAnim() { if (S.anim) cancelAnimationFrame(S.anim); S.anim = 0; }

  function startConversion(name, from) {
    cancelAnim();
    if (S.playing) pause();
    S.file = name || M.file.name;
    S.runEngine = S.engine;
    S.progress = from || 0;
    setView('progress');
    var T = 3200 * (1 - S.progress), p0 = S.progress, t0 = performance.now();
    var step = function (now) {
      S.progress = Math.min(1, p0 + (now - t0) / T * (1 - p0));
      renderVfd(); renderPath(); renderProgress();
      if (S.progress < 1) { S.anim = requestAnimationFrame(step); return; }
      S.anim = 0;
      S.used = transSig();
      S.time = 0;
      setView('result');
      flash('Conversion complete', 2400);
    };
    S.anim = requestAnimationFrame(step);
  }

  function goState(name) {
    cancelAnim();
    if (S.playing) pause();
    S.file = M.file.name;
    if (name === 'progress') { S.runEngine = S.engine; S.progress = M.progress.progress; S.adv = false; setView('progress'); return; }
    if (name === 'result' || name === 'advanced') {
      S.runEngine = M.job.engine; S.used = transSig(); S.time = 12;
      S.adv = name === 'advanced';
      setView('result');
      return;
    }
    S.adv = false;
    setView('home');
  }

  // ------------------------------------------------------------------ wiring
  function bind() {
    $('dropzone').addEventListener('click', function () { startConversion(); });
    $('convertBtn').addEventListener('click', function () { startConversion(); });
    $('cancelBtn').addEventListener('click', function () {
      cancelAnim();
      setView('home');
      toast('Conversion cancelled');
    });
    $('newBtn').addEventListener('click', function () { setView('home'); $('dropzone').focus({ preventScroll: true }); });
    $('saveBtn').addEventListener('click', function () {
      var name = stripExt(S.file) + '.mid';
      flash('Saved to Downloads', 2400);
      toast('Saved “' + name + '” to Downloads', { label: 'Show in folder', run: function () { } });
    });
    $('brandHome').addEventListener('click', function (e) {
      e.preventDefault();
      if (S.view === 'progress') { flash('Converting — press Cancel to stop'); return; }
      if (S.view !== 'home') setView('home');
    });
    $('advBtn').addEventListener('click', function () { setAdv(!S.adv, { reveal: true }); });
    $('advFromHome').addEventListener('click', function () { setAdv(true, { reveal: true }); });
    $('closeAdv').addEventListener('click', function () { setAdv(false); $('advBtn').focus(); });
    $('resetBtn').addEventListener('click', function () {
      var d = defaults();
      S.engine = d.engine; S.eopt = d.eopt; S.out = d.out;
      syncControls(); renderPath(); applyOutput(false); renderVfd();
      showParam('Reset', '', 'Every option is back to its default.');
      toast('Options reset to defaults');
    });
    $('rerunBtn').addEventListener('click', function () { startConversion(S.file); });

    // transport
    $('playBtn').addEventListener('click', function () { S.playing ? pause() : play(); });
    $('zoomIn').addEventListener('click', function () { roll.zoom(1.3); });
    $('zoomOut').addEventListener('click', function () { roll.zoom(1 / 1.3); });
    var mixBtns = Array.prototype.slice.call(document.querySelectorAll('#mixSlide button'));
    var MIX_TEXT = { original: 'Listening to the original recording', both: 'Listening to both, side by side', midi: 'Listening to the MIDI only' };
    var setMix = function (i) {
      S.mix = mixBtns[i].dataset.mix;
      $('mixSlide').style.setProperty('--i', i);
      mixBtns.forEach(function (b, k) { b.setAttribute('aria-checked', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; });
      flash(MIX_TEXT[S.mix], 1600);
    };
    mixBtns.forEach(function (b, i) { b.addEventListener('click', function () { setMix(i); }); });
    radioKeys($('mixSlide'), mixBtns, setMix);

    // keyboard
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.adv) { setAdv(false); $('advBtn').focus(); return; }
      if (e.code === 'Space' && S.view === 'result') {
        var t = e.target;
        if (t.closest && t.closest('button, [role="slider"], [role="radio"], input, a')) return;
        e.preventDefault();
        S.playing ? pause() : play();
      }
    });

    // drag and drop anywhere on the window
    var depth = 0;
    window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; if (S.view !== 'progress') { document.body.classList.add('dragging'); renderVfd(); } });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) { document.body.classList.remove('dragging'); renderVfd(); } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0;
      document.body.classList.remove('dragging');
      if (S.view === 'progress') { toast('Wait for this conversion to finish, or press Cancel.'); return; }
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      startConversion(f ? f.name : null);
    });

    // reviewer state switcher
    Array.prototype.forEach.call(document.querySelectorAll('.switcher button'), function (b) {
      b.addEventListener('click', function () { goState(b.dataset.go); });
    });

    new ResizeObserver(function () { if (S.view === 'progress') drawWave(); }).observe($('anWave'));
  }

  // ------------------------------------------------------------------ boot
  buildMeter();
  buildMeterLR();
  buildWindows();
  renderRecent();
  buildControls();
  bind();
  var initial = (qs.get('state') || 'home').toLowerCase();
  goState(['home', 'progress', 'result', 'advanced'].indexOf(initial) >= 0 ? initial : 'home');
})();
