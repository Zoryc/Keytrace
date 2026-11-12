import { PianoRoll, fmtTime } from './pianoroll.js';
import { Player } from './player.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'midiconv.settings.v1';
const DEPENDS = { flat_velocity: (o) => o.velocity === 'flat' };

const state = {
  info: null,
  instrument: 'piano',
  settings: loadSettings(),
  job: null, // job currently shown (progress or result)
  es: null,
  pollTimer: 0,
  exportTimer: 0,
  recent: [],
};

const roll = new PianoRoll($('roll'), { onSeek: (t) => { player.seek(t); roll.setTime(t, player.playing); updateTime(); } });
const player = new Player({
  onStatus: (s) => { $('pianoStatus').textContent = s; },
  onEnded: () => { setPlaying(false); roll.setTime(player.time, false); updateTime(); },
});

// ------------------------------------------------------------------ settings
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
function instrumentInfo() { return state.info.instruments.find((i) => i.id === state.instrument) || state.info.instruments[0]; }
function engineSettings() {
  const inst = instrumentInfo();
  state.settings.engines ??= {};
  const s = (state.settings.engines[inst.id] ??= { engine: inst.default_engine, options: {} });
  if (!inst.engines.some((e) => e.id === s.engine && e.available)) s.engine = inst.default_engine;
  s.options[s.engine] ??= {};
  return s;
}
function currentEngine() { return instrumentInfo().engines.find((e) => e.id === engineSettings().engine); }
function withDefaults(specs, values) {
  const out = {};
  for (const o of specs) out[o.key] = values?.[o.key] ?? o.default;
  return out;
}
function engineOptions() { const s = engineSettings(); return withDefaults(currentEngine().options, s.options[s.engine]); }
function outputOptions() { return withDefaults(state.info.output_options, state.settings.output); }

// ------------------------------------------------------------------ views
function show(view) {
  for (const v of ['viewDrop', 'viewProgress', 'viewResult']) $(v).hidden = v !== view;
  if (view !== 'viewResult') { player.stop(); setPlaying(false); }
  if (view === 'viewResult') requestAnimationFrame(() => roll._resize());
}

