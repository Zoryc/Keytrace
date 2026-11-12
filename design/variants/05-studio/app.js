/* MIDI Converter · Studio prototype. Classic script, no network, opens from file://. */
(function () {
'use strict';

// ------------------------------------------------------------------ data
const M = window.MOCK;
const R = window.MCRoll || {};
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = R.noteName || ((p) => NAMES[p % 12] + (Math.floor(p / 12) - 1));
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const isBlack = (p) => BLACK[p % 12];
const fmtTime = (t) => { t = Math.max(0, t); const w = Math.floor(t + 1e-6); return Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0'); };
const fmtTenth = (t) => { const d = Math.floor(Math.max(0, t) * 10 + 1e-6); const m = Math.floor(d / 600); return m + ':' + ((d - m * 600) / 10).toFixed(1).padStart(4, '0'); };
const fmtLen = (sec) => sec < 1 ? Math.round(sec * 1000) + ' ms' : sec.toFixed(2) + ' s';

const INFO = M.info;
const INST = INFO.instruments[0];
const ENGINES = INST.engines;
const OUTS = INFO.output_options;
const DEVICE = INFO.device;
const GPU_SHORT = DEVICE.kind === 'gpu' ? DEVICE.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '') : 'CPU only';
const JOB = M.job;
const STATS = JOB.stats;
const DUR = STATS.duration || M.duration || 60;
const NOTES = M.notes.slice().sort((a, b) => a[0] - b[0]);
const SUS = M.pedals.filter((p) => p[2] === 64);
const SOFT = M.pedals.filter((p) => p[2] === 67);
const WF = M.waveform;
const WINDOWS = M.progress.windows || 9;
let LO = 127, HI = 0, MAXSPAN = 0;
for (const n of NOTES) { LO = Math.min(LO, n[2]); HI = Math.max(HI, n[2]); MAXSPAN = Math.max(MAXSPAN, (n[4] || n[1]) - n[0]); }
LO = Math.max(21, LO - 2); HI = Math.min(108, HI + 2);

const engById = (id) => ENGINES.find((e) => e.id === id) || ENGINES[0];
function defaultEopt() { const o = {}; for (const e of ENGINES) for (const s of e.options) if (!(s.key in o)) o[s.key] = s.default; return o; }
function defaultOut() { const o = {}; for (const s of OUTS) o[s.key] = s.default; return o; }
const ALL_EOPT_SPECS = {};
for (const e of ENGINES) for (const s of e.options) if (!ALL_EOPT_SPECS[s.key]) ALL_EOPT_SPECS[s.key] = s;
const TRANSKUN = engById('transkun');

// ------------------------------------------------------------------ state
const S = {
  view: 'home',
  advanced: false,
  engine: INST.default_engine,
  eopt: defaultEopt(),
  out: defaultOut(),
  used: null,
  file: JOB.filename,
  midiName: JOB.midi_name,
  time: 0,
  playing: false,
  loop: false, loopA: 8, loopB: 16,
  mute: { audio: false, midi: false },
  solo: { audio: false, midi: false },
  collapsed: {},
  more: true,
  progress: null,
  activeId: null,
  hover: null,
  gpu: 0.03,
};
const V = { pps: 30, sx: 0, userScrolledAt: 0, needsFit: true };

// ------------------------------------------------------------------ help texts (info view)
const HELP = {
  engine: () => { const e = engById(S.engine); return { t: e.name, b: e.summary }; },
  instrument: { t: 'Instrument', b: 'Piano is the first instrument. Engines are plug-ins, so the list grows as new ones are added.' },
  mix: { t: 'Listen', b: 'Hear the original recording, the MIDI played on a piano, or both together. The M (mute) and S (solo) buttons on each track do the same.' },
  ms: { t: 'Mute and solo', b: 'M silences a track, S plays only that track. Use them to compare the MIDI with the recording.' },
  loop: { t: 'Loop', b: 'Repeats the marked bars. Drag along the top edge of the ruler to mark different bars.' },
  gpu: { t: 'Graphics card', b: 'Conversions run on ' + DEVICE.name + ' (' + DEVICE.vram_gb + ' GB). Without a CUDA graphics card they fall back to the processor and are much slower.' },
  rerun: { t: 'Re-convert', b: 'Engine settings only change new conversions. Re-convert this recording to hear their effect.' },
  reset: { t: 'Reset to defaults', b: 'Puts every engine and MIDI file option back to the measured-best defaults.' },
  accuracy: { t: 'Measured accuracy', b: 'Note-onset F1 on 12 two-minute MAESTRO test excerpts, clean and degraded to imitate real recordings. A note counts when its pitch is right and it starts within 50 ms.' },
};
for (const e of ENGINES) for (const s of e.options) HELP['eopt.' + s.key] = { t: s.label, b: s.help };
for (const s of OUTS) HELP['out.' + s.key] = { t: s.label, b: s.help };
HELP.tempo = HELP['out.tempo'];
HELP.pedal = HELP['out.pedal'];
HELP.soft_pedal = HELP['out.soft_pedal'];
function helpFor(key) {
  if (!key) return null;
  if (key.startsWith('engine:')) { const e = engById(key.slice(7)); return { t: e.name, b: e.summary }; }
  const h = HELP[key];
  return typeof h === 'function' ? h() : h || null;
}

// ------------------------------------------------------------------ derived
let notesCache = null, notesKey = '';
function displayNotes() {
  const key = String(S.out.min_note_ms);
  if (key !== notesKey) {
    const minS = (+S.out.min_note_ms || 0) / 1000;
    notesCache = minS > 0 ? NOTES.filter((n) => n[1] - n[0] >= minS - 1e-9) : NOTES;
    notesKey = key;
  }
  return notesCache;
}
function viewsLabel(eopt) {
  const spec = ALL_EOPT_SPECS.views;
  const c = spec && spec.choices.find((x) => x.value === eopt.views);
  return c ? c.label : '';
}
function shortViews(eopt) {
  return { none: 'Single view', channels: 'Stereo views 4x', full: 'Stereo + tone views 6x' }[eopt.views] || viewsLabel(eopt);
}
function engineLine(engine, eopt) {
  const e = engById(engine);
  const short = engine === 'ensemble' ? 'Ensemble' : e.name;
  return e.options.some((o) => o.key === 'views') ? short + ' · ' + shortViews(eopt) : short;
}
function audible(lane) {
  const anySolo = S.solo.audio || S.solo.midi;
  return !S.mute[lane] && (!anySolo || S.solo[lane]);
}
function mixState() {
  const a = audible('audio'), m = audible('midi');
  return a && m ? 'both' : a ? 'original' : m ? 'midi' : 'none';
}
function sameEngine(a, b) { return a && b && a.engine === b.engine && JSON.stringify(a.eopt) === JSON.stringify(b.eopt); }
const snapshotEngine = () => ({ engine: S.engine, eopt: Object.assign({}, S.eopt) });

// progress model: decode 0–6 %, Transkun windows 6–80 %, Aria 80–94 %, merge 94–100 %
const SPLIT = { decode: [0, 0.06], transkun: [0.06, 0.8], aria: [0.8, 0.94], fuse: [0.94, 1] };
function stagesFor(engine, eopt) {
  const views = { none: 1, channels: 4, full: 6 }[eopt.views] || 4;
  const st = [{ id: 'decode', label: 'Read audio' }];
  if (engine !== 'aria') st.push({ id: 'transkun', label: 'Transkun V2 · ' + views + (views === 1 ? ' view' : ' views') });
  if (engine === 'aria') st.push({ id: 'transkun', label: 'Aria-AMT' });
  if (engine === 'ensemble') st.push({ id: 'aria', label: 'Aria-AMT second opinion' });
  st.push({ id: 'fuse', label: 'Merge + write MIDI' });
  return st;
}
function progInfo() {
  const p = S.progress ? S.progress.p : 0;
  let stage = 'fuse';
  for (const id of ['decode', 'transkun', 'aria', 'fuse']) { if (p < SPLIT[id][1]) { stage = id; break; } }
  if (S.engine !== 'ensemble' && stage === 'aria') stage = 'fuse';
  const [a, b] = SPLIT.transkun;
  const wf = clamp((p - a) / (b - a), 0, 1) * WINDOWS;
  const win = Math.min(WINDOWS, Math.floor(wf) + 1);
  const msg = stage === 'decode' ? 'Reading audio'
    : stage === 'transkun' ? 'Transcribing window ' + win + ' of ' + WINDOWS
    : stage === 'aria' ? 'Aria-AMT is double-checking unsure notes'
    : 'Merging and writing the MIDI file';
  const revealT = stage === 'decode' ? 0 : (wf / WINDOWS) * DUR;
  const eta = Math.max(1, Math.round((1 - p) * 26));
  return { p, stage, wf, win, msg, revealT, eta };
}

// ------------------------------------------------------------------ dom refs
const body = document.body;
const el = {
  lanes: $('lanes'), lanesCv: $('lanesCanvas'), rulerCv: $('rulerCanvas'), ovCv: $('ovCanvas'), kbdCv: $('kbdCanvas'),
  tip: $('tip'), inspBody: $('inspBody'),
};
if (qs.get('clean') === '1') body.classList.add('clean');
const mqInsp = matchMedia('(max-width: 1179px)');
const mqBrowser = matchMedia('(max-width: 1023px)');

// ------------------------------------------------------------------ toast + status flash
let toastTimer = 0;
function toast(msg, opts) {
  opts = opts || {};
  const t = $('toast');
  t.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  t.innerHTML = '';
  const m = document.createElement('span'); m.className = 't-msg'; m.textContent = msg; t.append(m);
  if (opts.action) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 't-act'; b.textContent = opts.action.label;
    b.onclick = () => { t.classList.remove('show'); opts.action.run && opts.action.run(); };
    t.append(b);
  }
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), opts.action ? 5200 : 2600);
}
let flashTimer = 0;
function flash(html) {
  S.flash = html;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { S.flash = null; renderStatusMsg(); }, 2600);
  renderStatusMsg();
}
function clearFlash() { S.flash = null; clearTimeout(flashTimer); }

// ------------------------------------------------------------------ chrome rendering
function renderAll() {
  body.classList.toggle('view-home', S.view === 'home');
  body.classList.toggle('view-progress', S.view === 'progress');
  body.classList.toggle('view-result', S.view === 'result');
  renderTransport();
  renderToolbar();
  renderHeaders();
  renderBrowser();
  renderInspector();
  renderStatus();
  renderSwitcher();
  draw();
}

function renderTransport() {
  const res = S.view === 'result';
  for (const id of ['startBtn', 'playBtn', 'stopBtn', 'loopBtn']) $(id).disabled = !res;
  $('saveBtn').disabled = !res;
  $('playBtn').classList.toggle('on', S.playing);
  $('playBtn').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  $('loopBtn').setAttribute('aria-pressed', String(S.loop));
  $('render').hidden = S.view !== 'progress';
  $('cancelBtn').hidden = S.view !== 'progress';
  $('newBtn').hidden = S.view === 'progress';
  $('advBtn').setAttribute('aria-pressed', String(S.advanced));
  $('lcdDur').textContent = S.view === 'home' ? '0:00' : fmtTime(DUR);
  if (document.activeElement !== $('tempoField')) $('tempoField').value = S.out.tempo;
  renderLcd();
  renderRender();
  renderMeter();
}
function renderLcd() {
  $('lcdTime').textContent = fmtTenth(S.time);
  const beat = 60 / S.out.tempo;
  const b = S.time / beat + 1e-7;
  const bar = Math.floor(b / 4) + 1, bt = Math.floor(b % 4) + 1, tick = Math.floor((b - Math.floor(b)) * 960);
  $('lcdBars').textContent = bar + '.' + bt + '.' + String(tick).padStart(3, '0');
}
function renderRender() {
  if (S.view !== 'progress') return;
  const pi = progInfo();
  const pct = Math.round(pi.p * 100);
  $('renderFile').textContent = S.file;
  $('renderFile').title = S.file;
  $('renderPct').textContent = pct + '%';
  $('renderFill').style.width = (pi.p * 100).toFixed(1) + '%';
  $('renderBar').setAttribute('aria-valuenow', String(pct));
  $('renderMsg').textContent = pi.msg;
  $('renderEta').textContent = pi.eta < 5 ? 'Almost done' : 'About ' + pi.eta + ' s left';
}
function buildLeds(id) { const box = $(id); if (!box.children.length) for (let i = 0; i < 12; i++) box.append(document.createElement('i')); return box.children; }
function renderMeter() {
  const busy = S.view === 'progress';
  const g = S.gpu;
  const leds = buildLeds('gpuLeds');
  const on = Math.round(g * leds.length);
  for (let i = 0; i < leds.length; i++) leds[i].className = i < on ? 'on' + (i >= 10 ? ' hot' : i >= 7 ? ' mid' : '') : '';
  $('gpuPct').textContent = Math.round(g * 100) + '%';
  const vram = busy ? 6.8 : 2.4;
  const vl = buildLeds('vramLeds');
  const von = Math.max(1, Math.round((vram / DEVICE.vram_gb) * vl.length));
  for (let i = 0; i < vl.length; i++) vl[i].className = i < von ? 'on' : '';
  $('vramVal').textContent = vram.toFixed(1) + ' GB';
  $('gpuName').textContent = GPU_SHORT;
}

