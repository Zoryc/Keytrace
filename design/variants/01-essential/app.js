// MIDI Converter — "Essential" prototype. Classic script, no network, mock data only.
(function () {
  'use strict';

  var M = window.MOCK;
  var R = window.MCRoll;
  var params = new URLSearchParams(location.search);
  if (params.get('clean') === '1') document.body.classList.add('clean');

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var stem = function (name) { return String(name).replace(/\.[^.]+$/, ''); };
  var ext = function (name) { var m = /\.([^.]+)$/.exec(name); return m ? m[1].toUpperCase() : ''; };
  var fmt = R.fmtTime;

  // ------------------------------------------------------------------ schema + state
  var piano = M.info.instruments[0];
  var ENG = {};
  piano.engines.forEach(function (e) { ENG[e.id] = e; });
  var OUT = {};
  M.info.output_options.forEach(function (o) { OUT[o.key] = o; });
  var SHORT_ENGINE = { ensemble: 'Ensemble', transkun: 'Transkun V2', aria: 'Aria-AMT' };

  function engOpt(engineId, key) {
    return (ENG[engineId].options || []).filter(function (o) { return o.key === key; })[0];
  }

  function defaults() {
    var s = { engine: piano.default_engine, eng: {}, out: {} };
    piano.engines.forEach(function (e) {
      s.eng[e.id] = {};
      e.options.forEach(function (o) { s.eng[e.id][o.key] = o.default; });
    });
    M.info.output_options.forEach(function (o) { s.out[o.key] = o.default; });
    return s;
  }

  var S = defaults();
  var view = 'home';
  var ctx = { file: M.job.filename, duration: M.job.stats.duration, seconds: M.job.stats.seconds_total, engine: M.job.engine, listenKey: null };
  var more = false;        // "More settings" expanded
  var tkOpen = false;      // Transkun sub-group open
  var lastOpener = null;

  // Plain-language labels. Technical names stay available as titles and secondary text.
  var LABEL = {
    views: { none: 'Single', channels: 'Stereo 4×', full: 'Stereo + tone 6×' },
    viewsSummary: { none: 'Single view', channels: 'Stereo views 4×', full: 'Stereo + tone views 6×' },
    rescue: { '0.1': 'Generous', '0.3': 'Balanced', '0.5': 'Cautious' },
    tkvel: { mode: 'Most likely', mean: 'Average', median: 'Median' },
    pedal: { cc: 'Keep as pedal', extend: 'Bake into notes', none: 'Remove' },
    dyn: { played: 'As played', flat: 'Even' }
  };
  var HELP = {
    quality: {
      ensemble: 'The most accurate result. About 20–25 seconds for a 2-minute piece on your graphics card.',
      transkun: 'About 4× quicker and almost as accurate. Good for long recordings.',
      aria: 'Using Aria-AMT on its own, chosen under More settings.'
    },
    engine: {
      ensemble: 'Transkun V2 writes, Aria-AMT double-checks.',
      transkun: 'About 4× faster and almost as accurate.',
      aria: 'On its own, for comparison.'
    },
    pedal: {
      cc: 'Writes the sustain pedal as pedal events (CC64). The most faithful choice.',
      extend: 'Lengthens the notes instead, for apps that ignore the pedal.',
      none: 'Leaves the sustain pedal out of the file.'
    },
    dyn: {
      played: 'Keeps how hard each key was struck.',
      flat: 'Gives every note the same loudness.'
    },
    views: 'More views take longer but catch more detail. Stereo 4× measured best.',
    rescue: 'How readily notes only Aria heard are added. Balanced measured best.',
    tkvel: 'How each note’s loudness is read from the model.',
    merge_fix: 'Keeps long sustain-pedal presses from being cut or dropped.',
    soft_pedal: 'Include una corda pedal events (CC67).',
    flat_velocity: 'The loudness every note gets, from 1 to 127.',
    min_note_ms: 'Drops notes shorter than this. Off keeps everything.',
    tempo: 'Only changes how bars line up in a DAW or notation app. Notes keep their real timing.'
  };

  function listenKey() { return JSON.stringify([S.engine, S.eng[S.engine]]); }

  // ------------------------------------------------------------------ icons
  var IC = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chevR: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8v4h-4"/><path d="M18.6 12A7 7 0 1 1 16.5 6.6"/></svg>'
  };
  function ringIcon(p) {
    var r = 14, c = 2 * Math.PI * r;
    return '<svg viewBox="0 0 34 34" aria-hidden="true"><circle class="trk" cx="17" cy="17" r="' + r + '"/>' +
      '<circle class="val" cx="17" cy="17" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - p)).toFixed(2) +
      '" transform="rotate(-90 17 17)"/></svg>';
  }

  // ------------------------------------------------------------------ home
  function renderSummary() {
    var e = S.engine;
    var q = e === 'ensemble' ? 'Best quality' : e === 'transkun' ? 'Faster' : 'Comparison';
    var parts = ['<b class="q">' + q + '</b>', SHORT_ENGINE[e]];
    var v = S.eng[e].views;
    if (v) parts.push(LABEL.viewsSummary[v]);
    $('engineSum').innerHTML = parts.join('<span class="dot" aria-hidden="true">·</span>');
    $('engineSum').title = ENG[e].name;
  }

  function renderRecent() {
    $('recentMore').textContent = 'Show all ' + M.recent.length;
    $('recentList').innerHTML = M.recent.map(function (j) {
      var icon, meta;
      var kind = ext(j.filename);
      if (j.status === 'done') {
        icon = '<span class="ri-icon done">' + IC.check + '</span>';
        meta = [kind, fmt(j.duration), j.notes.toLocaleString('en-US') + ' notes', j.when].join(' · ');
      } else if (j.status === 'running') {
        icon = '<span class="ri-icon running">' + ringIcon(j.progress) + '</span>';
        meta = '<span class="live">Converting · ' + Math.round(j.progress * 100) + '%</span> · ' + fmt(j.duration) + ' long';
      } else if (j.status === 'queued') {
        icon = '<span class="ri-icon queued">' + IC.clock + '</span>';
        meta = 'Waiting · up next · ' + fmt(j.duration) + ' long';
      } else {
        icon = '<span class="ri-icon error">' + IC.alert + '</span>';
        meta = 'Couldn’t convert: ' + esc(j.error || 'unknown error');
      }
      return '<li><button type="button" class="recent-item" data-id="' + j.id + '" title="' + esc(j.filename) + '">' + icon +
        '<span class="ri-text"><span class="ri-name">' + esc(stem(j.filename)) + '</span>' +
        '<span class="ri-meta' + (j.status === 'error' ? ' err' : '') + '">' + meta + '</span></span></button></li>';
    }).join('');
  }

  // ------------------------------------------------------------------ progress
  var CIRC = 2 * Math.PI * 108;
  $('ringFill').style.strokeDasharray = CIRC.toFixed(2);
  var progTimer = 0;

  var PLAIN = {
    decode: 'Reading your recording…',
    transkun: 'Listening to your recording…',
    aria: 'Double-checking the tricky notes…',
    fuse: 'Writing your MIDI file…'
  };

  function stagesFor(engine) {
    var views = S.eng[engine].views;
    var vlabel = views === 'none' ? '1 view' : views === 'full' ? '6 views' : '4 views';
    if (engine === 'transkun') return [
      { id: 'decode', label: 'Read audio' }, { id: 'transkun', label: 'Transkun V2 · ' + vlabel }, { id: 'fuse', label: 'Write MIDI' }];
    if (engine === 'aria') return [
      { id: 'decode', label: 'Read audio' }, { id: 'aria', label: 'Aria-AMT' }, { id: 'fuse', label: 'Write MIDI' }];
    return M.progress.stages.map(function (s) { return { id: s.id, label: s.id === 'transkun' ? 'Transkun V2 · ' + vlabel : s.label }; });
  }

  // Maps overall progress to a stage + window, the way the real pipeline reports it.
  function stageAt(p, engine) {
    var W = M.progress.windows;
    if (engine === 'ensemble') {
      if (p < 0.05) return { id: 'decode' };
      if (p < 0.80) return { id: 'transkun', win: Math.min(W, Math.max(1, Math.ceil((p - 0.05) / 0.75 * W))) };
      if (p < 0.94) return { id: 'aria' };
      return { id: 'fuse' };
    }
    if (p < 0.06) return { id: 'decode' };
    if (p < 0.94) return { id: engine === 'aria' ? 'aria' : 'transkun', win: Math.min(W, Math.max(1, Math.ceil((p - 0.06) / 0.88 * W))) };
    return { id: 'fuse' };
  }

  function renderProgress(o) {
    // o: {file, p, eta, engine, waiting, message}
    var ring = $('ring');
    ring.classList.toggle('waiting', !!o.waiting);
    $('progFile').textContent = o.file;
    $('progFile').title = o.file;
    var list = stagesFor(o.engine);
    if (o.waiting) {
      $('pct').textContent = 'Up next';
      ring.querySelector('small').hidden = true;
      $('ringFill').style.strokeDashoffset = (CIRC * 0.82).toFixed(2);
      ring.setAttribute('aria-valuetext', 'Waiting');
      $('progTitle').textContent = 'Waiting for the converter…';
      $('progEta').textContent = 'Starts when the current conversion finishes';
      $('progDetail').textContent = '1 conversion ahead';
      $('stages').innerHTML = list.map(function (s) {
        return '<li class="stage"><span class="st-ic"></span>' + esc(s.label) + '</li>';
      }).join('');
      return;
    }
    ring.querySelector('small').hidden = false;
    var pct = Math.round(o.p * 100);
    $('pct').textContent = pct;
    $('ringFill').style.strokeDashoffset = (CIRC * (1 - o.p)).toFixed(2);
    ring.setAttribute('aria-valuenow', pct);
    ring.removeAttribute('aria-valuetext');
    var st = stageAt(o.p, o.engine);
    $('progTitle').textContent = PLAIN[st.id];
    var eta = o.eta != null ? o.eta : Math.round((1 - o.p) * 26);
    $('progEta').textContent = eta <= 2 ? 'Almost done' : 'About ' + eta + ' seconds left';
    var detail = o.message || (st.id === 'decode' ? 'Reading audio' : st.win ? 'Transcribing window ' + st.win + ' of ' + M.progress.windows :
      st.id === 'aria' ? 'Comparing with Aria-AMT' : 'Merging notes and writing the file');
    $('progDetail').textContent = detail;
    var idx = list.map(function (s) { return s.id; }).indexOf(st.id);
    $('stages').innerHTML = list.map(function (s, i) {
      var cls = i < idx ? 'done' : i === idx ? 'active' : '';
      return '<li class="stage ' + cls + '"' + (i === idx ? ' aria-current="step"' : '') + '><span class="st-ic">' + (i < idx ? IC.check : '') + '</span>' + esc(s.label) + '</li>';
    }).join('');
  }

  function startConversion(fileName) {
    stopPlayback();
    clearInterval(progTimer);
    var engine = S.engine;
    var total = 3100, t0 = performance.now();
    show('progress');
    renderProgress({ file: fileName, p: 0, engine: engine });
    progTimer = setInterval(function () {
      var p = Math.min(1, (performance.now() - t0) / total);
      // ease a little so the ring slows near the end like a real job
      var shown = p < 1 ? 1 - Math.pow(1 - p, 1.35) : 1;
      renderProgress({ file: fileName, p: shown, engine: engine });
      if (p >= 1) {
        clearInterval(progTimer);
        setTimeout(function () {
          ctx = {
            file: fileName, duration: M.job.stats.duration, engine: engine, listenKey: listenKey(),
            seconds: engine === 'ensemble' ? M.job.stats.seconds_total : engine === 'transkun' ? 3.4 : 6.9
          };
          openResult(0);
        }, 260);
      }
    }, 50);
  }

  function showStaticProgress(o) {
    clearInterval(progTimer);
    show('progress');
    renderProgress(o);
  }

  // ------------------------------------------------------------------ result
  var roll = new R.PianoRoll($('roll'), { onSeek: function (t) { setTime(t); } });
  var cur = { notes: [], pedals: [] };

  // Hover info in plain words ("A♭4 · soft · held 0.42 s") instead of velocity numbers.
  // Runs after the roll's own pointermove handler, so it only rewrites the text it just set.
  function loudWord(v) { return v < 36 ? 'very soft' : v < 56 ? 'soft' : v < 76 ? 'medium' : v < 96 ? 'loud' : 'very loud'; }
  function plainNote(n) {
    var len = n[1] - n[0];
    var held = len < 0.1 ? 'a quick touch' : 'held ' + (len < 10 ? len.toFixed(len < 1 ? 2 : 1) : Math.round(len)) + ' s';
    var s = R.noteName(n[2]) + (n[2] === 60 ? ' (middle C)' : '') + ' · ' + (S.out.velocity === 'flat' ? 'even' : loudWord(n[3])) + ' · ' + held;
    if ((n[5] == null ? 1 : n[5]) < 0.9) s += ' · not quite sure';
    return s;
  }
  $('roll').querySelectorAll('canvas')[1].addEventListener('pointermove', function () {
    if (roll.hover && !roll.tip.hidden) roll.tip.textContent = plainNote(roll.hover);
  });
  var playT = 0, playing = false, raf = 0, last = 0;

  function derived() {
    var o = S.out;
    var notes = M.notes.map(function (n) { return n.slice(); });
    if (o.min_note_ms > 0) notes = notes.filter(function (n) { return (n[1] - n[0]) * 1000 >= o.min_note_ms; });
    if (o.pedal === 'extend') notes.forEach(function (n) { n[1] = Math.max(n[1], n[4] || n[1]); n[4] = n[1]; });
    else if (o.pedal === 'none') notes.forEach(function (n) { n[4] = n[1]; });
    if (o.velocity === 'flat') notes.forEach(function (n) { n[3] = o.flat_velocity; });
    var pedals = M.pedals.filter(function (p) { return p[2] === 64 ? o.pedal === 'cc' : o.soft_pedal; });
    return { notes: notes, pedals: pedals };
  }

  function renderStats() {
    var o = S.out;
    var dot = '<span class="dot" aria-hidden="true">·</span>';
    var sustain = cur.pedals.filter(function (p) { return p[2] === 64; }).length;
    var pedalText = o.pedal === 'cc' ? sustain + ' pedal presses' : o.pedal === 'extend' ? 'pedal baked into notes' : 'no pedal';
    var parts = [
      fmt(ctx.duration) + ' long',
      '<b>' + cur.notes.length.toLocaleString('en-US') + '</b> notes',
      pedalText,
      SHORT_ENGINE[ctx.engine],
      'converted in ' + ctx.seconds.toFixed(1) + ' s'
    ];
    $('resStats').innerHTML = parts.join(dot);
  }

  function applyOutput(keepView) {
    cur = derived();
    roll.setData({ notes: cur.notes, pedals: cur.pedals, duration: M.duration }, { keepView: !!keepView });
    roll.setTime(playT, playing);
    renderStats();
  }

  function openResult(t) {
    clearInterval(progTimer);
    show('result');
    $('resTitle').textContent = stem(ctx.file);
    $('resTitle').title = ctx.file;
    playT = t || 0;
    applyOutput(false);
    setTime(playT);
    resetSave();
  }

  function setTime(t) {
    playT = Math.max(0, Math.min(ctx.duration, t));
    roll.setTime(playT, playing);
    $('time').textContent = fmt(playT) + ' / ' + fmt(ctx.duration);
  }

  function tick() {
    if (!playing) return;
    var now = performance.now();
    var dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
    last = now;
    var t = playT + dt;
    if (t >= ctx.duration) { setTime(ctx.duration); stopPlayback(); return; }
    setTime(t);
  }
  function startPlayback() {
    if (playT >= ctx.duration - 0.05) playT = 0;
    playing = true;
    last = performance.now();
    $('playBtn').classList.add('playing');
    $('playBtn').setAttribute('aria-pressed', 'true');
    $('playLabel').textContent = 'Pause';
    clearInterval(raf);
    raf = setInterval(tick, 16);
  }
  function stopPlayback() {
    playing = false;
    clearInterval(raf);
    $('playBtn').classList.remove('playing');
    $('playBtn').setAttribute('aria-pressed', 'false');
    $('playLabel').textContent = 'Play preview';
    roll.setTime(playT, false);
  }
  $('playBtn').addEventListener('click', function () { playing ? stopPlayback() : startPlayback(); });

  var MIX_NOTE = { original: '#9db8b1', both: '', midi: '' };
  function setMix(mix) {
    Array.prototype.forEach.call($('mix').children, function (b) {
      var on = b.dataset.mix === mix;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    // In "Original" the MIDI is muted, so its notes are drawn quieter.
    var root = document.documentElement.style;
    if (MIX_NOTE[mix]) { root.setProperty('--note', MIX_NOTE[mix]); root.setProperty('--note-tail', 'rgba(157,184,177,.25)'); }
    else { root.removeProperty('--note'); root.removeProperty('--note-tail'); }
    roll._readColors();
    roll.requestDraw();
  }
  $('mix').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mix]');
    if (b) setMix(b.dataset.mix);
  });

  $('zoomIn').addEventListener('click', function () { roll.zoom(1.4); });
  $('zoomOut').addEventListener('click', function () { roll.zoom(1 / 1.4); });

  var saveTimer = 0;
  function resetSave() {
    clearTimeout(saveTimer);
    $('saveBtn').classList.remove('saved');
    $('saveLabel').textContent = 'Save MIDI';
  }
  $('saveBtn').addEventListener('click', function () {
    var name = stem(ctx.file) + '.mid';
    $('saveBtn').classList.add('saved');
    $('saveLabel').textContent = 'Saved';
    toast('Saved “' + name + '” to Music › MIDI Converter', { label: 'Show in folder', run: function () { toast('Opened Music › MIDI Converter in File Explorer'); } });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(resetSave, 2600);
  });

  $('newBtn').addEventListener('click', function () { goHome(); });

  // ------------------------------------------------------------------ views
  function show(v) {
    view = v;
    $('app').dataset.view = v;
    $('viewHome').hidden = v !== 'home';
    $('viewProgress').hidden = v !== 'progress';
    $('viewResult').hidden = v !== 'result';
    if (v !== 'result') stopPlayback();
    markSwitcher();
  }
  function goHome() {
    clearInterval(progTimer);
    closeDialog(true);
    show('home');
  }

  // ------------------------------------------------------------------ drop target
  var drop = $('drop');
  drop.addEventListener('click', function () { startConversion(M.file.name); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startConversion(M.file.name); }
  });
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; if (view === 'home') document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && (view === 'home' || view === 'result')) startConversion(f.name);
  });

  // instrument menu
  var instBtn = $('instBtn'), instMenu = $('instMenu');
  function setMenu(open) {
    instMenu.hidden = !open;
    instBtn.setAttribute('aria-expanded', String(open));
    if (open) instMenu.querySelector('button').focus();
  }
  instBtn.addEventListener('click', function (e) { e.stopPropagation(); setMenu(instMenu.hidden); });
  instMenu.addEventListener('click', function (e) { e.stopPropagation(); if (e.target.closest('button')) { setMenu(false); instBtn.focus(); } });
  document.addEventListener('click', function () { if (!instMenu.hidden) setMenu(false); });

  $('recentList').addEventListener('click', function (e) {
    var b = e.target.closest('.recent-item');
    if (!b) return;
    var j = M.recent.filter(function (x) { return x.id === b.dataset.id; })[0];
    if (j.status === 'done') {
      ctx = { file: j.filename, duration: j.id === M.job.id ? M.job.stats.duration : M.duration, engine: 'ensemble', listenKey: listenKey(), seconds: M.job.stats.seconds_total };
      openResult(0);
    } else if (j.status === 'running') {
      showStaticProgress({ file: j.filename, p: j.progress, engine: 'ensemble', eta: 58 });
    } else if (j.status === 'queued') {
      showStaticProgress({ file: j.filename, p: 0, engine: 'ensemble', waiting: true });
    } else {
      toast('Couldn’t convert “' + j.filename + '”. ' + (j.error || ''), { label: 'Try another file', run: function () { drop.focus(); } }, 'error');
    }
  });

  $('recentMore').addEventListener('click', function () {
    var r = $('recent');
    var open = !r.classList.contains('expanded');
    r.classList.toggle('expanded', open);
    $('recentMore').setAttribute('aria-expanded', String(open));
    $('recentMore').textContent = open ? 'Show fewer' : 'Show all ' + M.recent.length;
  });

  $('cancelBtn').addEventListener('click', function () {
    goHome();
    toast('Conversion cancelled');
  });
  $('brand').addEventListener('click', function (e) { e.preventDefault(); goHome(); });

  // GPU indicator
  (function () {
    var d = M.info.device;
    var gpu = d.kind === 'gpu';
    $('gpuName').textContent = gpu ? d.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '') : 'CPU only (slow)';
    $('gpu').setAttribute('data-tip', gpu ? 'Converting on your ' + d.name + ' (' + d.vram_gb + ' GB)' : 'No NVIDIA graphics card found, so conversions will be slow');
    $('gpu').setAttribute('aria-label', gpu ? 'Graphics card: ' + d.name : 'No graphics card found');
  })();

  // ------------------------------------------------------------------ options dialog
  var dialog = $('dialog'), body = $('dlgBody');

  function segHTML(path, choices, value, labels, aria, wide) {
    return '<div class="seg' + (wide ? ' wide' : '') + '" role="radiogroup" aria-label="' + esc(aria) + '">' +
      choices.map(function (c) {
        var on = String(c.value) === String(value);
        return '<button type="button" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-set="' + path +
          '" data-val="' + esc(c.value) + '" title="' + esc(c.label) + '">' + esc((labels && labels[c.value]) || c.label) + '</button>';
      }).join('') + '</div>';
  }
  function switchHTML(path, on, labelId) {
    return '<button type="button" class="switch" role="switch" aria-checked="' + !!on + '" aria-labelledby="' + labelId + '" data-toggle="' + path + '"></button>';
  }
  function rangeHTML(path, spec, value, id) {
    var fill = ((value - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + '%';
    return '<input class="range" type="range" id="' + id + '" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step +
      '" value="' + value + '" data-num="' + path + '" style="--fill:' + fill + '">';
  }
  function minLenText(v) { return v > 0 ? v + ' ms' : 'Off'; }

  function qualityChoices() { return [{ value: 'ensemble', label: 'Best' }, { value: 'transkun', label: 'Faster' }]; }

  function reconvertHTML() {
    if (view !== 'result' || listenKey() === ctx.listenKey) return '';
    return '<div class="reconvert"><button type="button" class="btn soft" data-action="reconvert">' + IC.redo +
      'Convert this file again with these settings</button></div>';
  }

  function instantHTML(cls) {
    if (view === 'result') return '<p class="' + cls + '" id="instantNote">' + IC.check + 'Pedal and dynamics changes update this result instantly.</p>';
    return '';
  }

  function renderSimple() {
    var o = S.out;
    var html = '';
    html += '<div class="srow"><h3 id="lbl-q">Quality</h3><div>' +
      segHTML('engine', qualityChoices(), S.engine, null, 'Quality') +
      '<p class="help">' + HELP.quality[S.engine] + '</p>' + reconvertHTML() + '</div></div>';
    html += '<div class="srow"><h3>Pedal</h3><div>' +
      segHTML('out.pedal', OUT.pedal.choices, o.pedal, LABEL.pedal, 'Sustain pedal') +
      '<p class="help">' + HELP.pedal[o.pedal] + '</p></div></div>';
    html += '<div class="srow"><h3>Dynamics</h3><div>' +
      segHTML('out.velocity', OUT.velocity.choices, o.velocity, LABEL.dyn, 'Dynamics') +
      '<p class="help">' + HELP.dyn[o.velocity] + '</p></div></div>';
    html += instantHTML('instant-note');
    return html;
  }

  function engineFields(engineId, path, exclude) {
    // Renders the options an engine exposes (from MOCK.info), in plain words.
    var vals = S.eng[engineId];
    var html = '';
    (ENG[engineId].options || []).forEach(function (opt) {
      if (exclude && exclude.indexOf(opt.key) >= 0) return;
      var id = 'f-' + engineId + '-' + opt.key;
      if (opt.key === 'views') {
        html += '<div class="field"><div class="field-top"><span class="field-label" id="' + id + '">' + esc(opt.label) + '</span></div>' +
          segHTML(path + '.views', opt.choices, vals.views, LABEL.views, opt.label, true) + '<p class="help">' + HELP.views + '</p></div>';
      } else if (opt.key === 'rescue') {
        html += '<div class="field"><div class="field-top"><span class="field-label" id="' + id + '">' + esc(opt.label) + '</span></div>' +
          segHTML(path + '.rescue', opt.choices, vals.rescue, LABEL.rescue, opt.label, true) + '<p class="help">' + HELP.rescue + '</p></div>';
      } else if (opt.key === 'velocity') {
        html += '<div class="field field-inline"><div><span class="field-label" id="' + id + '">' + esc(opt.label) + '</span>' +
          '<p class="help">' + HELP.tkvel + '</p></div>' + segHTML(path + '.velocity', opt.choices, vals.velocity, LABEL.tkvel, opt.label, false) + '</div>';
      } else if (opt.kind === 'bool') {
        html += '<div class="field field-inline"><div><span class="field-label" id="' + id + '">' + esc(opt.label) + '</span>' +
          '<p class="help">' + HELP[opt.key] + '</p></div>' + switchHTML(path + '.' + opt.key, vals[opt.key], id) + '</div>';
      }
    });
    return html;
  }

  function renderFull() {
    var o = S.out;
    var left = '<section class="col" aria-labelledby="colListen"><header class="col-head"><h3 id="colListen">Listening</h3>' +
      '<p>' + (view === 'result' ? 'Used the next time you convert.' : 'Used for your next conversion.') + '</p></header>';
    left += '<div class="field"><div class="field-top"><span class="field-label">Quality <span class="tech">Engine</span></span></div>' +
      '<div class="engines" role="radiogroup" aria-label="Engine">' +
      piano.engines.map(function (e) {
        var on = e.id === S.engine;
        var tag = e.id === 'ensemble' ? 'Best' : e.id === 'transkun' ? 'Faster' : '';
        return '<button type="button" class="engine-opt" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) +
          '" data-set="engine" data-val="' + e.id + '" title="' + esc(e.summary) + '"><span class="radio" aria-hidden="true"></span>' +
          '<span><span class="eng-name">' + esc(e.name) + '</span><span class="eng-desc">' + HELP.engine[e.id] + '</span></span>' +
          (tag ? '<span class="tag">' + tag + '</span>' : '<span></span>') + '</button>';
      }).join('') + '</div></div>';
    if (S.engine === 'aria') left += '<p class="aside-note">Aria-AMT has no extra settings.</p>';
    else left += engineFields(S.engine, 'eng');
    if (S.engine !== 'transkun') {
      left += '<details class="subgroup" id="tkGroup"' + (tkOpen ? ' open' : '') + '><summary>' + IC.chevR +
        'Transkun V2 settings <small>· used when Transkun V2 is the engine</small></summary>' +
        engineFields('transkun', 'tk', ['views']) + '</details>';
    }
    left += reconvertHTML() + '</section>';

    var right = '<section class="col" aria-labelledby="colFile"><header class="col-head"><h3 id="colFile">In the MIDI file</h3>' +
      (view === 'result'
        ? '<p class="instant" id="instantNote">' + IC.check + 'Changes update this result instantly. No need to convert again.</p>'
        : '<p>Applied whenever a MIDI file is written.</p>') + '</header>';
    right += '<div class="field"><div class="field-top"><span class="field-label">Sustain pedal <span class="tech">CC64</span></span></div>' +
      segHTML('out.pedal', OUT.pedal.choices, o.pedal, LABEL.pedal, 'Sustain pedal', true) + '<p class="help">' + HELP.pedal[o.pedal] + '</p></div>';
    right += '<div class="field field-inline"><div><span class="field-label" id="f-soft">Soft pedal <span class="tech">CC67</span></span>' +
      '<p class="help">' + HELP.soft_pedal + '</p></div>' + switchHTML('out.soft_pedal', o.soft_pedal, 'f-soft') + '</div>';
    right += '<div class="field"><div class="field-top"><span class="field-label">Dynamics</span></div>' +
      segHTML('out.velocity', OUT.velocity.choices, o.velocity, LABEL.dyn, 'Dynamics', true) + '<p class="help">' + HELP.dyn[o.velocity] + '</p></div>';
    if (o.velocity === 'flat') {
      right += '<div class="field"><div class="field-top"><label class="field-label" for="f-flat">Flat velocity</label><output id="o-flat" for="f-flat">' + o.flat_velocity + '</output></div>' +
        rangeHTML('out.flat_velocity', OUT.flat_velocity, o.flat_velocity, 'f-flat') + '<p class="help">' + HELP.flat_velocity + '</p></div>';
    }
    right += '<div class="field"><div class="field-top"><label class="field-label" for="f-min">Minimum note length</label><output id="o-min" for="f-min">' + minLenText(o.min_note_ms) + '</output></div>' +
      rangeHTML('out.min_note_ms', OUT.min_note_ms, o.min_note_ms, 'f-min') + '<p class="help">' + HELP.min_note_ms + '</p></div>';
    right += '<div class="field field-inline"><div><label class="field-label" for="f-tempo">MIDI tempo</label><p class="help">' + HELP.tempo + '</p></div>' +
      '<div class="stepper"><button type="button" data-step="-1" aria-label="Lower tempo">' + IC.minus + '</button>' +
      '<input id="f-tempo" type="number" inputmode="numeric" min="' + OUT.tempo.min + '" max="' + OUT.tempo.max + '" value="' + o.tempo + '" data-num="out.tempo">' +
      '<span class="unit">BPM</span><button type="button" data-step="1" aria-label="Raise tempo">' + IC.plus + '</button></div></div>';
    if (view === 'result') right += '<div class="file-now" id="fileNow" aria-live="polite">' + IC.doc + '<p>' + fileNowText() + '</p></div>';
    right += '</section>';
    return '<div class="cols">' + left + right + '</div>';
  }

  // Live, plain-language read-out of what the open result's MIDI file contains with the current output options.
  function fileNowText() {
    var o = S.out;
    var sustain = cur.pedals.filter(function (p) { return p[2] === 64; }).length;
    var soft = cur.pedals.filter(function (p) { return p[2] === 67; }).length;
    var parts = ['<b>' + cur.notes.length.toLocaleString('en-US') + ' notes</b>'];
    parts.push(o.pedal === 'cc' ? '<b>' + sustain + ' sustain presses</b>' : o.pedal === 'extend' ? 'the sustain <b>baked into the notes</b>' : '<b>no sustain pedal</b>');
    parts.push(o.soft_pedal ? '<b>' + soft + ' soft-pedal presses</b>' : '<b>no soft pedal</b>');
    var dyn = o.velocity === 'flat' ? 'every note at loudness <b>' + o.flat_velocity + '</b>' : 'loudness <b>as played</b>';
    return 'Your file now has ' + parts[0] + ', ' + parts[1] + ' and ' + parts[2] + ', with ' + dyn + ', written at <b>' + o.tempo + ' BPM</b>.';
  }

  function renderDialog() {
    if (dialog.hidden) return;
    // keep focus on the same control across re-renders
    var a = document.activeElement, key = null;
    if (a && body.contains(a)) key = a.dataset.set ? '[data-set="' + a.dataset.set + '"][data-val="' + a.dataset.val + '"]' :
      a.dataset.toggle ? '[data-toggle="' + a.dataset.toggle + '"]' : a.id ? '#' + a.id : a.dataset.action ? '[data-action="' + a.dataset.action + '"]' : null;
    var scroll = body.scrollTop;
    dialog.classList.toggle('full', more);
    body.innerHTML = more ? renderFull() : renderSimple();
    $('moreBtn').setAttribute('aria-expanded', String(more));
    $('moreLabel').textContent = more ? 'Fewer settings' : 'More settings';
    body.scrollTop = scroll;
    if (key) { var n = body.querySelector(key); if (n) n.focus(); }
    var tg = $('tkGroup');
    if (tg) tg.addEventListener('toggle', function () { tkOpen = tg.open; });
  }

  function setPath(path, val) {
    var parts = path.split('.');
    if (path === 'engine') S.engine = val;
    else if (parts[0] === 'eng') S.eng[S.engine][parts[1]] = val;
    else if (parts[0] === 'tk') S.eng.transkun[parts[1]] = val;
    else if (parts[0] === 'out') S.out[parts[1]] = val;
    renderSummary();
    if (parts[0] === 'out' && view === 'result') {
      applyOutput(true);
      var fn = document.querySelector('#fileNow p');
      if (fn) fn.innerHTML = fileNowText();
      flashInstant();
    }
  }

  function flashInstant() {
    var n = $('instantNote');
    if (!n) return;
    n.classList.remove('flash');
    void n.offsetWidth;
    n.classList.add('flash');
  }

  body.addEventListener('click', function (e) {
    var b = e.target.closest('[data-set]');
    if (b) {
      var path = b.dataset.set, val = b.dataset.val;
      setPath(path, val);
      renderDialog();
      flashInstant();
      return;
    }
    var t = e.target.closest('[data-toggle]');
    if (t) {
      var cur2 = t.getAttribute('aria-checked') === 'true';
      setPath(t.dataset.toggle, !cur2);
      renderDialog();
      flashInstant();
      return;
    }
    var st = e.target.closest('[data-step]');
    if (st) {
      var spec = OUT.tempo;
      var v = Math.max(spec.min, Math.min(spec.max, S.out.tempo + Number(st.dataset.step)));
      setPath('out.tempo', v);
      $('f-tempo').value = v;
      flashInstant();
      return;
    }
    var act = e.target.closest('[data-action="reconvert"]');
    if (act) {
      closeDialog();
      startConversion(ctx.file);
    }
  });

  body.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.num) return;
    var key = el.dataset.num.split('.')[1];
    var spec = OUT[key];
    var v = Number(el.value);
    if (!isFinite(v)) return;
    if (el.type === 'range') {
      el.style.setProperty('--fill', ((v - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + '%');
      if (key === 'min_note_ms') $('o-min').textContent = minLenText(v);
      if (key === 'flat_velocity') $('o-flat').textContent = v;
    } else {
      if (v < spec.min || v > spec.max) return;
    }
    setPath(el.dataset.num, v);
  });
  body.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'f-tempo') {
      var spec = OUT.tempo;
      var v = Math.round(Number(el.value));
      if (!isFinite(v)) v = S.out.tempo;
      v = Math.max(spec.min, Math.min(spec.max, v));
      el.value = v;
      setPath('out.tempo', v);
      flashInstant();
    } else if (el.type === 'range') flashInstant();
  });

  // arrow keys inside radio groups
  document.addEventListener('keydown', function (e) {
    var r = e.target.closest && e.target.closest('[role="radio"]');
    if (!r || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
    var group = r.closest('[role="radiogroup"]');
    var items = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
    var i = items.indexOf(r) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
    var next = items[(i + items.length) % items.length];
    e.preventDefault();
    next.click();
    var again = group.isConnected ? next : document.querySelector(next.dataset.set ? '[data-set="' + next.dataset.set + '"][data-val="' + next.dataset.val + '"]' : '[data-mix="' + next.dataset.mix + '"]');
    if (again) again.focus();
  });

  function openDialog(opener, opts) {
    opts = opts || {};
    lastOpener = opener || document.activeElement;
    more = !!opts.more;
    tkOpen = !!opts.tkOpen;
    stopPlayback();
    $('scrim').hidden = false;
    dialog.hidden = false;
    renderDialog();
    markSwitcher();
    if (!opts.noFocus) {
      var first = body.querySelector('[role="radio"][aria-checked="true"]') || $('dlgClose');
      first.focus();
    }
  }
  function closeDialog(silent) {
    if (dialog.hidden) return;
    dialog.hidden = true;
    $('scrim').hidden = true;
    markSwitcher();
    if (!silent && lastOpener && document.contains(lastOpener)) lastOpener.focus();
  }
  $('optsHome').addEventListener('click', function (e) { openDialog(e.currentTarget); });
  $('optsResult').addEventListener('click', function (e) { openDialog(e.currentTarget); });
  $('dlgClose').addEventListener('click', function () { closeDialog(); });
  $('doneBtn').addEventListener('click', function () { closeDialog(); });
  $('scrim').addEventListener('click', function () { closeDialog(); });
  $('moreBtn').addEventListener('click', function () { more = !more; if (more) tkOpen = false; renderDialog(); });
  $('resetBtn').addEventListener('click', function () {
    S = defaults();
    renderSummary();
    if (view === 'result') applyOutput(true);
    renderDialog();
    toast('Options reset to defaults');
  });

  document.addEventListener('keydown', function (e) {
    if (!dialog.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
      if (e.key === 'Tab') {
        var f = Array.prototype.filter.call(dialog.querySelectorAll('button, input, summary, [tabindex="0"]'), function (n) {
          return !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null;
        });
        if (!f.length) return;
        var first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (e.key === 'Escape' && !instMenu.hidden) { setMenu(false); instBtn.focus(); return; }
    if (view === 'result' && (e.key === ' ' || e.code === 'Space')) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'input' || tag === 'summary' || e.target.getAttribute('role') === 'radio') return;
      e.preventDefault();
      playing ? stopPlayback() : startPlayback();
    }
  });

  // ------------------------------------------------------------------ toast
  var toastTimer = 0;
  function toast(msg, action, kind) {
    var t = $('toast');
    t.classList.toggle('error', kind === 'error');
    t.innerHTML = (kind === 'error'
      ? '<svg class="t-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>'
      : '<svg class="t-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>') + '<span class="t-msg"></span>';
    t.querySelector('.t-msg').textContent = msg;
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', function () { t.classList.remove('show'); action.run(); });
      t.appendChild(b);
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4200);
  }

  // ------------------------------------------------------------------ reviewer state switcher
  function currentState() { return !dialog.hidden && view === 'result' ? 'advanced' : view; }
  function markSwitcher() {
    var s = currentState();
    Array.prototype.forEach.call($('switcher').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-current', String(b.dataset.state === s));
    });
  }
  function goState(s, fromUrl) {
    closeDialog(true);
    if (s === 'progress') {
      showStaticProgress({ file: M.job.filename, p: M.progress.progress, engine: 'ensemble', eta: M.progress.eta_seconds, message: M.progress.message });
    } else if (s === 'result' || s === 'advanced') {
      ctx = { file: M.job.filename, duration: M.job.stats.duration, seconds: M.job.stats.seconds_total, engine: M.job.engine, listenKey: listenKey() };
      openResult(12);
      if (s === 'advanced') openDialog(null, { more: true, tkOpen: true, noFocus: fromUrl });
    } else {
      show('home');
    }
    markSwitcher();
  }
  $('switcher').addEventListener('click', function (e) {
    var b = e.target.closest('[data-state]');
    if (!b) return;
    var p = new URLSearchParams(location.search);
    p.set('state', b.dataset.state);
    try { history.replaceState(null, '', '?' + p.toString()); } catch (err) { /* file:// may refuse */ }
    goState(b.dataset.state);
  });

  // ------------------------------------------------------------------ boot
  renderSummary();
  renderRecent();
  var initial = params.get('state');
  goState(['home', 'progress', 'result', 'advanced'].indexOf(initial) >= 0 ? initial : 'home', true);
})();