function toast(msg, action = null) {
  const t = $('toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.run(); };
    t.append(b);
  }
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

async function saveMidi(e) {
  const api = window.pywebview?.api;
  if (!api || !state.job) return; // plain download link fallback
  e.preventDefault();
  try {
    const r = await api.save_midi(state.job.id, state.job.midi_name);
    if (r?.saved) toast(`Saved ${r.name}`, { label: 'Show in folder', run: () => api.show_in_folder(r.path) });
    else if (r?.error) toast(r.error);
  } catch {
    toast('Could not save the MIDI file.');
  }
}

function fmtDuration(sec) {
  if (!isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

function renderPicker() {
  const el = $('instrumentPicker');
  el.innerHTML = '';
  for (const inst of state.info.instruments) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(inst.id === state.instrument));
    b.textContent = inst.name;
    b.title = inst.description;
    b.onclick = () => { state.instrument = inst.id; state.settings.instrument = inst.id; saveSettings(); renderAll(); };
    el.append(b);
  }
  const soon = document.createElement('button');
  soon.type = 'button';
  soon.disabled = true;
  soon.innerHTML = 'More instruments <span class="soon">soon</span>';
  el.append(soon);
}

function renderSettingsLine() {
  const eng = currentEngine();
  const eo = engineOptions();
  const views = eng.options.find((o) => o.key === 'views');
  const viewLabel = views ? (views.choices.find((c) => c.value === eo.views)?.label || '') : '';
  const parts = [`<b>${instrumentInfo().name}</b>`, eng.name];
  if (viewLabel) parts.push(viewLabel.replace(/\s*\(.*\)/, '') + (viewLabel.match(/\((.*)\)/) ? ` (${viewLabel.match(/\((.*)\)/)[1]})` : ''));
  $('settingsLine').innerHTML = parts.join('<span class="dot">·</span>') +
    '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px"><path d="M9 6l6 6-6 6"/></svg>';
  $('settingsLine').title = 'Change in Advanced options';
}

function optionControl(spec, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'opt';
  wrap.dataset.key = spec.key;
  const id = `opt-${spec.key}-${Math.random().toString(36).slice(2, 7)}`;
  const row = document.createElement('div');
  row.className = 'opt-row';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = spec.label;
  if (value !== spec.default) label.classList.add('changed-dot');
  row.append(label);
  let input;
  if (spec.kind === 'choice') {
    input = document.createElement('select');
    for (const c of spec.choices) {
      const o = document.createElement('option');
      o.value = c.value; o.textContent = c.label; o.selected = c.value === value;
      input.append(o);
    }
    input.onchange = () => onChange(input.value);
    row.append(input);
  } else if (spec.kind === 'bool') {
    const sw = document.createElement('span');
    sw.className = 'switch';
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.onchange = () => onChange(input.checked);
    sw.append(input, document.createElement('span'));
    row.append(sw);
  } else {
    const box = document.createElement('span');
    input = document.createElement('input');
    input.type = 'number';
    if (spec.min != null) input.min = spec.min;
    if (spec.max != null) input.max = spec.max;
    if (spec.step != null) input.step = spec.step;
    input.value = value;
    input.onchange = () => {
      let v = Number(input.value);
      if (!isFinite(v)) v = spec.default;
      if (spec.min != null) v = Math.max(spec.min, v);
      if (spec.max != null) v = Math.min(spec.max, v);
      input.value = v;
      onChange(v);
    };
    box.append(input);
    if (spec.unit) { const u = document.createElement('span'); u.className = 'unit'; u.textContent = spec.unit; box.append(u); }
    row.append(box);
  }
  input.id = id;
  wrap.append(row);
  if (spec.help) { const p = document.createElement('p'); p.className = 'help'; p.textContent = spec.help; wrap.append(p); }
  return wrap;
}

function renderDrawer() {
  const inst = instrumentInfo();
  const es = engineSettings();
  const engBox = $('engineOptions');
  engBox.innerHTML = '';
  const engines = inst.engines;
  if (engines.length > 1) {
    const spec = {
      key: 'engine', label: 'Engine', kind: 'choice', default: inst.default_engine,
      choices: engines.map((e) => ({ value: e.id, label: e.name + (e.available ? '' : ' (not installed)') })),
    };
    const ctl = optionControl(spec, es.engine, (v) => {
      const target = engines.find((e) => e.id === v);
      if (!target?.available) { toast(target?.unavailable_reason || 'This engine is not installed.'); renderDrawer(); return; }
      es.engine = v; saveSettings(); renderAll();
    });
    engBox.append(ctl);
  }
  const eng = currentEngine();
  const summary = document.createElement('p');
  summary.className = 'engine-summary';
  summary.textContent = eng.summary;
  engBox.append(summary);
  const eo = engineOptions();
  for (const spec of eng.options) {
    engBox.append(optionControl(spec, eo[spec.key], (v) => {
      es.options[es.engine][spec.key] = v;
      saveSettings();
      renderDrawer();
      renderSettingsLine();
    }));
  }

  const outBox = $('outputOptions');
  outBox.innerHTML = '';
  const oo = outputOptions();
  for (const spec of state.info.output_options) {
    const ctl = optionControl(spec, oo[spec.key], (v) => {
      state.settings.output ??= {};
      state.settings.output[spec.key] = v;
      saveSettings();
      renderDrawer();
      scheduleReexport();
    });
    if (DEPENDS[spec.key] && !DEPENDS[spec.key](oo)) ctl.hidden = true;
    outBox.append(ctl);
  }
  const done = state.job?.status === 'done' && !$('viewResult').hidden;
  $('outputNote').textContent = done ? 'Changes update the open result instantly.' : 'Applied when the file is written.';
  $('rerunBtn').hidden = !(done && engineDiffers(state.job));
}

function engineDiffers(job) {
  if (!job) return false;
  if (job.engine !== engineSettings().engine || job.instrument !== state.instrument) return true;
  const eo = engineOptions();
  return Object.keys(eo).some((k) => String(eo[k]) !== String(job.engine_options?.[k]));
}

function renderAll() {
  renderPicker();
  renderSettingsLine();
  renderDrawer();
}

// ------------------------------------------------------------------ drawer
function openDrawer() {
  renderDrawer();
  $('scrim').hidden = false;
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('closeAdvanced').focus(), 50);
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
}