function renderToolbar() {
  const t = $('clipTitle'), m = $('clipMeta');
  if (S.view === 'home') {
    t.textContent = 'No recording yet';
    m.textContent = 'Drop a recording to convert it to MIDI';
  } else if (S.view === 'progress') {
    t.textContent = S.file;
    m.innerHTML = esc(fmtTime(DUR)) + '<span class="sep">·</span>' + esc(M.file.format) + '<span class="sep">·</span>Converting with ' + esc(engById(S.engine).name);
  } else {
    t.textContent = S.file;
    const used = S.used || snapshotEngine();
    const n = displayNotes().length;
    const ped = S.out.pedal === 'cc' ? SUS.length + ' pedal presses' : S.out.pedal === 'extend' ? 'pedal baked into notes' : 'no pedal';
    const bits = [fmtTime(DUR), n.toLocaleString() + ' notes', ped, engById(used.engine).name, 'converted in ' + STATS.seconds_total.toFixed(1) + ' s'];
    m.innerHTML = bits.map((b, i) => i === 0 || i === 1 ? '<b>' + esc(b) + '</b>' : esc(b)).join('<span class="sep">·</span>');
  }
  t.title = t.textContent;
  const mix = mixState();
  const live = S.view === 'result';
  for (const b of $('monitorSeg').children) {
    b.setAttribute('aria-checked', String(b.dataset.mix === mix));
    b.disabled = !live;
  }
  $('monitorSeg').classList.toggle('is-disabled', !live);
  rovingTabindex($('monitorSeg'));
  for (const id of ['zoomOut', 'zoomIn', 'zoomFit']) $(id).disabled = S.view === 'home';
}

function renderHeaders() {
  const live = S.view !== 'home';
  $('audioSub').textContent = live ? M.file.format.replace(' · 320 kbps', '') : 'Drop a recording';
  if (S.view === 'progress') $('midiSub').textContent = 'Transcribing…';
  else if (S.view === 'result') $('midiSub').textContent = displayNotes().length.toLocaleString() + ' notes';
  else $('midiSub').textContent = 'Not converted yet';
  document.querySelectorAll('.ms').forEach((b) => {
    const lane = b.dataset.lane, kind = b.dataset.ms;
    b.setAttribute('aria-pressed', String(!!S[kind][lane]));
    b.disabled = S.view !== 'result';
  });
  const sus = $('susSeg');
  for (const b of sus.children) { b.setAttribute('aria-checked', String(b.dataset.val === S.out.pedal)); b.disabled = !live; }
  rovingTabindex(sus);
  // the legend follows the MIDI file options
  const flat = S.out.velocity === 'flat';
  $('lgNote').textContent = S.out.pedal === 'extend' ? 'Note incl. pedal' : 'Key held';
  $('lgTailRow').hidden = S.out.pedal !== 'cc';
  $('lgVel').textContent = flat ? 'All at velocity ' + S.out.flat_velocity : 'Brighter = louder';
  $('lgVelRow').classList.toggle('flat', flat);
  const soft = document.querySelector('.t-soft .tgl');
  soft.setAttribute('aria-checked', String(!!S.out.soft_pedal));
  soft.querySelector('.tgl-txt').textContent = S.out.soft_pedal ? 'On' : 'Off';
  soft.disabled = !live;
}

function renderStatus() {
  const dot = $('sbDot');
  dot.className = 'dot' + (S.view === 'progress' ? ' busy' : '');
  $('sbState').textContent = S.view === 'progress' ? 'Converting' : 'Ready';
  $('sbEngine').textContent = INST.name + ' · ' + engById(S.engine).name + ' · ' + (engById(S.engine).options.some((o) => o.key === 'views') ? viewsLabel(S.eopt) : 'no extra settings');
  $('sbDevice').textContent = GPU_SHORT + ' · ' + DEVICE.vram_gb + ' GB';
  $('sbVer').textContent = INFO.app + ' ' + INFO.version;
  const list = recentList();
  const waiting = list.filter((r) => r.status === 'queued').length;
  const running = list.filter((r) => r.status === 'running' && r.id !== 'current').length;
  const parts = [];
  if (running) parts.push(running + ' converting');
  if (waiting) parts.push(waiting + ' waiting');
  $('sbQueue').textContent = parts.length ? 'Queue: ' + parts.join(' · ') : 'Queue empty';
  renderStatusMsg();
}
function renderStatusMsg() {
  const m = $('sbMsg');
  if (S.hover) { m.innerHTML = S.hover; return; }
  if (S.flash) { m.innerHTML = S.flash; return; }
  if (S.view === 'home') m.textContent = 'Drop a recording anywhere in the window to convert it.';
  else if (S.view === 'progress') { const pi = progInfo(); m.textContent = pi.msg + ' · ' + Math.round(pi.p * 100) + '%'; }
  else m.textContent = 'Space to play · click the ruler to move the playhead · Ctrl + scroll to zoom';
}

function renderSwitcher() {
  const cur = S.view === 'result' && S.advanced ? 'advanced' : S.view;
  document.querySelectorAll('#switcher button').forEach((b) => b.classList.toggle('on', b.dataset.goto === cur));
  $('dsEngineTxt').textContent = engineLine(S.engine, S.eopt);
}

// ------------------------------------------------------------------ browser (recent conversions)
function recentList() {
  let list = M.recent.map((r) => Object.assign({}, r));
  if (S.view === 'progress') {
    list = list.filter((r) => r.filename !== S.file).map((r) => r.status === 'running' ? Object.assign(r, { status: 'queued' }) : r);
    list.unshift({ id: 'current', filename: S.file, status: 'running', progress: S.progress ? S.progress.p : 0, duration: DUR, when: 'Today ' + nowHM() });
  } else if (S.used && S.file !== JOB.filename) {
    list = list.filter((r) => r.filename !== S.file);
    list.unshift({ id: 'current', filename: S.file, status: 'done', duration: DUR, notes: displayNotes().length, when: 'Today ' + nowHM() });
  }
  return list;
}
function nowHM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function groupOf(when) { return /^Today/.test(when) ? 'Today' : /^Yesterday/.test(when) ? 'Yesterday' : 'Earlier this week'; }
function whenShort(when) { return when.replace(/^Today\s*/, '').replace(/^Yesterday$/, '') || ''; }
function renderBrowser() {
  const box = $('recentList');
  const list = recentList();
  $('recentCount').textContent = list.length === 1 ? '1 file' : list.length + ' files';
  if (!list.length) { box.innerHTML = '<p class="empty">No conversions yet. Files you convert appear here, so you can open them again.</p>'; return; }
  let html = '', group = '';
  for (const r of list) {
    const g = groupOf(r.when);
    if (g !== group) { html += '<div class="group-h">' + g + '</div>'; group = g; }
    const video = /\.(mp4|mkv|mov|webm)$/i.test(r.filename);
    const active = (S.view === 'result' && ((r.id === S.activeId) || (r.id === 'current'))) || (S.view === 'progress' && r.id === 'current');
    let meta = '';
    if (r.status === 'done') meta = '<span>' + fmtTime(r.duration) + ' · ' + (r.notes || 0).toLocaleString() + ' notes</span><span class="r-when">' + esc(whenShort(r.when) || r.when) + '</span>';
    else if (r.status === 'running') meta = '<span class="r-badge run">' + Math.round(r.progress * 100) + '%</span><span class="r-prog"><span style="width:' + (r.progress * 100).toFixed(1) + '%"></span></span>';
    else if (r.status === 'queued') meta = '<span class="r-badge wait">Waiting</span><span>' + fmtTime(r.duration) + '</span><span class="r-when">' + esc(whenShort(r.when) || r.when) + '</span>';
    else if (r.status === 'error') meta = '<span class="r-badge err"><svg class="ico" style="width:11px;height:11px" aria-hidden="true"><use href="#i-warn"/></svg>Failed</span><span class="r-when">' + esc(whenShort(r.when) || r.when) + '</span>';
    const label = r.filename + ', ' + ({ done: 'converted', running: 'converting, ' + Math.round((r.progress || 0) * 100) + '%', queued: 'waiting', error: 'failed: ' + (r.error || '') }[r.status] || '');
    html += '<button type="button" class="ritem' + (active ? ' active' : '') + '" data-rid="' + esc(r.id) + '" aria-label="' + esc(label) + '"' + (active ? ' aria-current="true"' : '') + ' title="' + esc(r.filename) + '">' +
      '<svg class="ico" aria-hidden="true"><use href="#' + (video ? 'i-video' : 'i-audio') + '"/></svg>' +
      '<span class="r-name">' + esc(r.filename) + '</span>' +
      '<span class="r-meta">' + meta + '</span>' +
      (r.status === 'error' ? '<span class="r-err">' + esc(r.error || 'The conversion failed.') + '</span>' : '') +
      '</button>';
  }
  box.innerHTML = html;
  renderDropRecent(list);
}
function renderDropRecent(list) {
  const chip = (r) => {
    const st = r.status === 'done' ? '<span class="dr-v">' + fmtTime(r.duration) + '</span>'
      : r.status === 'running' ? '<span class="r-badge run">' + Math.round((r.progress || 0) * 100) + '%</span>'
      : r.status === 'queued' ? '<span class="r-badge wait">Waiting</span>'
      : '<span class="r-badge err">Failed</span>';
    return '<button type="button" class="dr-chip" data-drid="' + esc(r.id) + '" title="' + esc(r.filename) + '"><span class="dr-name">' + esc(r.filename.replace(/\.[^.]+$/, '')) + '</span>' + st + '</button>';
  };
  $('dropRecent').innerHTML = '<span class="ds-k">Recent</span>' + list.slice(0, 3).map(chip).join('') +
    '<button type="button" class="dr-all" id="dropAll">All ' + list.length + '<svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg></button>';
}
function updateRunningRow() {
  const b = document.querySelector('.ritem[data-rid="current"]');
  if (!b || !S.progress) return;
  const badge = b.querySelector('.r-badge.run'), bar = b.querySelector('.r-prog span');
  if (badge) badge.textContent = Math.round(S.progress.p * 100) + '%';
  if (bar) bar.style.width = (S.progress.p * 100).toFixed(1) + '%';
}

// ------------------------------------------------------------------ inspector
const SEG_KEYS = { 'out.pedal': { cc: 'Events', extend: 'Bake', none: 'Off' }, 'out.velocity': { played: 'As played', flat: 'Flat' }, 'eopt.rescue': { '0.1': 'Generous', '0.3': 'Balanced', '0.5': 'Cautious' } };
const ENG_TAGS = { ensemble: 'Most accurate', transkun: 'About 4× faster', aria: 'For comparison' };
const ACC_LABELS = { clean: 'Clean', mp3: 'MP3', phone: 'Phone', reverb: 'Reverb', noise: 'Noise', worst: 'Worst case' };
const fid = (s) => s.replace(/[^a-z0-9]+/gi, '-');

