/* MIDI Converter — "Guided" prototype. Classic script, no backend: everything runs on window.MOCK. */
(function () {
  'use strict';

  var M = window.MOCK;
  var R = window.MCRoll;
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var params = new URLSearchParams(location.search);
  var CLEAN = params.get('clean') === '1';
  var DEBUG = params.get('debug') === '1';

  /* ------------------------------------------------------------------ data */
  var INST = M.info.instruments[0];
  var ENGINES = INST.engines;
  var engineById = function (id) { return ENGINES.filter(function (e) { return e.id === id; })[0]; };
  var TK = engineById('transkun');
  var OUT = M.info.output_options;
  var outOpt = function (k) { return OUT.filter(function (o) { return o.key === k; })[0]; };
  var DEVICE = M.info.device;
  var GPU_SHORT = DEVICE.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');

  var FILE = {
    name: M.file.name,
    midi: M.job.midi_name,
    duration: M.duration,
    meta: R.fmtTime(M.duration) + ' · ' + M.file.format.split(' · ').slice(0, 2).join(' ') + ' · ' + M.file.size_mb + ' MB'
  };

  var SHORT_ENGINE = { ensemble: 'Ensemble', transkun: 'Transkun V2', aria: 'Aria-AMT' };
  var VIEWS_SHORT = { none: 'Single view', channels: 'Stereo views 4x', full: 'Stereo + tone views 6x' };
  var VIEWS_N = { none: 1, channels: 4, full: 6 };
  // Seconds per 2 minutes of music on the RTX 5070 Ti (README: Ensemble 20-25 s, Transkun about 4x faster).
  var BASE_PER_2MIN = { ensemble: 24, transkun: 6, aria: 17 };
  var VIEW_FACTOR = { none: 0.4, channels: 1, full: 1.45 };

  // Plain-language one-liners. The full help text from the engine stays in the tooltip.
  var HELP = {
    engine: {
      ensemble: 'Most accurate: Transkun V2 plus a second opinion from Aria-AMT.',
      transkun: 'One model on its own. About 4× faster, almost as accurate.',
      aria: 'Aria-AMT on its own. Mainly useful for comparison.'
    },
    views: 'Hears the piano from several angles. 4 views measured best.',
    rescue: 'How unsure Transkun must be before an Aria-only note is added.',
    velocity: 'How each note’s loudness is read from the model.',
    merge_fix: 'Stops long pedal presses being cut short.',
    pedal: 'As pedal events, baked into note lengths, or left out.',
    soft_pedal: 'Include una corda presses (the left pedal).',
    out_velocity: 'Keep how hard each key was struck, or make every note equal.',
    flat_velocity: 'Loudness used for every note when Dynamics is Flat.',
    min_note_ms: 'Drop notes shorter than this. 0 keeps everything.',
    tempo: 'Only changes how bars line up in a DAW. Timing stays real.'
  };

  var DEFAULTS = {
    engine: INST.default_engine,
    eng: { views: 'channels', rescue: '0.3', velocity: 'mode', merge_fix: true },
    out: { pedal: 'cc', soft_pedal: true, velocity: 'played', flat_velocity: 80, min_note_ms: 0, tempo: 120 }
  };
  var PRESET_NAME = { best: 'Best quality', fast: 'Faster', custom: 'Custom' };

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var S = {
    step: 1, maxStep: 1,
    file: null,
    preset: 'best',
    set: clone(DEFAULTS),
    skipQuality: false,
    moreOpen: false,
    converting: false, staticProgress: false, progress: 0,
    hasResult: false, resultEngine: 'ensemble', resultSeconds: M.job.stats.seconds_total,
    saved: false,
    time: 0, playing: false, mix: 'both'
  };

  /* ------------------------------------------------------------------ icons */
  var IC = {
    star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.4 5.6 6.1.6-4.6 4 1.4 6-5.3-3.2-5.3 3.2 1.4-6-4.6-4 6.1-.6z"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z"/></svg>',
    sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 7.5v5.5M12 16.6v.4"/></svg>',
    left: '<svg class="back" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg class="arrow" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    notes: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    vel: '<svg viewBox="0 0 24 24"><path d="M5 19V15M10 19v-7M15 19V9M20 19V5"/></svg>',
    pedal: '<svg viewBox="0 0 24 24"><path d="M7 20h10M9 20l1.5-9h3L15 20M10.5 11L9 4h6l-1.5 7"/></svg>',
    soft: '<svg viewBox="0 0 24 24"><path d="M4 14c2.5-4 5-4 8 0s5.5 4 8 0"/></svg>'
  };
  var PRESET_ICON = { best: IC.star, fast: IC.bolt, custom: IC.sliders };

  /* ------------------------------------------------------------------ helpers */
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function estimate(engine, views, dur) {
    var f = engine === 'aria' ? 1 : (VIEW_FACTOR[views] || 1);
    return Math.max(1, Math.round(BASE_PER_2MIN[engine] * f * (dur / 120)));
  }
  function estNow() { return estimate(S.set.engine, S.set.eng.views, (S.file || FILE).duration); }
  function settingsLine() {
    var e = S.set.engine;
    return e === 'aria' ? SHORT_ENGINE.aria : SHORT_ENGINE[e] + ' · ' + VIEWS_SHORT[S.set.eng.views];
  }
  function matchPreset() {
    var s = S.set;
    if (s.engine === 'ensemble' && s.eng.views === 'channels' && s.eng.rescue === '0.3') return 'best';
    if (s.engine === 'transkun' && s.eng.views === 'channels' && s.eng.velocity === 'mode' && s.eng.merge_fix) return 'fast';
    return null;
  }
  function bindText(key, text) { qsa('[data-bind="' + key + '"]').forEach(function (el) { el.textContent = text; }); }

  /* ------------------------------------------------------------------ toast */
  var toastTimer = 0;
  function toast(msg, action) {
    var t = $('toast'), a = $('toastAction');
    $('toastText').textContent = msg;
    if (action) { a.hidden = false; a.textContent = action.label; a.onclick = function () { t.classList.remove('show'); action.run(); }; }
    else { a.hidden = true; a.onclick = null; }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, action ? 5200 : 2600);
  }

  /* ------------------------------------------------------------------ navigation */
  function go(n, opts) {
    opts = opts || {};
    if (n !== 4 && S.playing) pause();
    S.step = n;
    S.maxStep = Math.max(S.maxStep, n);
    render();
    $('stage').scrollTop = 0;
    if (!opts.silent) {
      var h = $('h' + n);
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
  }

  function pickFile() {
    var dz = $('dropzone');
    S.file = FILE;
    S.hasResult = false; S.saved = false; S.maxStep = 1; S.time = 0;
    dz.classList.add('picked');
    qsa('.dz-title', dz)[0].textContent = FILE.name;
    qsa('.dz-sub', dz)[0].textContent = FILE.meta;
    setTimeout(function () {
      dz.classList.remove('picked');
      qsa('.dz-title', dz)[0].textContent = 'Drop a recording here';
      qsa('.dz-sub', dz)[0].innerHTML = 'or <span class="dz-link">choose a file</span> from your computer';
      if (S.skipQuality) startConversion();
      else go(2);
    }, 520);
  }

  function newFile() {
    if (S.playing) pause();
    S.file = null; S.hasResult = false; S.saved = false; S.maxStep = 1; S.time = 0;
    go(1);
  }

  /* ------------------------------------------------------------------ render */
  function render() {
    [1, 2, 3, 4].forEach(function (i) { $('step' + i).hidden = S.step !== i; });
    renderStepper();
    renderFooter();
    bindText('fileName', (S.file || FILE).name);
    bindText('fileMeta', (S.file || FILE).meta);
    if (S.step === 1) renderHome();
    if (S.step === 2) renderQuality();
    if (S.step === 3) renderProgress();
    if (S.step === 4) renderReview();
    if ($('drawer').classList.contains('open')) renderDrawer();
    qsa('.switcher a').forEach(function (a) {
      var st = { 1: 'home', 2: S.preset === 'custom' ? 'advanced' : '', 3: 'progress', 4: 'result' }[S.step];
      a.classList.toggle('on', a.getAttribute('data-state') === st);
    });
  }

  function renderStepper() {
    var pct = Math.round(S.progress * 100);
    [1, 2, 3, 4].forEach(function (i) {
      var li = qsa('.st[data-step="' + i + '"]')[0];
      var btn = li.querySelector('.st-btn');
      var current = S.step === i;
      var done = !current && (i < S.step || i < S.maxStep) && !(i === 3 && S.converting);
      if (i === 4) done = S.saved && !current;
      if (i === 4 && current && S.saved) done = false;
      li.classList.toggle('current', current);
      li.classList.toggle('done', done || (i === 4 && S.saved));
      li.classList.toggle('busy', i === 3 && S.converting);
      var can = !S.converting && (i === 1 || (i === 2 && !!S.file) || (i === 4 && S.hasResult));
      if (i === 3) can = S.converting && !current;
      btn.disabled = !can || current;
      if (current) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
    qsa('.st-line').forEach(function (l) {
      var after = +l.getAttribute('data-after');
      l.classList.toggle('done', after < S.maxStep && !(after === 3 && S.converting) && !(after >= 2 && !S.file));
    });
    $('stRing').style.setProperty('--p', pct);
    $('sub1').textContent = S.file ? S.file.name : 'MP3, WAV, video…';
    $('sub2').textContent = PRESET_NAME[S.preset];
    $('sub3').textContent = S.converting ? pct + '% · about ' + etaSeconds() + ' s left'
      : S.hasResult ? 'Done in ' + S.resultSeconds + ' s' : 'About ' + estNow() + ' s';
    $('sub4').textContent = S.saved ? 'Saved' : 'Listen, then save';
  }

  function renderFooter() {
    var L = '', Rt = '';
    if (S.step === 1) {
      L = '<div class="qsum"><span class="qsum-ic" aria-hidden="true">' + PRESET_ICON[S.preset] + '</span>' +
          '<span class="qsum-text"><small>Quality</small><span>' + esc(PRESET_NAME[S.preset] + ' · ' + settingsLine()) + '</span></span>' +
          '<button class="link-btn" type="button" data-action="advanced">Change</button></div>';
      Rt = S.file
        ? '<span class="ab-hint"><b>' + esc(S.file.name) + '</b> is ready</span><button class="btn primary lg" type="button" data-action="next">Next: Choose quality' + IC.right + '</button>'
        : '<span class="ab-hint">Choose a recording to continue</span><button class="btn primary lg" type="button" disabled>Next: Choose quality' + IC.right + '</button>';
    } else if (S.step === 2) {
      L = '<button class="btn ghost" type="button" data-action="back">' + IC.left + 'Back</button>' +
          '<span class="ab-hint">About <b>' + estNow() + ' s</b> for this ' + Math.round((S.file || FILE).duration / 60) + '-minute recording on your ' + esc(GPU_SHORT) + '</span>';
      Rt = '<button class="btn primary lg" type="button" data-action="start">Start converting' + IC.right + '</button>';
    } else if (S.step === 3) {
      L = '<button class="btn danger-quiet" type="button" data-action="cancel">' + IC.x + 'Cancel</button>' +
          '<span class="ab-hint">You can keep using your PC while this runs.</span>';
      Rt = '<button class="btn primary lg" type="button" disabled>Review &amp; save' + IC.right + '</button>';
    } else if (S.step === 4) {
      L = '<button class="btn ghost" type="button" data-action="back">' + IC.left + 'Change quality</button>' +
          '<button class="btn quiet" type="button" data-action="new">New file</button>';
      Rt = (S.saved
        ? '<span class="saved-note">' + IC.check + 'Saved to Music › MIDI Converter</span>'
        : '<span class="ab-hint">Saves <b>' + esc(midiName()) + '</b></span>') +
        '<button class="btn primary lg" type="button" data-action="save">' + IC.save + (S.saved ? 'Save again' : 'Save MIDI') + '</button>';
    }
    $('abLeft').innerHTML = L;
    $('abRight').innerHTML = Rt;
  }
  function midiName() { return (S.file || FILE).name.replace(/\.[^.]+$/, '') + '.mid'; }

  /* ---------- step 1 ---------- */
  var recentBuilt = false;
  function renderHome() {
    if (recentBuilt) return;
    recentBuilt = true;
    var list = $('recentList');
    var items = M.recent || [];
    $('recentEmpty').hidden = items.length > 0;
    $('recentCount').textContent = items.length || '';
    list.innerHTML = items.map(function (r, i) {
      var ic, meta, cls = r.status;
      if (r.status === 'done') { ic = IC.check; meta = R.fmtTime(r.duration) + ' · ' + r.notes.toLocaleString('en-US') + ' notes'; }
      else if (r.status === 'running') { ic = ''; meta = '<span class="mini"><i style="width:' + Math.round(r.progress * 100) + '%"></i></span>Converting · ' + Math.round(r.progress * 100) + '%'; }
      else if (r.status === 'queued') { ic = IC.clock; meta = 'Waiting · starts next'; }
      else { ic = IC.alert; meta = 'Failed · ' + esc(r.error || 'Could not convert'); }
      return '<li><button class="r-item" type="button" data-recent="' + i + '" title="' + esc(r.filename) + '">' +
        '<span class="r-ic ' + cls + '" aria-hidden="true">' + ic + '</span>' +
        '<span class="r-text"><span class="r-name">' + esc(r.filename.replace(/\.[^.]+$/, '')) + '</span>' +
        '<span class="r-meta' + (r.status === 'error' ? ' err' : '') + '">' + meta + '</span></span>' +
        '<span class="r-when">' + esc(r.when) + '</span></button></li>';
    }).join('');
  }

  function openRecent(i) {
    var r = M.recent[i];
    if (r.status === 'done') {
      if (S.playing) pause();
      S.file = r.id === M.job.id ? FILE : { name: r.filename, midi: r.filename.replace(/\.[^.]+$/, '.mid'), duration: r.duration, meta: R.fmtTime(r.duration) };
      S.hasResult = true; S.saved = false; S.maxStep = 4; S.time = 0;
      S.resultEngine = 'ensemble'; S.resultSeconds = M.job.stats.seconds_total;
      if (r.id !== M.job.id) toast('Prototype: showing the Schubert notes for every saved result.');
      go(4);
    } else if (r.status === 'running') {
      toast(r.filename + ' is converting (' + Math.round(r.progress * 100) + '%). It shows up here when it is done.');
    } else if (r.status === 'queued') {
      toast(r.filename + ' is waiting. It starts after the conversion in progress.');
    } else {
      toast('“' + r.filename + '” could not be converted: ' + (r.error || 'unknown error').replace(/\.$/, '').toLowerCase() + '.', { label: 'Try another file', run: pickFile });
    }
  }

  /* ---------- step 2 ---------- */
  function renderQuality() {
    qsa('#presets .preset').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-preset') === S.preset));
      b.tabIndex = b.getAttribute('data-preset') === S.preset ? 0 : -1;
    });
    var custom = S.preset === 'custom';
    $('presets').classList.toggle('compact', custom);
    $('customPanel').hidden = !custom;
    $('presetNote').hidden = custom;
    var d = (S.file || FILE).duration;
    bindText('bestTime', 'About ' + estimate('ensemble', 'channels', d) + ' s for this recording');
    bindText('fastTime', 'About ' + estimate('transkun', 'channels', d) + ' s for this recording');
    bindText('customTime', custom ? 'About ' + estNow() + ' s with your settings' : 'Depends on your settings');
    bindText('customSummary', custom ? settingsLine() : 'Starts from Best quality');
    $('skipQuality').checked = S.skipQuality;
    $('cpSummary').textContent = settingsLine();
    $('cpTime').textContent = '· about ' + estNow() + ' s for this recording';
    if (custom) {
      $('engineOptions').innerHTML = engineOptionsHTML('cp');
      $('outputOptions').innerHTML = outputOptionsHTML('cp');
      syncRanges();
    }
  }

  function choosePreset(p) {
    S.preset = p;
    if (p === 'best') { S.set.engine = 'ensemble'; S.set.eng.views = 'channels'; S.set.eng.rescue = '0.3'; }
    if (p === 'fast') { S.set.engine = 'transkun'; S.set.eng.views = 'channels'; S.set.eng.velocity = 'mode'; S.set.eng.merge_fix = true; }
    render();
    if (p === 'custom') {
      var panel = $('customPanel');
      setTimeout(function () { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30);
    }
  }

  /* ---------- options (custom panel, drawer) ---------- */
  function chipsHTML(scope, key, label, choices, value, opts) {
    opts = opts || {};
    return '<div class="chips" role="radiogroup" aria-label="' + esc(label) + '">' + choices.map(function (c) {
      var on = String(c.value) === String(value);
      return '<button class="chip" type="button" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-scope="' + scope + '" data-key="' + key + '" data-value="' + esc(c.value) + '">' +
        esc(c.label) + (c.rec ? ' <span class="rec">Default</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function switchHTML(scope, key, label, on) {
    return '<button class="switch" type="button" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '" data-scope="' + scope + '" data-key="' + key + '"></button>';
  }
  function rangeHTML(scope, key, label, o, value, fmt) {
    return '<div class="range-row"><input type="range" aria-label="' + esc(label) + '" min="' + o.min + '" max="' + o.max + '" step="' + o.step + '" value="' + value + '" data-scope="' + scope + '" data-key="' + key + '" data-fmt="' + fmt + '">' +
      '<span class="range-val" data-val="' + key + '">' + fmtVal(fmt, value) + '</span></div>';
  }
  function numHTML(scope, key, label, o, value) {
    return '<div class="num-row"><span class="num"><button type="button" aria-label="Lower ' + esc(label) + '" data-scope="' + scope + '" data-key="' + key + '" data-step="-1">−</button>' +
      '<input type="text" inputmode="numeric" aria-label="' + esc(label) + '" value="' + value + '" data-scope="' + scope + '" data-key="' + key + '" data-num>' +
      '<button type="button" aria-label="Raise ' + esc(label) + '" data-scope="' + scope + '" data-key="' + key + '" data-step="1">+</button></span>' +
      '<span class="unit">' + esc(o.unit) + '</span></div>';
  }
  function fmtVal(fmt, v) {
    v = +v;
    if (fmt === 'ms') return v === 0 ? 'Keep all' : v + ' ms';
    if (fmt === 'vel') return v + ' of 127';
    return String(v);
  }
  function optRow(label, help, title, control, extraCls) {
    return '<div class="opt' + (extraCls ? ' ' + extraCls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<div class="opt-line"><span class="opt-label">' + esc(label) + '</span><span class="opt-help">' + esc(help) + '</span></div>' + control + '</div>';
  }
  function boolRow(label, help, title, control, extraCls) {
    return '<div class="opt bool' + (extraCls ? ' ' + extraCls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<div class="opt-line"><span class="opt-label">' + esc(label) + '</span><span class="opt-help">' + esc(help) + '</span></div>' + control + '</div>';
  }
  function engOptHTML(o, extraCls) {
    var v = S.set.eng[o.key];
    if (o.kind === 'bool') return boolRow(o.label, HELP[o.key] || o.help, o.help, switchHTML('eng', o.key, o.label, v), extraCls);
    return optRow(o.label, HELP[o.key] || o.help, o.help, chipsHTML('eng', o.key, o.label, o.choices.map(function (c) {
      return { value: c.value, label: c.label };
    }), v), extraCls);
  }

  function engineOptionsHTML(ctx) {
    var e = engineById(S.set.engine);
    var h = optRow('Engine', HELP.engine[S.set.engine], e.summary,
      chipsHTML('engine', 'engine', 'Engine', ENGINES.map(function (x) { return { value: x.id, label: x.name, rec: x.id === INST.default_engine }; }), S.set.engine));
    e.options.forEach(function (o) { h += engOptHTML(o); });
    if (S.set.engine === 'aria') h += '<p class="engine-empty">Aria-AMT has no extra settings.</p>';
    if (S.set.engine !== 'transkun') {
      var extras = TK.options.filter(function (o) { return !e.options.some(function (x) { return x.key === o.key; }); });
      h += '<div class="more"><button class="more-btn" type="button" data-more aria-expanded="' + S.moreOpen + '" aria-controls="' + ctx + '-more">' + IC.chev + 'More: Transkun V2 settings <span class="more-note">used when Transkun V2 runs alone</span></button>' +
        '<div class="more-body" id="' + ctx + '-more"' + (S.moreOpen ? '' : ' hidden') + '>' +
        extras.map(function (o) { return engOptHTML(o, 'inactive'); }).join('') + '</div></div>';
    }
    return h;
  }

  function outputOptionsHTML(ctx) {
    var o = S.set.out;
    var ped = outOpt('pedal'), soft = outOpt('soft_pedal'), vel = outOpt('velocity'), flat = outOpt('flat_velocity'), min = outOpt('min_note_ms'), tempo = outOpt('tempo');
    var h = '';
    h += optRow(ped.label, HELP.pedal, ped.help, chipsHTML('out', 'pedal', ped.label, ped.choices, o.pedal));
    h += boolRow(soft.label, HELP.soft_pedal, soft.help, switchHTML('out', 'soft_pedal', soft.label, o.soft_pedal));
    var velCtl = chipsHTML('out', 'velocity', vel.label, vel.choices, o.velocity);
    if (o.velocity === 'flat') velCtl += '<div class="flat-inline" title="' + esc(flat.help) + '"><span class="opt-label">' + esc(flat.label) + '</span>' + rangeHTML('out', 'flat_velocity', flat.label, flat, o.flat_velocity, 'vel') + '</div>';
    h += optRow(vel.label, HELP.out_velocity, vel.help, velCtl);
    h += '<div class="opt-pair">' +
      optRow(min.label, HELP.min_note_ms, min.help, rangeHTML('out', 'min_note_ms', min.label, min, o.min_note_ms, 'ms')) +
      optRow(tempo.label, HELP.tempo, tempo.help, numHTML('out', 'tempo', tempo.label, tempo, o.tempo)) + '</div>';
    return h;
  }

  function syncRanges() {
    qsa('input[type=range]').forEach(function (r) {
      var min = +r.min, max = +r.max;
      r.style.setProperty('--fill', ((+r.value - min) / (max - min) * 100) + '%');
    });
  }

  function setOption(scope, key, value, opts) {
    opts = opts || {};
    if (scope === 'engine') S.set.engine = value;
    else if (scope === 'eng') S.set.eng[key] = value;
    else S.set.out[key] = value;
    if (scope !== 'out' && S.preset !== 'custom') S.preset = matchPreset() || 'custom';
    if (scope === 'out' && S.hasResult) { applyOutput(); toastOnce('MIDI updated'); }
    if (!opts.noRender) rerenderKeepingFocus();
  }
  var toastOnceTimer = 0;
  function toastOnce(msg) { clearTimeout(toastOnceTimer); toastOnceTimer = setTimeout(function () { toast(msg); }, 350); }

  function rerenderKeepingFocus() {
    var a = document.activeElement, sel = null;
    if (a && a.getAttribute) {
      if (a.hasAttribute('data-key')) {
        sel = '[data-scope="' + a.getAttribute('data-scope') + '"][data-key="' + a.getAttribute('data-key') + '"]' +
          (a.hasAttribute('data-value') ? '[data-value="' + a.getAttribute('data-value') + '"]' : '') +
          (a.hasAttribute('data-step') ? '[data-step="' + a.getAttribute('data-step') + '"]' : '') +
          (a.hasAttribute('data-num') ? '[data-num]' : '') + (a.type === 'range' ? '[type=range]' : '');
      } else if (a.hasAttribute('data-more')) sel = '[data-more]';
      else if (a.hasAttribute('data-ci')) sel = '[data-ci="' + a.getAttribute('data-ci') + '"]';
    }
    var inDrawer = a && a.closest && !!a.closest('#drawer');
    var inContents = a && a.closest && !!a.closest('#contentsList');
    render();
    if (sel) {
      var root = inDrawer ? $('drawer') : inContents ? $('contentsList') : $('stage');
      var el = root.querySelector(sel);
      if (el) el.focus({ preventScroll: true });
    }
  }

  /* ---------- drawer ---------- */
  var drawerOpener = null;
  function renderDrawer() {
    $('drEngineOptions').innerHTML = engineOptionsHTML('dr');
    $('drOutputOptions').innerHTML = outputOptionsHTML('dr');
    var showRe = S.hasResult && S.step === 4;
    $('reconvertBtn').hidden = !showRe;
    $('drEngineNote').textContent = showRe ? 'Changes here need a new conversion.' : 'Used for the next conversion.';
    syncRanges();
  }
  function openDrawer() {
    drawerOpener = document.activeElement;
    renderDrawer();
    var d = $('drawer');
    $('scrim').hidden = false;
    d.removeAttribute('inert');
    d.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function () { d.classList.add('open'); });
    setTimeout(function () { $('closeDrawer').focus(); }, 60);
  }
  function closeDrawer() {
    var d = $('drawer');
    d.classList.remove('open');
    d.setAttribute('inert', '');
    d.setAttribute('aria-hidden', 'true');
    $('scrim').hidden = true;
    if (drawerOpener && document.body.contains(drawerOpener)) drawerOpener.focus();
  }

  function resetDefaults() {
    S.set = clone(DEFAULTS);
    if (S.preset !== 'custom') S.preset = 'best';
    if (S.hasResult) applyOutput();
    render();
    toast('Settings reset to the defaults');
  }

  /* ---------- step 3: progress ---------- */
  var STAGE_DESC = {
    decode: 'Opens your file and prepares the sound.',
    transkun: 'Listens for every note and pedal press.',
    aria: 'A second AI double-checks notes Transkun was unsure about.',
    aria_solo: 'Listens for every note and the sustain pedal.',
    fuse: 'Combines everything and writes your MIDI file.',
    write: 'Writes your MIDI file.'
  };
  function stagePlan() {
    var e = S.set.engine, v = VIEWS_N[S.set.eng.views];
    var p = [{ id: 'decode', label: 'Read audio', a: 0, b: 0.04 }];
    if (e === 'ensemble') {
      p.push({ id: 'transkun', label: 'Transkun V2 · ' + v + ' view' + (v > 1 ? 's' : ''), a: 0.04, b: 0.82, windows: true });
      p.push({ id: 'aria', label: 'Aria-AMT second opinion', a: 0.82, b: 0.95 });
      p.push({ id: 'fuse', label: 'Merge + write MIDI', a: 0.95, b: 1 });
    } else if (e === 'transkun') {
      p.push({ id: 'transkun', label: 'Transkun V2 · ' + v + ' view' + (v > 1 ? 's' : ''), a: 0.04, b: 0.95, windows: true });
      p.push({ id: 'write', label: 'Write MIDI', a: 0.95, b: 1 });
    } else {
      p.push({ id: 'aria_solo', label: 'Aria-AMT', a: 0.04, b: 0.95, windows: true });
      p.push({ id: 'write', label: 'Write MIDI', a: 0.95, b: 1 });
    }
    return p;
  }
  var WINDOWS = M.progress.windows || 9;
  function progressState(p) {
    var plan = stagePlan(), cur = plan[plan.length - 1];
    for (var i = 0; i < plan.length; i++) { if (p < plan[i].b) { cur = plan[i]; break; } }
    var win = 0, msg;
    if (cur.windows) {
      win = Math.min(WINDOWS, Math.max(1, Math.ceil((p - cur.a) / (cur.b - cur.a) * WINDOWS)));
      msg = 'Transcribing window ' + win + ' of ' + WINDOWS;
    } else if (cur.id === 'decode') msg = 'Reading audio';
    else if (cur.id === 'aria') msg = 'Getting a second opinion from Aria-AMT';
    else msg = 'Writing the MIDI file';
    var winDone = cur.windows ? win - 1 : (plan.indexOf(cur) > 1 || cur.id === 'aria' || cur.id === 'fuse' || cur.id === 'write' ? WINDOWS : 0);
    return { plan: plan, cur: cur, win: win, winDone: winDone, msg: msg };
  }
  function etaSeconds() {
    if (S.staticProgress) return M.progress.eta_seconds;
    var total = estNow() * 2.2;
    return Math.max(1, Math.round((1 - S.progress) * total));
  }

  function renderProgress() {
    var p = S.progress, st = progressState(p);
    var pct = Math.round(p * 100);
    var msg = S.staticProgress ? M.progress.message : st.msg;
    var win = S.staticProgress ? M.progress.window : st.win;
    var winDone = S.staticProgress ? M.progress.window - 1 : st.winDone;
    $('cvPct').textContent = pct + '%';
    $('cvMsg').textContent = msg;
    var eta = etaSeconds();
    $('cvEta').textContent = p >= 0.995 ? 'Finishing up' : eta <= 2 ? 'Almost done' : 'About ' + eta + ' s left';
    $('cvBar').setAttribute('aria-valuenow', pct);
    $('cvBarFill').style.width = pct + '%';
    $('cvWinCount').textContent = winDone >= WINDOWS ? 'All ' + WINDOWS + ' windows done' : winDone + ' of ' + WINDOWS + ' done';
    bindText('presetLine', PRESET_NAME[S.preset] + ' · ' + settingsLine());
    var curIdx = st.plan.indexOf(st.cur);
    $('stages').innerHTML = st.plan.map(function (s, i) {
      var state = i < curIdx ? 'done' : i === curIdx ? 'active' : 'pending';
      var meta = '';
      if (state === 'active' && s.windows) meta = 'window ' + win + ' of ' + WINDOWS;
      else if (state === 'active') meta = 'now';
      else if (state === 'done' && s.id === 'decode') meta = '0.4 s';
      else if (state === 'done') meta = 'done';
      var desc = STAGE_DESC[s.id];
      if (s.id === 'transkun') desc = 'Listens for every note and pedal press, from ' + VIEWS_N[S.set.eng.views] + ' angle' + (VIEWS_N[S.set.eng.views] > 1 ? 's' : '') + '.';
      return '<li class="stage-i ' + state + '"><span class="sg-dot" aria-hidden="true">' + (state === 'done' ? IC.check : (i + 1)) + '</span>' +
        '<div><div class="sg-title">' + esc(s.label) + (meta ? '<span class="sg-meta">' + esc(meta) + '</span>' : '') + '</div>' +
        '<p class="sg-desc">' + esc(desc) + '</p></div>' +
        '<span class="sr-only">' + (state === 'done' ? 'Done' : state === 'active' ? 'In progress' : 'Not started') + '</span></li>';
    }).join('');
    drawWave(winDone, win, st.cur.windows || S.staticProgress);
  }

  function drawWave(done, cur, inWindows) {
    var box = $('wave'), cv = $('waveCanvas');
    var w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var peaks = M.waveform.peak, rms = M.waveform.rms, n = peaks.length;
    var segW = w / WINDOWS;
    // current window highlight
    if (inWindows && cur >= 1 && done < WINDOWS) {
      ctx.fillStyle = 'rgba(14,122,104,0.10)';
      ctx.fillRect((cur - 1) * segW, 0, segW, h);
      ctx.fillStyle = 'rgba(14,122,104,0.9)';
      ctx.fillRect((cur - 1) * segW, h - 3, segW, 3);
    }
    var band = 18, top = band + 4, bottom = h - 6;
    var bar = 3, gap = 1.5, mid = (top + bottom) / 2, half = (bottom - top) / 2;
    for (var x = 0; x < w; x += bar + gap) {
      var i0 = Math.floor(x / w * n), i1 = Math.max(i0 + 1, Math.floor((x + bar) / w * n));
      var pk = 0, rm = 0;
      for (var i = i0; i < i1 && i < n; i++) { pk = Math.max(pk, peaks[i]); rm = Math.max(rm, rms[i]); }
      var amp = Math.max(1, Math.min(1, pk * 1.5) * half);
      var seg = Math.floor(x / segW);
      var col = seg < done ? '#0e7a68' : (inWindows && seg === cur - 1 && done < WINDOWS) ? '#3fa58f' : '#cbc6b8';
      ctx.fillStyle = col;
      ctx.fillRect(x, mid - amp, bar, amp * 2);
    }
    // window separators
    ctx.fillStyle = 'rgba(24,32,30,0.12)';
    for (var k = 1; k < WINDOWS; k++) ctx.fillRect(Math.round(k * segW), 0, 1, h);
    ctx.fillStyle = 'rgba(24,32,30,0.08)';
    ctx.fillRect(0, band, w, 1);
    // window numbers
    ctx.font = '600 10.5px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var j = 0; j < WINDOWS; j++) {
      ctx.fillStyle = j < done ? '#0a5a4c' : (inWindows && j === cur - 1) ? '#0a5a4c' : '#6b7672';
      ctx.fillText(String(j + 1), (j + 0.5) * segW, 4);
    }
  }

  var convRaf = 0, convStart = 0, CONV_MS = 3200;
  function startConversion() {
    if (S.playing) pause();
    S.converting = true; S.staticProgress = false; S.progress = 0;
    S.hasResult = false; S.saved = false;
    S.maxStep = 3;
    go(3);
    convStart = performance.now();
    cancelAnimationFrame(convRaf);
    var tick = function (now) {
      var t = Math.min(1, (now - convStart) / CONV_MS);
      // ease: a little slower at the start (reading) and the end (writing)
      var ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      S.progress = Math.max(0, Math.min(1, 0.7 * ease + 0.3 * t));
      renderProgress(); renderStepper();
      if (t < 1) convRaf = requestAnimationFrame(tick);
      else setTimeout(finishConversion, 380);
    };
    convRaf = requestAnimationFrame(tick);
  }
  function finishConversion() {
    if (!S.converting) return;
    S.converting = false;
    S.hasResult = true;
    S.resultEngine = S.set.engine;
    S.resultSeconds = S.set.engine === 'ensemble' && S.set.eng.views === 'channels' ? M.job.stats.seconds_total : +(estNow() * 0.95).toFixed(1);
    S.time = 0;
    S.maxStep = 4;
    go(4);
  }
  function cancelConversion() {
    cancelAnimationFrame(convRaf);
    S.converting = false; S.staticProgress = false; S.progress = 0;
    S.maxStep = 2;
    go(2);
    toast('Conversion cancelled. Nothing was saved.');
  }

  /* ---------- step 4: review ---------- */
  var roll = null;
  function derived() {
    var o = S.set.out;
    var notes = M.notes.map(function (n) { return n.slice(); });
    if (o.min_note_ms > 0) notes = notes.filter(function (n) { return (n[1] - n[0]) * 1000 >= o.min_note_ms; });
    if (o.velocity === 'flat') notes.forEach(function (n) { n[3] = o.flat_velocity; });
    var pedals = M.pedals.slice();
    if (o.pedal === 'extend') { notes.forEach(function (n) { n[1] = n[4] || n[1]; }); pedals = pedals.filter(function (p) { return p[2] !== 64; }); }
    else if (o.pedal === 'none') { notes.forEach(function (n) { n[4] = n[1]; }); pedals = pedals.filter(function (p) { return p[2] !== 64; }); }
    if (!o.soft_pedal) pedals = pedals.filter(function (p) { return p[2] !== 67; });
    return { notes: notes, pedals: pedals, duration: M.duration };
  }
  function counts() {
    var d = derived();
    var lo = 127, hi = 1;
    d.notes.forEach(function (n) { lo = Math.min(lo, n[3]); hi = Math.max(hi, n[3]); });
    return {
      velLo: d.notes.length ? lo : 0, velHi: d.notes.length ? hi : 0,
      notes: d.notes.length,
      sustain: M.pedals.filter(function (p) { return p[2] === 64; }).length,
      soft: M.pedals.filter(function (p) { return p[2] === 67; }).length
    };
  }
  function applyOutput() {
    if (roll) roll.setData(derived(), { keepView: true });
    if (roll) roll.setTime(S.time, S.playing);
    if (S.step === 4) renderReviewText();
  }

  function renderReview() {
    if (!roll) {
      roll = new R.PianoRoll($('roll'), {
        onSeek: function (t) { S.time = t; roll.setTime(t, S.playing); updateTime(); }
      });
      roll.setData(derived());
    } else {
      roll.setData(derived(), { keepView: true });
    }
    roll.setTime(S.time, S.playing);
    renderReviewText();
    renderMix();
    updateTime();
  }

  function renderReviewText() {
    var c = counts(), o = S.set.out;
    $('stNotes').textContent = c.notes.toLocaleString('en-US');
    $('stPedals').textContent = o.pedal === 'cc' ? c.sustain + ' pedal presses' : o.pedal === 'extend' ? 'pedal baked in' : 'no pedal';
    $('stEngine').textContent = SHORT_ENGINE[S.resultEngine];
    $('stTime').textContent = S.resultSeconds + ' s';
    $('stDuration').textContent = R.fmtTime(M.duration);
    $('resultPill').title = 'Converted in ' + S.resultSeconds + ' s on your ' + DEVICE.name;

    var flat = outOpt('flat_velocity');
    var h = '';
    // Notes
    h += '<div class="ci" title="' + esc(outOpt('min_note_ms').help) + '"><div class="ci-head"><span class="ci-ic" aria-hidden="true">' + IC.notes + '</span><b>Notes</b>' +
      '<span class="ci-count">' + c.notes.toLocaleString('en-US') + '</span></div>' +
      '<p class="ci-desc">' + (o.min_note_ms > 0 ? 'Notes under ' + o.min_note_ms + ' ms are left out.' : 'Pitch, timing and length of every key.') + '</p></div>';
    // Velocities
    var velCtl = segHTML('out', 'velocity', 'Dynamics', [{ value: 'played', label: 'As played' }, { value: 'flat', label: 'All the same' }], o.velocity);
    if (o.velocity === 'flat') velCtl += '<div class="flat-inline" title="' + esc(flat.help) + '"><span class="opt-label">Loudness</span>' + rangeHTML('out', 'flat_velocity', flat.label, flat, o.flat_velocity, 'vel') + '</div>';
    h += '<div class="ci" title="' + esc(outOpt('velocity').help) + '"><div class="ci-head"><span class="ci-ic vel" aria-hidden="true">' + IC.vel + '</span><b>Velocities</b>' +
      '<span class="ci-count" title="MIDI velocity runs from 1 (softest) to 127 (loudest)">' + (o.velocity === 'flat' ? 'all ' + o.flat_velocity : c.velLo + ' to ' + c.velHi) + '</span></div>' +
      '<p class="ci-desc">How hard each key was struck: 1 to 127.</p>' +
      '<div class="ci-ctl">' + velCtl + '</div></div>';
    // Sustain pedal
    h += '<div class="ci" title="' + esc(outOpt('pedal').help) + '"><div class="ci-head"><span class="ci-ic ped" aria-hidden="true">' + IC.pedal + '</span><b>Sustain pedal</b>' +
      '<span class="ci-count">' + c.sustain + ' presses</span></div>' +
      '<p class="ci-desc">' + (o.pedal === 'cc' ? 'The right pedal: the orange lane.' : o.pedal === 'extend' ? 'Baked into note lengths instead.' : 'Left out of the file.') + '</p>' +
      '<div class="ci-ctl">' + segHTML('out', 'pedal', 'Sustain pedal', [{ value: 'cc', label: 'Keep as pedal' }, { value: 'extend', label: 'Bake into notes' }, { value: 'none', label: 'Leave out' }], o.pedal) + '</div></div>';
    // Soft pedal
    h += '<div class="ci" title="' + esc(outOpt('soft_pedal').help) + '"><div class="ci-head"><span class="ci-ic soft" aria-hidden="true">' + IC.soft + '</span><b>Soft pedal</b>' +
      switchHTML('out', 'soft_pedal', 'Include soft pedal', o.soft_pedal) + '</div>' +
      '<p class="ci-desc">' + (o.soft_pedal
        ? 'The left pedal, pressed ' + c.soft + ' times: the thin line under the orange lane.'
        : 'The left pedal (' + c.soft + ' presses) is left out of the file.') + '</p></div>';
    // More
    h += '<div class="ci-more"><span>Tempo ' + o.tempo + ' BPM · ' + (o.min_note_ms ? 'notes from ' + o.min_note_ms + ' ms' : 'all notes kept') + '</span>' +
      '<button class="link-btn" type="button" data-action="advanced" data-ci="more">More settings</button></div>';
    $('contentsList').innerHTML = h;
    syncRanges();
    renderFooter();
    renderStepper();
  }
  function segHTML(scope, key, label, choices, value) {
    return '<div class="seg" role="radiogroup" aria-label="' + esc(label) + '">' + choices.map(function (c) {
      var on = String(c.value) === String(value);
      return '<button type="button" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-scope="' + scope + '" data-key="' + key + '" data-value="' + esc(c.value) + '">' + esc(c.label) + '</button>';
    }).join('') + '</div>';
  }

  var MIX_HINT = {
    original: 'You hear: your recording only',
    both: 'You hear: recording and MIDI together',
    midi: 'You hear: the MIDI file only'
  };
  function renderMix() {
    qsa('#mixSeg button').forEach(function (b) {
      var on = b.getAttribute('data-mix') === S.mix;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('roll').classList.toggle('mix-original', S.mix === 'original');
    $('mixHint').textContent = MIX_HINT[S.mix];
  }

  function updateTime() {
    $('timeLabel').textContent = R.fmtTime(S.time) + ' / ' + R.fmtTime(M.duration);
  }
  var playRaf = 0, lastT = 0;
  function play() {
    if (S.time >= M.duration - 0.05) S.time = 0;
    S.playing = true;
    $('playBtn').classList.add('playing');
    $('playBtn').setAttribute('aria-label', 'Pause');
    lastT = performance.now();
    var loop = function (now) {
      if (!S.playing) return;
      S.time += (now - lastT) / 1000; lastT = now;
      if (S.time >= M.duration) { S.time = M.duration; pause(); }
      if (roll) roll.setTime(S.time, S.playing);
      updateTime();
      if (S.playing) playRaf = requestAnimationFrame(loop);
    };
    playRaf = requestAnimationFrame(loop);
  }
  function pause() {
    S.playing = false;
    cancelAnimationFrame(playRaf);
    $('playBtn').classList.remove('playing');
    $('playBtn').setAttribute('aria-label', 'Play');
    if (roll) roll.setTime(S.time, false);
  }

  function save() {
    S.saved = true;
    renderFooter(); renderStepper();
    toast('Saved “' + midiName() + '”', { label: 'Show in folder', run: function () { toast('Opened Music › MIDI Converter in File Explorer'); } });
  }

  /* ------------------------------------------------------------------ events */
  function bind() {
    $('dropzone').addEventListener('click', pickFile);
    // Drag and drop over the whole window on step 1
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { if (S.step === 1) { e.preventDefault(); $('dropzone').classList.add('drag'); } });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        $('dropzone').classList.remove('drag');
        if (ev === 'drop' && S.step === 1) pickFile();
      });
    });

    $('brandHome').addEventListener('click', function (e) { e.preventDefault(); if (!S.converting) newFile(); });
    $('openAdvanced').addEventListener('click', openDrawer);
    $('closeDrawer').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('reconvertBtn').addEventListener('click', function () { closeDrawer(); startConversion(); });
    $('skipQuality').addEventListener('change', function (e) {
      S.skipQuality = e.target.checked;
      if (S.skipQuality) toast('Next time, conversion starts as soon as you choose a file.');
    });

    qsa('.st-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = +b.getAttribute('data-goto');
        if (b.disabled) return;
        go(n);
      });
    });

    $('presets').addEventListener('click', function (e) {
      var b = e.target.closest('.preset');
      if (b) choosePreset(b.getAttribute('data-preset'));
    });

    document.addEventListener('click', function (e) {
      var t = e.target;
      var act = t.closest('[data-action]');
      if (act && !act.disabled) {
        var a = act.getAttribute('data-action');
        if (a === 'next') go(2);
        else if (a === 'back') go(S.step === 4 ? 2 : S.step - 1);
        else if (a === 'start') startConversion();
        else if (a === 'cancel') cancelConversion();
        else if (a === 'save') save();
        else if (a === 'new') newFile();
        else if (a === 'advanced') openDrawer();
        else if (a === 'change-file') go(1);
        else if (a === 'reset') resetDefaults();
        else if (a === 'open-folder') toast('Opened Music › MIDI Converter in File Explorer');
        else if (a === 'to-contents') {
          var box = document.querySelector('.contents');
          box.scrollIntoView({ block: 'start', behavior: 'smooth' });
          var first = box.querySelector('[role=radio][aria-checked=true], .switch');
          if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 350);
        }
        return;
      }
      var rec = t.closest('[data-recent]');
      if (rec) { openRecent(+rec.getAttribute('data-recent')); return; }
      var more = t.closest('[data-more]');
      if (more) { S.moreOpen = !S.moreOpen; rerenderKeepingFocus(); return; }
      var ctl = t.closest('[data-key][data-scope]');
      if (!ctl || ctl.tagName === 'INPUT') return;
      var scope = ctl.getAttribute('data-scope'), key = ctl.getAttribute('data-key');
      if (ctl.hasAttribute('data-step')) {
        var o = outOpt(key), cur = +S.set.out[key];
        var v = Math.max(o.min, Math.min(o.max, cur + (+ctl.getAttribute('data-step')) * (o.step || 1)));
        setOption(scope, key, v);
      } else if (ctl.getAttribute('role') === 'switch') {
        var curB = scope === 'eng' ? S.set.eng[key] : S.set.out[key];
        setOption(scope, key, !curB);
      } else if (ctl.hasAttribute('data-value')) {
        setOption(scope, key, ctl.getAttribute('data-value'));
      }
    });

    document.addEventListener('input', function (e) {
      var r = e.target;
      if (r.type !== 'range' || !r.hasAttribute('data-key')) return;
      var key = r.getAttribute('data-key'), v = +r.value;
      S.set.out[key] = v;
      qsa('input[type=range][data-key="' + key + '"]').forEach(function (x) { if (x !== r) x.value = v; });
      qsa('[data-val="' + key + '"]').forEach(function (x) { x.textContent = fmtVal(r.getAttribute('data-fmt'), v); });
      syncRanges();
      if (S.hasResult) { applyOutputSoon(); toastOnce('MIDI updated'); }
    });
    document.addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.hasAttribute || !inp.hasAttribute('data-num')) return;
      var key = inp.getAttribute('data-key'), o = outOpt(key);
      var v = parseInt(inp.value, 10);
      if (isNaN(v)) v = S.set.out[key];
      v = Math.max(o.min, Math.min(o.max, v));
      setOption('out', key, v);
    });

    // Arrow keys move inside radio groups
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) >= 0 && t.getAttribute && t.getAttribute('role') === 'radio') {
        var group = t.closest('[role=radiogroup]');
        if (!group) return;
        var radios = qsa('[role=radio]', group).filter(function (x) { return !x.disabled; });
        var i = radios.indexOf(t);
        var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
        var next = radios[(i + d + radios.length) % radios.length];
        e.preventDefault();
        next.focus();
        next.click();
        var again = group.isConnected ? null : document.querySelector('[data-key="' + next.getAttribute('data-key') + '"][data-value="' + next.getAttribute('data-value') + '"]');
        if (again) again.focus();
        return;
      }
      if (e.key === 'Escape' && $('drawer').classList.contains('open')) { closeDrawer(); return; }
      var typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName);
      var onControl = /BUTTON|A/.test(t.tagName);
      if (e.code === 'Space' && S.step === 4 && !typing && !onControl && !$('drawer').classList.contains('open')) {
        e.preventDefault();
        S.playing ? pause() : play();
      }
    });

    $('playBtn').addEventListener('click', function () { S.playing ? pause() : play(); });
    $('mixSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mix]');
      if (!b) return;
      S.mix = b.getAttribute('data-mix');
      renderMix();
    });
    $('zoomIn').addEventListener('click', function () { if (roll) roll.zoom(1.35); });
    $('zoomOut').addEventListener('click', function () { if (roll) roll.zoom(1 / 1.35); });

    var rz = 0;
    window.addEventListener('resize', function () {
      cancelAnimationFrame(rz);
      rz = requestAnimationFrame(function () { if (S.step === 3) renderProgress(); });
    });
  }
  var applyTimer = 0;
  function applyOutputSoon() { clearTimeout(applyTimer); applyTimer = setTimeout(applyOutput, 60); }

  /* ------------------------------------------------------------------ init */
  function init() {
    qsa('.m-dots').forEach(function (el) {
      var v = +el.getAttribute('data-v'), h = '';
      for (var i = 1; i <= 5; i++) h += '<i' + (i <= v ? ' class="on"' : '') + '></i>';
      el.innerHTML = h;
    });
    $('gpuChip').title = 'Running on ' + DEVICE.name + ' (' + DEVICE.vram_gb + ' GB)';
    $('aboutLine').textContent = M.info.app + ' ' + M.info.version;

    var sw = $('switcher');
    if (CLEAN) sw.hidden = true;
    qsa('a', sw).forEach(function (a) {
      a.href = '?state=' + a.getAttribute('data-state') + (DEBUG ? '&debug=1' : '');
    });

    bind();

    var state = params.get('state') || 'home';
    if (state === 'progress') {
      S.file = FILE; S.converting = true; S.staticProgress = true; S.progress = M.progress.progress;
      S.step = 3; S.maxStep = 3;
    } else if (state === 'result') {
      S.file = FILE; S.hasResult = true; S.step = 4; S.maxStep = 4; S.time = 12;
    } else if (state === 'quality') {
      S.file = FILE; S.step = 2; S.maxStep = 2;
    } else if (state === 'advanced') {
      S.file = FILE; S.preset = 'custom'; S.moreOpen = true; S.step = 2; S.maxStep = 2;
    } else {
      S.step = 1;
    }
    render();
    if (params.get('drawer') === '1') openDrawer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