// ------------------------------------------------------------------ conversion
function startConversion(file, rerunOf = null) {
  if (!file && !rerunOf) return;
  closeDrawer();
  stopWatching();
  const name = file ? file.name : rerunOf.filename;
  $('progressName').textContent = name;
  $('progressHint').textContent = '';
  $('errorBox').hidden = true;
  $('cancelBtn').hidden = false;
  setProgress(0, file ? 'Uploading' : 'Starting', !file);
  show('viewProgress');

  const body = {
    instrument: state.instrument,
    engine: engineSettings().engine,
    engine_options: engineOptions(),
    output_options: outputOptions(),
  };
  if (rerunOf) {
    fetch(`/api/jobs/${rerunOf.id}/rerun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).detail || r.statusText); return r.json(); })
      .then((job) => { state.job = job; watch(job.id); refreshRecent(); })
      .catch((e) => showError(e.message));
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('instrument', body.instrument);
  fd.append('engine', body.engine);
  fd.append('engine_options', JSON.stringify(body.engine_options));
  fd.append('output_options', JSON.stringify(body.output_options));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/jobs');
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) setProgress(0, `Uploading ${Math.round((100 * e.loaded) / e.total)}%`, false, 0);
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      state.job = xhr.response;
      watch(state.job.id);
      refreshRecent();
    } else {
      showError(xhr.response?.detail || `Upload failed (${xhr.status}).`);
    }
  };
  xhr.onerror = () => showError('Could not reach the converter. Is it still running?');
  state.uploadXhr = xhr;
  xhr.send(fd);
}

function setProgress(frac, msg, indeterminate = false, pctOverride = null) {
  const pct = Math.round((pctOverride ?? frac) * 100);
  $('progressPct').textContent = indeterminate ? '' : `${pct}%`;
  $('progressMsg').textContent = msg;
  const bar = $('progressBar');
  bar.classList.toggle('indeterminate', indeterminate);
  bar.querySelector('span').style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
}

function showError(msg) {
  $('errorText').textContent = msg;
  $('errorBox').hidden = false;
  $('cancelBtn').hidden = true;
  setProgress(0, 'Something went wrong');
  show('viewProgress');
}

function stopWatching() {
  if (state.es) { state.es.close(); state.es = null; }
  clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

function watch(id) {
  stopWatching();
  setHash(id);
  const es = new EventSource(`/api/jobs/${id}/events`);
  state.es = es;
  es.addEventListener('job', (e) => onJobUpdate(JSON.parse(e.data)));
  es.addEventListener('end', () => stopWatching());
  es.onerror = () => {
    // Fall back to polling if the stream drops before the job finishes.
    es.close();
    if (state.es !== es) return;
    state.es = null;
    state.pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (r.status === 404) { stopWatching(); return; }
        const job = await r.json();
        onJobUpdate(job);
        if (['done', 'error', 'cancelled'].includes(job.status)) stopWatching();
      } catch { /* server restarting */ }
    }, 1000);
  };
}

function etaText(job) {
  const now = performance.now();
  const e = state.eta;
  if (!e || e.id !== job.id || job.progress < e.p0) { state.eta = { id: job.id, t0: now, p0: job.progress }; return 'Estimating time left…'; }
  const dp = job.progress - e.p0, dt = (now - e.t0) / 1000;
  if (dp < 0.03 || dt < 3) return 'Estimating time left…';
  const left = (dt / dp) * (1 - job.progress);
  return left < 10 ? 'Almost done' : `About ${fmtDuration(left)} left`;
}

function updateRecentStatus(job) {
  const li = [...$('recentList').children].find((x) => x.dataset.id === job.id);
  const badge = li?.querySelector('.r-status');
  if (!badge) return;
  if (job.status === 'running') { badge.className = 'r-status running'; badge.textContent = `${Math.round(job.progress * 100)}%`; }
  else if (job.status === 'queued') { badge.className = 'r-status'; badge.textContent = 'Waiting'; }
}

function onJobUpdate(job) {
  updateRecentStatus(job);
  if (state.job && job.id !== state.job.id) return;
  state.job = job;
  if (job.status === 'queued') {
    const ahead = job.queue_position > 0 ? `${job.queue_position} conversion${job.queue_position > 1 ? 's' : ''} ahead` : 'Starting soon';
    setProgress(0, `Waiting · ${ahead}`, true);
  } else if (job.status === 'running') {
    setProgress(job.progress, job.message || 'Working');
    $('progressHint').textContent = etaText(job);
  } else if (job.status === 'done') {
    stopWatching();
    openResult(job);
    refreshRecent();
  } else if (job.status === 'error') {
    stopWatching();
    showError(job.error || 'The conversion failed.');
    refreshRecent();
  } else if (job.status === 'cancelled') {
    stopWatching();
    toast('Conversion cancelled');
    goHome();
    refreshRecent();
  }
}

async function openResult(job) {
  state.job = job;
  setHash(job.id);
  try {
    const r = await fetch(`/api/jobs/${job.id}/notes`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const data = await r.json();
    applyResultData(job, data);
    show('viewResult');
    player.setAudio(`/api/jobs/${job.id}/audio`, data.duration);
    markCurrentRecent();
    renderDrawer();
  } catch {
    toast('Could not open this result.');
    goHome();
  }
}

function applyResultData(job, data, keepView = false) {
  const notes = data.tracks.flatMap((t) => t.notes);
  const pedals = data.tracks.flatMap((t) => t.pedals);
  roll.setData({ notes, pedals, duration: data.duration }, { keepView });
  player.setNotes(notes, data.duration);
  setPlaying(false);
  updateTime();
  const st = data.stats || job.stats || {};
  $('resultName').textContent = job.filename;
  $('resultName').title = job.filename;
  const sustain = pedals.filter((p) => p[2] === 64).length;
  const bits = [
    fmtTime(data.duration),
    `${(st.notes ?? notes.length).toLocaleString()} notes`,
    sustain ? `${sustain} pedal presses` : null,
    st.engine_name ? `${st.engine_name}` : null,
    st.seconds_total ? `converted in ${fmtDuration(st.seconds_total)}` : null,
  ].filter(Boolean);
  $('resultMeta').innerHTML = bits.map(escapeHtml).join('<span class="sep">·</span>');
  const dl = $('downloadBtn');
  dl.href = `/api/jobs/${job.id}/midi?v=${job.version}`;
  dl.setAttribute('download', job.midi_name || 'transcription.mid');
}

function scheduleReexport() {
  const job = state.job;
  if (!job || job.status !== 'done' || $('viewResult').hidden) return;
  clearTimeout(state.exportTimer);
  state.exportTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/jobs/${job.id}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output_options: outputOptions() }),
      });
      if (!r.ok) throw new Error();
      const updated = await r.json();
      const n = await (await fetch(`/api/jobs/${job.id}/notes`, { cache: 'no-store' })).json();
      const t = player.time;
      const wasPlaying = player.playing;
      state.job = updated;
      applyResultData(updated, n, true);
      player.seek(t);
      if (wasPlaying) { setPlaying(true); player.play(); }
      roll.setTime(t, player.playing);
      updateTime();
      toast('MIDI updated');
    } catch {
      toast('Could not update the MIDI file.');
    }
  }, 350);
}

function goHome() {
  stopWatching();
  state.job = null;
  setHash(null);
  show('viewDrop');
  markCurrentRecent();
}

function setHash(id) {
  const h = id ? `#/job/${id}` : '';
  if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ recent
async function refreshRecent() {
  try {
    state.recent = await (await fetch('/api/jobs', { cache: 'no-store' })).json();
  } catch { return; }
  const list = $('recentList');
  list.innerHTML = '';
  const items = state.recent.slice(0, 12);
  $('recent').hidden = items.length === 0;
  for (const job of items) {
    const li = document.createElement('li');
    li.dataset.id = job.id;
    li.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'r-name';
    name.textContent = job.filename;
    const meta = document.createElement('span');
    meta.className = 'r-meta';
    const when = new Date(job.created * 1000);
    const st = job.stats || {};
    meta.textContent = [st.duration ? fmtTime(st.duration) : null, st.notes != null ? `${st.notes.toLocaleString()} notes` : null,
      when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })]
      .filter(Boolean).join(' · ');
    li.append(name, meta);
    if (job.status !== 'done') {
      const s = document.createElement('span');
      s.className = `r-status ${job.status}`;
      s.textContent = { queued: 'Waiting', running: `${Math.round(job.progress * 100)}%`, error: 'Failed', cancelled: 'Cancelled' }[job.status] || job.status;
      li.append(s);
    }
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.setAttribute('aria-label', `Remove ${job.filename}`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
      if (state.job?.id === job.id) goHome();
      refreshRecent();
    };
    li.append(del);
    const open = () => openJob(job);
    li.onclick = open;
    li.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    list.append(li);
  }
  markCurrentRecent();
}

function markCurrentRecent() {
  for (const li of $('recentList').children) li.classList.toggle('current', li.dataset.id === state.job?.id && !$('viewResult').hidden);
}

function openJob(job) {
  if (job.status === 'done') { stopWatching(); openResult(job); return; }
  if (job.status === 'queued' || job.status === 'running') {
    state.job = job;
    $('progressName').textContent = job.filename;
    $('errorBox').hidden = true;
    $('cancelBtn').hidden = false;
    show('viewProgress');
    onJobUpdate(job);
    watch(job.id);
    return;
  }
  state.job = job;
  $('progressName').textContent = job.filename;
  if (job.status === 'error') showError(job.error || 'The conversion failed.');
  else toast('This conversion was cancelled.');
}

// ------------------------------------------------------------------ transport
function setPlaying(on) {
  $('playBtn').classList.toggle('playing', on);
  $('playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
}
function updateTime() {
  $('timeLabel').textContent = `${fmtTime(player.time)} / ${fmtTime(player.duration)}`;
}
function frame() {
  if (player.playing) {
    const t = player.time;
    roll.setTime(t, true);
    updateTime();
  }
  requestAnimationFrame(frame);
}
async function togglePlay() {
  if (player.playing) {
    player.pause();
    setPlaying(false);
    roll.setTime(player.time, false);
  } else {
    setPlaying(true);
    await player.play();
    if (!player.playing) setPlaying(false);
  }
}

// ------------------------------------------------------------------ wiring
function bind() {
  const input = $('fileInput');
  input.onchange = () => { if (input.files[0]) startConversion(input.files[0]); input.value = ''; };
  $('dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('dropOverlay').hidden = false; $('dropzone').classList.add('over'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { $('dropOverlay').hidden = true; $('dropzone').classList.remove('over'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('dropOverlay').hidden = true;
    $('dropzone').classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) startConversion(f);
  });

  $('openAdvanced').onclick = openDrawer;
  $('settingsLine').onclick = openDrawer;
  $('closeAdvanced').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;
  $('resetBtn').onclick = () => {
    const inst = instrumentInfo();
    state.settings.engines = { ...(state.settings.engines || {}), [inst.id]: { engine: inst.default_engine, options: {} } };
    state.settings.output = {};
    saveSettings();
    renderAll();
    scheduleReexport();
    toast('Options reset');
  };
  $('rerunBtn').onclick = () => { if (state.job) startConversion(null, state.job); };
  $('cancelBtn').onclick = async () => {
    if (state.uploadXhr && state.uploadXhr.readyState !== 4) { state.uploadXhr.abort(); goHome(); return; }
    if (state.job) await fetch(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' });
  };
  $('retryBtn').onclick = goHome;
  $('newBtn').onclick = goHome;
  $('downloadBtn').onclick = saveMidi;
  $('home').onclick = (e) => { e.preventDefault(); goHome(); };

  $('playBtn').onclick = togglePlay;
  for (const b of $('mixSeg').querySelectorAll('button')) {
    b.onclick = () => {
      for (const x of $('mixSeg').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
      player.setMix(b.dataset.mix);
    };
  }
  $('zoomIn').onclick = () => roll.zoom(1.5);
  $('zoomOut').onclick = () => roll.zoom(1 / 1.5);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').classList.contains('open')) { closeDrawer(); return; }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.code === 'Space' && !typing && !$('viewResult').hidden && !$('drawer').classList.contains('open')) {
      e.preventDefault();
      togglePlay();
    }
  });
}

