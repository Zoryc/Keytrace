// MIDI Converter: Pro Dashboard prototype (variant 04). Classic script, no network, mock data only.
(function () {
  'use strict';

  const M = window.MOCK;
  const R = window.MCRoll;
  const Q = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const fmtTime = R.fmtTime;

  const INFO = M.info;
  const INST = INFO.instruments[0];
  const ENGINES = INST.engines;
  const OUT = INFO.output_options;
  const DUR = M.duration || M.job.stats.duration || 60;
  const STATS = M.job.stats;
  const PROG = M.progress;
  const narrowMQ = matchMedia('(max-width: 1099px)');

  const SHORT_ENGINE = { ensemble: 'Ensemble', transkun: 'Transkun V2', aria: 'Aria-AMT' };
  const SHORT_VIEWS = { none: 'Single view', channels: 'Stereo views 4x', full: 'Stereo + tone views 6x' };
  const VIEW_COUNT = { none: 1, channels: 4, full: 6 };
  const SPEED = { ensemble: 10.5, transkun: 3, aria: 6.5 };   // seconds per minute of audio at stereo views
  const VIEW_COST = { none: 0.4, channels: 1, full: 1.5 };
  const DYN = [['pp', 32], ['p', 48], ['mp', 64], ['mf', 80], ['f', 96], ['ff', 112]];

  const S = {
    view: 'home',
    progMode: 'static',
    progName: M.file.name,
    advanced: false,
    sheet: false,
    engine: INST.default_engine,
    eopts: {},
    out: {},
    time: 0,
    playing: false,
    mix: 'both',
    job: { filename: M.job.filename, engine: M.job.engine, eopts: { views: 'channels', rescue: '0.3' }, when: 'Today 14:32' },
    data: null,
    errorJob: null,
  };

  // ------------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(id, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDur(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + ' s';
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ------------------------------------------------------------------ settings model
  const engineById = (id) => ENGINES.find((e) => e.id === id);
  const specOf = (engineId, key) => engineById(engineId).options.find((o) => o.key === key);
  const hasOpt = (engineId, key) => engineById(engineId).options.some((o) => o.key === key);
  function eVal(engineId, key) {
    const v = S.eopts[engineId] && S.eopts[engineId][key];
    return v === undefined ? specOf(engineId, key).default : v;
  }
  function setE(engineId, key, v) { (S.eopts[engineId] = S.eopts[engineId] || {})[key] = v; }
  const outSpec = (key) => OUT.find((o) => o.key === key);
  function oVal(key) { const v = S.out[key]; return v === undefined ? outSpec(key).default : v; }
  function isAllDefault() {
    if (S.engine !== INST.default_engine) return false;
    for (const e of ENGINES) for (const o of e.options) if (String(eVal(e.id, o.key)) !== String(o.default)) return false;
    for (const o of OUT) if (String(oVal(o.key)) !== String(o.default)) return false;
    return true;
  }
  function snapshotEngine() {
    const o = {};
    for (const spec of engineById(S.engine).options) o[spec.key] = eVal(S.engine, spec.key);
    return o;
  }
  function engineDiffers() {
    if (S.engine !== S.job.engine) return true;
    const now = snapshotEngine();
    return Object.keys(now).some((k) => String(now[k]) !== String(S.job.eopts[k] ?? specOf(S.engine, k).default));
  }
  function speedPerMin() {
    let s = SPEED[S.engine];
    if (hasOpt(S.engine, 'views')) s *= VIEW_COST[eVal(S.engine, 'views')];
    return s;
  }
  function advSummary() {
    if (S.engine === 'aria') return 'Built-in settings';
    const bits = [SHORT_VIEWS[eVal(S.engine, 'views')]];
    if (S.engine === 'ensemble') bits.push(specOf('ensemble', 'rescue').choices.find((c) => c.value === eVal('ensemble', 'rescue')).label.replace(/\s*\(.*\)/, ''));
    if (S.engine === 'transkun') bits.push(eVal('transkun', 'merge_fix') ? 'Merge fix on' : 'Merge fix off');
    return bits.join(' · ');
  }

  // ------------------------------------------------------------------ toast + popover
  let toastTimer = 0;
  function toast(msg, action, iconId) {
    const t = $('toast');
    t.innerHTML = '';
    t.append(icon(iconId || 'i-check-circle', 'ti'));
    t.append(el('span', 'tm', msg));
    if (action) {
      const b = el('button', null, action.label);
      b.type = 'button';
      b.onclick = () => { t.classList.remove('show'); action.run && action.run(); };
      t.append(b);
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
  }

  function showHelp(btn) {
    const p = $('popover');
    p.innerHTML = '';
    p.append(el('b', null, btn.dataset.helpTitle), document.createTextNode(btn.dataset.help));
    p.hidden = false;
    const r = btn.getBoundingClientRect();
    const pw = p.offsetWidth, ph = p.offsetHeight;
    let x = r.left - pw - 12, y = r.top - 6;
    if (x < 8) { x = clamp(r.left - pw / 2, 8, innerWidth - pw - 8); y = r.bottom + 8; }
    y = clamp(y, 8, innerHeight - ph - 8);
    p.style.left = x + 'px';
    p.style.top = y + 'px';
  }
  const hideHelp = () => { $('popover').hidden = true; };

  // ------------------------------------------------------------------ option controls
  function optRow({ id, label, help, changed, inline, control, labelFor = true, extra }) {
    const wrap = el('div', 'opt' + (inline ? ' inline' : ''));
    const lab = el('div', 'opt-label');
    let t;
    if (labelFor) { t = el('label', null, label); t.htmlFor = id; }
    else { t = el('span', 't', label); t.id = id + '-l'; }
    lab.append(t);
    if (changed) {
      const d = el('span', 'changed');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', 'changed from default');
      d.title = 'Changed from default';
      lab.append(d);
    }
    if (help) {
      const b = el('button', 'info');
      b.type = 'button';
      b.setAttribute('aria-label', 'About ' + label);
      b.setAttribute('aria-describedby', 'popover');
      b.dataset.helpTitle = label;
      b.dataset.help = help;
      b.append(icon('i-info'));
      lab.append(b);
    }
    wrap.append(lab, control);
    if (extra) wrap.append(extra);
    return wrap;
  }
  function selectCtl(id, choices, value, onChange) {
    const w = el('div', 'select');
    const s = el('select');
    s.id = id;
    for (const c of choices) {
      const o = new Option(c.label, c.value);
      o.selected = String(c.value) === String(value);
      s.append(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    w.append(s, icon('i-chev-down'));
    return w;
  }
  function radioKeys(g) {
    g.addEventListener('keydown', (e) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const bs = [...g.querySelectorAll('[role=radio]:not([disabled])')];
      const i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (back ? -1 : 1) + bs.length) % bs.length;
      bs[j].focus();
      bs[j].click();
    });
  }
  function segCtl(id, choices, value, onChange, full) {
    const g = el('div', 'seg' + (full ? ' full' : ''));
    g.setAttribute('role', 'radiogroup');
    g.setAttribute('aria-labelledby', id + '-l');
    for (const c of choices) {
      const b = el('button');
      b.type = 'button';
      b.id = id + '-' + c.value;
      b.setAttribute('role', 'radio');
      const on = String(c.value) === String(value);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.textContent = c.short || c.label;
      if (c.short && c.short !== c.label) b.title = c.label;
      b.addEventListener('click', () => { if (!on) onChange(c.value); });
      g.append(b);
    }
    radioKeys(g);
    return g;
  }
  function switchCtl(id, checked, onChange) {
    const w = el('span', 'switch');
    const i = el('input');
    i.type = 'checkbox';
    i.id = id;
    i.setAttribute('role', 'switch');
    i.checked = !!checked;
    i.addEventListener('change', () => onChange(i.checked));
    w.append(i, el('span', 'track'));
    return w;
  }
  function numCtl(id, spec, value, onChange) {
    const w = el('span', 'numf');
    const i = el('input');
    i.type = 'number';
    i.id = id;
    i.min = spec.min; i.max = spec.max; i.step = spec.step;
    i.value = value;
    const commit = () => {
      let v = Number(i.value);
      if (i.value === '' || !isFinite(v)) v = spec.default;
      v = clamp(Math.round(v / spec.step) * spec.step, spec.min, spec.max);
      i.value = v;
      if (v !== value) onChange(v);
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    w.append(i);
    if (spec.unit) w.append(el('span', 'u', spec.unit));
    return w;
  }
  function rangeCtl(id, spec, value, onChange) {
    const row = el('div', 'range-row');
    const r = el('input');
    r.type = 'range';
    r.min = spec.min; r.max = spec.max; r.step = spec.step; r.value = value;
    r.setAttribute('aria-label', spec.label + ' slider');
    const n = numCtl(id, spec, value, onChange);
    r.addEventListener('input', () => { n.querySelector('input').value = r.value; });
    r.addEventListener('change', () => onChange(Number(r.value)));
    row.append(r, n);
    return row;
  }

  function engineOptRow(engineId, spec) {
    const id = `opt-${engineId}-${spec.key}`;
    const val = eVal(engineId, spec.key);
    const changed = String(val) !== String(spec.default);
    const set = (v) => { setE(engineId, spec.key, v); onEngineChange(); };
    if (spec.kind === 'bool') return optRow({ id, label: spec.label, help: spec.help, changed, inline: true, control: switchCtl(id, val, set) });
    if (spec.key === 'rescue') {
      const ch = spec.choices.map((c) => ({ value: c.value, label: c.label, short: c.label.replace(/\s*\(.*\)/, '') }));
      return optRow({ id, label: spec.label, help: spec.help + ' Balanced measured best.', changed, labelFor: false, control: segCtl(id, ch, val, set, true) });
    }
    return optRow({ id, label: spec.label, help: spec.help, changed, control: selectCtl(id, spec.choices, val, set) });
  }

  function renderTx() {
    const box = $('txBox');
    box.innerHTML = '';
    const eng = engineById(S.engine);
    const engRow = optRow({
      id: 'opt-engine', label: 'Engine', changed: S.engine !== INST.default_engine,
      help: 'Ensemble is the most accurate and the default. Transkun V2 alone is about 4x faster and almost as accurate. Aria-AMT alone is there for comparison.',
      control: selectCtl('opt-engine', ENGINES.map((e) => ({ value: e.id, label: e.name + (e.available ? '' : ' (not installed)') })), S.engine,
        (v) => { S.engine = v; onEngineChange(); }),
      extra: el('p', 'summary', eng.summary),
    });
    box.append(engRow);

    const t = el('button', 'adv-toggle');
    t.type = 'button';
    t.id = 'advToggle';
    t.setAttribute('aria-expanded', String(S.advanced));
    t.setAttribute('aria-controls', 'advBox');
    t.append(icon('i-chev', 'chev'), el('span', null, 'Advanced'));
    if (!S.advanced) t.append(el('span', 'vals', advSummary()));
    else t.append(el('span', 'vals', 'Hide'));
    t.addEventListener('click', () => setAdvanced(!S.advanced));
    box.append(t);

    if (S.advanced) {
      const adv = el('div', 'adv-box');
      adv.id = 'advBox';
      for (const spec of eng.options) adv.append(engineOptRow(S.engine, spec));
      if (S.engine === 'aria') adv.append(el('p', 'side-note', 'Aria-AMT runs with its built-in settings.'));
      if (S.engine !== 'transkun') {
        const gl = el('div', 'group-label');
        gl.append(el('span', null, 'Transkun V2'), el('span', 'tag', 'used when selected'));
        adv.append(gl);
        for (const spec of engineById('transkun').options) if (spec.key !== 'views') adv.append(engineOptRow('transkun', spec));
      }
      box.append(adv);
    }

    if (S.view === 'result' && engineDiffers()) {
      const b = el('button', 'btn btn-secondary btn-block rerun');
      b.type = 'button';
      b.append(icon('i-refresh'), document.createTextNode('Re-convert this file with these settings'));
      b.onclick = () => { closeSheet(); startConversion(S.job.filename); };
      box.append(b);
    }
  }

  function renderOut() {
    const box = $('outBox');
    box.innerHTML = '';
    for (const spec of OUT) {
      const id = 'opt-out-' + spec.key;
      const val = oVal(spec.key);
      const changed = String(val) !== String(spec.default);
      const set = (v) => { S.out[spec.key] = v; onOutputChange(spec.key); };
      let row;
      if (spec.key === 'flat_velocity') {
        if (oVal('velocity') !== 'flat') continue;
        row = optRow({ id, label: spec.label, help: spec.help, changed, control: rangeCtl(id, spec, val, set) });
      } else if (spec.kind === 'bool') {
        row = optRow({ id, label: spec.label, help: spec.help, changed, inline: true, control: switchCtl(id, val, set) });
      } else if (spec.key === 'velocity') {
        row = optRow({ id, label: spec.label, help: spec.help, changed, inline: true, labelFor: false, control: segCtl(id, spec.choices, val, set) });
      } else if (spec.kind === 'choice') {
        row = optRow({ id, label: spec.label, help: spec.help, changed, control: selectCtl(id, spec.choices, val, set) });
      } else {
        row = optRow({ id, label: spec.label, help: spec.help, changed, inline: true, control: numCtl(id, spec, val, set) });
      }
      box.append(row);
    }
  }

  function renderOptions() {
    const a = document.activeElement;
    const focusId = a && a.id && $('sidebar').contains(a) ? a.id : null;
    renderTx();
    renderOut();
    $('resetBtn').disabled = isAllDefault();
    $('outBadge').title = S.view === 'result'
      ? 'Changes rewrite the open MIDI file straight away: no need to convert again'
      : 'Applied when the MIDI file is written, and to an open result straight away';
    if (focusId && $(focusId)) $(focusId).focus();
  }

  function renderEngineSum() {
    const parts = [SHORT_ENGINE[S.engine]];
    if (hasOpt(S.engine, 'views')) parts.push(SHORT_VIEWS[eVal(S.engine, 'views')]);
    $('engineSumText').innerHTML = `<b>${esc(parts[0])}</b>` + (parts[1] ? ' · ' + esc(parts[1]) : '');
    $('engineSum').title = `About ${Math.max(1, Math.round(speedPerMin()))} s per minute of audio on this GPU. Change in Advanced options.`;
  }

  function onEngineChange() {
    renderOptions();
    renderEngineSum();
  }

  let outTimer = 0;
  function onOutputChange() {
    renderOptions();
    if (S.view !== 'result') return;
    applyData(true, true);
    clearTimeout(outTimer);
    outTimer = setTimeout(() => toast('MIDI updated'), 350);
  }

  function setAdvanced(on) {
    S.advanced = on;
    renderOptions();
    syncSwitcher();
    if (on && !narrowMQ.matches) $('sideBody').scrollTop = 0;
  }

  // ------------------------------------------------------------------ sheet (narrow windows)
  function syncSheet() {
    const narrow = narrowMQ.matches;
    const sb = $('sidebar');
    const open = narrow && S.sheet;
    sb.classList.toggle('open', open);
    $('scrim').classList.toggle('show', open);
    sb.inert = narrow && !S.sheet;
    if (narrow) { sb.setAttribute('role', 'dialog'); sb.setAttribute('aria-modal', String(open)); }
    else { sb.removeAttribute('role'); sb.removeAttribute('aria-modal'); }
    $('optionsBtn').setAttribute('aria-expanded', String(open));
  }
  function openSheet() {
    S.sheet = true;
    syncSheet();
    if (narrowMQ.matches) setTimeout(() => $('sheetClose').focus(), 80);
  }
  function closeSheet(restoreFocus) {
    const was = S.sheet && narrowMQ.matches;
    S.sheet = false;
    hideHelp();
    syncSheet();
    if (was && restoreFocus) $('optionsBtn').focus();
  }
  function openAdvanced() {
    if (!S.advanced) setAdvanced(true);
    if (narrowMQ.matches) openSheet();
    else setTimeout(() => $('opt-engine') && $('opt-engine').focus(), 30);
  }

  // ------------------------------------------------------------------ views
  function show(view) {
    S.view = view;
    $('viewHome').hidden = view !== 'home';
    $('viewProgress').hidden = view !== 'progress';
    $('viewResult').hidden = view !== 'result';
    if (view !== 'result') pause();
    if (view !== 'progress') stopAnim();
    const name = view === 'home' ? 'New conversion' : view === 'progress' ? S.progName : S.job.filename;
    $('crumbRoot').hidden = view === 'home';
    $('crumbSep2').hidden = view === 'home';
    $('crumbCurrent').textContent = name;
    $('crumbCurrent').title = name;
    $('main').scrollTop = 0;
    const busy = view === 'progress' && (S.progMode === 'live' || S.progMode === 'static');
    $('gpuChip').classList.toggle('busy', busy);
    $('gpuSub').textContent = busy ? '16 GB · Busy' : '16 GB · Ready';
    renderOptions();
    syncSwitcher();
  }

  function syncSwitcher() {
    const cur = S.view === 'result' && S.advanced ? 'advanced' : S.view;
    for (const b of $('switcher').querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.state === cur));
  }

  // ------------------------------------------------------------------ home
  function statusEl(job) {
    const s = el('span', 'status ' + job.status);
    if (job.status === 'done') { s.append(icon('i-check-circle'), document.createTextNode('Done')); }
    else if (job.status === 'running') {
      const C = 2 * Math.PI * 6;
      const p = job.progress || 0;
      s.insertAdjacentHTML('beforeend',
        `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="ring-bg" stroke-width="2.2"/>` +
        `<circle cx="8" cy="8" r="6" stroke-width="2.2" stroke-linecap="butt" stroke-dasharray="${(C * p).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`);
      s.append(document.createTextNode(`Converting ${Math.round(p * 100)}%`));
    } else if (job.status === 'queued') { s.append(icon('i-dash-circle'), document.createTextNode('Waiting')); }
    else if (job.status === 'error') { s.append(icon('i-alert'), document.createTextNode('Failed')); }
    else s.append(document.createTextNode(job.status));
    return s;
  }
  function statusText(job) {
    return { done: 'done', running: `converting, ${Math.round((job.progress || 0) * 100)}%`, queued: 'waiting', error: 'failed: ' + job.error }[job.status] || job.status;
  }

  function renderRecent() {
    const tb = $('recentBody');
    tb.innerHTML = '';
    const jobs = M.recent.filter((j) => !S.removed || !S.removed.has(j.id));
    for (const job of jobs) {
      const tr = el('tr');
      tr.tabIndex = 0;
      tr.dataset.id = job.id;
      tr.setAttribute('aria-label', `${job.filename}, ${statusText(job)}. Open`);
      const isVideo = /\.(mp4|mkv|mov|webm)$/i.test(job.filename);
      const td1 = el('td');
      const fc = el('div', 'file-cell');
      const ic = el('span', 'file-ico');
      ic.append(icon(isVideo ? 'i-film' : 'i-music'));
      const ft = el('div', 'file-text');
      ft.append(el('span', 'file-name', job.filename));
      if (job.status === 'error') ft.append(el('span', 'file-err', job.error));
      fc.append(ic, ft);
      td1.append(fc);
      td1.title = job.filename;
      const td2 = el('td');
      td2.append(statusEl(job));
      const td3 = el('td', 'num', fmtTime(job.duration));
      const td4 = el('td', 'num', job.notes != null ? job.notes.toLocaleString('en-US') : '–');
      if (job.notes == null) td4.style.color = 'var(--faint)';
      const td5 = el('td', null, job.when);
      const td6 = el('td', 'c-go');
      td6.append(icon('i-chev'));
      tr.append(td1, td2, td3, td4, td5, td6);
      tr.addEventListener('click', () => openJob(job));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openJob(job); } });
      tb.append(tr);
    }
    const running = jobs.filter((j) => j.status === 'running').length;
    const queued = jobs.filter((j) => j.status === 'queued').length;
    $('queueLine').innerHTML = running || queued
      ? `<b>${running}</b> converting<span style="color:var(--line-strong)"> · </span><b>${queued}</b> waiting`
      : `${jobs.length} files`;
  }

  function renderAccuracy() {
    const f = M.accuracy.onset_f1;
    $('accValue').innerHTML = `${f.clean.toFixed(1)}% <small>clean audio</small>`;
    const names = { mp3: 'MP3', phone: 'Phone', reverb: 'Reverb', noise: 'Noise', worst: 'Worst' };
    $('accGrid').innerHTML = Object.keys(names).map((k) => `<span>${names[k]}<b>${f[k].toFixed(1)}</b></span>`).join('');
    $('accGrid').title = `Note-onset F1 (%) on ${M.accuracy.note}`;
  }

  function showHome() {
    show('home');
  }

  function openJob(job) {
    if (job.status === 'done') {
      S.job = { filename: M.job.filename, engine: M.job.engine, eopts: { views: 'channels', rescue: '0.3' }, when: job.id === M.job.id ? job.when : 'Today 14:32' };
      showResult(0);
      if (job.id !== M.job.id) toast('This preview opens the sample result for every finished file', null, 'i-info');
    } else if (job.status === 'running') {
      showProgress('static', job.filename, job.progress, job.duration);
    } else if (job.status === 'queued') {
      showProgress('queued', job.filename, 0, job.duration);
    } else if (job.status === 'error') {
      S.errorJob = job;
      showProgress('error', job.filename, 0, job.duration, job.error);
    }
  }

  // ------------------------------------------------------------------ progress
  const windowsFor = (dur) => Math.max(1, Math.ceil(Math.max(0, dur - 16) / 5.5) + 1);
  function stagesFor(engine) {
    const st = PROG.stages;
    if (engine === 'ensemble') return st.map((s) => ({ id: s.id, label: s.label }));
    if (engine === 'transkun') return [st[0], { id: 'transkun', label: `Transkun V2 · ${VIEW_COUNT[eVal('transkun', 'views')]} views` }, { id: 'fuse', label: 'Write MIDI' }];
    return [st[0], { id: 'aria', label: 'Aria-AMT' }, { id: 'fuse', label: 'Write MIDI' }];
  }
  function model(f, dur) {
    const W = windowsFor(dur);
    const total = dur * 26 / 60;
    let phase, msg, win = 0, winDone = 0;
    if (f < 0.04) { phase = 0; msg = 'Reading audio'; }
    else if (f < 0.84) {
      phase = 1;
      win = Math.min(W, Math.floor((f - 0.04) / 0.8 * W) + 1);
      winDone = win - 1;
      msg = `Transcribing window ${win} of ${W}`;
    } else if (f < 0.95) { phase = 2; winDone = W; msg = 'Aria-AMT is checking unsure notes'; }
    else { phase = 3; winDone = W; msg = 'Merging notes and writing MIDI'; }
    const left = (1 - f) * total;
    const eta = f >= 1 ? 'Done' : left < 3 ? 'Almost done' : `About ${fmtDur(left)} left`;
    return { W, phase, msg, win, winDone, eta };
  }

  function logLines(W) {
    const lines = M.log.slice();
    let [hh, mm, ss] = lines[lines.length - 1].slice(0, 12).split(':');
    let t = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
    const stamp = () => {
      t += 0.772;
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    };
    const adds = [97, 88, 112, 79, 101, 93];
    for (let k = 6; k <= W; k++) lines.push(`${stamp()}  transkun  window ${k}/${W}  notes+=${adds[k % adds.length]}${adds[k % adds.length] < 100 ? '  ' : ' '} pedal+=${k % 3 + 1}`);
    lines.push(`${stamp()}  aria  second opinion  candidates=31  added=${STATS.notes_added_by_aria}`);
    lines.push(`${stamp()}  fuse  notes=${STATS.notes}  pedal=${STATS.pedals}+${STATS.soft_pedals}  wrote ${M.job.midi_name}`);
    return lines;
  }
  function renderLog(count, W) {
    const all = logLines(W).slice(0, count);
    const shown = all.slice(-6);
    $('log').innerHTML = shown.map((ln, i) => {
      const m = ln.match(/^(\S+)\s+(\S+)(.*)$/);
      const body = m ? `<span class="t">${esc(m[1])}</span>  <span class="k">${esc(m[2])}</span>${esc(m[3])}` : esc(ln);
      return `<div class="${i === shown.length - 1 ? 'last' : ''}" style="overflow:hidden;text-overflow:ellipsis">${body}</div>`;
    }).join('');
  }

  let waveState = { done: 0, a0: 0, a1: 0, dur: DUR };
  function drawWave() {
    const host = $('wave');
    const cv = host.querySelector('canvas');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const acc = cssVar('--accent'), rest = cssVar('--wave-rest'), soft = cssVar('--accent-soft');
    const { done, a0, a1, dur } = waveState;
    const tx = (t) => (t / dur) * W;
    if (a1 > a0) {
      ctx.fillStyle = soft;
      ctx.beginPath();
      ctx.roundRect(tx(a0), 0, Math.max(2, tx(a1) - tx(a0)), H, 4);
      ctx.fill();
    }
    const peaks = M.waveform.peak, n = peaks.length;
    let gmax = 0;
    for (let i = 0; i < n; i++) if (peaks[i] > gmax) gmax = peaks[i];
    gmax = gmax || 1;
    const step = 3, bw = 2, mid = H / 2;
    for (let x = 0; x + bw <= W; x += step) {
      const i0 = Math.floor((x / W) * n), i1 = Math.max(i0 + 1, Math.floor(((x + step) / W) * n));
      let pk = 0;
      for (let i = i0; i < i1 && i < n; i++) if (peaks[i] > pk) pk = peaks[i];
      const h = Math.max(1, Math.pow(pk / gmax, 0.8) * (mid - 6));
      const t = ((x + bw / 2) / W) * dur;
      ctx.globalAlpha = 1;
      if (t < done) ctx.fillStyle = acc;
      else if (t < a1) { ctx.fillStyle = acc; ctx.globalAlpha = 0.5; }
      else ctx.fillStyle = rest;
      ctx.beginPath();
      ctx.roundRect(x, mid - h, bw, h * 2, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function renderStages(engine, phase, m, mode) {
    const list = stagesFor(engine);
    const idxOfPhase = list.length === 4 ? phase : (phase === 0 ? 0 : phase === 1 ? 1 : 2);
    $('stages').innerHTML = '';
    list.forEach((s, i) => {
      let state = i < idxOfPhase ? 'done' : i === idxOfPhase ? 'active' : 'pending';
      if (mode === 'queued') state = 'pending';
      const li = el('li', 'stage ' + state);
      const ic = state === 'done' ? icon('i-check-circle', 'si') : state === 'active' ? icon('i-spinner', 'si spin') : icon('i-dash-circle', 'si');
      let d = 'Waiting';
      if (state === 'done') d = { decode: '0.41 s', transkun: `${m.W} windows`, aria: s.label === 'Aria-AMT' ? `${m.W} windows` : `${STATS.notes_added_by_aria} notes added`, fuse: 'Done' }[s.id];
      if (state === 'active') d = { decode: 'Reading audio', transkun: `Window ${m.win} of ${m.W}`, aria: s.label === 'Aria-AMT' ? `Window ${m.win} of ${m.W}` : 'Checking unsure notes', fuse: 'Writing the file' }[s.id];
      const tx = el('div', 'st');
      tx.append(el('div', 'sl', s.label), el('div', 'sd', d));
      li.append(ic, tx);
      $('stages').append(li);
    });
  }

  let anim = 0, animTimer = 0;
  function stopAnim() { clearInterval(anim); clearTimeout(animTimer); anim = 0; }

  function setProgressHead(mode, name, dur, err) {
    S.progName = name;
    const pill = $('progPill');
    pill.innerHTML = '';
    const p = el('span', 'pill' + (mode === 'error' ? ' danger' : mode === 'queued' ? '' : ' accent'));
    if (mode === 'error') p.append(icon('i-alert'), document.createTextNode('Failed'));
    else if (mode === 'queued') p.append(icon('i-dash-circle'), document.createTextNode('Waiting'));
    else { p.append(el('span', 'live-dot'), document.createTextNode('Converting')); }
    p.querySelectorAll('.i').forEach((i) => { i.style.width = '13px'; i.style.height = '13px'; });
    pill.append(p);
    $('progName').textContent = name;
    $('progName').title = name;
    const ext = (name.match(/\.(\w+)$/) || [, ''])[1].toUpperCase();
    $('progMeta').textContent = name === M.file.name
      ? `${M.file.format} · ${M.file.size_mb} MB · ${fmtTime(dur)}`
      : `${ext}${ext ? ' · ' : ''}${fmtTime(dur)}`;
    $('progLive').hidden = mode === 'error';
    $('errorCard').hidden = mode !== 'error';
    $('cancelBtn').hidden = mode === 'error';
    $('cancelBtn').textContent = mode === 'queued' ? 'Remove from queue' : 'Cancel';
    if (mode === 'error') {
      $('errorTitle').textContent = 'This file could not be converted';
      $('errorText').textContent = `${err} Check that the recording plays in another app, or try a different file.`;
    }
    const eng = S.progEngine || S.engine;
    const views = hasOpt(eng, 'views') ? ` · ${VIEW_COUNT[eVal(eng, 'views')]} views` : '';
    $('progEngine').innerHTML = `<b>${esc(SHORT_ENGINE[eng])}</b>${views}<br>RTX 5070 Ti`;
  }

  function renderProgress(f, dur, mode) {
    const eng = S.progEngine || S.engine;
    const m = model(f, dur);
    const bar = $('progBar');
    const pct = Math.round(f * 100);
    if (mode === 'queued') {
      $('progPct').innerHTML = '–';
      $('progMsg').textContent = 'Waiting · 1 conversion ahead';
      $('progEta').textContent = 'Starts when the current file is done';
      bar.classList.add('indet');
      bar.removeAttribute('aria-valuenow');
    } else {
      $('progPct').innerHTML = `${pct}<span class="unit">%</span>`;
      $('progMsg').textContent = eng === 'aria' && m.phase === 1 ? `Aria-AMT · window ${m.win} of ${m.W}` : m.msg;
      $('progEta').textContent = m.eta;
      bar.classList.remove('indet');
      bar.setAttribute('aria-valuenow', String(pct));
    }
    bar.firstElementChild.style.width = (mode === 'queued' ? 30 : pct) + '%';
    renderStages(eng, mode === 'queued' ? -1 : m.phase, m, mode);

    // windows strip + waveform
    const wins = $('windows');
    if (wins.childElementCount !== m.W) {
      wins.innerHTML = '';
      wins.style.gridTemplateColumns = `repeat(${m.W}, minmax(0, 1fr))`;
      for (let k = 1; k <= m.W; k++) {
        const c = el('div', 'win', m.W <= 16 ? String(k) : '');
        c.title = `Window ${k}`;
        wins.append(c);
      }
    }
    [...wins.children].forEach((c, i) => {
      const k = i + 1;
      const st = mode === 'queued' ? '' : k <= m.winDone ? 'done' : (m.phase === 1 && k === m.win ? 'active' : '');
      c.className = 'win' + (st ? ' ' + st : '');
    });
    $('winCount').innerHTML = mode === 'queued' ? `${m.W} windows` : `<b>${m.winDone}</b> of ${m.W} done`;
    const seg = dur / m.W;
    waveState = { done: mode === 'queued' ? 0 : m.winDone * seg, a0: m.phase === 1 ? m.winDone * seg : 0, a1: m.phase === 1 ? m.win * seg : 0, dur };
    $('waveEnd').textContent = fmtTime(dur);
    drawWave();
    const count = mode === 'queued' ? 0 : m.phase === 0 ? 2 : m.phase === 1 ? 2 + m.win : m.phase === 2 ? 2 + m.W + 1 : 2 + m.W + 2;
    if (mode === 'queued') $('log').innerHTML = '<div class="last" style="color:var(--muted)">Waiting for the GPU…</div>';
    else renderLog(count, m.W);
  }

  function showProgress(mode, name, f, dur, err) {
    stopAnim();
    S.progMode = mode;
    if (mode !== 'live') S.progEngine = 'ensemble';
    setProgressHead(mode, name, dur, err);
    show('progress');
    if (mode !== 'error') renderProgress(f, dur, mode);
  }

  function startConversion(name) {
    pause();
    S.progEngine = S.engine;
    S.job = { filename: name, engine: S.engine, eopts: snapshotEngine(), when: 'Just now' };
    showProgress('live', name, 0, DUR);
    const t0 = performance.now(), D = 3200;
    // Timer-driven (not rAF) so the simulation also advances in a background window.
    anim = setInterval(() => {
      const f = Math.min(1, (performance.now() - t0) / D);
      renderProgress(f, DUR, 'live');
      if (f < 1) return;
      clearInterval(anim);
      animTimer = setTimeout(() => {
        showResult(0);
        toast(`Converted in ${STATS.seconds_total.toFixed(1)} s`, null, 'i-check-circle');
      }, 300);
    }, 40);
  }

  // ------------------------------------------------------------------ result data
  function derive() {
    const flat = oVal('velocity') === 'flat';
    const fv = oVal('flat_velocity');
    const minMs = oVal('min_note_ms');
    const pedal = oVal('pedal');
    const soft = oVal('soft_pedal');
    const notes = [];
    for (const n of M.notes) {
      if ((n[1] - n[0]) * 1000 < minMs) continue;
      const m = n.slice();
      if (flat) m[3] = fv;
      if (pedal === 'extend') { m[1] = Math.max(m[1], m[4] || m[1]); m[4] = m[1]; }
      if (pedal === 'none') m[4] = m[1];
      notes.push(m);
    }
    const pedals = M.pedals.filter((p) => (p[2] === 64 ? pedal === 'cc' : !!soft));
    return { notes, pedals };
  }

  const roll = new R.PianoRoll($('roll'), { onSeek: (t) => seek(t) });
  // The shared roll only labels octaves when rows are 5px or taller. At this card's height they are
  // about 4px, so draw compact C labels ourselves (the keyboard stays readable at every window size).
  (function labelOctaves() {
    const drawKeys = roll._drawKeys.bind(roll);
    roll._drawKeys = function () {
      drawKeys();
      const rh = this._rowH();
      if (rh >= 5) return;
      const ctx = this.keys.getContext('2d');
      ctx.font = `600 9px ${cssVar('--font')}`;
      ctx.fillStyle = this.c.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let p = this.lo; p <= this.hi; p++) {
        if (p % 12) continue;
        // sit just above the C row's octave line, inside the octave it names
        const y = this._rowY(p) + rh / 2 - 2.5;
        if (y < this.axisH + 6 || y > this.el.clientHeight - this.pedalH - 6) continue;
        ctx.fillText(R.noteName(p), this.keyW - 5, y);
      }
    };
  })();

  // ------------------------------------------------------------------ stat sparklines
  // Small, same-size micro-charts that sit beside each headline number.
  const SP_W = 56, SP_H = 24, SP_BINS = 14;
  function binCounts(times) {
    const b = new Array(SP_BINS).fill(0);
    for (const t of times) b[clamp(Math.floor((t / DUR) * SP_BINS), 0, SP_BINS - 1)]++;
    return b;
  }
  function svgOpen(label) {
    return `<svg class="spark" width="${SP_W}" height="${SP_H}" viewBox="0 0 ${SP_W} ${SP_H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>`;
  }
  function sparkBars(vals, label) {
    const slot = SP_W / vals.length, bw = slot - 1, max = Math.max(1, ...vals);
    let s = svgOpen(label);
    vals.forEach((v, i) => {
      const h = v ? Math.max(2, (v / max) * (SP_H - 2)) : 1.5;
      s += `<rect class="sb${v ? '' : ' zero'}" data-b="${i}" x="${(i * slot).toFixed(2)}" y="${(SP_H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="1"/>`;
    });
    return s + '</svg>';
  }
  function sparkConf(notes) {
    const mins = new Array(SP_BINS).fill(null);
    for (const n of notes) {
      const i = clamp(Math.floor((n[0] / DUR) * SP_BINS), 0, SP_BINS - 1);
      const c = n[5] ?? 1;
      mins[i] = mins[i] == null ? c : Math.min(mins[i], c);
    }
    const vals = mins.filter((v) => v != null);
    const lo = vals.length ? Math.min(...vals) : 1;
    const y0 = Math.min(0.9, Math.floor(lo * 20) / 20);
    const X = (i) => 2 + (i / (SP_BINS - 1)) * (SP_W - 4);
    const Y = (c) => 2 + (1 - (c - y0) / (1 - y0)) * (SP_H - 4);
    let d = '', worst = -1;
    mins.forEach((c, i) => {
      if (c == null) return;
      d += (d ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(c).toFixed(1);
      if (worst < 0 || c < mins[worst]) worst = i;
    });
    let s = svgOpen(`Lowest confidence across the piece: ${(lo * 100).toFixed(1)}%`);
    s += `<line class="sg" x1="0" x2="${SP_W}" y1="${Y(1).toFixed(1)}" y2="${Y(1).toFixed(1)}"/>`;
    if (d) s += `<path class="ln" d="${d}"/><circle class="pt" cx="${X(worst).toFixed(1)}" cy="${Y(mins[worst]).toFixed(1)}" r="2.4"/>`;
    return s + '</svg>';
  }
  let waveBars = null;
  function sparkWave() {
    if (!waveBars) {
      const pk = M.waveform.peak, n = pk.length, N = 19;
      let g = 0;
      for (let i = 0; i < n; i++) if (pk[i] > g) g = pk[i];
      waveBars = [];
      for (let k = 0; k < N; k++) {
        let m = 0;
        for (let i = Math.floor((k / N) * n); i < Math.floor(((k + 1) / N) * n); i++) if (pk[i] > m) m = pk[i];
        waveBars.push(Math.pow(m / (g || 1), 0.9));
      }
    }
    const N = waveBars.length, slot = SP_W / N, bw = 2, mid = SP_H / 2;
    let s = svgOpen('Waveform of the recording; the bright part has been played');
    waveBars.forEach((v, k) => {
      const h = Math.max(1.5, v * (SP_H - 2));
      s += `<rect class="wv" data-t="${(((k + 0.5) / N) * DUR).toFixed(2)}" x="${(k * slot + (slot - bw) / 2).toFixed(2)}" y="${(mid - h / 2).toFixed(2)}" width="${bw}" height="${h.toFixed(2)}" rx="1"/>`;
    });
    return s + '</svg>';
  }
  function sparkSpeed() {
    const took = clamp((STATS.seconds_total / DUR) * SP_W, 3, SP_W);
    let s = svgOpen(`Converted in ${STATS.seconds_total.toFixed(1)} s for ${fmtTime(DUR)} of audio`);
    s += `<rect class="tr" x="0" y="6" width="${SP_W}" height="4" rx="2"/>`;
    s += `<rect class="tk" x="0" y="14" width="${took.toFixed(1)}" height="4" rx="2"/>`;
    return s + '</svg>';
  }
  let sparkBin = -1;
  function updateSparks() {
    const box = $('stats');
    if (!box) return;
    const b = clamp(Math.floor((S.time / DUR) * SP_BINS), 0, SP_BINS - 1);
    if (b !== sparkBin) {
      sparkBin = b;
      box.querySelectorAll('.sb').forEach((r) => r.classList.toggle('cur', Number(r.dataset.b) === b));
    }
    box.querySelectorAll('.wv').forEach((r) => r.classList.toggle('past', Number(r.dataset.t) <= S.time));
  }

  let lastStats = {};
  function renderStats(animate) {
    const d = S.data;
    const n = d.notes.length;
    const dropped = M.notes.length - n;
    const sustain = d.pedals.filter((p) => p[2] === 64).length;
    const soft = d.pedals.filter((p) => p[2] === 67).length;
    let csum = 0, unsure = 0;
    for (const x of d.notes) { const c = x[5] ?? 1; csum += c; if (c < 0.6) unsure++; }
    const conf = n ? csum / n : 0;
    const pedalMode = oVal('pedal');
    const allSustain = M.pedals.filter((p) => p[2] === 64).length;
    const fmtShort = M.file.format.split(' · ').slice(0, 2).join(' · ');
    const pedalTimes = pedalMode === 'none' ? [] : M.pedals.filter((p) => p[2] === 64).map((p) => p[0]);
    const tiles = [
      { k: 'notes', ic: 'i-notes', l: 'Notes', v: n.toLocaleString('en-US'),
        s: dropped ? `${dropped} under ${oVal('min_note_ms')} ms left out` : `${STATS.notes_added_by_aria} recovered by Aria`,
        sp: sparkBars(binCounts(d.notes.map((x) => x[0])), 'Notes across the piece; the bright bar is where the playhead is') },
      { k: 'pedal', ic: 'i-pedal', l: 'Pedal presses',
        v: pedalMode === 'cc' ? String(sustain) : pedalMode === 'extend' ? 'Baked in' : 'Left out',
        s: pedalMode === 'cc' ? (soft ? `+ ${soft} soft pedal` : 'Soft pedal left out') : pedalMode === 'extend' ? `${allSustain} presses in note lengths` : 'No pedal in the file',
        sp: pedalMode === 'cc' ? sparkBars(binCounts(pedalTimes), 'Sustain pedal presses across the piece') : '' },
      { k: 'conf', ic: 'i-target', l: 'Mean confidence', v: n ? `${(conf * 100).toFixed(1)}<small>%</small>` : '–',
        s: unsure ? `${unsure} unsure notes` : 'No unsure notes', sp: n ? sparkConf(d.notes) : '' },
      { k: 'dur', ic: 'i-clock', l: 'Duration', v: fmtTime(DUR), s: fmtShort, sp: sparkWave() },
      { k: 'time', ic: 'i-bolt', l: 'Time taken', v: `${STATS.seconds_total.toFixed(1)}<small>s</small>`,
        s: `${(DUR / STATS.seconds_total).toFixed(1)}× real-time speed`, sp: sparkSpeed() },
    ];
    const box = $('stats');
    box.innerHTML = '';
    for (const t of tiles) {
      const c = el('div', 'stat');
      const l = el('div', 'l');
      l.append(icon(t.ic), document.createTextNode(t.l));
      const row = el('div', 'vrow');
      const v = el('div', 'v');
      v.innerHTML = t.v;
      row.append(v);
      if (t.sp) row.insertAdjacentHTML('beforeend', t.sp);
      const s = el('div', 's', t.s);
      s.title = t.s;
      c.append(l, row, s);
      if (animate && lastStats[t.k] !== undefined && lastStats[t.k] !== t.v + t.s) c.classList.add('flash');
      lastStats[t.k] = t.v + t.s;
      box.append(c);
    }
    sparkBin = -1;
    updateSparks();
  }

  function renderResultHead() {
    $('resName').textContent = S.job.filename;
    $('resName').title = S.job.filename;
    const eng = engineById(S.job.engine);
    const bits = [eng.name];
    if (S.job.eopts.views) bits.push(SHORT_VIEWS[S.job.eopts.views]);
    bits.push(`converted in ${STATS.seconds_total.toFixed(1)} s`);
    bits.push(S.job.when);
    $('resMeta').innerHTML = bits.map(esc).join('<span class="sep">·</span>');
  }

  function applyData(keepView, animate) {
    S.data = derive();
    roll.setData({ notes: S.data.notes, pedals: S.data.pedals, duration: DUR }, { keepView });
    roll.setTime(S.time, S.playing);
    renderStats(animate);
    renderCharts();
    updateTime();
  }

  function showResult(t) {
    S.time = t || 0;
    lastStats = {};
    show('result');
    renderResultHead();
    applyData(false);
    requestAnimationFrame(() => {
      roll._resize();
      roll.setTime(S.time, false);
      renderCharts();
    });
  }

  // ------------------------------------------------------------------ charts
  function niceStep(max, target) {
    const raw = max / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    const b = y + h;
    return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
  }
  function tipAt(host, x, y, html) {
    const tip = host.querySelector('.chart-tip');
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth;
    const cx = clamp(x, w / 2, host.clientWidth - w / 2);
    tip.style.left = cx + 'px';
    tip.style.top = y + 'px';
  }

  function renderVel() {
    const host = $('velChart');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !S.data) return;
    const notes = S.data.notes;
    const bins = new Array(16).fill(0);
    for (const n of notes) bins[clamp(Math.floor(n[3] / 8), 0, 15)]++;
    const maxC = Math.max(1, ...bins);
    const step = niceStep(maxC, 3);
    const top = Math.ceil(maxC / step) * step;
    const padL = 30, padR = 2, padT = 6, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const X = (v) => padL + (v / 128) * pw;
    const Y = (c) => padT + ph - (c / top) * ph;
    const vs = notes.map((n) => n[3]).sort((a, b) => a - b);
    const median = vs.length ? vs[Math.floor(vs.length / 2)] : 0;
    const flat = oVal('velocity') === 'flat';
    let g = `<svg width="${W}" height="${H}" role="img" aria-label="Velocity histogram of ${notes.length} notes. Median velocity ${median}.">`;
    for (let t = 0; t <= top + 1e-9; t += step) {
      const y = Math.round(Y(t)) + 0.5;
      g += `<line class="${t === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end">${t}</text>`;
    }
    const slot = pw / 16;
    const bw = Math.min(24, slot - 2);
    bins.forEach((c, i) => {
      if (!c) return;
      const bx = padL + i * slot + (slot - bw) / 2;
      const by = Y(c);
      g += `<path class="bar-m" data-i="${i}" d="${roundTop(bx, by, bw, padT + ph - by, 4)}"/>`;
    });
    g += `<text x="${padL}" y="${H - 5}" text-anchor="start">1</text><text x="${W - padR}" y="${H - 5}" text-anchor="end">127</text>`;
    for (const [t, v] of DYN) g += `<text class="dyn" x="${X(v).toFixed(1)}" y="${H - 5}" text-anchor="middle">${t}</text>`;
    g += `<rect class="hit" x="${padL}" y="0" width="${pw}" height="${padT + ph}"/></svg><div class="chart-tip" hidden></div>`;
    host.innerHTML = g;
    const dyn = DYN.reduce((best, d) => (Math.abs(d[1] - median) < Math.abs(best[1] - median) ? d : best), DYN[0])[0];
    $('velAside').innerHTML = flat ? `flat <b>${oVal('flat_velocity')}</b>` : `median <b>${median}</b> · <i style="font-family:var(--serif);font-weight:600">${dyn}</i>`;
    $('velSub').textContent = flat ? 'Dynamics set to Flat: every note the same' : 'How hard each key was struck';

    const svg = host.querySelector('svg');
    const hit = svg.querySelector('.hit');
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = clamp(Math.floor((e.clientX - r.left - padL) / slot), 0, 15);
      host.classList.add('hovering');
      svg.querySelectorAll('.bar-m').forEach((b) => b.classList.toggle('hot', Number(b.dataset.i) === i));
      const c = bins[i];
      const pct = notes.length ? Math.round((c / notes.length) * 100) : 0;
      tipAt(host, padL + i * slot + slot / 2, Y(c) - 2,
        `<b>Velocity ${Math.max(1, i * 8)}–${i * 8 + 7}</b><br><span class="tm">${c} notes · ${pct}%</span>`);
    });
    hit.addEventListener('mouseleave', () => { host.classList.remove('hovering'); host.querySelector('.chart-tip').hidden = true; });
  }

  let confGeo = null;
  function renderConf() {
    const host = $('confChart');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !S.data) return;
    const B = 2, nb = Math.ceil(DUR / B);
    const bk = [];
    for (let i = 0; i < nb; i++) bk.push({ t0: i * B, t1: Math.min(DUR, (i + 1) * B), min: 1, sum: 0, count: 0 });
    for (const x of S.data.notes) {
      const b = bk[clamp(Math.floor(x[0] / B), 0, nb - 1)];
      const c = x[5] ?? 1;
      b.count++; b.sum += c; if (c < b.min) b.min = c;
    }
    const filled = bk.filter((b) => b.count);
    const lo = filled.length ? Math.min(...filled.map((b) => b.min)) : 1;
    const yMin = lo >= 0.9 ? 0.9 : Math.floor(lo * 10) / 10;
    const padL = 34, padR = 6, padT = 8, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const X = (t) => padL + (t / DUR) * pw;
    const Y = (c) => padT + (1 - (c - yMin) / (1 - yMin)) * ph;
    confGeo = { X, padT, ph };
    let g = `<svg width="${W}" height="${H}" role="img" aria-label="Lowest note confidence per 2 seconds. Lowest ${(lo * 100).toFixed(1)} percent.">`;
    const mid = (yMin + 1) / 2;
    for (const v of [yMin, mid, 1]) {
      const y = Math.round(Y(v)) + 0.5;
      g += `<line class="${v === yMin ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      g += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    }
    let line = '', area = '', run = [];
    const flush = () => {
      if (!run.length) return;
      line += run.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
      area += 'M' + run[0][0].toFixed(1) + ',' + (padT + ph) + run.map((p) => 'L' + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('') + 'L' + run[run.length - 1][0].toFixed(1) + ',' + (padT + ph) + 'Z';
      run = [];
    };
    for (const b of bk) { if (b.count) run.push([X((b.t0 + b.t1) / 2), Y(b.min)]); else flush(); }
    flush();
    g += `<path class="area" d="${area}"/><path class="line" d="${line}"/>`;
    for (const t of [0, 15, 30, 45, 60]) {
      if (t > DUR) continue;
      g += `<text x="${X(t).toFixed(1)}" y="${H - 5}" text-anchor="${t === 0 ? 'start' : t >= DUR ? 'end' : 'middle'}">${fmtTime(t)}</text>`;
    }
    const worst = filled.reduce((a, b) => (b.min < a.min ? b : a), filled[0] || bk[0]);
    if (filled.length) {
      const wx = X((worst.t0 + worst.t1) / 2), wy = Y(worst.min);
      const right = wx < W - 70;
      g += `<circle class="dot" cx="${wx.toFixed(1)}" cy="${wy.toFixed(1)}" r="4"/>`;
      g += `<text class="lbl" x="${(wx + (right ? 9 : -9)).toFixed(1)}" y="${(wy + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${(worst.min * 100).toFixed(1)}%</text>`;
    }
    const px = X(S.time);
    g += `<line class="ph" id="confPh" x1="${px}" x2="${px}" y1="${padT}" y2="${padT + ph}"/>`;
    g += `<line class="cross" id="confCross" y1="${padT}" y2="${padT + ph}" x1="-9" x2="-9" visibility="hidden"/><circle class="dot" id="confDot" r="4" cx="-9" cy="-9" visibility="hidden"/>`;
    g += `<rect class="hit" x="${padL}" y="0" width="${pw}" height="${padT + ph}"/></svg><div class="chart-tip" hidden></div>`;
    host.innerHTML = g;
    let mean = 0;
    for (const x of S.data.notes) mean += x[5] ?? 1;
    mean = S.data.notes.length ? mean / S.data.notes.length : 0;
    $('confAside').innerHTML = `mean <b>${(mean * 100).toFixed(1)}%</b>`;

    const svg = host.querySelector('svg');
    const hit = svg.querySelector('.hit');
    const pick = (e) => {
      const r = svg.getBoundingClientRect();
      const t = ((e.clientX - r.left - padL) / pw) * DUR;
      return bk[clamp(Math.floor(t / B), 0, nb - 1)];
    };
    hit.addEventListener('mousemove', (e) => {
      const b = pick(e);
      const cx = X((b.t0 + b.t1) / 2);
      const cross = $('confCross'), dot = $('confDot');
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      if (b.count) { dot.setAttribute('cx', cx); dot.setAttribute('cy', Y(b.min)); dot.setAttribute('visibility', 'visible'); }
      else dot.setAttribute('visibility', 'hidden');
      tipAt(host, cx, b.count ? Y(b.min) - 4 : padT,
        b.count
          ? `<b>${fmtTime(b.t0)}–${fmtTime(b.t1)} · lowest ${(b.min * 100).toFixed(1)}%</b><br><span class="tm">${b.count} notes · click to jump here</span>`
          : `<b>${fmtTime(b.t0)}–${fmtTime(b.t1)}</b><br><span class="tm">No notes start here</span>`);
    });
    hit.addEventListener('mouseleave', () => {
      $('confCross').setAttribute('visibility', 'hidden');
      $('confDot').setAttribute('visibility', 'hidden');
      host.querySelector('.chart-tip').hidden = true;
    });
    hit.addEventListener('click', (e) => { const b = pick(e); seek(b.t0); roll.revealTime(b.t0); });
  }

  const chartW = { vel: -1, conf: -1 };
  function renderCharts(force) {
    if (S.view !== 'result') return;
    const vw = $('velChart').clientWidth, cw = $('confChart').clientWidth;
    if (force !== false || vw !== chartW.vel) { chartW.vel = vw; $('velChart').classList.remove('hovering'); renderVel(); }
    if (force !== false || cw !== chartW.conf) { chartW.conf = cw; renderConf(); }
  }
  function updateConfPh() {
    const l = $('confPh');
    if (!l || !confGeo) return;
    const x = confGeo.X(S.time);
    l.setAttribute('x1', x);
    l.setAttribute('x2', x);
  }

  // ------------------------------------------------------------------ transport
  let raf = 0, last = 0;
  function updateTime() {
    $('timeLabel').innerHTML = `${fmtTime(S.time)} <span class="tot">/ ${fmtTime(DUR)}</span>`;
    updateConfPh();
    updateSparks();
  }
  function setPlayUi() {
    $('playBtn').classList.toggle('on', S.playing);
    $('playBtn').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    $('playBtn').title = S.playing ? 'Pause (Space)' : 'Play (Space)';
  }
  function loop() {
    const now = performance.now();
    const dt = clamp((now - last) / 1000, 0, 0.25);
    last = now;
    S.time = Math.min(DUR, S.time + dt);
    roll.setTime(S.time, true);
    updateTime();
    if (S.time >= DUR) { pause(); return; }
    raf = requestAnimationFrame(loop);
  }
  function play() {
    if (S.time >= DUR - 0.05) S.time = 0;
    S.playing = true;
    last = performance.now();
    setPlayUi();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }
  function pause() {
    const was = S.playing;
    S.playing = false;
    cancelAnimationFrame(raf);
    setPlayUi();
    if (was) roll.setTime(S.time, false);
  }
  const togglePlay = () => (S.playing ? pause() : play());
  function seek(t) {
    S.time = clamp(t, 0, DUR);
    roll.setTime(S.time, S.playing);
    updateTime();
  }

  function setMix(mix) {
    S.mix = mix;
    for (const b of $('mixSeg').querySelectorAll('button')) {
      const on = b.dataset.mix === mix;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    $('roll').dataset.mix = mix;
    $('mixHint').textContent = { original: 'Recording only', both: 'Recording + MIDI piano', midi: 'MIDI piano only' }[mix];
  }

  function saveMidi() {
    const name = M.job.midi_name;
    toast(`Saved “${name}” to Downloads`, { label: 'Show in folder', run: () => {} }, 'i-check-circle');
  }

  // ------------------------------------------------------------------ theme
  let themeLocked = Q.get('theme') === 'light' || Q.get('theme') === 'dark';
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeIcon').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
    $('themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    roll._readColors();
    roll._drawKeys();
    roll.requestDraw();
    if (S.view === 'progress') drawWave();
  }

  // ------------------------------------------------------------------ state switching
  function go(state) {
    closeSheet(false);
    hideHelp();
    if (state === 'progress') {
      S.advanced = false;
      S.progEngine = 'ensemble';
      showProgress('static', M.file.name, PROG.progress, DUR);
    } else if (state === 'result' || state === 'advanced') {
      S.advanced = state === 'advanced';
      S.job = { filename: M.job.filename, engine: M.job.engine, eopts: { views: 'channels', rescue: '0.3' }, when: 'Today 14:32' };
      showResult(12);
      if (state === 'advanced') { setAdvanced(true); if (narrowMQ.matches) { S.sheet = true; syncSheet(); } }
    } else {
      S.advanced = false;
      showHome();
    }
    try {
      const q = new URLSearchParams(location.search);
      q.set('state', state);
      history.replaceState(null, '', '?' + q.toString());
    } catch (e) { /* file:// may refuse; harmless */ }
    syncSwitcher();
  }

  // ------------------------------------------------------------------ wiring
  function bind() {
    $('dropzone').addEventListener('click', () => startConversion(M.file.name));
    $('engineSum').addEventListener('click', openAdvanced);
    $('brandHome').addEventListener('click', () => go('home'));
    $('crumbRoot').addEventListener('click', () => go('home'));
    $('newBtn').addEventListener('click', () => { go('home'); $('dropzone').focus(); });
    $('saveBtn').addEventListener('click', saveMidi);
    $('cancelBtn').addEventListener('click', () => {
      const queued = S.progMode === 'queued';
      stopAnim();
      showHome();
      toast(queued ? 'Removed from the queue' : 'Conversion cancelled', null, 'i-info');
    });
    $('retryBtn').addEventListener('click', () => { go('home'); $('dropzone').focus(); });
    $('removeBtn').addEventListener('click', () => {
      S.removed = S.removed || new Set();
      if (S.errorJob) S.removed.add(S.errorJob.id);
      renderRecent();
      showHome();
      toast('Removed from the list', null, 'i-info');
    });
    $('playBtn').addEventListener('click', togglePlay);
    for (const b of $('mixSeg').querySelectorAll('button')) b.addEventListener('click', () => setMix(b.dataset.mix));
    radioKeys($('mixSeg'));
    radioKeys($('instSeg'));
    $('zoomIn').addEventListener('click', () => roll.zoom(1.5));
    $('zoomOut').addEventListener('click', () => roll.zoom(1 / 1.5));
    $('zoomFit').addEventListener('click', () => {
      const f = roll._viewW() / DUR / roll.pxPerSec;
      roll.scrollX = 0;
      roll.zoom(f, 0);
    });
    $('resetBtn').addEventListener('click', () => {
      S.engine = INST.default_engine;
      S.eopts = {};
      S.out = {};
      onEngineChange();
      if (S.view === 'result') applyData(true, true);
      toast('Options reset to defaults', null, 'i-refresh');
    });
    $('optionsBtn').addEventListener('click', () => (S.sheet ? closeSheet(true) : openSheet()));
    $('sheetClose').addEventListener('click', () => closeSheet(true));
    $('scrim').addEventListener('click', () => closeSheet(true));
    $('themeBtn').addEventListener('click', () => {
      themeLocked = true;
      setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { if (!themeLocked) setTheme(e.matches ? 'dark' : 'light'); });
    narrowMQ.addEventListener('change', () => { if (!narrowMQ.matches) S.sheet = false; syncSheet(); hideHelp(); });

    // help popovers in the options panel
    const sb = $('sidebar');
    sb.addEventListener('mouseover', (e) => { const b = e.target.closest('.info'); if (b) showHelp(b); });
    sb.addEventListener('mouseout', (e) => { const b = e.target.closest('.info'); if (b && !b.contains(e.relatedTarget)) hideHelp(); });
    sb.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('info')) showHelp(e.target); else hideHelp(); });
    sb.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('info')) hideHelp(); });
    sb.addEventListener('click', (e) => { const b = e.target.closest('.info'); if (b) showHelp(b); });
    $('sideBody').addEventListener('scroll', hideHelp, { passive: true });

    for (const b of $('switcher').querySelectorAll('button')) b.addEventListener('click', () => go(b.dataset.state));

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('popover').hidden) { hideHelp(); return; }
        if (S.sheet) { closeSheet(true); return; }
      }
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.view === 'result') { e.preventDefault(); saveMidi(); return; }
      if (e.code === 'Space' && S.view === 'result' && !typing && !(S.sheet && narrowMQ.matches)) {
        const onBtn = tag === 'BUTTON' && document.activeElement !== $('playBtn');
        if (onBtn) return;
        e.preventDefault();
        togglePlay();
      }
    });

    // drag and drop anywhere
    let depth = 0;
    const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('dragVeil').hidden = false; $('dropzone').classList.add('over'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { $('dragVeil').hidden = true; $('dropzone').classList.remove('over'); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('dragVeil').hidden = true;
      $('dropzone').classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) startConversion(f.name);
    });

    // keep canvases + charts sharp on resize
    let rt = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(rt);
      rt = requestAnimationFrame(() => { renderCharts(false); if (S.view === 'progress') drawWave(); });
    }).observe($('main'));
  }

  function init() {
    if (Q.get('clean') === '1') $('switcher').hidden = true;
    setTheme(document.documentElement.getAttribute('data-theme') || 'light');
    $('verLine').textContent = `${INFO.app} ${INFO.version}`;
    $('gpuChip').title = `Running on ${INFO.device.name} (${INFO.device.vram_gb} GB)`;
    renderAccuracy();
    renderRecent();
    renderEngineSum();
    bind();
    syncSheet();
    const st = Q.get('state');
    go(['home', 'progress', 'result', 'advanced'].includes(st) ? st : 'home');
  }

  init();
})();
