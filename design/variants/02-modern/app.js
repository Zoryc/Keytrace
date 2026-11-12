/* MIDI Converter — "Modern" prototype. Classic script, no backend: everything runs on window.MOCK. */
(function () {
  'use strict';

  var M = window.MOCK;
  var R = window.MCRoll;
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var fmtTime = R.fmtTime;

  var INFO = M.info;
  var INST = INFO.instruments[0];
  var ENGINES = INST.engines;
  var OUT_SPECS = INFO.output_options;
  var DEVICE = INFO.device.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');

  function eng(id) { return ENGINES.find(function (e) { return e.id === id; }); }
  function defaultsFor(specs) { var o = {}; specs.forEach(function (s) { o[s.key] = s.default; }); return o; }
  function outSpec(key) { return OUT_SPECS.find(function (s) { return s.key === key; }); }
  function engSpec(engineId, key) { return eng(engineId).options.find(function (s) { return s.key === key; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var ENGINE_TAGLINE = {
    ensemble: 'Most accurate · recommended',
    transkun: 'About 4x faster, almost as accurate',
    aria: 'On its own, for comparison',
  };
  var BASE_SECONDS = { ensemble: 26, transkun: 7, aria: 17 };   // progress ETA model, per 60 s of audio
  var VIEW_FACTOR = { none: 0.45, channels: 1, full: 1.45 };
  // Home hint, per 2-minute piece on the RTX 5070 Ti: Transkun scales with the number of views, Aria does not.
  var TK_2MIN = 5.6, ARIA_2MIN = 16.9;

  var ICON = {
    audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M6 12h12M12 6v12"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/></svg>',
  };

  // ------------------------------------------------------------------ state
  var state = {
    view: 'home',
    engine: INST.default_engine,
    eo: {},
    out: defaultsFor(OUT_SPECS),
    job: null,
    data: null,
    time: 0,
    playing: false,
    mix: 'both',
    recent: [],
    sim: 0,
    prog: null,
    moreOpen: false,
    drawerOpener: null,
  };
  ENGINES.forEach(function (e) { state.eo[e.id] = defaultsFor(e.options); });

  function resetRecent() { state.recent = clone(M.recent); }
  resetRecent();

  // ------------------------------------------------------------------ helpers
  function shortEngine(id) { return eng(id).name.replace(/\s*\(.*\)\s*$/, ''); }
  function viewsLabel(engineId) {
    var spec = engSpec(engineId, 'views');
    if (!spec) return '';
    var v = state.eo[engineId].views;
    var c = spec.choices.find(function (x) { return x.value === v; });
    return c ? c.label.replace(/\s*\((\d+x)\)/, ' $1').replace(/\s*\(.*\)/, '') : '';
  }
  function settingsSummary(engineId) {
    engineId = engineId || state.engine;
    var parts = [shortEngine(engineId)];
    var v = viewsLabel(engineId);
    if (v) parts.push(v);
    return parts.join(' · ');
  }
  function totalSeconds(engineId, views, duration) {
    return BASE_SECONDS[engineId] * (VIEW_FACTOR[views] || 1) * (duration / 60);
  }
  function fmtDuration(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + ' s';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return s ? m + ' min ' + s + ' s' : m + ' min';
  }
  function speedHint() {
    var f = VIEW_FACTOR[state.eo[state.engine].views] || 1;
    var c = state.engine === 'ensemble' ? TK_2MIN * f + ARIA_2MIN : state.engine === 'transkun' ? TK_2MIN * f : ARIA_2MIN;
    var lo = Math.max(1, Math.floor(c * 0.9)), hi = Math.max(lo + 1, Math.ceil(c * 1.1));
    return 'About ' + lo + '–' + hi + ' s for a 2-minute piece';
  }
  function isVideo(name) { return /\.(mp4|mkv|mov|webm)$/i.test(name); }
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toUpperCase() : 'Audio'; }
  function midiName(name) { return name.replace(/\.[a-z0-9]+$/i, '') + '.mid'; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  var uidN = 0;
  function uid(p) { uidN += 1; return (p || 'id') + '-' + uidN; }

  // ------------------------------------------------------------------ toast
  var toastTimer = 0;
  function toast(msg, opts) {
    opts = opts || {};
    var t = $('toast');
    t.innerHTML = '';
    if (opts.icon !== false) t.insertAdjacentHTML('beforeend', ICON.check);
    var m = el('span', 't-msg');
    m.textContent = msg;
    t.append(m);
    if (opts.action) {
      var b = el('button', 'toast-action');
      b.type = 'button';
      b.textContent = opts.action.label;
      b.onclick = function () { t.classList.remove('show'); opts.action.run(); };
      t.append(b);
    }
    t.classList.toggle('has-action', !!opts.action);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, opts.action ? 5200 : 2400);
  }

  // ------------------------------------------------------------------ views
  function markReview() {
    var s = state.view === 'result' && $('drawer').classList.contains('open') ? 'advanced' : state.view;
    document.querySelectorAll('#review [data-state]').forEach(function (b) {
      var on = b.dataset.state === s;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
  }

  function show(view) {
    state.view = view;
    $('viewHome').hidden = view !== 'home';
    $('viewProgress').hidden = view !== 'progress';
    $('viewResult').hidden = view !== 'result';
    if (view !== 'result') setPlaying(false);
    if (view === 'result') requestAnimationFrame(function () { roll._resize(); drawOverview(true); });
    renderRecent();
    renderOutputNote();
    syncDrawer();
    markReview();
    window.scrollTo(0, 0);
  }

  function renderSummary() {
    $('summaryText').textContent = settingsSummary();
    $('speedHint').textContent = speedHint();
  }

  // ------------------------------------------------------------------ data (MIDI-file options applied to the mock transcription)
  function buildData() {
    var o = state.out;
    var notes = M.notes.map(function (n) { return n.slice(); });
    if (o.min_note_ms > 0) notes = notes.filter(function (n) { return (n[1] - n[0]) * 1000 >= o.min_note_ms; });
    if (o.velocity === 'flat') notes.forEach(function (n) { n[3] = o.flat_velocity; });
    var pedals = M.pedals.filter(function (p) { return p[2] !== 67 || o.soft_pedal; });
    if (o.pedal === 'extend') {
      notes.forEach(function (n) { n[1] = Math.max(n[1], n[4]); });
      pedals = pedals.filter(function (p) { return p[2] !== 64; });
    } else if (o.pedal === 'none') {
      notes.forEach(function (n) { n[4] = n[1]; });
      pedals = pedals.filter(function (p) { return p[2] !== 64; });
    }
    return { notes: notes, pedals: pedals, duration: M.duration };
  }

  // ------------------------------------------------------------------ piano roll + overview
  var roll = new R.PianoRoll($('roll'), {
    onSeek: function (t) { state.time = t; roll.setTime(t, state.playing); updateTime(); },
  });

  var ov = $('overview');
  var ovKey = '';
  var ovColors = {};
  function readOvColors() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    ovColors = { wave: v('--wave'), played: v('--wave-played'), accent: v('--accent'), soft: v('--accent-soft'), playhead: v('--playhead') };
  }
  readOvColors();

  function drawOverview(force) {
    if (state.view !== 'result' || !state.data) return;
    var w = ov.clientWidth, h = ov.clientHeight;
    if (!w || !h) return;
    var dur = Math.max(1, roll.duration || state.data.duration);
    var viewSec = roll._viewW() / roll.pxPerSec;
    var key = [w, h, roll.scrollX.toFixed(3), roll.pxPerSec.toFixed(2), state.time.toFixed(3), document.documentElement.getAttribute('data-theme')].join('|');
    if (!force && key === ovKey) return;
    ovKey = key;
    var dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) {
      ov.width = Math.round(w * dpr);
      ov.height = Math.round(h * dpr);
    }
    var ctx = ov.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var x0 = (roll.scrollX / dur) * w;
    var x1 = Math.min(w, ((roll.scrollX + viewSec) / dur) * w);
    ctx.fillStyle = ovColors.soft;
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);

    var peaks = M.waveform.peak, hop = M.waveform.hop_seconds;
    var mid = h / 2, amp = (h - 10) / 2;
    for (var x = 0; x < w; x += 2) {
      var t0 = (x / w) * dur, t1 = ((x + 2) / w) * dur;
      var i0 = Math.floor(t0 / hop), i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(t1 / hop)));
      var pk = 0;
      for (var i = i0; i < i1; i++) if (peaks[i] > pk) pk = peaks[i];
      var bh = Math.max(1, Math.pow(pk, 0.7) * amp);
      ctx.fillStyle = t0 < state.time ? ovColors.played : ovColors.wave;
      ctx.fillRect(x, mid - bh, 1.25, bh * 2);
    }
    ctx.strokeStyle = ovColors.accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(2, Math.round(x1 - x0) - 1), h - 1);
    ctx.globalAlpha = 1;
    var px = (state.time / dur) * w;
    ctx.fillStyle = ovColors.playhead;
    ctx.fillRect(Math.round(px) - 0.75, 0, 1.5, h);
  }

  function overviewSeek(e) {
    var rect = ov.getBoundingClientRect();
    var dur = Math.max(1, roll.duration);
    var t = Math.max(0, Math.min(dur, ((e.clientX - rect.left) / rect.width) * dur));
    var viewSec = roll._viewW() / roll.pxPerSec;
    state.time = t;
    roll.scrollX = roll._clampScroll(t - viewSec / 2);
    roll.userScrolledAt = performance.now() - 2000;
    roll.setTime(t, state.playing);
    updateTime();
  }
  var ovDrag = false;
  ov.addEventListener('pointerdown', function (e) { ovDrag = true; ov.setPointerCapture(e.pointerId); overviewSeek(e); });
  ov.addEventListener('pointermove', function (e) { if (ovDrag) overviewSeek(e); });
  ov.addEventListener('pointerup', function () { ovDrag = false; });
  ov.addEventListener('pointercancel', function () { ovDrag = false; });

  // ------------------------------------------------------------------ transport
  function setPlaying(on) {
    state.playing = on;
    $('playBtn').classList.toggle('playing', on);
    $('playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
    $('playBtn').title = (on ? 'Pause' : 'Play') + ' (Space)';
    if (state.data) roll.setTime(state.time, on);
  }
  function togglePlay() {
    if (state.view !== 'result') return;
    if (!state.playing && state.time >= roll.duration - 0.05) state.time = 0;
    setPlaying(!state.playing);
  }
  function updateTime() {
    var dur = fmtTime(roll.duration || M.duration);
    $('timeNow').textContent = fmtTime(state.time);
    $('timeDur').textContent = dur;
    $('ovEnd').textContent = dur;
  }
  var lastTs = 0;
  function frame(ts) {
    var dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (state.playing && state.view === 'result') {
      state.time += dt;
      if (state.time >= roll.duration) { state.time = roll.duration; setPlaying(false); }
      roll.setTime(state.time, state.playing);
      updateTime();
    }
    drawOverview(false);
    requestAnimationFrame(frame);
  }

  var MIX_TEXT = { original: 'Original recording', both: 'Original + grand piano', midi: 'Grand piano (MIDI)' };
  function setMix(mix) {
    state.mix = mix;
    var card = $('rollCard');
    card.classList.remove('mix-original', 'mix-both', 'mix-midi');
    card.classList.add('mix-' + mix);
    $('mixSeg').querySelectorAll('button').forEach(function (b) {
      var on = b.dataset.mix === mix;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('pianoStatusText').textContent = MIX_TEXT[mix];
  }

  // ------------------------------------------------------------------ result
  function jobFor(filename, recentId) {
    return {
      id: recentId || M.job.id,
      filename: filename || M.job.filename,
      midi_name: midiName(filename || M.job.filename),
      engine: state.engine,
      eo: clone(state.eo[state.engine]),
      stats: M.job.stats,
    };
  }

  function openResult(job, time) {
    stopSim();
    state.job = job;
    show('result');
    state.data = buildData();
    roll.setData(state.data);
    state.time = time || 0;
    setPlaying(false);
    roll.setTime(state.time, false);
    updateTime();
    renderResultHead(false);
    resetSaveBtn();
    renderRecent();
  }

  function renderResultHead(flash) {
    var job = state.job;
    var d = state.data;
    $('resultName').textContent = job.filename;
    $('resultName').title = job.filename;
    var st = job.stats;
    var engineName = eng(job.engine).name;
    var views = job.eo.views ? ' · ' + viewsLabelFor(job.engine, job.eo.views) : '';
    var secs = st.seconds_total < 60 ? st.seconds_total.toFixed(1).replace(/\.0$/, '') + ' s' : fmtDuration(st.seconds_total);
    $('resultSub').textContent = 'Converted in ' + secs + ' with ' + engineName + views;

    var sustain = d.pedals.filter(function (p) { return p[2] === 64; }).length;
    var soft = d.pedals.filter(function (p) { return p[2] === 67; }).length;
    var pedalVal;
    if (state.out.pedal === 'cc') pedalVal = sustain + (soft ? '<small>+ ' + soft + ' soft</small>' : '');
    else if (state.out.pedal === 'extend') pedalVal = 'Baked in' + (soft ? '<small>+ ' + soft + ' soft</small>' : '');
    else pedalVal = 'Left out' + (soft ? '<small>+ ' + soft + ' soft</small>' : '');
    var items = [
      ['Length', fmtTime(d.duration), ''],
      ['Notes', d.notes.length.toLocaleString('en-US'), 'notes'],
      ['Pedal presses', pedalVal, 'pedal'],
    ];
    if (job.engine === 'ensemble') items.push(['Added by Aria', st.notes_added_by_aria + '<small>notes</small>', 'aria', true]);
    items.push(['Average certainty', (st.mean_confidence * 100).toFixed(1) + '<small class="pct">%</small>', 'conf', true]);
    var prev = {};
    $('stats').querySelectorAll('dd').forEach(function (dd) { prev[dd.dataset.k] = dd.innerHTML; });
    $('stats').innerHTML = items.map(function (it) {
      return '<div class="stat' + (it[3] ? ' optional' : '') + '"><dt>' + it[0] + '</dt><dd data-k="' + it[2] + '">' + it[1] + '</dd></div>';
    }).join('');
    if (flash) {
      $('stats').querySelectorAll('dd').forEach(function (dd) {
        if (prev[dd.dataset.k] != null && prev[dd.dataset.k] !== dd.innerHTML) dd.classList.add('flash');
      });
    }
    $('legendPedal').hidden = !d.pedals.some(function (p) { return p[2] === 64; });
    $('legendSoft').hidden = !d.pedals.some(function (p) { return p[2] === 67; });
    renderOutCard();
  }

  // The file the MIDI-file options produce, shown at the end of that drawer section so it can be saved from there.
  function renderOutCard() {
    var card = $('outCard');
    var on = state.view === 'result' && !!state.job && !!state.data;
    card.hidden = !on;
    if (!on) return;
    var d = state.data, o = state.out;
    var sustain = d.pedals.filter(function (p) { return p[2] === 64; }).length;
    var soft = d.pedals.filter(function (p) { return p[2] === 67; }).length;
    var parts = [d.notes.length.toLocaleString('en-US') + ' notes'];
    if (o.pedal === 'cc') parts.push(sustain + ' pedal presses' + (soft ? ' + ' + soft + ' soft' : ''));
    else parts.push(o.pedal === 'extend' ? 'pedal baked into lengths' : 'no sustain pedal');
    if (o.velocity === 'flat') parts.push('all at velocity ' + o.flat_velocity);
    parts.push(o.tempo + ' BPM');
    $('outName').textContent = state.job.midi_name;
    $('outName').title = state.job.midi_name;
    $('outMeta').textContent = parts.join(' · ');
  }
  function viewsLabelFor(engineId, v) {
    var spec = engSpec(engineId, 'views');
    var c = spec && spec.choices.find(function (x) { return x.value === v; });
    return c ? c.label.replace(/\s*\((\d+x)\)/, ' $1').replace(/\s*\(.*\)/, '') : '';
  }

  var saveTimer = 0;
  function setSaveButtons(saved) {
    document.querySelectorAll('.save-btn').forEach(function (b) {
      b.classList.toggle('saved', saved);
      b.querySelector('.save-label').textContent = saved ? 'Saved' : 'Save MIDI';
    });
  }
  function resetSaveBtn() {
    clearTimeout(saveTimer);
    setSaveButtons(false);
  }
  function saveMidi() {
    if (!state.job) return;
    setSaveButtons(true);
    toast('Saved “' + state.job.midi_name + '” to Music', {
      action: { label: 'Show in folder', run: function () { toast('Opened Music in File Explorer'); } },
    });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(resetSaveBtn, 3200);
  }

  var exportTimer = 0;
  function applyOutput() {
    if (state.view !== 'result' || !state.job) return;
    state.data = buildData();
    roll.setData(state.data, { keepView: true });
    roll.setTime(state.time, state.playing);
    updateTime();
    renderResultHead(true);
    resetSaveBtn();
    clearTimeout(exportTimer);
    exportTimer = setTimeout(function () { toast('MIDI updated · ' + state.data.notes.length.toLocaleString('en-US') + ' notes'); }, 260);
  }

  // ------------------------------------------------------------------ progress
  function stagesFor(engineId, views) {
    var vc = { none: 1, channels: 4, full: 6 }[views] || 1;
    var tk = 'Transkun V2 · ' + vc + ' view' + (vc > 1 ? 's' : '');
    if (engineId === 'ensemble') {
      return [
        { id: 'decode', label: 'Read audio', w: 0.06, took: 0.4 },
        { id: 'transkun', label: tk, w: 0.80, windows: true, took: 7.8 },
        { id: 'aria', label: 'Aria-AMT second opinion', w: 0.10, took: 2.9 },
        { id: 'fuse', label: 'Merge + write MIDI', w: 0.04, took: 0.5 },
      ];
    }
    if (engineId === 'transkun') {
      return [
        { id: 'decode', label: 'Read audio', w: 0.06, took: 0.4 },
        { id: 'transkun', label: tk, w: 0.88, windows: true, took: 2.6 },
        { id: 'fuse', label: 'Write MIDI', w: 0.06, took: 0.2 },
      ];
    }
    return [
      { id: 'decode', label: 'Read audio', w: 0.06, took: 0.4 },
      { id: 'aria', label: 'Aria-AMT', w: 0.88, windows: true, took: 6.1 },
      { id: 'fuse', label: 'Write MIDI', w: 0.06, took: 0.2 },
    ];
  }

  function progressModel(ctx, p) {
    var stages = stagesFor(ctx.engine, ctx.views);
    var W = Math.max(1, Math.round((ctx.duration * 9) / 60));
    var acc = 0, active = stages.length - 1, frac = 1;
    for (var i = 0; i < stages.length; i++) {
      if (p < acc + stages[i].w || i === stages.length - 1) { active = i; frac = Math.min(1, Math.max(0, (p - acc) / stages[i].w)); break; }
      acc += stages[i].w;
    }
    var win = Math.min(W, Math.floor(frac * W) + 1);
    var s = stages[active];
    var msg;
    if (s.id === 'decode') msg = 'Reading the audio';
    else if (s.windows) msg = 'Transcribing window ' + win + ' of ' + W;
    else if (s.id === 'aria') msg = 'Getting a second opinion from Aria-AMT';
    else msg = ctx.engine === 'ensemble' ? 'Merging and writing the MIDI file' : 'Writing the MIDI file';
    return { stages: stages, active: active, win: win, W: W, msg: msg };
  }

  var stageKey = '';
  function renderProgress(ctx, p, status) {
    state.prog = { ctx: ctx, p: p, status: status };
    var card = $('progressCard');
    card.dataset.status = status;
    $('progName').textContent = ctx.name;
    $('progName').title = ctx.name;
    $('progFmt').textContent = ctx.fmt;
    var tile = $('progTile');
    tile.classList.toggle('error', status === 'error');
    tile.innerHTML = status === 'error' ? ICON.alert : (isVideo(ctx.name) ? ICON.video : ICON.audio);
    var bar = $('progBar');
    var pct = Math.round(p * 100);
    bar.hidden = status === 'error';
    bar.classList.toggle('indeterminate', status === 'queued');
    $('progFill').style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    if (status === 'queued') bar.removeAttribute('aria-valuenow');
    $('progPct').hidden = status !== 'running';
    $('progPct').innerHTML = pct + '<span>%</span>';
    $('errorBox').hidden = status !== 'error';
    $('progStatus').hidden = status === 'error';
    $('stages').hidden = status === 'error';
    $('retryBtn').hidden = status !== 'error';
    $('cancelBtn').textContent = status === 'queued' ? 'Remove from queue' : status === 'error' ? 'Remove' : 'Cancel';
    $('cancelBtn').className = 'btn' + (status === 'error' ? ' ghost' : '');
    $('retryBtn').className = 'btn primary';
    var summary = settingsSummary(ctx.engine);
    var deviceText = status === 'running' ? 'Running on ' + DEVICE + ' · ' + summary
      : status === 'queued' ? 'Will run on ' + DEVICE + ' · ' + summary : summary;
    $('progDevice').innerHTML = (status === 'error' ? '' : '<span class="gpu-dot" aria-hidden="true"></span>') + esc(deviceText);

    if (status === 'error') {
      $('progMsg').textContent = 'Could not convert this file';
      $('progEta').textContent = '';
      $('errTitle').textContent = ctx.error || 'The conversion failed.';
      stageKey = '';
      return;
    }
    if (status === 'queued') {
      $('progMsg').textContent = 'Waiting · ' + (ctx.ahead || 1) + ' conversion' + ((ctx.ahead || 1) > 1 ? 's' : '') + ' ahead';
      $('progEta').textContent = 'Starts automatically';
      renderStages(ctx, null);
      return;
    }
    var m = progressModel(ctx, p);
    $('progMsg').textContent = ctx.msg || m.msg;
    var left = ctx.eta != null && p === ctx.p0 ? ctx.eta : (1 - p) * totalSeconds(ctx.engine, ctx.views, ctx.duration);
    $('progEta').textContent = p >= 1 ? 'Done' : left < 2.5 ? 'Almost done' : 'About ' + fmtDuration(left) + ' left';
    renderStages(ctx, m);
  }

  function renderStages(ctx, m) {
    var stages = m ? m.stages : stagesFor(ctx.engine, ctx.views);
    var key = ctx.name + '|' + (m ? m.active + ':' + m.win : 'q') + '|' + ctx.engine + ctx.views;
    if (key === stageKey) return;
    stageKey = key;
    var ol = $('stages');
    ol.innerHTML = '';
    stages.forEach(function (s, i) {
      var st = !m ? 'pending' : i < m.active ? 'done' : i === m.active ? 'active' : 'pending';
      var li = el('li', 'stage ' + st);
      var dot = el('span', 'st-dot', st === 'done' ? ICON.check : '');
      var label = el('span', 'st-label');
      label.textContent = s.label;
      var side = el('span', 'st-side');
      if (st === 'done') side.textContent = s.took.toFixed(1) + ' s';
      else if (st === 'active' && s.windows) {
        if (m.W <= 20) {
          var wins = el('span', 'windows');
          wins.setAttribute('aria-hidden', 'true');
          for (var k = 1; k <= m.W; k++) wins.append(el('i', k < m.win ? 'd' : k === m.win ? 'a' : ''));
          side.append(wins);
        } else {
          var mb = el('span', 'mini-bar', '<span style="width:' + Math.round(((m.win - 1) / m.W) * 100) + '%"></span>');
          side.append(mb);
        }
        side.append(document.createTextNode(m.win + ' / ' + m.W));
      } else if (st === 'active') side.textContent = 'Working…';
      else if (m && i === m.active + 1) side.textContent = 'Next';
      li.append(dot, label, side);
      li.setAttribute('aria-current', st === 'active' ? 'step' : 'false');
      ol.append(li);
    });
  }

  function stopSim() {
    if (state.sim) cancelAnimationFrame(state.sim);
    state.sim = 0;
  }

  function startConversion(opts) {
    closeDrawer(true);
    stopSim();
    setPlaying(false);
    var ctx = {
      name: opts.name, fmt: opts.fmt, recentId: opts.recentId, duration: opts.duration || M.duration,
      engine: state.engine, views: state.eo[state.engine].views || 'none',
    };
    var item = recentById(ctx.recentId);
    if (!item) {
      item = { id: ctx.recentId, filename: ctx.name, status: 'running', progress: 0, duration: ctx.duration, when: 'Just now' };
      state.recent.unshift(item);
    }
    item.status = 'running';
    item.progress = 0;
    delete item.error;
    // one conversion runs at a time: anything else that was running waits
    state.recent.forEach(function (r) { if (r !== item && r.status === 'running') { r.status = 'queued'; r._paused = true; } });
    stageKey = '';
    show('progress');
    renderProgress(ctx, 0, 'running');
    var t0 = performance.now(), D = 3200;
    var step = function (now) {
      var k = Math.min(1, (now - t0) / D);
      var p = 0.7 * k + 0.3 * k * k * (3 - 2 * k);
      renderProgress(ctx, p, 'running');
      item.progress = p;
      updateRecentRow(item);
      if (k < 1) { state.sim = requestAnimationFrame(step); return; }
      state.sim = 0;
      item.status = 'done';
      item.notes = M.job.stats.notes;
      item.when = 'Just now';
      state.recent.forEach(function (r) { if (r._paused) { r.status = 'running'; delete r._paused; } });
      var job = jobFor(ctx.name, ctx.recentId);
      job.engine = ctx.engine;
      job.eo = clone(state.eo[ctx.engine]);
      setTimeout(function () { openResult(job, 0); }, 350);
    };
    state.sim = requestAnimationFrame(step);
  }

  function cancelConversion() {
    var pr = state.prog;
    stopSim();
    if (!pr) { goHome(); return; }
    var item = recentById(pr.ctx.recentId);
    if (pr.status === 'running' && item) {
      if (item.id === M.job.id) { item.status = 'done'; item.notes = M.job.stats.notes; }
      else item.status = 'cancelled';
      state.recent.forEach(function (r) { if (r._paused) { r.status = 'running'; delete r._paused; } });
      state.recent = state.recent.filter(function (r) { return r.status !== 'cancelled'; });
      goHome();
      toast('Conversion cancelled', { icon: false });
    } else {
      removeRecent(pr.ctx.recentId, true);
      goHome();
    }
  }

  function goHome() {
    stopSim();
    setPlaying(false);
    state.job = null;
    show('home');
  }

  function snapshotFor(item) {
    var name = item.filename;
    var fmt = item.id === M.job.id ? M.file.format + ' · ' + M.file.size_mb + ' MB'
      : (isVideo(name) ? extOf(name) + ' video' : extOf(name)) + ' · ' + fmtTime(item.duration);
    return {
      name: name, fmt: fmt, recentId: item.id, duration: item.duration || 60, engine: state.engine,
      views: state.eo[state.engine].views || 'none', error: item.error, ahead: 1,
    };
  }

  // ------------------------------------------------------------------ recent
  function recentById(id) { return state.recent.find(function (r) { return r.id === id; }); }

  function recentMeta(r) {
    var bits = [];
    if (r.status === 'error') return '<span class="err">' + esc(r.error || 'Failed') + '</span> · ' + esc(r.when);
    if (r.duration) bits.push(fmtTime(r.duration));
    if (r.status === 'done' && r.notes != null) bits.push(r.notes.toLocaleString('en-US') + ' notes');
    if (r.status === 'running') bits.push('Converting');
    if (r.status === 'queued') bits.push('In line');
    bits.push(r.when);
    return bits.map(esc).join(' · ');
  }

  function statusHtml(r) {
    if (r.status === 'running') {
      var pct = Math.round((r.progress || 0) * 100);
      return '<span class="mini-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span><span class="r-pct">' + pct + '%</span>';
    }
    if (r.status === 'queued') return '<span class="pill">Waiting</span>';
    if (r.status === 'error') return '<span class="pill error">Failed</span>';
    return '<span class="r-open" aria-hidden="true">' + ICON.chevron + '</span>';
  }

  function renderRecent() {
    var list = $('recentList');
    list.innerHTML = '';
    state.recent.forEach(function (r) {
      var li = el('li', 'r-item is-' + r.status);
      li.dataset.id = r.id;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      var verb = r.status === 'done' ? 'Open' : r.status === 'error' ? 'Show error for' : 'Show progress of';
      li.setAttribute('aria-label', verb + ' ' + r.filename);
      li.innerHTML =
        '<span class="r-icon" aria-hidden="true">' + (r.status === 'error' ? ICON.alert : isVideo(r.filename) ? ICON.video : ICON.audio) + '</span>' +
        '<span class="r-main"><span class="r-name"></span><span class="r-meta">' + recentMeta(r) + '</span></span>' +
        '<span class="r-status">' + statusHtml(r) + '</span>';
      li.querySelector('.r-name').textContent = r.filename;
      var del = el('button', 'icon-btn', ICON.close);
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove ' + r.filename + ' from Recent');
      del.title = 'Remove from Recent';
      del.onclick = function (e) { e.stopPropagation(); removeRecent(r.id); };
      li.append(del);
      li.onclick = function () { openRecent(r); };
      li.onkeydown = function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === li) { e.preventDefault(); openRecent(r); } };
      var current = (state.view === 'result' && state.job && state.job.id === r.id) ||
        (state.view === 'progress' && state.prog && state.prog.ctx.recentId === r.id);
      li.classList.toggle('current', !!current);
      if (current) li.setAttribute('aria-current', 'true');
      list.append(li);
    });
    $('recentEmpty').hidden = state.recent.length > 0;
    $('recentNote').textContent = state.recent.length ? state.recent.length + ' kept on this PC' : 'Kept on this PC';
  }

  function updateRecentRow(r) {
    var li = $('recentList').querySelector('[data-id="' + r.id + '"]');
    if (!li) { renderRecent(); return; }
    if (!li.classList.contains('is-' + r.status)) { renderRecent(); return; }
    var fill = li.querySelector('.mini-bar span');
    if (fill) fill.style.width = Math.round(r.progress * 100) + '%';
    var pct = li.querySelector('.r-pct');
    if (pct) pct.textContent = Math.round(r.progress * 100) + '%';
  }

  function openRecent(r) {
    if (state.sim && state.prog && state.prog.ctx.recentId === r.id) return;
    if (r.status === 'done') {
      stopSim();
      openResult(jobFor(r.filename, r.id), 0);
      return;
    }
    stopSim();
    var ctx = snapshotFor(r);
    stageKey = '';
    state.prog = { ctx: ctx, p: r.progress || 0, status: r.status };
    show('progress');
    renderProgress(ctx, r.progress || 0, r.status === 'error' ? 'error' : r.status);
    renderRecent();
  }

  function removeRecent(id, silent) {
    var idx = state.recent.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return;
    var item = state.recent[idx];
    var li = $('recentList').querySelector('[data-id="' + id + '"]');
    var finish = function () {
      state.recent.splice(state.recent.indexOf(item), 1);
      if (state.job && state.job.id === id && state.view === 'result') goHome();
      else renderRecent();
      if (!silent) {
        toast('Removed “' + item.filename + '” from Recent', {
          icon: false,
          action: { label: 'Undo', run: function () { state.recent.splice(Math.min(idx, state.recent.length), 0, item); renderRecent(); } },
        });
      }
    };
    if (li) { li.classList.add('leaving'); setTimeout(finish, 200); } else finish();
  }

  // ------------------------------------------------------------------ advanced drawer
  function optValue(scope, key) { return scope === 'out' ? state.out[key] : state.eo[scope][key]; }
  function setOptValue(scope, key, v) {
    if (scope === 'out') { state.out[key] = v; syncDrawer(); applyOutput(); }
    else { state.eo[scope][key] = v; syncDrawer(); renderSummary(); }
  }

  function optControl(scope, spec, display, extra) {
    extra = extra || {};
    var wrap = el('div', 'opt' + (extra.nested ? ' nested' : ''));
    wrap.dataset.scope = scope;
    wrap.dataset.key = spec.key;
    var id = uid('opt');
    var row = el('div', 'opt-row');
    var isGroup = display === 'seg' || display === 'segFull';
    var label = el(isGroup ? 'span' : 'label', 'opt-label');
    label.id = id + '-l';
    if (!isGroup) label.htmlFor = id;
    label.append(document.createTextNode(spec.label));
    var dot = el('span', 'dot');
    dot.title = 'Changed from the default';
    dot.hidden = true;
    label.append(dot);
    row.append(label);
    var value = optValue(scope, spec.key);
    var fk = scope + '.' + spec.key;

    if (display === 'select') {
      var box = el('span', 'select');
      var sel = el('select');
      sel.id = id;
      sel.dataset.fk = fk;
      spec.choices.forEach(function (c) {
        var o = el('option');
        o.value = c.value; o.textContent = c.label; o.selected = c.value === value;
        sel.append(o);
      });
      sel.onchange = function () { setOptValue(scope, spec.key, sel.value); };
      box.append(sel);
      box.insertAdjacentHTML('beforeend', ICON.chevronDown);
      row.append(box);
    } else if (isGroup) {
      var seg = el('div', 'seg' + (display === 'segFull' ? ' full' : ''));
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-labelledby', label.id);
      spec.choices.forEach(function (c) {
        var b = el('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = c.value;
        b.dataset.fk = fk + '=' + c.value;
        b.textContent = c.label.replace(/\s*\(.*\)/, '');
        if (/\(/.test(c.label)) b.title = c.label;
        b.onclick = function () {
          seg.querySelectorAll('button').forEach(function (x) { var on = x === b; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
          setOptValue(scope, spec.key, c.value);
        };
        var on = c.value === value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        seg.append(b);
      });
      radioKeys(seg);
      if (display === 'segFull') { wrap.append(row); row.after(seg); } else row.append(seg);
    } else if (display === 'switch') {
      var sw = el('span', 'switch');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.dataset.fk = fk;
      cb.setAttribute('role', 'switch');
      cb.checked = !!value;
      cb.onchange = function () { setOptValue(scope, spec.key, cb.checked); };
      sw.append(cb, el('span'));
      row.append(sw);
    } else if (display === 'stepper') {
      var st = el('span', 'stepper');
      var dec = el('button', '', ICON.minus);
      var inc = el('button', '', ICON.plus);
      dec.type = inc.type = 'button';
      dec.tabIndex = inc.tabIndex = -1;
      dec.setAttribute('aria-label', 'Decrease ' + spec.label);
      inc.setAttribute('aria-label', 'Increase ' + spec.label);
      var inp = el('input');
      inp.type = 'number';
      inp.id = id;
      inp.dataset.fk = fk;
      inp.min = spec.min; inp.max = spec.max; inp.step = spec.step;
      inp.value = value;
      inp.inputMode = 'numeric';
      var commit = function (v) {
        if (!isFinite(v)) v = spec.default;
        v = Math.max(spec.min, Math.min(spec.max, Math.round(v / spec.step) * spec.step));
        inp.value = v;
        if (v !== optValue(scope, spec.key)) setOptValue(scope, spec.key, v);
      };
      inp.onchange = function () { commit(Number(inp.value)); };
      dec.onclick = function () { commit(Number(inp.value) - spec.step); };
      inc.onclick = function () { commit(Number(inp.value) + spec.step); };
      st.append(dec, inp, inc);
      if (spec.unit) { var u = el('span', 'unit'); u.textContent = spec.unit; st.append(u); }
      row.append(st);
    } else if (display === 'slider') {
      var sr = el('span', 'slider-row');
      var rg = el('input', 'range');
      rg.type = 'range';
      rg.id = id;
      rg.dataset.fk = fk;
      rg.min = spec.min; rg.max = spec.max; rg.step = spec.step;
      rg.value = value;
      var val = el('span', 'range-val');
      val.textContent = value;
      var t = 0;
      var paint = function () {
        var pct = ((rg.value - spec.min) / (spec.max - spec.min)) * 100;
        rg.style.background = 'linear-gradient(to right, var(--accent) ' + pct + '%, var(--surface-3) ' + pct + '%)';
      };
      paint();
      rg.oninput = function () {
        val.textContent = rg.value;
        paint();
        state.out[spec.key] = Number(rg.value);
        syncDrawer();
        clearTimeout(t);
        t = setTimeout(applyOutput, 120);
      };
      sr.append(rg, val);
      row.append(sr);
    }
    if (display !== 'segFull') wrap.append(row);
    var help = extra.help || spec.help;
    if (help) { var p = el('p', 'help'); p.textContent = help; wrap.append(p); }
    return wrap;
  }

  function radioKeys(group) {
    group.addEventListener('keydown', function (e) {
      var keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (keys.indexOf(e.key) < 0) return;
      var items = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
      var i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      var dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      var next = items[(i + dir + items.length) % items.length];
      next.focus();
      next.click();
    });
  }

  function renderEngineSection() {
    var box = $('engineOptions');
    box.innerHTML = '';
    var list = el('div', 'engine-list');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Engine');
    ENGINES.forEach(function (e) {
      var b = el('button', 'engine-card');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.fk = 'engine=' + e.id;
      var on = e.id === state.engine;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.innerHTML = '<span class="radio-dot" aria-hidden="true"></span>' +
        '<span class="ec-name"></span><span class="ec-sub"></span>';
      b.querySelector('.ec-name').textContent = e.name;
      if (e.id === INST.default_engine) b.querySelector('.ec-name').insertAdjacentHTML('beforeend', '<span class="tag">Default</span>');
      b.querySelector('.ec-sub').textContent = !e.available ? (e.unavailable_reason || 'Not installed') : on ? e.summary : ENGINE_TAGLINE[e.id];
      if (!on) b.title = e.summary;
      b.onclick = function () {
        if (!e.available) { toast(e.unavailable_reason || 'This engine is not installed.', { icon: false }); return; }
        if (state.engine === e.id) return;
        state.engine = e.id;
        renderEngineSection();
        syncDrawer();
        renderSummary();
        var f = box.querySelector('[data-fk="engine=' + e.id + '"]');
        if (f) f.focus();
      };
      list.append(b);
    });
    radioKeys(list);
    box.append(list);

    var cur = eng(state.engine);

    var opts = el('div', 'opts');
    cur.options.forEach(function (spec) {
      if (spec.key === 'views') opts.append(optControl(state.engine, spec, 'select'));
      else if (spec.key === 'rescue') opts.append(optControl(state.engine, spec, 'seg', { help: spec.help + ' Balanced measured best.' }));
      else if (spec.key === 'velocity') opts.append(optControl(state.engine, spec, 'select'));
      else if (spec.kind === 'bool') opts.append(optControl(state.engine, spec, 'switch'));
      else opts.append(optControl(state.engine, spec, spec.kind === 'choice' ? 'select' : 'stepper'));
    });
    if (!cur.options.length) {
      var none = el('p', 'help');
      none.style.padding = '8px 0 4px';
      none.textContent = 'Aria-AMT has no extra settings.';
      opts.append(none);
    }
    box.append(opts);

    if (state.engine !== 'transkun') {
      var tk = eng('transkun');
      var more = el('details', 'more');
      more.open = state.moreOpen;
      more.ontoggle = function () { state.moreOpen = more.open; };
      var summ = el('summary', '', ICON.chevron + '<span>Transkun V2 settings</span><span class="muted">Apply when it runs alone</span>');
      more.append(summ);
      var body = el('div', 'more-body');
      tk.options.forEach(function (spec) {
        if (spec.key === 'views') return;
        body.append(optControl('transkun', spec, spec.kind === 'bool' ? 'switch' : 'select'));
      });
      more.append(body);
      box.append(more);
    }
  }

  function renderOutputSection() {
    var box = $('outputOptions');
    box.innerHTML = '';
    box.append(optControl('out', outSpec('pedal'), 'select'));
    box.append(optControl('out', outSpec('soft_pedal'), 'switch'));
    var dyn = optControl('out', outSpec('velocity'), 'seg');
    var flat = optControl('out', outSpec('flat_velocity'), 'slider', { nested: true });
    dyn.append(flat);
    box.append(dyn);
    box.append(optControl('out', outSpec('min_note_ms'), 'stepper'));
    box.append(optControl('out', outSpec('tempo'), 'stepper'));
  }

  function renderOutputNote() {
    var n = $('outputNote');
    var live = state.view === 'result';
    renderOutCard();
    n.classList.toggle('live', live);
    n.innerHTML = live
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/></svg>Changes update this result instantly'
      : 'Applied whenever a MIDI file is written';
  }

  function changedCount() {
    var n = state.engine !== INST.default_engine ? 1 : 0;
    ENGINES.forEach(function (e) {
      e.options.forEach(function (s) { if (String(state.eo[e.id][s.key]) !== String(s.default)) n++; });
    });
    OUT_SPECS.forEach(function (s) {
      if (s.key === 'flat_velocity' && state.out.velocity !== 'flat') return;
      if (String(state.out[s.key]) !== String(s.default)) n++;
    });
    return n;
  }

  function engineDiffers() {
    var job = state.job;
    if (!job) return false;
    if (job.engine !== state.engine) return true;
    var cur = state.eo[state.engine];
    return Object.keys(cur).some(function (k) { return String(cur[k]) !== String(job.eo[k]); });
  }

  function syncDrawer() {
    var n = changedCount();
    var badge = $('changedBadge');
    badge.hidden = n === 0;
    badge.textContent = n;
    $('openAdvanced').setAttribute('aria-label', n ? 'Advanced options, ' + n + ' changed' : 'Advanced options');
    $('resetBtn').disabled = n === 0;
    $('rerunBtn').hidden = !(state.view === 'result' && engineDiffers());
    document.querySelectorAll('#drawer .opt').forEach(function (w) {
      var scope = w.dataset.scope, key = w.dataset.key;
      var spec = scope === 'out' ? outSpec(key) : engSpec(scope, key);
      var dot = w.querySelector(':scope > .opt-row .dot, :scope > .opt-row > .opt-label .dot');
      if (dot) dot.hidden = String(optValue(scope, key)) === String(spec.default);
      if (key === 'flat_velocity') {
        var off = state.out.velocity !== 'flat';
        w.classList.toggle('is-disabled', off);
        var r = w.querySelector('input');
        if (r) r.disabled = off;
        if (off && dot) dot.hidden = true;
      }
    });
  }

  function renderDrawer() {
    var a = document.activeElement;
    var fk = a && a.dataset ? a.dataset.fk : null;
    renderEngineSection();
    renderOutputSection();
    renderOutputNote();
    syncDrawer();
    if (fk) { var f = document.querySelector('#drawer [data-fk="' + fk + '"]'); if (f) f.focus(); }
  }

  function openDrawer(opener) {
    if ($('drawer').classList.contains('open')) return;
    state.drawerOpener = opener || document.activeElement;
    renderDrawer();
    var d = $('drawer');
    d.inert = false;
    d.setAttribute('aria-hidden', 'false');
    $('scrim').hidden = false;
    d.classList.add('open');
    $('openAdvanced').setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('drawer-open');
    markReview();
    if (!document.documentElement.classList.contains('booting')) setTimeout(function () { $('closeAdvanced').focus(); }, 80);
  }
  function closeDrawer(silent) {
    var d = $('drawer');
    var wasOpen = d.classList.contains('open');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    d.inert = true;
    $('scrim').hidden = true;
    $('openAdvanced').setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('drawer-open');
    markReview();
    if (wasOpen && !silent && state.drawerOpener && state.drawerOpener.focus) state.drawerOpener.focus();
  }

  function resetOptions() {
    state.engine = INST.default_engine;
    ENGINES.forEach(function (e) { state.eo[e.id] = defaultsFor(e.options); });
    state.out = defaultsFor(OUT_SPECS);
    renderDrawer();
    renderSummary();
    applyOutput();
    clearTimeout(exportTimer);
    toast('Options reset to defaults');
  }

  // ------------------------------------------------------------------ reviewer states
  function goState(s) {
    stopSim();
    closeDrawer(true);
    resetRecent();
    state.prog = null;
    if (s === 'progress') {
      var schubert = recentById(M.job.id);
      schubert.status = 'running';
      schubert.progress = M.progress.progress;
      state.recent.forEach(function (r) { if (r !== schubert && r.status === 'running') r.status = 'queued'; });
      var ctx = snapshotFor(schubert);
      ctx.engine = 'ensemble';
      ctx.views = 'channels';
      ctx.msg = M.progress.message;
      ctx.eta = M.progress.eta_seconds;
      ctx.p0 = M.progress.progress;
      stageKey = '';
      state.prog = { ctx: ctx, p: ctx.p0, status: 'running' };
      show('progress');
      renderProgress(ctx, ctx.p0, 'running');
      renderRecent();
    } else if (s === 'result' || s === 'advanced') {
      openResult(jobFor(M.job.filename, M.job.id), 12);
      if (s === 'advanced') { state.moreOpen = true; openDrawer($('openAdvanced')); }
    } else {
      goHome();
    }
    markReview();
  }

  function setUrlParam(k, v) {
    var p = new URLSearchParams(location.search);
    if (v == null) p.delete(k); else p.set(k, v);
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  }

  var THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  function applyTheme(pref) {
    window.__applyTheme(pref === 'auto' ? null : pref);
    document.documentElement.setAttribute('data-theme-pref', pref);
    $('themeBtn').textContent = THEME_LABEL[pref];
    roll._readColors();
    roll._drawKeys();
    roll.requestDraw();
    readOvColors();
    drawOverview(true);
  }

  // ------------------------------------------------------------------ wiring
  function bind() {
    $('dropzone').onclick = function () {
      startConversion({ name: M.file.name, fmt: M.file.format + ' · ' + M.file.size_mb + ' MB', recentId: M.job.id, duration: M.duration });
    };
    $('homeLink').onclick = function (e) { e.preventDefault(); closeDrawer(true); goHome(); };
    $('openAdvanced').onclick = function () { openDrawer($('openAdvanced')); };
    $('summaryLine').onclick = function () { openDrawer($('summaryLine')); };
    $('closeAdvanced').onclick = function () { closeDrawer(); };
    $('scrim').onclick = function () { closeDrawer(); };
    $('resetBtn').onclick = resetOptions;
    $('rerunBtn').onclick = function () {
      if (!state.job) return;
      var r = recentById(state.job.id);
      startConversion({
        name: state.job.filename, recentId: state.job.id, duration: M.duration,
        fmt: state.job.id === M.job.id ? M.file.format + ' · ' + M.file.size_mb + ' MB' : extOf(state.job.filename) + ' · ' + fmtTime((r && r.duration) || 60),
      });
    };
    $('cancelBtn').onclick = cancelConversion;
    $('retryBtn').onclick = function () { goHome(); setTimeout(function () { $('dropzone').focus(); }, 50); };
    $('newBtn').onclick = function () { goHome(); setTimeout(function () { $('dropzone').focus(); }, 50); };
    $('saveBtn').onclick = saveMidi;
    $('drawerSave').onclick = saveMidi;
    $('playBtn').onclick = togglePlay;
    $('mixSeg').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setMix(b.dataset.mix); }; });
    radioKeys($('mixSeg'));
    $('zoomIn').onclick = function () { roll.zoom(1.5); };
    $('zoomOut').onclick = function () { roll.zoom(1 / 1.5); };
    $('zoomFit').onclick = function () {
      roll.pxPerSec = Math.max(6, roll._viewW() / Math.max(1, roll.duration));
      roll.scrollX = 0;
      roll.requestDraw();
    };

    // focus trap inside the drawer
    $('drawer').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(
        $('drawer').querySelectorAll('button, select, input, summary, [tabindex="0"]'),
        function (x) { return !x.disabled && x.offsetParent !== null && x.tabIndex >= 0; }
      );
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    window.addEventListener('keydown', function (e) {
      var open = $('drawer').classList.contains('open');
      if (e.key === 'Escape' && open) { closeDrawer(); return; }
      if (open || state.view !== 'result') return;
      var a = document.activeElement;
      var tag = a ? a.tagName : '';
      var handlesSpace = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].indexOf(tag) >= 0 || (a && a.getAttribute('role') === 'button');
      if (e.code === 'Space' && (!handlesSpace || a === $('playBtn'))) { e.preventDefault(); togglePlay(); }
      else if ((e.key === '+' || e.key === '=') && !handlesSpace) roll.zoom(1.5);
      else if (e.key === '-' && !handlesSpace) roll.zoom(1 / 1.5);
    });

    // drag and drop a real file: runs the same simulated conversion with its name
    var depth = 0;
    var hasFiles = function (e) { return Array.prototype.indexOf.call((e.dataTransfer && e.dataTransfer.types) || [], 'Files') >= 0; };
    window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; depth++; $('dropOverlay').hidden = false; $('dropzone').classList.add('over'); });
    window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) { $('dropOverlay').hidden = true; $('dropzone').classList.remove('over'); } });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('dropOverlay').hidden = true;
      $('dropzone').classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (!f) return;
      startConversion({
        name: f.name, recentId: 'local-' + Date.now(), duration: M.duration,
        fmt: (isVideo(f.name) ? extOf(f.name) + ' video' : extOf(f.name)) + ' · ' + (f.size / 1048576).toFixed(1) + ' MB',
      });
    });

    window.addEventListener('scroll', function () { $('topbar').classList.toggle('scrolled', window.scrollY > 4); }, { passive: true });

    document.querySelectorAll('#review [data-state]').forEach(function (b) {
      b.onclick = function () { setUrlParam('state', b.dataset.state); goState(b.dataset.state); };
    });
    $('themeBtn').onclick = function () {
      var cur = document.documentElement.getAttribute('data-theme-pref') || 'auto';
      var next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
      setUrlParam('theme', next === 'auto' ? null : next);
      applyTheme(next);
    };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { readOvColors(); drawOverview(true); });
  }

  // ------------------------------------------------------------------ init
  function init() {
    bind();
    $('aboutLine').textContent = 'Options kept on this PC · v' + INFO.version;
    $('gpuChip').title = 'Running on ' + INFO.device.name + ', ' + INFO.device.vram_gb + ' GB';
    $('themeBtn').textContent = THEME_LABEL[document.documentElement.getAttribute('data-theme-pref')] || 'Auto';
    renderSummary();
    setMix('both');
    var s = q.get('state');
    goState(['home', 'progress', 'result', 'advanced'].indexOf(s) >= 0 ? s : 'home');
    requestAnimationFrame(frame);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { document.documentElement.classList.remove('booting'); });
    });
  }

  init();
})();