function section(id, title, note, inner, bodyId) {
  const open = !S.collapsed[id];
  return '<section class="isec" data-sec="' + id + '">' +
    '<h3 class="isec-h"><button type="button" class="isec-toggle" data-act="sec" data-sec="' + id + '" aria-expanded="' + open + '" aria-controls="sec-' + id + '" data-fid="sec-' + id + '">' +
    '<svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg>' + esc(title) + '</button>' + (note || '') + '</h3>' +
    '<div class="isec-b" id="' + (bodyId || 'sec-' + id) + '"' + (open ? '' : ' hidden') + '>' + inner + '</div></section>';
}
function row(path, label, ctl, labelFor, spec) {
  const id = fid(path);
  const text = esc(label).replace(/-/g, '‑');
  const lbl = labelFor ? '<label class="ilbl" for="f-' + id + '">' + text + '</label>' : '<span class="ilbl" id="l-' + id + '">' + text + '</span>';
  // switches sit at the right edge; the note-length fader gets the full width under its label
  const kind = spec && spec.kind === 'bool' ? ' is-bool' : spec && spec.key === 'min_note_ms' ? ' is-stack' : '';
  const aside = kind === ' is-stack' ? '<span class="fader-val" id="fv-' + id + '">' + esc(minLenText(S.out.min_note_ms)) + '</span>' : '';
  return '<div class="irow' + kind + '" data-help="' + path + '">' + lbl + aside + '<div class="ictl">' + ctl + '</div></div>';
}
function control(spec, path, value) {
  const id = fid(path);
  if (spec.kind === 'choice') {
    const short = SEG_KEYS[path];
    if (short) {
      return '<div class="seg sm" role="radiogroup" aria-labelledby="l-' + id + '">' + spec.choices.map((c) =>
        '<button type="button" role="radio" aria-checked="' + (c.value === value) + '" data-opt="' + path + '" data-val="' + esc(c.value) + '" data-fid="' + id + '-' + fid(c.value) + '" title="' + esc(c.label) + '">' + esc(short[c.value] || c.label) + '</button>').join('') + '</div>';
    }
    return '<select class="sel" id="f-' + id + '" data-opt="' + path + '" data-fid="' + id + '">' + spec.choices.map((c) =>
      '<option value="' + esc(c.value) + '"' + (c.value === value ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select>';
  }
  if (spec.kind === 'bool') {
    return '<button type="button" class="tgl" role="switch" aria-checked="' + !!value + '" data-opt="' + path + '" aria-labelledby="l-' + id + '" data-fid="' + id + '"><span class="tgl-track"><span class="tgl-knob"></span></span><span class="tgl-txt">' + (value ? 'On' : 'Off') + '</span></button>';
  }
  if (spec.key === 'flat_velocity') {
    const f = (value - spec.min) / (spec.max - spec.min);
    return '<div class="knob-wrap"><div class="knob" role="slider" tabindex="0" aria-labelledby="l-' + id + '" aria-valuemin="' + spec.min + '" aria-valuemax="' + spec.max + '" aria-valuenow="' + value + '" data-knob="' + path + '" data-min="' + spec.min + '" data-max="' + spec.max + '" data-def="' + spec.default + '" data-fid="' + id + '">' + knobSvg(f) + '</div>' +
      '<span class="knob-val" id="kv-' + id + '">' + value + '</span><span class="knob-hint">of 127</span></div>';
  }
  if (spec.key === 'min_note_ms') {
    const f = ((value - spec.min) / (spec.max - spec.min)) * 100;
    const ticks = [];
    for (let v = spec.min; v <= spec.max; v += 50) ticks.push('<span style="left:' + (((v - spec.min) / (spec.max - spec.min)) * 100) + '%">' + v + '</span>');
    return '<div class="fader"><input type="range" id="f-' + id + '" data-range="' + path + '" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + value + '" style="--fill:' + f + '%" aria-labelledby="l-' + id + '" aria-valuetext="' + esc(minLenText(value)) + '" data-fid="' + id + '">' +
      '<div class="fader-scale" aria-hidden="true">' + ticks.join('') + '</div></div>';
  }
  return '<div class="num"><input type="text" inputmode="numeric" id="f-' + id + '" data-num="' + path + '" data-min="' + spec.min + '" data-max="' + spec.max + '" data-step="' + (spec.step || 1) + '" value="' + value + '" aria-labelledby="l-' + id + '" data-fid="' + id + '" spellcheck="false" autocomplete="off">' +
    (spec.unit ? '<span class="unit">' + esc(spec.unit) + '</span>' : '') +
    '<span class="step"><button type="button" tabindex="-1" data-stepfor="' + path + '" data-dir="1" aria-label="Increase"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<button type="button" tabindex="-1" data-stepfor="' + path + '" data-dir="-1" aria-label="Decrease"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span></div>';
}
function minLenText(v) { return +v === 0 ? 'Keep all' : v + ' ms'; }
function knobSvg(f) {
  const cx = 17, cy = 17, r = 14.5;
  const pt = (a, rr) => [cx + rr * Math.cos(a * Math.PI / 180), cy + rr * Math.sin(a * Math.PI / 180)];
  const arc = (a0, a1) => { const p0 = pt(a0, r), p1 = pt(a1, r); return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2); };
  const a1 = 135 + 270 * clamp(f, 0, 1);
  const p0 = pt(a1, 4), p1 = pt(a1, 9);
  return '<svg viewBox="0 0 34 34" aria-hidden="true">' +
    '<path d="' + arc(135, 405) + '" stroke="#2f333a" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
    (f > 0.004 ? '<path d="' + arc(135, a1) + '" stroke="#f0a640" stroke-width="2.6" fill="none" stroke-linecap="round"/>' : '') +
    '<circle cx="17" cy="17" r="10.5" fill="#2b2e34" stroke="#474c55"/>' +
    '<circle cx="17" cy="17" r="8.5" fill="#24272c"/>' +
    '<line x1="' + p0[0].toFixed(2) + '" y1="' + p0[1].toFixed(2) + '" x2="' + p1[0].toFixed(2) + '" y2="' + p1[1].toFixed(2) + '" stroke="#f2f4f7" stroke-width="2" stroke-linecap="round"/></svg>';
}

function trackHTML() {
  return '<div class="irow" data-help="instrument"><span class="ilbl" id="l-inst">Instrument</span><div class="ictl">' +
    '<div class="seg sm" role="radiogroup" aria-labelledby="l-inst"><button type="button" role="radio" aria-checked="true" class="inst-on" data-fid="inst-piano" title="' + esc(INST.description) + '"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg>' + esc(INST.name) + '</button>' +
    '<button type="button" role="radio" aria-checked="false" disabled aria-disabled="true" title="More instruments are coming">More <span class="soon">soon</span></button></div></div></div>';
}
function clipHTML() {
  const used = S.used || snapshotEngine();
  const n = displayNotes().length, dropped = NOTES.length - n;
  const sus = S.out.pedal === 'cc' ? SUS.length + ' sustain' : S.out.pedal === 'extend' ? 'sustain baked in' : 'no sustain';
  const soft = S.out.soft_pedal ? SOFT.length + ' soft' : 'no soft';
  const viewNames = { orig: 'stereo', left: 'left', right: 'right', mid: 'mid' };
  const views = used.engine === 'aria' ? '—' : (used.eopt.views === 'channels' ? STATS.views.map((v) => viewNames[v] || v).join(', ') : viewsLabel(used.eopt));
  return '<div class="file-line"><svg class="ico" aria-hidden="true"><use href="#i-audio"/></svg><span class="fname" title="' + esc(S.file) + '">' + esc(S.file) + '</span></div>' +
    '<dl class="kv">' +
    '<dt>Recording</dt><dd>' + fmtTime(DUR) + ' <span class="dim">· ' + esc(M.file.format.split(' · ').slice(0, 2).join(' · ')) + '</span></dd>' +
    '<dt>Notes</dt><dd>' + n.toLocaleString() + (dropped ? ' <span class="dim">· ' + dropped + ' short ones left out</span>' : '') + '</dd>' +
    '<dt>Pedal presses</dt><dd>' + sus + ' <span class="dim">·</span> ' + soft + '</dd>' +
    '<dt>Engine</dt><dd>' + esc(engById(used.engine).name) + '</dd>' +
    '<dt>Views</dt><dd>' + esc(views) + '</dd>' +
    (used.engine === 'ensemble' ? '<dt>Second opinion</dt><dd>' + STATS.notes_added_by_aria + ' notes added by Aria</dd>' : '') +
    '<dt>Certainty</dt><dd>' + (STATS.mean_confidence * 100).toFixed(1) + '% average <span class="dim">· ' + STATS.uncertain_notes + ' unsure</span></dd>' +
    '<dt>Converted in</dt><dd>' + STATS.seconds_total.toFixed(1) + ' s <span class="dim">on ' + esc(GPU_SHORT) + '</span></dd>' +
    '</dl>';
}
function engineSummaryHTML() {
  const e = engById(S.engine);
  const sub = e.options.map((o) => { const v = S.eopt[o.key]; const c = o.choices && o.choices.find((x) => x.value === v); return c ? c.label.replace(/\s*\(.*\)$/, '') : ''; }).filter(Boolean).join(' · ');
  let h = '<button type="button" class="sum-btn" data-act="adv" data-help="engine" data-fid="eng-sum"><span class="sum-main"><span class="sum-t">' + esc(e.name) + '</span><span class="sum-s">' + esc(sub || 'No extra settings') + '</span></span><svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg></button>';
  if (S.engine === 'ensemble' && S.view === 'home') {
    const acc = M.accuracy.onset_f1;
    h += '<div class="acc" data-help="accuracy"><div class="acc-h"><span>Note accuracy (F1)</span><span>' + esc(M.accuracy.note) + '</span></div>' +
      Object.keys(ACC_LABELS).map((k) => '<div class="acc-row"><span>' + ACC_LABELS[k] + '</span><span class="acc-bar"><span style="width:' + clamp((acc[k] - 90) * 10, 0, 100).toFixed(1) + '%"></span></span><span class="v">' + acc[k].toFixed(1) + '</span></div>').join('') + '</div>';
  }
  if (S.view === 'result' && !sameEngine(S.used, snapshotEngine())) h += rerunHTML();
  return h;
}
function rerunHTML() {
  return '<button type="button" class="btn-sec accent" data-act="rerun" data-help="rerun" data-fid="rerun">Re-convert with these settings</button>';
}
function engineFullHTML() {
  const e = engById(S.engine);
  let h = '<div class="engines" role="radiogroup" aria-label="Engine">' + ENGINES.map((x) =>
    '<button type="button" class="eng" role="radio" aria-checked="' + (x.id === S.engine) + '" data-opt="engine" data-val="' + x.id + '" data-help="engine:' + x.id + '" data-fid="eng-' + x.id + '"' + (x.available ? '' : ' disabled') + '>' +
    '<span class="eng-dot" aria-hidden="true"></span><span class="eng-name">' + esc(x.name) + '</span><span class="eng-tag">' + esc(x.available ? ENG_TAGS[x.id] || '' : 'Not installed') + '</span></button>').join('') + '</div>';
  for (const o of e.options) h += row('eopt.' + o.key, o.label, control(o, 'eopt.' + o.key, S.eopt[o.key]), o.kind === 'choice' && !SEG_KEYS['eopt.' + o.key], o);
  if (!e.options.length) h += '<p class="hint">' + esc(e.name) + ' has no extra settings.</p>';
  if (S.engine !== 'transkun') {
    const extra = TRANSKUN.options.filter((o) => !e.options.some((x) => x.key === o.key));
    if (extra.length) {
      h += '<div class="more"><button type="button" class="more-h" data-act="more" aria-expanded="' + S.more + '" aria-controls="moreBody" data-fid="more"><svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg>More<span class="more-note">Only when Transkun V2 runs alone</span></button>' +
        '<div class="more-b" id="moreBody"' + (S.more ? '' : ' hidden') + '>' + extra.map((o) => row('eopt.' + o.key, o.label, control(o, 'eopt.' + o.key, S.eopt[o.key]), o.kind === 'choice', o)).join('') + '</div></div>';
    }
  }
  if (S.view === 'result' && !sameEngine(S.used, snapshotEngine())) h += rerunHTML();
  return h;
}
function outputHTML(adv) {
  const keys = adv ? OUTS.map((o) => o.key) : ['pedal', 'velocity', 'flat_velocity', 'tempo'];
  let h = '';
  for (const k of keys) {
    const o = OUTS.find((x) => x.key === k);
    if (!o) continue;
    if (k === 'flat_velocity' && S.out.velocity !== 'flat') continue;
    const path = 'out.' + k;
    h += row(path, o.label.replace(/\s*\(CC67\)/, ''), control(o, path, S.out[k]), (o.kind === 'choice' && !SEG_KEYS[path]) || (o.kind === 'number' && k !== 'flat_velocity'), o);
  }
  if (!adv) h += '<button type="button" class="more-link" data-act="adv" data-fid="out-more">Soft pedal, minimum note length<svg class="ico" aria-hidden="true"><use href="#i-chev"/></svg></button>';
  return h;
}
function stagesHTML() {
  const pi = progInfo();
  const st = stagesFor(S.engine, S.eopt);
  const order = st.map((x) => x.id);
  const cur = order.indexOf(pi.stage);
  return '<ol class="stages">' + st.map((x, i) => {
    const state = i < cur ? 'done' : i === cur ? 'active' : 'pending';
    const ico = state === 'done' ? '<svg aria-hidden="true"><use href="#i-check"/></svg>' : state === 'active' ? '<span class="spin" aria-hidden="true"></span>' : '';
    const v = x.id === 'transkun' && state !== 'pending' ? Math.min(WINDOWS, state === 'done' ? WINDOWS : pi.win) + ' / ' + WINDOWS : state === 'done' ? 'Done' : '';
    return '<li class="stage ' + state + '"><span class="st-ico">' + ico + '</span><span>' + esc(x.label) + '</span><span class="st-v">' + v + '</span></li>';
  }).join('') + '</ol>';
}
function logHTML() {
  const pi = progInfo();
  const shown = pi.stage === 'decode' ? 2 : Math.min(M.log.length, 2 + Math.floor(pi.wf));
  // time stamp in its own column, the message wraps under itself instead of being cut off
  const lines = M.log.slice(0, Math.max(1, shown)).slice(-4).map((l) => {
    const m = l.replace(/^\d\d:\d\d:/, '').match(/^(\S+)\s+(\S+)\s+(.*)$/);
    return m ? { t: m[1], s: m[2], d: m[3].replace(/\s{2,}/g, ' ') } : { t: '', s: '', d: l };
  });
  return '<div class="log" role="log" aria-label="Engine log">' + lines.map((l, i, a) => '<div class="l-row' + (i === a.length - 1 ? ' l-new' : '') + '"><span class="l-t">' + esc(l.t) + '</span><span class="l-m"><span class="l-s">' + esc(l.s) + '</span> ' + esc(l.d) + '</span></div>').join('') + '</div>';
}
function deviceHTML() {
  const gpu = DEVICE.kind === 'gpu';
  const typical = S.engine === 'ensemble' && S.eopt.views === 'channels' ? '<dt>Typical time</dt><dd>20–25 s <span class="dim">per 2-minute piece</span></dd>' : '';
  return '<dl class="kv" data-help="gpu">' +
    '<dt>Card</dt><dd>' + esc(GPU_SHORT) + (gpu ? ' <span class="dim">· ' + DEVICE.vram_gb + ' GB</span>' : '') + '</dd>' +
    '<dt>Runs on</dt><dd>' + (gpu ? 'CUDA <span class="dim">· graphics card</span>' : 'Processor <span class="dim">· much slower</span>') + '</dd>' +
    typical + '</dl>';
}
function footHTML() {
  return '<div class="insp-foot"><button type="button" class="btn-sec" data-act="reset" data-help="reset" data-fid="reset">Reset to defaults</button><span class="ver">' + esc(INFO.app + ' ' + INFO.version) + '</span></div>';
}

let lastConvKey = '';
function renderInspector() {
  const adv = S.advanced, v = S.view;
  const active = document.activeElement;
  const keep = active && el.inspBody.contains(active) ? active.dataset.fid : null;
  const scroll = el.inspBody.scrollTop;
  let h = '';
  if (v === 'progress') h += section('conv', 'Conversion', '<span class="isec-note">' + Math.round(progInfo().p * 100) + '%</span>', stagesHTML() + logHTML(), 'convBody');
  if (v === 'result' && !adv) h += section('clip', 'This conversion', '', clipHTML());
  // the instrument picks which engines are offered, so it leads the engine section
  h += section('engine', 'Engine', '<span class="isec-note">' + (v === 'result' ? 'For the next conversion' : 'For new conversions') + '</span>', trackHTML() + (adv ? engineFullHTML() : engineSummaryHTML()));
  h += section('out', 'MIDI file', v === 'result' ? '<span class="isec-note live">Applies instantly</span>' : '<span class="isec-note">Applied when written</span>', outputHTML(adv));
  if (v === 'home') h += section('device', 'Graphics card', '<span class="isec-note live">Ready</span>', deviceHTML());
  if (adv) h += footHTML();
  el.inspBody.innerHTML = h;
  el.inspBody.scrollTop = scroll;
  el.inspBody.querySelectorAll('[role="radiogroup"]').forEach(rovingTabindex);
  if (keep) { const n = el.inspBody.querySelector('[data-fid="' + keep + '"]'); if (n) n.focus({ preventScroll: true }); }
  $('inspTitle').textContent = adv ? 'Advanced options' : 'Inspector';
  const mode = $('inspMode');
  mode.textContent = adv ? 'Show less' : 'Show all options';
  mode.hidden = adv && mqInsp.matches;
  mode.setAttribute('aria-pressed', String(adv));
  lastConvKey = '';
  setInfo(null);
}
function updateConv() {
  const pi = progInfo();
  const key = pi.stage + '|' + pi.win + '|' + Math.round(pi.p * 100);
  if (key === lastConvKey) return;
  lastConvKey = key;
  const b = $('convBody');
  if (b) b.innerHTML = stagesHTML() + logHTML();
  const note = document.querySelector('.isec[data-sec="conv"] .isec-note');
  if (note) note.textContent = Math.round(pi.p * 100) + '%';
}

let infoKey = null;
function setInfo(key) {
  const h = helpFor(key) || (S.advanced && S.view === 'result'
    ? { t: 'When options take effect', b: 'MIDI file options update the open result instantly, without converting again. Engine options are used for the next conversion.' }
    : helpFor('engine'));
  infoKey = key;
  $('infoT').textContent = h.t;
  $('infoB').textContent = h.b;
}

// ------------------------------------------------------------------ option changes
function setOpt(path, val, opts) {
  opts = opts || {};
  if (path === 'engine') {
    const e = engById(val);
    if (!e.available) { toast(e.unavailable_reason || 'This engine is not installed.', { kind: 'warn' }); return; }
    S.engine = val;
  } else {
    const parts = path.split('.');
    S[parts[0]][parts[1]] = val;
  }
  const isOut = path.startsWith('out.');
  if (opts.rebuild !== false) renderInspector();
  if (isOut) {
    renderHeaders();
    renderToolbar();
    if (path === 'out.tempo') { if (document.activeElement !== $('tempoField')) $('tempoField').value = S.out.tempo; renderLcd(); }
    if (S.view === 'result') flash('<span class="ok">✓</span> MIDI updated · ' + esc(describeOut(path)));
  } else {
    renderSwitcher();
    renderStatus();
    if (S.view === 'result' && opts.rebuild !== false) flash('Engine settings are used for the next conversion');
  }
  if (path === 'out.min_note_ms' || path === 'out.velocity') renderBrowser();
  draw();
}
function describeOut(path) {
  const k = path.slice(4), o = OUTS.find((x) => x.key === k), v = S.out[k];
  if (o.kind === 'choice') { const c = o.choices.find((x) => x.value === v); return o.label + ': ' + (c ? c.label : v); }
  if (o.kind === 'bool') return o.label.replace(/\s*\(CC67\)/, '') + (v ? ' on' : ' off');
  if (k === 'min_note_ms') return o.label + ': ' + minLenText(v);
  return o.label + ': ' + v + (o.unit ? ' ' + o.unit : '');
}
function resetDefaults() {
  S.engine = INST.default_engine; S.eopt = defaultEopt(); S.out = defaultOut();
  renderAll();
  toast('Options reset to defaults');
}

// ------------------------------------------------------------------ views
function enterHome() {
  stopPlay(); clearFlash();
  S.view = 'home'; S.progress = null; S.activeId = null; S.time = 0; S.file = JOB.filename;
  renderAll();
}
function enterProgress(frozen, name) {
  stopPlay(); clearFlash();
  S.view = 'progress';
  S.file = name || JOB.filename;
  S.midiName = S.file.replace(/\.[^.]+$/, '') + '.mid';
  S.time = 0; S.activeId = 'current';
  S.progress = frozen ? { p: M.progress.progress, frozen: true } : { p: 0, frozen: false, start: performance.now(), dur: 3200 };
  S.runEngine = snapshotEngine();
  V.needsFit = true; fitDefault();
  renderAll();
  ensureLoop();
}
function enterResult(time) {
  stopPlay(); clearFlash();
  S.view = 'result';
  S.progress = null;
  if (!S.used) S.used = snapshotEngine();
  S.activeId = S.file === JOB.filename ? JOB.id : 'current';
  S.time = time || 0;
  V.needsFit = true; fitDefault();
  renderAll();
}
function finishRun() {
  S.used = S.runEngine || snapshotEngine();
  enterResult(0);
  flash('<span class="ok">✓</span> Converted in ' + STATS.seconds_total.toFixed(1) + ' s · ' + displayNotes().length + ' notes');
}
function startRun(name) {
  setBrowserOpen(false);
  enterProgress(false, name || M.file.name);
}
function cancelRun() {
  enterHome();
  toast('Conversion cancelled', { kind: 'warn' });
}
function goTo(state) {
  setBrowserOpen(false);
  if (state === 'home') { setAdvanced(false); enterHome(); }
  else if (state === 'progress') { setAdvanced(false); S.used = null; enterProgress(true); }
  else if (state === 'result') { S.file = JOB.filename; S.used = null; setAdvanced(false, true); enterResult(12); }
  else if (state === 'advanced') { S.file = JOB.filename; S.used = null; enterResult(12); setAdvanced(true); }
  try { const u = new URL(location.href); u.searchParams.set('state', state); history.replaceState(null, '', u.href); } catch (e) { /* file:// in some browsers */ }
}

function setAdvanced(on, quiet) {
  S.advanced = on;
  body.classList.toggle('insp-open', on && mqInsp.matches);
  $('advBtn').setAttribute('aria-pressed', String(on));
  if (!quiet) { renderInspector(); renderSwitcher(); }
}
function setBrowserOpen(on) {
  body.classList.toggle('browser-open', on && mqBrowser.matches);
  $('browserToggle').setAttribute('aria-expanded', String(on && mqBrowser.matches));
}

// ------------------------------------------------------------------ playback
function play() {
  if (S.view !== 'result') return;
  if (S.time >= DUR - 0.05) S.time = S.loop ? S.loopA : 0;
  if (S.loop && (S.time < S.loopA || S.time >= S.loopB)) S.time = S.loopA;
  S.playing = true; S.lastTick = performance.now();
  renderTransport();
  ensureLoop();
}
function stopPlay() {
  S.playing = false;
  if ($('playBtn')) { $('playBtn').classList.remove('on'); $('playBtn').setAttribute('aria-label', 'Play'); }
  $('meterAudio').style.width = '0'; $('meterMidi').style.width = '0';
}
function togglePlay() { if (S.playing) { stopPlay(); draw(); } else play(); }
function seek(t) {
  S.time = clamp(t, 0, DUR);
  renderLcd();
  draw();
}
function followPlayhead() {
  const viewSec = viewW() / V.pps;
  if (performance.now() - V.userScrolledAt < 2500) return;
  if (S.time > V.sx + viewSec * 0.88 || S.time < V.sx) V.sx = clampScroll(S.time - viewSec * 0.1);
}

// ------------------------------------------------------------------ animation loop
let looping = false;
function ensureLoop() { if (!looping) { looping = true; S.lastTick = performance.now(); requestAnimationFrame(frame); } }
function frame(now) {
  const dt = Math.min(0.1, (now - (S.lastTick || now)) / 1000);
  S.lastTick = now;
  let keep = false;
  if (S.playing) {
    keep = true;
    S.time += dt;
    if (S.loop && S.time >= S.loopB) S.time = S.loopA + (S.time - S.loopB);
    if (S.time >= DUR) { S.time = DUR; stopPlay(); renderTransport(); }
    followPlayhead();
    renderLcd();
    updateMeters();
  }
  if (S.view === 'progress' && S.progress) {
    keep = true;
    if (!S.progress.frozen) {
      S.progress.p = clamp((now - S.progress.start) / S.progress.dur, 0, 1);
      if (S.progress.p >= 1) { looping = false; finishRun(); return; }
      updateRunningRow();
    }
    S.gpu = clamp(0.84 + 0.07 * Math.sin(now / 180) + 0.04 * Math.sin(now / 67), 0, 1);
    renderRender();
    renderMeter();
    updateConv();
    if (!S.hover && !S.flash) renderStatusMsg();
  } else {
    const target = S.playing ? 0.05 : 0.03;
    if (Math.abs(S.gpu - target) > 0.005) { S.gpu = target; renderMeter(); }
  }
  draw();
  if (keep) requestAnimationFrame(frame); else looping = false;
}
function updateMeters() {
  const idx = clamp(Math.floor(S.time / WF.hop_seconds), 0, WF.rms.length - 1);
  const a = audible('audio') ? clamp(WF.rms[idx] / 0.36, 0, 1) : 0;
  let m = 0;
  if (audible('midi')) {
    const notes = displayNotes();
    for (let i = lowerBound(notes, S.time - MAXSPAN - 0.01); i < notes.length && notes[i][0] <= S.time; i++) {
      const n = notes[i], end = soundingEnd(n);
      if (S.time < end) m += (S.out.velocity === 'flat' ? S.out.flat_velocity : n[3]) * (S.time < n[1] ? 1 : 0.45);
    }
    m = clamp(m / 320, 0, 1);
  }
  const wA = $('meterAudio').parentNode.clientWidth;
  $('meterAudio').style.cssText = 'width:' + (a * 100).toFixed(1) + '%;--mw:' + wA + 'px';
  $('meterMidi').style.cssText = 'width:' + (m * 100).toFixed(1) + '%;--mw:' + $('meterMidi').parentNode.clientWidth + 'px';
}
function soundingEnd(n) { return S.out.pedal === 'none' ? n[1] : Math.max(n[1], n[4] || n[1]); }

// ------------------------------------------------------------------ arrangement geometry
function viewW() { return Math.max(1, el.lanesCv.clientWidth || el.rulerCv.clientWidth || 1); }
const X = (t) => (t - V.sx) * V.pps;
const T = (x) => V.sx + x / V.pps;
function minPps() { return viewW() / (DUR + 2); }
const MAX_PPS = 480;
function clampScroll(s) { const vs = viewW() / V.pps; return clamp(s, 0, Math.max(0, DUR + 1 - vs)); }
function fitDefault() {
  const w = viewW();
  if (!V.needsFit || w < 60) return;
  V.needsFit = false;
  V.pps = S.view === 'progress' ? minPps() : clamp(w / 20, minPps(), MAX_PPS);
  V.sx = 0;
  syncZoomSlider();
}
function zoomBy(f, anchorX) {
  const ax = anchorX == null ? viewW() / 2 : anchorX;
  const ta = T(ax);
  V.pps = clamp(V.pps * f, minPps(), MAX_PPS);
  V.sx = clampScroll(ta - ax / V.pps);
  syncZoomSlider();
  draw();
}
function syncZoomSlider() {
  $('zoomIn').disabled = S.view === 'home' || V.pps >= MAX_PPS - 0.01;
  $('zoomOut').disabled = S.view === 'home' || V.pps <= minPps() + 0.01;
}
function lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; } return lo; }