async function init() {
  bind();
  requestAnimationFrame(frame);
  try {
    state.info = await (await fetch('/api/info')).json();
  } catch {
    document.body.innerHTML = '<p style="padding:40px;font:16px system-ui">The converter engine is not responding. Close MIDI Converter and open it again.</p>';
    return;
  }
  if (state.settings.instrument && state.info.instruments.some((i) => i.id === state.settings.instrument)) state.instrument = state.settings.instrument;
  const dev = state.info.device;
  $('device').hidden = false;
  $('device').textContent = dev.kind === 'gpu' ? dev.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '') : 'CPU only (slow)';
  $('device').classList.toggle('cpu', dev.kind !== 'gpu');
  $('device').title = dev.kind === 'gpu' ? `Running on ${dev.name}` : 'No CUDA GPU found: conversions will be slow';
  $('aboutLine').textContent = `${state.info.app} ${state.info.version}`;
  renderAll();
  await refreshRecent();
  const m = location.hash.match(/^#\/job\/(\w+)/);
  if (m) {
    const job = state.recent.find((j) => j.id === m[1]);
    if (job) openJob(job); else setHash(null);
  }
  window.midiconvReady = true;
}

// Called by the desktop shell for files opened with the app (Open with, right-click, second launch).
window.midiconvConvertPaths = async (paths) => {
  let first = true;
  for (const path of paths) {
    try {
      const r = await fetch('/api/jobs/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path, instrument: state.instrument, engine: engineSettings().engine,
          engine_options: engineOptions(), output_options: outputOptions(),
        }),
      });
      const job = await r.json();
      if (!r.ok) { toast(job.detail || 'Could not open that file.'); continue; }
      if (first) {
        first = false;
        closeDrawer();
        state.job = job;
        $('progressName').textContent = job.filename;
        $('progressHint').textContent = '';
        $('errorBox').hidden = true;
        $('cancelBtn').hidden = false;
        show('viewProgress');
        onJobUpdate(job);
        watch(job.id);
      }
    } catch {
      toast('Could not open that file.');
    }
  }
  if (paths.length > 1) toast(`${paths.length} files added`);
  refreshRecent();
};

init();