// ------------------------------------------------------------------ drawing
const COL = {
  laneA: '#151619', laneB: '#121316', after: 'rgba(0,0,0,0.28)',
  beat: 'rgba(255,255,255,0.032)', bar: 'rgba(255,255,255,0.07)', barMajor: 'rgba(255,255,255,0.12)',
  blackRow: 'rgba(0,0,0,0.24)', octave: 'rgba(255,255,255,0.065)',
  audio: [98, 168, 224], midi: [240, 166, 64], sus: [111, 207, 142], soft: [180, 142, 242], loop: [87, 173, 255], grey: [118, 124, 133],
  playhead: '#f4f6f8', stripText: '#101215',
};
const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
const FONT_NUM = 'Bahnschrift, "Segoe UI", sans-serif';
const FONT_UI = '"Segoe UI Variable Text", "Segoe UI", sans-serif';
const VEL = [], VEL_MUTED = [];
for (let v = 0; v < 128; v++) {
  const f = Math.min(1, v / 100);
  VEL[v] = 'hsl(35, ' + (78 + 14 * f).toFixed(0) + '%, ' + (27 + 45 * f).toFixed(1) + '%)';
  VEL_MUTED[v] = 'hsl(220, 5%, ' + (30 + 18 * f).toFixed(1) + '%)';
}
let hatch = null;
function hatchPattern(ctx) {
  if (hatch) return hatch;
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  hatch = ctx.createPattern(c, 'repeat');
  return hatch;
}
function prep(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}
function drawNow() {
  if (V.needsFit) fitDefault();
  drawOverview();
  drawRuler();
  drawLanes();
  if (S.view !== 'home') drawKeyboard();
}
function laneGeo() {
  const host = el.lanes.getBoundingClientRect();
  const g = {};
  for (const id of ['audio', 'midi', 'sus', 'soft']) {
    const r = $('th-' + id).getBoundingClientRect();
    g[id] = { y: r.top - host.top, h: r.height };
  }
  return g;
}
function midiBody(L) { const HDR = 14; return { y: L.y + 2 + HDR, h: Math.max(10, L.h - 4 - HDR) }; }
function pill(ctx, text, x, y, color) {
  ctx.font = '500 11px ' + FONT_UI;
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = 'rgba(16,17,20,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.roundRect(x, y - 10, w, 20, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color || '#d4d8de';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, x + 8, y + 0.5);
}

function drawGrid(ctx, W, H) {
  const beat = 60 / S.out.tempo, bar = beat * 4;
  const t0 = V.sx, t1 = T(W);
  const beatPx = beat * V.pps, barPx = bar * V.pps;
  if (beatPx >= 9) {
    ctx.fillStyle = COL.beat;
    for (let k = Math.max(0, Math.floor(t0 / beat)); k * beat <= t1; k++) { if (k % 4 === 0) continue; ctx.fillRect(Math.round(X(k * beat)), 0, 1, H); }
  }
  let step = 1; while (step * barPx < 30) step *= 2;
  for (let k = Math.max(0, Math.floor(t0 / bar)); k * bar <= t1; k++) {
    if (barPx < 6 && k % step) continue;
    ctx.fillStyle = k % (step * 4) === 0 ? COL.barMajor : COL.bar;
    ctx.fillRect(Math.round(X(k * bar)), 0, 1, H);
  }
}

function clipFrame(ctx, L, col, label, muted, W, progress) {
  const x0 = X(0), x1 = X(DUR);
  if (x1 < 0 || x0 > W) return;
  const y = L.y + 2, h = L.h - 4, HDR = 14;
  const c = muted ? COL.grey : col;
  ctx.fillStyle = rgba(c, muted ? 0.035 : 0.075);
  ctx.beginPath(); ctx.roundRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, h - 1, 4); ctx.fill();
  ctx.strokeStyle = rgba(c, muted ? 0.25 : 0.5); ctx.lineWidth = 1; ctx.stroke();
  // name strip
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, HDR, [4, 4, 0, 0]); ctx.clip();
  if (progress) {
    ctx.fillStyle = '#33373e'; ctx.fillRect(x0, y, x1 - x0, HDR + 1);
    const rx = X(progress.revealT);
    ctx.fillStyle = rgba(col, 0.95); ctx.fillRect(x0, y, Math.max(0, rx - x0), HDR + 1);
    const wl = DUR / WINDOWS;
    ctx.font = '600 9.5px ' + FONT_NUM; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (let k = 0; k < WINDOWS; k++) {
      const a = X(k * wl), b = X((k + 1) * wl);
      if (k) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(Math.round(a), y, 1, HDR + 1); }
      if (b - a >= 18) {
        const done = (k + 1) * wl <= progress.revealT + 1e-6;
        const cur = !done && k * wl <= progress.revealT + 1e-6 && progress.stage === 'transkun';
        ctx.fillStyle = done || cur ? COL.stripText : '#a7adb6';
        ctx.fillText((cur ? '▸ ' : '') + (k + 1), (a + b) / 2, y + HDR / 2 + 1);
      }
    }
  } else {
    ctx.fillStyle = muted ? '#4b5058' : rgba(col, 0.92);
    ctx.fillRect(x0, y, x1 - x0, HDR + 1);
    ctx.font = '600 10.5px ' + FONT_UI; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = muted ? '#cdd1d6' : COL.stripText;
    ctx.fillText(label + (muted ? '  (muted)' : ''), Math.max(x0, 0) + 7, y + HDR / 2 + 1);
  }
  ctx.restore();
}

function drawLanes() {
  const { ctx, w: W, h: H } = prep(el.lanesCv);
  ctx.fillStyle = COL.laneB; ctx.fillRect(0, 0, W, H);
  const g = laneGeo();
  const prog = S.view === 'progress' ? progInfo() : null;
  const reveal = prog ? prog.revealT : Infinity;
  const ids = ['audio', 'midi', 'sus', 'soft'];
  ids.forEach((id, i) => { const L = g[id]; ctx.fillStyle = i % 2 ? COL.laneA : COL.laneB; ctx.fillRect(0, L.y, W, L.h); });

  // piano rows in the MIDI lane
  const mb = midiBody(g.midi);
  const rows = HI - LO + 1, rh = mb.h / rows;
  for (let p = LO; p <= HI; p++) {
    const y = mb.y + (HI - p) * rh;
    if (isBlack(p)) { ctx.fillStyle = COL.blackRow; ctx.fillRect(0, y, W, rh); }
    if (p % 12 === 0) { ctx.fillStyle = COL.octave; ctx.fillRect(0, Math.round(y + rh) - 0.5, W, 1); }
  }
  drawGrid(ctx, W, H);
  // area after the end of the recording
  const xe = X(DUR);
  if (xe < W) { ctx.fillStyle = COL.after; ctx.fillRect(Math.max(0, xe), 0, W - Math.max(0, xe), H); }
  // loop region
  if (S.view === 'result' && S.loop) {
    const a = X(S.loopA), b = X(S.loopB);
    ctx.fillStyle = rgba(COL.loop, 0.07); ctx.fillRect(a, 0, b - a, H);
    ctx.fillStyle = rgba(COL.loop, 0.45); ctx.fillRect(Math.round(a), 0, 1, H); ctx.fillRect(Math.round(b), 0, 1, H);
  }
  // lane separators
  ids.forEach((id) => { const L = g[id]; ctx.fillStyle = '#08090a'; ctx.fillRect(0, L.y + L.h - 1, W, 1); });

  if (S.view === 'home') return;
  const mutedA = S.view === 'result' && !audible('audio');
  const mutedM = S.view === 'result' && !audible('midi');
  // ---- audio
  clipFrame(ctx, g.audio, COL.audio, S.file, mutedA, W);
  drawWave(ctx, g.audio, W, mutedA);
  // ---- midi
  clipFrame(ctx, g.midi, COL.midi, 'Piano · ' + engById((S.used || S).engine).name, mutedM, W, prog);
  drawNotes(ctx, mb, rh, W, reveal, mutedM);
  // ---- pedals
  const susState = S.out.pedal === 'cc' ? 'on' : 'dim';
  drawAuto(ctx, g.sus, SUS, COL.sus, susState, W, reveal);
  drawAuto(ctx, g.soft, SOFT, COL.soft, S.out.soft_pedal ? 'on' : 'dim', W, reveal);
  if (!prog) {
    if (S.out.pedal === 'extend') pill(ctx, 'Baked into note lengths · no pedal events in the file', 10, g.sus.y + g.sus.h / 2, '#b9e8c7');
    if (S.out.pedal === 'none') pill(ctx, 'Left out of the MIDI file', 10, g.sus.y + g.sus.h / 2);
    if (!S.out.soft_pedal) pill(ctx, 'Soft pedal not written to the file', 10, g.soft.y + g.soft.h / 2);
  }
  // ---- progress overlay
  if (prog) {
    const rx = Math.max(0, X(reveal));
    for (const id of ['midi', 'sus', 'soft']) {
      const L = g[id];
      const top = id === 'midi' ? mb.y : L.y + 1, bot = L.y + L.h - 1;
      if (rx < Math.min(W, xe)) {
        ctx.fillStyle = 'rgba(8,9,10,0.35)'; ctx.fillRect(rx, top, Math.min(W, xe) - rx, bot - top);
        ctx.fillStyle = hatchPattern(ctx); ctx.fillRect(rx, top, Math.min(W, xe) - rx, bot - top);
      }
    }
    if (prog.stage === 'transkun') {
      const ws = Math.floor(prog.wf) * (DUR / WINDOWS);
      const a = X(ws), b = X(reveal);
      const top = mb.y, bot = g.soft.y + g.soft.h - 1;
      const grad = ctx.createLinearGradient(a, 0, b, 0);
      grad.addColorStop(0, rgba(COL.midi, 0)); grad.addColorStop(1, rgba(COL.midi, 0.16));
      ctx.fillStyle = grad; ctx.fillRect(a, top, b - a, bot - top);
      const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 160);
      ctx.fillStyle = rgba(COL.midi, pulse); ctx.fillRect(Math.round(b) - 1, top, 2, bot - top);
      // label next to the scan line
      const lx = b + 10, ly = mb.y + 22;
      if (lx < W - 190) pill(ctx, 'Window ' + prog.win + ' of ' + WINDOWS + ' · ' + Math.round((prog.wf % 1) * 100) + '%', lx, ly, '#ffd393');
      else if (b - 200 > 0) pill(ctx, 'Window ' + prog.win + ' of ' + WINDOWS, b - 120, ly, '#ffd393');
    } else if (prog.stage === 'aria') {
      pill(ctx, 'Aria-AMT is double-checking unsure notes…', 10, mb.y + 22, '#ffd393');
    } else if (prog.stage === 'fuse') {
      pill(ctx, 'Writing the MIDI file…', 10, mb.y + 22, '#ffd393');
    } else {
      pill(ctx, 'Reading audio…', 10, mb.y + 22, '#ffd393');
    }
  }
  // ---- playhead
  if (S.view === 'result') {
    const px = Math.round(X(S.time));
    if (px >= -1 && px <= W + 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(px + 1, 0, 1, H);
      ctx.fillStyle = COL.playhead; ctx.fillRect(px, 0, 1, H);
    }
  }
}

function drawWave(ctx, L, W, muted) {
  const HDR = 14;
  const y0 = L.y + 2 + HDR, h = L.h - 4 - HDR;
  const mid = y0 + h / 2, amp = h / 2 - 3;
  const x0 = Math.max(0, Math.floor(X(0))), x1 = Math.min(W, Math.ceil(X(DUR)));
  const hop = WF.hop_seconds, n = WF.rms.length;
  const c = muted ? COL.grey : COL.audio;
  const pk = rgba(c, muted ? 0.3 : 0.45), rm = rgba(c, muted ? 0.55 : 0.95);
  ctx.fillStyle = rgba(c, 0.25); ctx.fillRect(x0, Math.round(mid), x1 - x0, 1);
  for (let px = x0; px < x1; px++) {
    let i0 = Math.floor(T(px) / hop), i1 = Math.floor(T(px + 1) / hop);
    i0 = clamp(i0, 0, n - 1); i1 = clamp(Math.max(i1, i0 + 1), 1, n);
    let p = 0, r = 0;
    for (let i = i0; i < i1; i++) { if (WF.peak[i] > p) p = WF.peak[i]; if (WF.rms[i] > r) r = WF.rms[i]; }
    const ph = Math.max(0.5, p * amp), rh = Math.max(0.5, Math.min(1, r * 1.7) * amp);
    ctx.fillStyle = pk; ctx.fillRect(px, mid - ph, 1, ph * 2);
    ctx.fillStyle = rm; ctx.fillRect(px, mid - rh, 1, rh * 2);
  }
}

function drawNotes(ctx, mb, rh, W, reveal, muted) {
  const notes = displayNotes();
  const t0 = V.sx, t1 = T(W);
  const nh = Math.max(1, rh - (rh > 5 ? 1.2 : 0.4));
  const r = Math.min(2, nh / 2);
  const flat = S.out.velocity === 'flat' ? clamp(+S.out.flat_velocity, 1, 127) : 0;
  const mode = S.out.pedal;
  const live = S.view === 'result';
  for (let i = lowerBound(notes, t0 - MAXSPAN - 0.01); i < notes.length; i++) {
    const n = notes[i];
    const s = n[0], e = n[1], p = n[2];
    if (s > t1) break;
    if (s >= reveal) continue;
    const snd = Math.max(e, n[4] || e);
    const end = mode === 'extend' ? snd : e;
    if (Math.max(end, snd) < t0) continue;
    const y = mb.y + (HI - p) * rh + (rh - nh) / 2;
    const xa = X(s), xb = X(Math.min(end, reveal));
    if (mode === 'cc' && snd > e + 0.01) {
      const xs = X(Math.min(snd, reveal));
      ctx.fillStyle = muted ? 'rgba(118,124,133,0.25)' : 'rgba(240,166,64,0.30)';
      ctx.fillRect(xb, y + nh * 0.32, Math.max(0, xs - xb), Math.max(1, nh * 0.36));
    }
    const v = flat || n[3];
    const active = live && S.time >= s && S.time < e;
    const conf = n[5] == null ? 1 : n[5];
    ctx.beginPath();
    ctx.roundRect(xa, y, Math.max(1.5, xb - xa), nh, r);
    if (conf < 0.6) {
      ctx.setLineDash([3, 2]); ctx.strokeStyle = muted ? VEL_MUTED[v] : VEL[Math.max(v, 80)]; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    } else {
      ctx.fillStyle = active && !muted ? '#fff1d8' : muted ? VEL_MUTED[v] : VEL[v];
      ctx.fill();
    }
    if (S.hoverNote === n) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}

function drawAuto(ctx, L, list, col, state, W, reveal) {
  const top = L.y + 7, bot = L.y + L.h - 7;
  const dim = state !== 'on';
  ctx.save();
  ctx.globalAlpha = dim ? 0.3 : 1;
  ctx.fillStyle = rgba(col, 0.2);
  for (const p of list) {
    if (p[0] >= reveal) continue;
    const a = X(p[0]), b = X(Math.min(p[1], reveal));
    if (b < 0 || a > W) continue;
    ctx.fillRect(a, top, b - a, bot - top);
  }
  ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  ctx.beginPath();
  const end = Math.min(DUR, reveal);
  ctx.moveTo(X(0), bot);
  for (const p of list) {
    if (p[0] >= reveal) break;
    const a = X(p[0]), b = X(Math.min(p[1], reveal));
    ctx.lineTo(a, bot); ctx.lineTo(a, top); ctx.lineTo(b, top); ctx.lineTo(b, p[1] <= reveal ? bot : top);
  }
  ctx.lineTo(X(end), bot);
  ctx.stroke();
  if (V.pps >= 14 && !dim) {
    ctx.fillStyle = rgba(col, 1);
    for (const p of list) {
      if (p[0] >= reveal) break;
      const a = X(p[0]), b = X(p[1]);
      if (b < -4 || a > W + 4) continue;
      ctx.fillRect(a - 2, top - 2, 4, 4);
      if (p[1] <= reveal) ctx.fillRect(b - 2, bot - 2, 4, 4);
    }
  }
  ctx.restore();
}

function drawRuler() {
  const { ctx, w: W, h: H } = prep(el.rulerCv);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#202227'); grad.addColorStop(1, '#1a1c20');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  const beat = 60 / S.out.tempo, bar = beat * 4;
  const t0 = V.sx, t1 = T(W);
  const LB = 8, ROW = 21;
  ctx.fillStyle = '#121316'; ctx.fillRect(0, 0, W, LB);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(0, ROW, W, 1);
  // loop brace
  if (S.view === 'result') {
    const a = X(S.loopA), b = X(S.loopB);
    if (S.loop) {
      ctx.fillStyle = rgba(COL.loop, 0.9);
      ctx.beginPath(); ctx.roundRect(a, 1.5, b - a, LB - 3, 2); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(160,168,180,0.4)';
      ctx.fillRect(a, 3.5, b - a, 1);
      ctx.fillRect(Math.round(a), 1.5, 1.5, LB - 3); ctx.fillRect(Math.round(b) - 1.5, 1.5, 1.5, LB - 3);
    }
  }
  if (S.view !== 'home' && X(DUR) < W) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(X(DUR), LB, W - X(DUR), H - LB); }
  // bars
  const barPx = bar * V.pps, beatPx = beat * V.pps;
  let step = 1; while (step * barPx < 30) step *= 2;
  ctx.font = '600 10.5px ' + FONT_NUM; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (let k = Math.max(0, Math.floor(t0 / bar)); k * bar <= t1 + bar; k++) {
    const x = Math.round(X(k * bar));
    if (k % step === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.fillRect(x, LB, 1, ROW - LB);
      ctx.fillStyle = '#c3c8cf'; ctx.fillText(String(k + 1), x + 4, LB + (ROW - LB) / 2 + 0.5);
    } else if (barPx >= 6) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x, ROW - 5, 1, 5);
    }
  }
  if (beatPx >= 7) {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    for (let k = Math.max(0, Math.floor(t0 / beat)); k * beat <= t1; k++) { if (k % 4) ctx.fillRect(Math.round(X(k * beat)), ROW - 3, 1, 3); }
  }
  // time
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
  const ts = steps.find((s) => s * V.pps >= 46) || 120;
  ctx.font = '400 10px ' + FONT_NUM;
  for (let k = Math.max(0, Math.floor(t0 / ts)); k * ts <= t1; k++) {
    const t = k * ts, x = Math.round(X(t));
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(x, H - 4, 1, 4);
    ctx.fillStyle = '#9aa1ab';
    ctx.fillText(ts < 1 ? fmtTenth(t) : fmtTime(t), x + 4, ROW + (H - ROW) / 2);
  }
  // playhead marker
  if (S.view === 'result') {
    const px = Math.round(X(S.time)) + 0.5;
    if (px >= -6 && px <= W + 6) {
      ctx.fillStyle = COL.playhead;
      // the head sits in the loop strip so it never hides the bar number under it
      ctx.beginPath(); ctx.moveTo(px - 5.5, 0); ctx.lineTo(px + 5.5, 0); ctx.lineTo(px + 5.5, 4); ctx.lineTo(px, 10); ctx.lineTo(px - 5.5, 4); ctx.closePath(); ctx.fill();
      ctx.fillRect(px - 0.5, 9, 1, H - 9);
    }
  }
  ctx.fillStyle = '#08090a'; ctx.fillRect(0, H - 1, W, 1);
}

function drawOverview() {
  const { ctx, w: W, h: H } = prep(el.ovCv);
  ctx.fillStyle = '#0f1012'; ctx.fillRect(0, 0, W, H);
  if (S.view === 'home') return;
  const sx = W / DUR;
  const prog = S.view === 'progress' ? progInfo() : null;
  const reveal = prog ? prog.revealT : Infinity;
  // waveform
  const n = WF.rms.length;
  ctx.fillStyle = rgba(COL.audio, 0.35);
  for (let px = 0; px < W; px++) {
    const i0 = Math.floor((px / W) * n), i1 = Math.max(i0 + 1, Math.floor(((px + 1) / W) * n));
    let r = 0; for (let i = i0; i < i1 && i < n; i++) if (WF.rms[i] > r) r = WF.rms[i];
    const h = Math.min(1, r * 2) * (H - 4);
    ctx.fillRect(px, (H - h) / 2, 1, h);
  }
  // mini notes
  ctx.fillStyle = rgba(COL.midi, 0.85);
  for (const nt of displayNotes()) {
    if (nt[0] >= reveal) break;
    const y = 2 + ((HI - nt[2]) / (HI - LO)) * (H - 5);
    ctx.fillRect(nt[0] * sx, y, Math.max(1, (nt[1] - nt[0]) * sx), 1);
  }
  if (prog) { ctx.fillStyle = 'rgba(8,9,10,0.55)'; ctx.fillRect(reveal * sx, 0, W - reveal * sx, H); }
  // viewport
  const va = V.sx * sx, vb = Math.min(W, (V.sx + viewW() / V.pps) * sx);
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(va, 0, vb - va, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(va) + 0.5, 0.5, Math.max(4, vb - va - 1), H - 1);
  if (S.view === 'result') { ctx.fillStyle = COL.playhead; ctx.fillRect(Math.round(S.time * sx), 0, 1, H); }
}

function drawKeyboard() {
  const { ctx, w, h } = prep(el.kbdCv);
  ctx.clearRect(0, 0, w, h);
  const rows = HI - LO + 1, rh = h / rows;
  const kx = 18, kw = w - kx;
  const active = new Set();
  if (S.view === 'result') {
    const notes = displayNotes();
    for (let i = lowerBound(notes, S.time - MAXSPAN - 0.01); i < notes.length && notes[i][0] <= S.time; i++) if (S.time < notes[i][1]) active.add(notes[i][2]);
  }
  ctx.fillStyle = '#d5d8dd'; ctx.fillRect(kx, 0, kw, h);
  for (let p = LO; p <= HI; p++) {
    const y = (HI - p) * rh;
    if (isBlack(p)) {
      ctx.fillStyle = active.has(p) ? '#f0a640' : '#1d1f23';
      ctx.fillRect(kx, y + 0.5, kw * 0.6, Math.max(1, rh - 1));
    } else {
      if (active.has(p)) { ctx.fillStyle = '#ffbd5c'; ctx.fillRect(kx, y, kw, rh); }
      if (!isBlack(p + 1) && p < HI) { ctx.fillStyle = '#8f959e'; ctx.fillRect(kx, Math.round(y) - 0.5, kw, 1); }
    }
    if (p % 12 === 0 && rh >= 4) {
      ctx.fillStyle = '#9aa1ab';
      ctx.font = '400 ' + Math.min(10, Math.max(8.5, rh + 1)).toFixed(1) + 'px ' + FONT_NUM;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      ctx.fillText(noteName(p), kx - 3, y + rh / 2);
    }
  }
  ctx.fillStyle = '#08090a'; ctx.fillRect(w - 1, 0, 1, h);
}

// ------------------------------------------------------------------ hit testing + tooltip
function hitNote(x, y) {
  const g = laneGeo();
  const mb = midiBody(g.midi);
  if (y < mb.y || y > mb.y + mb.h) return null;
  const rh = mb.h / (HI - LO + 1);
  const p = HI - Math.floor((y - mb.y) / rh);
  const t = T(x);
  const notes = displayNotes();
  let best = null;
  for (let i = lowerBound(notes, t - MAXSPAN - 0.01); i < notes.length && notes[i][0] <= t; i++) {
    const n = notes[i];
    const end = S.out.pedal === 'extend' ? Math.max(n[1], n[4] || n[1]) : n[1];
    if (n[2] === p && t <= Math.max(end, n[0] + 1.5 / V.pps)) best = n;
  }
  return best;
}
function hitPedal(x, y) {
  const g = laneGeo();
  const t = T(x);
  for (const [id, list, name] of [['sus', SUS, 'Sustain'], ['soft', SOFT, 'Soft pedal']]) {
    const L = g[id];
    if (y >= L.y && y < L.y + L.h) {
      const p = list.find((q) => t >= q[0] && t <= q[1]);
      return p ? { name, p } : null;
    }
  }
  return null;
}
function showTip(x, y, html, status) {
  const tip = el.tip;
  tip.innerHTML = html;
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight, W = viewW(), H = el.lanes.clientHeight;
  let left, top;
  if (x + 14 + tw <= W - 4) { left = x + 14; top = y - th / 2; }
  else if (x - 14 - tw >= 4) { left = x - 14 - tw; top = y - th / 2; }
  else { left = clamp(x - tw / 2, 4, W - tw - 4); top = y - th - 14; if (top < 4) top = y + 16; }
  tip.style.left = left + 'px';
  tip.style.top = clamp(top, 4, Math.max(4, H - th - 4)) + 'px';
  tip.style.transform = 'none';
  S.hover = status;
  renderStatusMsg();
}
function hideTip() {
  el.tip.hidden = true;
  if (S.hoverNote) { S.hoverNote = null; draw(); }
  if (S.hover) { S.hover = null; renderStatusMsg(); }
}

// ------------------------------------------------------------------ events: arrangement
function bindArrangement() {
  const cv = el.lanesCv;
  cv.addEventListener('wheel', (e) => {
    if (S.view === 'home') return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left);
    else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      V.sx = clampScroll(V.sx + (e.deltaMode === 1 ? d * 30 : d) / V.pps);
      V.userScrolledAt = performance.now();
      draw();
    }
  }, { passive: false });
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (S.view === 'home') return;
    cv.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, sx: V.sx, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) { V.sx = clampScroll(drag.sx - dx / V.pps); V.userScrolledAt = performance.now(); cv.style.cursor = 'grabbing'; hideTip(); draw(); return; }
    }
    if (S.view === 'home') return;
    const n = hitNote(x, y);
    if (n !== S.hoverNote) { S.hoverNote = n; draw(); }
    if (n) {
      const len = n[1] - n[0];
      const conf = n[5] == null ? 1 : n[5];
      const vel = S.out.velocity === 'flat' ? S.out.flat_velocity : n[3];
      const sure = conf < 0.995 ? Math.round(conf * 100) + '% sure' : 'certain';
      const pedalHeld = (n[4] || n[1]) > n[1] + 0.01 && S.out.pedal !== 'none' ? ' · held by pedal ' + fmtLen((n[4] || n[1]) - n[1]) : '';
      showTip(x, y, '<b>' + noteName(n[2]) + '</b>velocity ' + vel + ' · ' + fmtLen(len) + ' <span class="tip-dim">· ' + sure + pedalHeld + '</span>',
        '<b>' + noteName(n[2]) + '</b>  at ' + fmtTenth(n[0]) + ' · velocity ' + vel + ' · key held ' + fmtLen(len) + pedalHeld + ' · ' + sure);
      cv.style.cursor = 'pointer';
      return;
    }
    const pd = hitPedal(x, y);
    if (pd) {
      const st = (pd.name === 'Sustain' && S.out.pedal !== 'cc') || (pd.name === 'Soft pedal' && !S.out.soft_pedal) ? ' · not written' : '';
      showTip(x, y, '<b>' + pd.name + '</b>down ' + fmtTenth(pd.p[0]) + ' → ' + fmtTenth(pd.p[1]) + ' <span class="tip-dim">· ' + fmtLen(pd.p[1] - pd.p[0]) + st + '</span>',
        '<b>' + pd.name + '</b>  pressed ' + fmtTenth(pd.p[0]) + ' – ' + fmtTenth(pd.p[1]) + ' (' + fmtLen(pd.p[1] - pd.p[0]) + ')' + st);
      cv.style.cursor = 'crosshair';
      return;
    }
    hideTip();
    cv.style.cursor = 'crosshair';
  });
  const end = (e) => {
    if (drag && !drag.moved && e.type === 'pointerup' && S.view === 'result') {
      const r = cv.getBoundingClientRect();
      seek(T(e.clientX - r.left));
    }
    drag = null;
    cv.style.cursor = 'crosshair';
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', hideTip);

  // ruler: click/drag to scrub, drag along the top edge to set the loop
  const rc = el.rulerCv;
  let rdrag = null;
  rc.addEventListener('pointerdown', (e) => {
    if (S.view !== 'result') return;
    rc.setPointerCapture(e.pointerId);
    const r = rc.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const beat = 60 / S.out.tempo;
    if (y <= 9) { rdrag = { loop: true, a: Math.round(T(x) / beat) * beat }; }
    else { rdrag = { loop: false }; seek(T(x)); }
  });
  rc.addEventListener('pointermove', (e) => {
    if (!rdrag) return;
    const r = rc.getBoundingClientRect();
    const t = clamp(T(e.clientX - r.left), 0, DUR);
    if (rdrag.loop) {
      const beat = 60 / S.out.tempo;
      const b = Math.round(t / beat) * beat;
      if (Math.abs(b - rdrag.a) >= beat) { S.loopA = Math.min(rdrag.a, b); S.loopB = Math.max(rdrag.a, b); S.loop = true; renderTransport(); draw(); }
    } else seek(t);
  });
  rc.addEventListener('pointerup', () => { rdrag = null; });
  rc.addEventListener('wheel', (e) => { if (S.view === 'home') return; e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX - rc.getBoundingClientRect().left); }, { passive: false });

  // overview: click/drag to move the visible range
  const oc = el.ovCv;
  let odrag = false;
  const ovMove = (e) => {
    const r = oc.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * DUR;
    const vs = viewW() / V.pps;
    V.sx = clampScroll(t - vs / 2);
    V.userScrolledAt = performance.now();
    draw();
  };
  oc.addEventListener('pointerdown', (e) => { if (S.view === 'home') return; odrag = true; oc.setPointerCapture(e.pointerId); ovMove(e); });
  oc.addEventListener('pointermove', (e) => { if (odrag) ovMove(e); });
  oc.addEventListener('pointerup', () => { odrag = false; });

  new ResizeObserver(() => { if (V.needsFit) fitDefault(); else V.sx = clampScroll(V.sx); syncZoomSlider(); drawNow(); }).observe(el.lanes);
  new ResizeObserver(() => drawNow()).observe(el.rulerCv);
}

// ------------------------------------------------------------------ events: controls
function rovingTabindex(group) {
  if (!group) return;
  const radios = [...group.querySelectorAll('[role="radio"]')];
  const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true' && !r.disabled) || radios.find((r) => !r.disabled);
  radios.forEach((r) => { r.tabIndex = r === checked ? 0 : -1; });
}
function activateRadio(b) {
  if (b.dataset.mix) { setMix(b.dataset.mix); return; }
  if (b.dataset.opt) {
    const path = b.dataset.opt, val = b.dataset.val;
    const cur = path === 'engine' ? S.engine : S[path.split('.')[0]][path.split('.')[1]];
    if (cur !== val) setOpt(path, val);
  }
}
function setMix(mix) {
  if (S.view !== 'result') return;
  S.solo.audio = S.solo.midi = false;
  S.mute.audio = mix === 'midi';
  S.mute.midi = mix === 'original';
  renderToolbar(); renderHeaders(); draw();
  flash('Listening to ' + ({ original: 'the original recording', both: 'the recording and the MIDI together', midi: 'the MIDI only' }[mix]));
}
function stepNum(input, dir, big) {
  const min = +input.dataset.min, max = +input.dataset.max, step = +input.dataset.step || 1;
  const cur = parseFloat(input.value) || 0;
  const v = clamp(Math.round(cur + dir * step * (big ? 10 : 1)), min, max);
  input.value = v;
  commitNum(input, v);
}
function commitNum(input, v) {
  const path = input.dataset.num || 'out.tempo';
  if (S.out.tempo === v && path === 'out.tempo') { input.value = v; return; }
  setOpt(path, v, { rebuild: false });
  // keep the twin field (transport LCD / inspector) in sync
  const twin = input.id === 'tempoField' ? document.querySelector('[data-num="out.tempo"]') : $('tempoField');
  if (twin && twin !== document.activeElement) twin.value = v;
}
function bindControls() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t || t.disabled) return;
    if (t.getAttribute('role') === 'radio') { activateRadio(t); return; }
    if (t.getAttribute('role') === 'switch' && t.dataset.opt) { setOpt(t.dataset.opt, t.getAttribute('aria-checked') !== 'true'); return; }
    if (t.dataset.ms) {
      const lane = t.dataset.lane, kind = t.dataset.ms;
      S[kind][lane] = !S[kind][lane];
      renderHeaders(); renderToolbar(); draw();
      return;
    }
    if (t.dataset.stepfor) { const inp = t.closest('.num').querySelector('input'); stepNum(inp, +t.dataset.dir, e.shiftKey); return; }
    if (t.dataset.goto) { goTo(t.dataset.goto); return; }
    if (t.dataset.rid) { openRecent(t.dataset.rid); return; }
    const act = t.dataset.act;
    if (act === 'adv') { setAdvanced(true); const f = el.inspBody.querySelector('.eng[aria-checked="true"]'); if (f && e.detail === 0) f.focus(); return; }
    if (act === 'sec') { const id = t.dataset.sec; S.collapsed[id] = !S.collapsed[id]; t.setAttribute('aria-expanded', String(!S.collapsed[id])); const b = t.closest('.isec').querySelector('.isec-b'); b.hidden = !!S.collapsed[id]; return; }
    if (act === 'more') { S.more = !S.more; t.setAttribute('aria-expanded', String(S.more)); $('moreBody').hidden = !S.more; return; }
    if (act === 'reset') { resetDefaults(); return; }
    if (act === 'rerun') { S.used = null; startRun(S.file); return; }
  });
  document.addEventListener('change', (e) => {
    const s = e.target;
    if (s.matches('select[data-opt]')) setOpt(s.dataset.opt, s.value);
    if (s.matches('input[data-range]')) { setOpt(s.dataset.range, +s.value); }
  });
  document.addEventListener('input', (e) => {
    const s = e.target;
    if (s.matches('input[data-range]')) {
      const spec = OUTS.find((o) => 'out.' + o.key === s.dataset.range);
      s.style.setProperty('--fill', ((s.value - spec.min) / (spec.max - spec.min)) * 100 + '%');
      const v = s.closest('.irow').querySelector('.fader-val'); if (v) v.textContent = minLenText(+s.value);
      s.setAttribute('aria-valuetext', minLenText(+s.value));
      setOpt(s.dataset.range, +s.value, { rebuild: false });
    }
  });
  // numeric fields: tempo in the LCD + inspector
  const isNum = (t) => t && t.matches && (t.matches('input[data-num]') || t.id === 'tempoField');
  document.addEventListener('keydown', (e) => {
    if (!isNum(e.target)) return;
    const inp = e.target;
    if (!inp.dataset.min) { inp.dataset.min = 20; inp.dataset.max = 300; inp.dataset.step = 1; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepNum(inp, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
    else if (e.key === 'Enter') { inp.blur(); }
    else if (e.key === 'Escape') { inp.value = S.out.tempo; inp.blur(); }
  }, true);
  document.addEventListener('focusout', (e) => {
    if (!isNum(e.target)) return;
    const inp = e.target;
    const min = +(inp.dataset.min || 20), max = +(inp.dataset.max || 300);
    const v = parseFloat(inp.value);
    if (!isFinite(v)) { inp.value = S.out.tempo; return; }
    const c = clamp(Math.round(v), min, max);
    inp.value = c;
    if (c !== S.out.tempo) commitNum(inp, c);
  });
  // drag up/down on numeric fields and knobs
  let nd = null;
  document.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.knob');
    if (k) { e.preventDefault(); k.focus(); k.setPointerCapture(e.pointerId); nd = { knob: k, y: e.clientY, v: +k.getAttribute('aria-valuenow') }; return; }
    if (isNum(e.target) && document.activeElement !== e.target) {
      e.preventDefault();
      const inp = e.target;
      if (!inp.dataset.min) { inp.dataset.min = 20; inp.dataset.max = 300; inp.dataset.step = 1; }
      inp.setPointerCapture(e.pointerId);
      nd = { num: inp, y: e.clientY, v: S.out.tempo, moved: false };
    }
  });
  document.addEventListener('pointermove', (e) => {
    if (!nd) return;
    const dy = nd.y - e.clientY;
    if (nd.knob) {
      const min = +nd.knob.dataset.min, max = +nd.knob.dataset.max;
      setKnob(nd.knob, clamp(Math.round(nd.v + dy * (max - min) / 160), min, max));
    } else if (nd.num) {
      if (Math.abs(dy) > 3) nd.moved = true;
      if (nd.moved) {
        const v = clamp(Math.round(nd.v + dy / 3), +nd.num.dataset.min, +nd.num.dataset.max);
        if (v !== S.out.tempo) { nd.num.value = v; commitNum(nd.num, v); }
      }
    }
  });
  document.addEventListener('pointerup', () => {
    if (nd && nd.num && !nd.moved) { nd.num.focus(); nd.num.select(); }
    nd = null;
  });
  document.addEventListener('dblclick', (e) => { const k = e.target.closest('.knob'); if (k) setKnob(k, +k.dataset.def); });
  document.addEventListener('keydown', (e) => {
    const k = e.target.closest && e.target.closest('.knob');
    if (!k) return;
    const min = +k.dataset.min, max = +k.dataset.max, v = +k.getAttribute('aria-valuenow');
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (e.key in map) { e.preventDefault(); e.stopPropagation(); setKnob(k, clamp(v + map[e.key], min, max)); }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); setKnob(k, min); }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); setKnob(k, max); }
  }, true);
  // radio groups: arrow keys move the selection
  document.addEventListener('keydown', (e) => {
    const b = e.target;
    if (!b.getAttribute || b.getAttribute('role') !== 'radio') return;
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const group = b.closest('[role="radiogroup"]');
    const radios = [...group.querySelectorAll('[role="radio"]')].filter((r) => !r.disabled);
    const next = radios[(radios.indexOf(b) + dir + radios.length) % radios.length];
    activateRadio(next);
    const again = (next.dataset.fid && document.querySelector('[data-fid="' + next.dataset.fid + '"]')) || next;
    again.focus();
    rovingTabindex(again.closest('[role="radiogroup"]'));
  }, true);
  // info view: hover / focus explains the control
  const infoFrom = (e) => { const h = e.target.closest && e.target.closest('[data-help]'); if (h && h.dataset.help !== infoKey) setInfo(h.dataset.help); };
  document.addEventListener('mouseover', infoFrom);
  document.addEventListener('focusin', infoFrom);
  $('inspector').addEventListener('mouseleave', () => { if (!$('inspector').contains(document.activeElement)) setInfo(null); });
}
function setKnob(k, v) {
  k.setAttribute('aria-valuenow', v);
  const min = +k.dataset.min, max = +k.dataset.max;
  k.innerHTML = knobSvg((v - min) / (max - min));
  const out = k.parentNode.querySelector('.knob-val'); if (out) out.textContent = v;
  if (S.out.flat_velocity !== v) setOpt(k.dataset.knob, v, { rebuild: false });
}

function openRecent(id) {
  setBrowserOpen(false);
  if (id === 'current') { if (S.view !== 'result' && S.view !== 'progress') enterResult(0); return; }
  const r = M.recent.find((x) => x.id === id);
  if (!r) return;
  if (r.id === JOB.id) { S.file = JOB.filename; if (S.view !== 'result') { S.used = S.used || snapshotEngine(); enterResult(0); } else { S.activeId = JOB.id; renderAll(); } return; }
  if (r.status === 'running') { toast(r.filename + ' is converting · ' + Math.round(r.progress * 100) + '% done'); return; }
  if (r.status === 'queued') { toast(r.filename + ' is waiting for the current conversion to finish'); return; }
  if (r.status === 'error') { toast('Could not convert ' + r.filename + ': ' + (r.error || 'unknown error'), { kind: 'warn', action: { label: 'Try again', run: () => startRun(r.filename) } }); return; }
  toast('Only the Schubert result is included in this preview');
}

function bindChrome() {
  $('playBtn').onclick = togglePlay;
  $('stopBtn').onclick = () => { if (S.playing) { stopPlay(); draw(); } else seek(S.loop ? S.loopA : 0); renderTransport(); };
  $('startBtn').onclick = () => { seek(S.loop ? S.loopA : 0); V.sx = clampScroll(S.time - 1); draw(); };
  $('loopBtn').onclick = () => { S.loop = !S.loop; renderTransport(); draw(); flash(S.loop ? 'Loop on · bars ' + barOf(S.loopA) + '–' + (barOf(S.loopB) - 1) : 'Loop off'); };
  $('newBtn').onclick = () => { if (S.view === 'home') startRun(); else { setAdvanced(false); enterHome(); } };
  $('brand').onclick = (e) => { e.preventDefault(); if (S.view !== 'progress') { setAdvanced(false); enterHome(); } };
  $('saveBtn').onclick = saveMidi;
  $('advBtn').onclick = () => setAdvanced(!S.advanced);
  $('inspMode').onclick = () => setAdvanced(!S.advanced);
  $('inspClose').onclick = () => { setAdvanced(false); $('advBtn').focus(); };
  $('browserToggle').onclick = () => setBrowserOpen(!body.classList.contains('browser-open'));
  $('browserClose').onclick = () => { setBrowserOpen(false); $('browserToggle').focus(); };
  $('addBtn').onclick = () => startRun();
  $('cancelBtn').onclick = cancelRun;
  $('chooseBtn').onclick = (e) => { e.stopPropagation(); startRun(); };
  $('dsEngine').onclick = (e) => { e.stopPropagation(); setAdvanced(true); };
  document.querySelector('.drop-setup').addEventListener('click', (e) => e.stopPropagation());
  $('dropRecent').addEventListener('click', (e) => {
    e.stopPropagation();
    const c = e.target.closest('[data-drid]');
    if (c) { openRecent(c.dataset.drid); return; }
    if (e.target.closest('#dropAll')) { setBrowserOpen(true); const f = document.querySelector('#recentList .ritem'); if (f && e.detail === 0) f.focus(); }
  });
  $('drop').addEventListener('click', () => startRun());
  $('zoomIn').onclick = () => zoomBy(1.4);
  $('zoomOut').onclick = () => zoomBy(1 / 1.4);
  $('zoomFit').onclick = () => { V.pps = minPps(); V.sx = 0; syncZoomSlider(); draw(); };
  $('arrange').addEventListener('pointerdown', () => setBrowserOpen(false));
  $('gpuMeter').dataset.help = 'gpu';
  $('loopBtn').dataset.help = 'loop';
  $('monitorWrap').dataset.help = 'mix';
  document.querySelectorAll('.t-ctl').forEach((n) => { n.dataset.help = 'ms'; });

  // drag and drop files anywhere
  let depth = 0;
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('drop').classList.add('over'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; $('drop').classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) startRun(f.name);
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t.matches && t.matches('input[type="text"], select, textarea');
    if (e.key === 'Escape') {
      if (body.classList.contains('browser-open')) { setBrowserOpen(false); return; }
      if (S.advanced && !typing) { setAdvanced(false); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveMidi(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); startRun(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const onControl = t.closest && t.closest('button, [role="slider"], input, a');
    if (e.code === 'Space' && !onControl) { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'Home' && !onControl) { e.preventDefault(); $('startBtn').click(); return; }
    if ((e.key === 'l' || e.key === 'L') && S.view === 'result') { $('loopBtn').click(); return; }
    if ((e.key === '+' || e.key === '=') && S.view !== 'home') { zoomBy(1.4); return; }
    if ((e.key === '-' || e.key === '_') && S.view !== 'home') { zoomBy(1 / 1.4); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !onControl && S.view === 'result') {
      e.preventDefault();
      const bar = 240 / S.out.tempo;
      const k = Math.round(S.time / bar) + (e.key === 'ArrowRight' ? 1 : -1);
      seek(k * bar);
    }
  });

  const onMq = () => {
    body.classList.toggle('insp-open', S.advanced && mqInsp.matches);
    if (!mqBrowser.matches) setBrowserOpen(false);
    renderInspector();
  };
  mqInsp.addEventListener('change', onMq);
  mqBrowser.addEventListener('change', onMq);
}
function barOf(t) { return Math.round(t / (240 / S.out.tempo)) + 1; }
function saveMidi() {
  if (S.view !== 'result') return;
  toast('Saved ' + S.midiName, { action: { label: 'Show in folder', run: () => {} } });
  flash('<span class="ok">✓</span> Saved ' + esc(S.midiName));
}

// ------------------------------------------------------------------ boot
bindArrangement();
bindControls();
bindChrome();
const start = qs.get('state') || 'home';
if (start === 'progress') enterProgress(true);
else if (start === 'result') { setAdvanced(false, true); enterResult(12); }
else if (start === 'advanced') { enterResult(12); setAdvanced(true); }
else enterHome();
drawNow();
})();
