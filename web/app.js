import { PianoRoll, fmtTime, noteName } from './pianoroll.js';
import { Player } from './player.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'midiconv.settings.v1';
const DEPENDS = { flat_velocity: (o) => o.velocity === 'flat' };
const MAX_UPLOAD = 2 * 1024 ** 3;
const QUALITY_VIEWS = 'channels'; // both plain Quality choices use the measured-best analysis views
const QUALITY_WORDS = { best: 'Best quality', faster: 'Faster', custom: 'Custom' };
const APPEARANCES = [{ value: 'light', text: 'Light' }, { value: 'system', text: 'Match Windows' }, { value: 'dark', text: 'Dark' }];

// Plain words for the options this app knows. Anything else (a new engine or option) falls back to the
// schema's own label and help from /api/info, so the Options sheet always shows every option.
const WORDS = {
  engine: {
    ensemble: { short: 'Ensemble', desc: 'Transkun V2 writes, Aria-AMT double-checks.' },
    transkun: { short: 'Transkun V2', desc: 'About 4× faster and almost as accurate.' },
    aria: { short: 'Aria-AMT', desc: 'On its own, for comparison.' },
  },
  eng: {
    views: {
      choices: { none: 'Single', channels: 'Stereo 4×', full: 'Stereo + tone 6×' },
      summary: { none: 'Single view', channels: 'Stereo views 4×', full: 'Stereo + tone views 6×' },
      help: 'More views take longer but catch more detail. Stereo 4× measured best.',
    },
    rescue: {
      choices: { '0.1': 'Generous', '0.3': 'Balanced', '0.5': 'Cautious' },
      help: 'How readily notes only Aria-AMT heard are added. Balanced measured best.',
    },
    velocity: { choices: { mode: 'Most likely', mean: 'Average', median: 'Median' }, help: 'How each note’s loudness is read from the model.' },
    merge_fix: { help: 'Keeps long sustain-pedal presses from being cut or dropped.' },
  },
  out: {
    pedal: {
      tech: 'CC64',
      choices: { cc: 'Keep as pedal', extend: 'Bake into notes', none: 'Leave out' },
      help: {
        cc: 'Writes the sustain pedal as pedal events. The most faithful choice.',
        extend: 'Lengthens the notes instead, for apps that ignore the pedal.',
        none: 'Leaves the sustain pedal out of the file.',
      },
    },
    soft_pedal: { help: 'Include una corda pedal events.' },
    velocity: {
      choices: { played: 'As played', flat: 'Even' },
      help: { played: 'Keeps how hard each key was struck.', flat: 'Gives every note the same loudness.' },
    },
    flat_velocity: { help: 'The loudness every note gets, from 1 to 127.' },
    min_note_ms: { help: 'Drops notes shorter than this. Off keeps everything.' },
    tempo: { help: 'Only changes how bars line up in a DAW or notation app. Notes keep their real timing.' },
  },
};

const IC = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 15.5l7-7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>',
  redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8v4h-4"/><path d="M18.6 12A7 7 0 1 1 16.5 6.6"/></svg>',
  toastOk: '<svg class="t-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  toastErr: '<svg class="t-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
};

const state = {
  info: null,
  instrument: 'piano',
  settings: loadSettings(),
  job: null, // job currently shown (progress or result)
  es: null,
  pollTimer: 0,
  exportTimer: 0,
  recent: [],
  viewSeq: 0, // bumped whenever the main view switches to another job (late responses are ignored)
  recentTimer: 0,
  uploadXhr: null,
  retry: null, // what "Try again" converts again: { file } or { job }
  result: null, // { notes, pedals, duration } of the open result, as drawn
  more: false, // Options: "More settings" open
  opener: null, // element that opened Options (focus returns there)
  settingsLoaded: false, // the saved settings (server copy) are in state.settings
  sentDark: null, // last theme handed to the desktop shell
  playPending: null, // a play() still loading (piano sounds, audio)
  eta: null,
};

const roll = new PianoRoll($('roll'), {
  onSeek: (t) => { player.seek(t); roll.setTime(t, player.playing); updateTime(); },
  formatTip: plainNote,
});
const player = new Player({
  onStatus: (s) => { $('pianoStatus').textContent = s; },
  onEnded: () => { setPlaying(false); roll.setTime(player.time, false); updateTime(); },
});

// ------------------------------------------------------------------ small helpers
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const stem = (name) => String(name).replace(/\.[^.]+$/, '') || String(name);
const ext = (name) => (/\.([^.]+)$/.exec(name)?.[1] || '').toUpperCase();
const stripParen = (s) => String(s).replace(/\s*\([^)]*\)\s*$/, '');
function splitLabel(label) {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  return m ? [m[1], m[2]] : [label, ''];
}
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function fmtDuration(sec) {
  if (!isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}
const fmtTook = (sec) => (sec < 60 ? `${sec.toFixed(1)} s` : fmtDuration(sec));

function friendlyWhen(seconds) {
  const d = new Date(seconds * 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Hover text in plain words ("E5 · soft · held 0.28 s") instead of velocity numbers.
function loudWord(v) { return v < 36 ? 'very soft' : v < 56 ? 'soft' : v < 76 ? 'medium' : v < 96 ? 'loud' : 'very loud'; }
function plainNote(n) {
  const len = n[1] - n[0];
  const held = len < 0.1 ? 'a quick touch' : `held ${len < 10 ? len.toFixed(len < 1 ? 2 : 1) : Math.round(len)} s`;
  const even = state.job?.output_options?.velocity === 'flat';
  let s = `${noteName(n[2])}${n[2] === 60 ? ' (middle C)' : ''} · ${even ? 'even' : loudWord(n[3])} · ${held}`;
  const conf = n[5] ?? 1;
  if (conf < 0.6) s += ' · not quite sure'; // drawn dashed
  else if (conf < 0.9) s += ' · fairly sure';
  return s;
}

// ------------------------------------------------------------------ settings
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* storage full */ }
  clearTimeout(saveSettings.timer);
  saveSettings.timer = setTimeout(() => {
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.settings) })
      .catch(() => {});
  }, 300);
}
function instrumentInfo() { return state.info.instruments.find((i) => i.id === state.instrument) || state.info.instruments[0]; }
function engineSettings() {
  const inst = instrumentInfo();
  state.settings.engines ??= {};
  const s = (state.settings.engines[inst.id] ??= { engine: inst.default_engine, options: {} });
  s.options ??= {};
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
function specFor(scope, key) {
  return (scope === 'out' ? state.info.output_options : currentEngine().options).find((o) => o.key === key);
}
function engineShort(eng) { return WORDS.engine[eng.id]?.short || stripParen(eng.name); }
function choiceText(scope, key, c) { return WORDS[scope]?.[key]?.choices?.[c.value] || stripParen(c.label); }
function viewsSummary(spec, value) {
  return WORDS.eng.views.summary[value] || stripParen(spec.choices.find((c) => c.value === value)?.label || value);
}

// The three plain Quality choices map onto engines: Best = Ensemble (Transkun V2 when Ensemble is not
// installed), Faster = Transkun V2, both with the measured-best views. Anything else reads as "Custom".
function qualityEngines() {
  const inst = instrumentInfo();
  if (!inst.engines.some((e) => e.id === 'transkun')) return null;
  const ensemble = inst.engines.some((e) => e.id === 'ensemble' && e.available);
  return { best: ensemble ? 'ensemble' : 'transkun', faster: 'transkun' };
}
function qualityOf() {
  const q = qualityEngines();
  if (!q) return null;
  const eng = currentEngine();
  if (eng.options.some((o) => o.key === 'views') && engineOptions().views !== QUALITY_VIEWS) return 'custom';
  if (eng.id === q.best) return 'best';
  if (eng.id === q.faster) return 'faster';
  return 'custom';
}
function setQuality(q) {
  const id = qualityEngines()?.[q];
  const eng = instrumentInfo().engines.find((e) => e.id === id);
  if (!eng?.available) { toast(eng?.unavailable_reason || 'This engine is not installed.', null, 'error'); return false; }
  const es = engineSettings();
  es.engine = id;
  es.options[id] ??= {};
  if (eng.options.some((o) => o.key === 'views')) es.options[id].views = QUALITY_VIEWS;
  return true;
}

// ------------------------------------------------------------------ appearance
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function appearance() {
  const a = state.settings.appearance;
  return APPEARANCES.some((x) => x.value === a) ? a : 'light';
}
function applyAppearance() {
  const a = appearance();
  const dark = a === 'dark' || (a === 'system' && darkQuery.matches);
  const root = document.documentElement;
  const theme = dark ? 'dark' : 'light';
  if (root.dataset.theme !== theme) {
    root.dataset.theme = theme;
    roll.refreshColors();
  }
  // Tell the desktop shell (title bar, window background). Absent in a plain browser.
  if (state.sentDark !== dark && typeof window.pywebview?.api?.set_theme === 'function') {
    state.sentDark = dark;
    try { Promise.resolve(window.pywebview?.api?.set_theme?.(dark)).catch(() => {}); } catch { /* window closing */ }
  }
}
// Until init() has the saved settings, the theme the head script applied stands: applying the local copy
// here (empty on each launch's new origin, so "light") would flash a dark window light.
darkQuery.addEventListener('change', () => { if (state.settingsLoaded && appearance() === 'system') applyAppearance(); });
window.addEventListener('pywebviewready', () => { state.sentDark = null; if (state.settingsLoaded) applyAppearance(); });

// ------------------------------------------------------------------ views
function show(view) {
  const names = { viewDrop: 'home', viewProgress: 'progress', viewResult: 'result' };
  for (const v of Object.keys(names)) $(v).hidden = v !== view;
  $('app').dataset.view = names[view];
  closeMenu();
  if (view !== 'viewResult') { player.stop(); setPlaying(false); }
  if (view === 'viewResult') requestAnimationFrame(() => roll._resize());
}

function toast(msg, action = null, kind = 'ok') {
  const t = $('toast');
  t.innerHTML = kind === 'info' ? '' : kind === 'error' ? IC.toastErr : IC.toastOk;
  const m = document.createElement('span');
  m.className = 't-msg';
  m.textContent = msg;
  t.append(m);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.run(); };
    t.append(b);
  }
  t.classList.toggle('error', kind === 'error');
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

async function saveMidi(e) {
  const api = window.pywebview?.api;
  if (!api?.save_midi || !state.job) return; // plain download link fallback
  e.preventDefault();
  try {
    const r = await api.save_midi(state.job.id, state.job.midi_name);
    if (r?.saved) {
      flashSaved();
      toast(`Saved ${r.name}`, { label: 'Show in folder', run: () => api.show_in_folder(r.path) });
    } else if (r?.error) toast(r.error, null, 'error');
  } catch {
    toast('Could not save the MIDI file.', null, 'error');
  }
}
function flashSaved() {
  $('downloadBtn').classList.add('saved');
  $('saveLabel').textContent = 'Saved';
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(resetSaved, 2600);
}
function resetSaved() {
  clearTimeout(flashSaved.timer);
  $('downloadBtn').classList.remove('saved');
  $('saveLabel').textContent = 'Save MIDI';
}

// ------------------------------------------------------------------ home: instrument + settings line
function renderPicker() {
  $('instName').textContent = instrumentInfo().name;
  const menu = $('instMenu');
  menu.innerHTML = '';
  for (const inst of state.info.instruments) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(inst.id === state.instrument));
    b.innerHTML = `<span><b>${esc(inst.name)}</b><small>${esc(String(inst.description || '').replace(/\.$/, ''))}</small></span>${IC.check}`;
    b.onclick = (e) => {
      e.stopPropagation();
      closeMenu(true);
      if (inst.id === state.instrument) return;
      state.instrument = inst.id;
      state.settings.instrument = inst.id;
      saveSettings();
      renderAll();
    };
    menu.append(b);
  }
  const soon = document.createElement('div');
  soon.className = 'menu-item soon-item';
  soon.setAttribute('role', 'menuitem');
  soon.setAttribute('aria-disabled', 'true');
  soon.innerHTML = '<span><b>More instruments</b><small>Coming soon</small></span>';
  menu.append(soon);
}
function openMenu() {
  $('instMenu').hidden = false;
  $('instBtn').setAttribute('aria-expanded', 'true');
  ($('instMenu').querySelector('[aria-checked="true"]') || $('instMenu').querySelector('button'))?.focus();
}
function closeMenu(focusButton = false) {
  if ($('instMenu').hidden) return;
  $('instMenu').hidden = true;
  $('instBtn').setAttribute('aria-expanded', 'false');
  if (focusButton) $('instBtn').focus();
}

function renderSettingsLine() {
  const eng = currentEngine();
  const q = qualityOf();
  const parts = [];
  if (q) parts.push(`<b>${QUALITY_WORDS[q]}</b>`, esc(engineShort(eng)));
  else parts.push(`<b>${esc(engineShort(eng))}</b>`);
  const views = eng.options.find((o) => o.key === 'views');
  if (views) parts.push(esc(viewsSummary(views, engineOptions().views)));
  const line = $('settingsLine');
  line.innerHTML = parts.join('<span class="dot" aria-hidden="true">·</span>');
  line.setAttribute('aria-label', `${line.textContent.replace(/·/g, ', ')}. Change in Options`);
}

function renderAll() {
  renderPicker();
  renderSettingsLine();
  renderDrawer();
}

// ------------------------------------------------------------------ options sheet
function isResultOpen() { return state.job?.status === 'done' && !$('viewResult').hidden; }

function engineDiffers(job) {
  if (!job) return false;
  if (job.engine !== engineSettings().engine || job.instrument !== state.instrument) return true;
  const eo = engineOptions();
  return Object.keys(eo).some((k) => String(eo[k]) !== String(job.engine_options?.[k]));
}
function outputDiffers(job) {
  const oo = outputOptions();
  return Object.keys(oo).some((k) => String(oo[k]) !== String(job.output_options?.[k]));
}

// A segmented radio group. choices: [{ value, text, title?, disabled?, cls? }]
function segHTML({ scope, key, choices, value, label, wide = false }) {
  const anyOn = choices.some((c) => String(c.value) === String(value));
  return `<div class="seg${wide ? ' wide' : ''}" role="radiogroup" aria-label="${esc(label)}">` + choices.map((c, i) => {
    const on = String(c.value) === String(value);
    return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on || (!anyOn && i === 0) ? 0 : -1}"` +
      ` data-scope="${scope}" data-key="${esc(key)}" data-val="${esc(c.value)}"` +
      (c.disabled ? ' aria-disabled="true"' : '') + (c.cls ? ` class="${c.cls}"` : '') +
      ` title="${esc(c.title || c.text)}">${esc(c.text)}</button>`;
  }).join('') + '</div>';
}

function numText(spec, v) { return v === 0 && spec.min === 0 ? 'Off' : `${v}${spec.unit ? ` ${spec.unit}` : ''}`; }

// One option from the /api/info schema, drawn by its kind.
function fieldHTML(scope, spec, value) {
  const w = WORDS[scope]?.[spec.key] || {};
  const [main, tech0] = splitLabel(spec.label);
  const tech = w.tech || tech0;
  const id = `f-${scope}-${spec.key}`;
  const k = esc(spec.key);
  const data = `data-scope="${scope}" data-key="${k}"`;
  const changed = String(value) !== String(spec.default);
  const help = w.help && typeof w.help === 'object' ? (w.help[value] ?? spec.help) : (w.help || spec.help);
  const helpHTML = help ? `<p class="help">${esc(help)}</p>` : '';
  const labelInner = esc(main) + (tech ? ` <span class="tech">${esc(tech)}</span>` : '');
  const lbl = (tag, attrs) => `<${tag} class="field-label${changed ? ' changed' : ''}" ${attrs}${changed ? ' title="Changed from the default"' : ''}>${labelInner}</${tag}>`;

  if (spec.kind === 'choice') {
    if (spec.choices.length <= 4) {
      const choices = spec.choices.map((c) => ({ value: c.value, text: choiceText(scope, spec.key, c), title: c.label }));
      return `<div class="field"><div class="field-top">${lbl('span', `id="${id}"`)}</div>` +
        segHTML({ scope, key: spec.key, choices, value, label: main, wide: true }) + helpHTML + '</div>';
    }
    const opts = spec.choices.map((c) => `<option value="${esc(c.value)}"${String(c.value) === String(value) ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
    return `<div class="field"><div class="field-top">${lbl('label', `for="${id}"`)}</div><select id="${id}" ${data}>${opts}</select>${helpHTML}</div>`;
  }
  if (spec.kind === 'bool') {
    return `<div class="field field-inline"><div>${lbl('span', `id="${id}"`)}${helpHTML}</div>` +
      `<button type="button" class="switch" role="switch" aria-checked="${!!value}" aria-labelledby="${id}" ${data} data-toggle="1"></button></div>`;
  }
  const step = spec.step || 1;
  if (spec.min != null && spec.max != null && (spec.max - spec.min) / step <= 160) {
    const fill = (((value - spec.min) / (spec.max - spec.min)) * 100).toFixed(1);
    return `<div class="field"><div class="field-top">${lbl('label', `for="${id}"`)}<output id="${id}-out" for="${id}">${esc(numText(spec, value))}</output></div>` +
      `<input class="range" type="range" id="${id}" min="${spec.min}" max="${spec.max}" step="${step}" value="${esc(value)}" ${data} data-num="range" style="--fill:${fill}%">` +
      helpHTML + '</div>';
  }
  const what = esc(main.toLowerCase());
  return `<div class="field field-inline"><div>${lbl('label', `for="${id}"`)}${helpHTML}</div>` +
    `<div class="stepper"><button type="button" ${data} data-step="-1" aria-label="Lower ${what}">${IC.minus}</button>` +
    `<input id="${id}" type="number" inputmode="numeric"${spec.min != null ? ` min="${spec.min}"` : ''}${spec.max != null ? ` max="${spec.max}"` : ''} step="${step}" value="${esc(value)}" ${data} data-num="box">` +
    (spec.unit ? `<span class="unit">${esc(spec.unit)}</span>` : '') +
    `<button type="button" ${data} data-step="1" aria-label="Raise ${what}">${IC.plus}</button></div></div>`;
}

function reconvertHTML() {
  if (!isResultOpen() || !engineDiffers(state.job)) return '';
  return `<div class="reconvert"><button type="button" class="btn soft" id="rerunBtn" data-action="rerun">${IC.redo}Re-convert this file with these settings</button></div>`;
}

function qualityHelp(q, ids) {
  if (q === 'best') return ids.best === 'ensemble' ? 'The most accurate result. Takes 3–4× longer than Faster.' : 'Ensemble is not installed, so this uses Transkun V2.';
  if (q === 'faster') return 'About 4× quicker and almost as accurate. Good for long recordings.';
  const eng = currentEngine();
  const views = eng.options.find((o) => o.key === 'views');
  return `Using ${engineShort(eng)}${views ? ` with ${viewsSummary(views, engineOptions().views).toLowerCase()}` : ''}, set under More settings.`;
}

function srow(title, inner) { return `<div class="srow"><h3>${esc(title)}</h3><div>${inner}</div></div>`; }

function renderSimple() {
  const inst = instrumentInfo();
  const oo = outputOptions();
  const out = Object.fromEntries(state.info.output_options.map((o) => [o.key, o]));
  let html = '';
  const ids = qualityEngines();
  if (ids) {
    const q = qualityOf();
    const same = ids.best === ids.faster;
    const choices = [
      { value: 'best', text: 'Best', title: inst.engines.find((e) => e.id === ids.best)?.name },
      { value: 'faster', text: 'Faster', title: same ? 'Best already uses Transkun V2' : 'Transkun V2', disabled: same },
    ];
    if (q === 'custom') choices.push({ value: 'custom', text: 'Custom', title: 'Set under More settings', cls: 'custom' });
    html += srow('Quality', segHTML({ scope: 'quality', key: 'quality', choices, value: q, label: 'Quality' }) +
      `<p class="help">${esc(qualityHelp(q, ids))}</p>` + reconvertHTML());
  } else {
    const es = engineSettings();
    const choices = inst.engines.map((e) => ({ value: e.id, text: engineShort(e), title: e.summary, disabled: !e.available }));
    html += srow('Engine', (inst.engines.length > 1 ? segHTML({ scope: 'engine', key: 'engine', choices, value: es.engine, label: 'Engine' }) : '') +
      `<p class="help">${esc(currentEngine().summary)}</p>` + reconvertHTML());
  }
  for (const [key, title] of [['pedal', 'Pedal'], ['velocity', 'Dynamics']]) {
    const spec = out[key];
    if (!spec) continue;
    const choices = spec.choices.map((c) => ({ value: c.value, text: choiceText('out', key, c), title: c.label }));
    const help = WORDS.out[key]?.help?.[oo[key]] || spec.help;
    html += srow(title, segHTML({ scope: 'out', key, choices, value: oo[key], label: stripParen(spec.label) }) + `<p class="help">${esc(help)}</p>`);
  }
  if (isResultOpen()) html += `<p class="instant-note" id="instantNote">${IC.check}Pedal and dynamics changes update this result instantly.</p>`;
  return html;
}

function engineCardsHTML() {
  const inst = instrumentInfo();
  const es = engineSettings();
  const ids = qualityEngines();
  return '<div class="field"><div class="field-top"><span class="field-label" id="f-engine">Quality <span class="tech">Engine</span></span></div>' +
    '<div class="engines" role="radiogroup" aria-labelledby="f-engine">' + inst.engines.map((e) => {
      const on = e.id === es.engine;
      const desc = e.available ? (WORDS.engine[e.id]?.desc || e.summary) : (e.unavailable_reason || 'Not installed');
      const tag = ids && e.id === ids.best ? 'Best' : ids && e.id === ids.faster ? 'Faster' : '';
      return `<button type="button" class="engine-opt" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}"${e.available ? '' : ' aria-disabled="true"'}` +
        ` data-scope="engine" data-key="engine" data-val="${esc(e.id)}" title="${esc(e.summary)}">` +
        `<span class="radio" aria-hidden="true"></span><span><span class="eng-name">${esc(e.name)}</span><span class="eng-desc">${esc(desc)}</span></span>` +
        (tag ? `<span class="tag">${tag}</span>` : '<span></span>') + '</button>';
    }).join('') + '</div></div>';
}

function renderFull() {
  const inst = instrumentInfo();
  const eng = currentEngine();
  const eo = engineOptions();
  const oo = outputOptions();
  const open = isResultOpen();
  let left = '<section class="col" aria-labelledby="colListen"><header class="col-head"><h3 id="colListen">Listening</h3>' +
    `<p>${open ? 'Used the next time you convert.' : 'Used for your next conversion.'}</p></header>`;
  if (inst.engines.length > 1) left += engineCardsHTML();
  if (!eng.options.length) left += `<p class="aside-note">${esc(engineShort(eng))} has no extra settings.</p>`;
  for (const spec of eng.options) left += fieldHTML('eng', spec, eo[spec.key]);
  left += reconvertHTML() + '</section>';

  let right = '<section class="col" aria-labelledby="colFile"><header class="col-head"><h3 id="colFile">In the MIDI file</h3>' +
    (open ? `<p class="instant" id="instantNote">${IC.check}Changes update this result instantly. No need to convert again.</p>`
      : '<p>Applied whenever a MIDI file is written.</p>') + '</header>';
  for (const spec of state.info.output_options) {
    if (DEPENDS[spec.key] && !DEPENDS[spec.key](oo)) continue;
    right += fieldHTML('out', spec, oo[spec.key]);
  }
  if (open) right += `<div class="file-now" id="fileNow" aria-live="polite">${IC.doc}<p>${fileNowText()}</p></div>`;
  right += '</section>';

  const look = '<section class="look" aria-labelledby="lookTitle"><div><h3 id="lookTitle">Appearance</h3>' +
    '<p class="help">Match Windows follows the light or dark mode set in Windows.</p></div>' +
    segHTML({ scope: 'app', key: 'appearance', choices: APPEARANCES, value: appearance(), label: 'Appearance' }) + '</section>';
  return `<div class="cols">${left}${right}</div>${look}<p class="about">${esc(`${state.info.app} ${state.info.version}`)}</p>`;
}

// Live, plain-language read-out of what the open result's MIDI file contains (as currently written).
function fileNowText() {
  const r = state.result;
  const o = state.job?.output_options;
  if (!r || !o) return '';
  const sustain = r.pedals.filter((p) => p[2] === 64).length;
  const soft = r.pedals.filter((p) => p[2] === 67).length;
  const pedal = o.pedal === 'extend' ? 'the sustain <b>baked into the notes</b>' : o.pedal === 'none' ? '<b>no sustain pedal</b>'
    : `<b>${sustain.toLocaleString()} sustain press${sustain === 1 ? '' : 'es'}</b>`;
  const softText = o.soft_pedal === false ? '<b>no soft pedal</b>' : `<b>${soft.toLocaleString()} soft-pedal press${soft === 1 ? '' : 'es'}</b>`;
  const dyn = o.velocity === 'flat' ? `every note at loudness <b>${esc(o.flat_velocity)}</b>` : 'loudness <b>as played</b>';
  let s = `Your file now has <b>${plural(r.notes.length, 'note')}</b>, ${pedal} and ${softText}, with ${dyn}`;
  s += o.tempo != null ? `, written at <b>${esc(o.tempo)} BPM</b>.` : '.';
  if (o.min_note_ms > 0) s += ` Notes shorter than <b>${esc(o.min_note_ms)} ms</b> are left out.`;
  return s;
}
function updateFileNow(busy = false) {
  const box = $('fileNow');
  if (!box) return;
  box.classList.toggle('busy', busy);
  if (!busy) box.querySelector('p').innerHTML = fileNowText();
}

// A selector that finds the same control again after the sheet is re-drawn.
function controlSelector(el) {
  if (!el || !$('dlgBody').contains(el)) return null;
  const d = el.dataset;
  if (d.scope) {
    let sel = `[data-scope="${d.scope}"][data-key="${CSS.escape(d.key)}"]`;
    if (d.val != null) sel += `[data-val="${CSS.escape(d.val)}"]`;
    if (d.step) sel += `[data-step="${d.step}"]`;
    if (d.num) sel += `[data-num="${d.num}"]`;
    return sel;
  }
  if (d.action) return `[data-action="${d.action}"]`;
  return el.id ? `#${CSS.escape(el.id)}` : null;
}

function renderDrawer() {
  const dlg = $('drawer');
  if (dlg.hidden || !state.info) return;
  const body = $('dlgBody');
  const active = document.activeElement;
  const sel = controlSelector(active);
  const group = active?.dataset?.scope && active.getAttribute('role') === 'radio'
    ? `[data-scope="${active.dataset.scope}"][data-key="${CSS.escape(active.dataset.key)}"][aria-checked="true"]` : null;
  const scroll = body.scrollTop;
  dlg.classList.toggle('full', state.more);
  body.innerHTML = state.more ? renderFull() : renderSimple();
  $('moreBtn').setAttribute('aria-expanded', String(state.more));
  $('moreLabel').textContent = state.more ? 'Fewer settings' : 'More settings';
  body.scrollTop = scroll;
  if (sel) (body.querySelector(sel) || (group && body.querySelector(group)))?.focus();
}

function flashInstant() {
  const n = $('instantNote');
  if (!n) return;
  n.classList.remove('flash');
  void n.offsetWidth;
  n.classList.add('flash');
}

function setOption(scope, key, value, { render = true } = {}) {
  if (scope === 'eng') {
    if (String(engineOptions()[key]) === String(value)) return;
    const es = engineSettings();
    es.options[es.engine][key] = value;
  } else if (scope === 'out') {
    if (String(outputOptions()[key]) === String(value)) return;
    state.settings.output ??= {};
    state.settings.output[key] = value;
    scheduleReexport();
  } else if (scope === 'app') {
    if (appearance() === value) return;
    state.settings.appearance = value;
    applyAppearance();
  } else {
    return;
  }
  saveSettings();
  renderSettingsLine();
  if (render) renderDrawer();
}

function chooseValue(scope, key, value) {
  if (scope === 'quality') {
    if (value === 'custom') { state.more = true; renderDrawer(); return; }
    if (value === qualityOf() || !setQuality(value)) return;
  } else if (scope === 'engine') {
    const es = engineSettings();
    const target = instrumentInfo().engines.find((e) => e.id === value);
    if (!target?.available) { toast(target?.unavailable_reason || 'This engine is not installed.', null, 'error'); return; }
    if (es.engine === value) return;
    es.engine = value;
  } else {
    setOption(scope, key, value);
    return;
  }
  saveSettings();
  renderSettingsLine();
  renderDrawer();
}

function markChanged(input, spec, v) {
  input.closest('.field')?.querySelector('.field-label')?.classList.toggle('changed', String(v) !== String(spec.default));
}

function clampNum(spec, v) {
  if (!isFinite(v)) v = spec.default;
  if (spec.min != null) v = Math.max(spec.min, v);
  if (spec.max != null) v = Math.min(spec.max, v);
  return v;
}

function bindDrawer() {
  const body = $('dlgBody');
  body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-scope], [data-action]');
    if (!el || !body.contains(el)) return;
    if (el.dataset.action === 'rerun') { if (state.job) startConversion(null, state.job); return; }
    const { scope, key } = el.dataset;
    if (el.dataset.step) {
      const spec = specFor(scope, key);
      const cur = (scope === 'out' ? outputOptions() : engineOptions())[key];
      const v = clampNum(spec, Number(cur) + Number(el.dataset.step) * (spec.step || 1));
      setOption(scope, key, v, { render: false });
      const input = body.querySelector(`input[data-scope="${scope}"][data-key="${CSS.escape(key)}"]`);
      if (input) { input.value = v; markChanged(input, spec, v); }
      if (scope === 'out') flashInstant();
    } else if (el.dataset.toggle) {
      setOption(scope, key, el.getAttribute('aria-checked') !== 'true');
      if (scope === 'out') flashInstant();
    } else if (el.getAttribute('role') === 'radio' && el.dataset.val != null) {
      if (el.getAttribute('aria-disabled') === 'true') {
        if (scope === 'engine') chooseValue(scope, key, el.dataset.val); // explains why it is unavailable
        return;
      }
      chooseValue(scope, key, el.dataset.val);
      if (scope === 'out') flashInstant();
    }
  });
  body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset?.num !== 'range') return;
    const spec = specFor(el.dataset.scope, el.dataset.key);
    const v = clampNum(spec, Number(el.value));
    el.style.setProperty('--fill', `${(((v - spec.min) / (spec.max - spec.min)) * 100).toFixed(1)}%`);
    const out = $(`${el.id}-out`);
    if (out) out.textContent = numText(spec, v);
    markChanged(el, spec, v);
    setOption(el.dataset.scope, el.dataset.key, v, { render: false });
  });
  body.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset?.scope) return;
    const spec = specFor(el.dataset.scope, el.dataset.key);
    if (el.dataset.num === 'box') {
      const v = clampNum(spec, Number(el.value));
      el.value = v;
      markChanged(el, spec, v);
      setOption(el.dataset.scope, el.dataset.key, v, { render: false });
    } else if (el.tagName === 'SELECT') {
      setOption(el.dataset.scope, el.dataset.key, el.value);
    }
    if (el.dataset.scope === 'out') flashInstant();
  });
}

function openDrawer(e) {
  if (!state.info) return;
  state.opener = e?.currentTarget instanceof HTMLElement ? e.currentTarget : document.activeElement;
  state.more = false;
  closeMenu();
  const d = $('drawer');
  d.hidden = false;
  d.inert = false;
  $('scrim').hidden = false;
  $('app').inert = true; // the page behind the sheet is out of reach while it is open
  renderDrawer();
  requestAnimationFrame(() => ($('dlgBody').querySelector('[role="radio"][aria-checked="true"]') || $('closeAdvanced')).focus());
}
function closeDrawer() {
  const d = $('drawer');
  if (d.hidden) return;
  const hadFocus = d.contains(document.activeElement);
  d.hidden = true;
  d.inert = true;
  $('scrim').hidden = true;
  $('app').inert = false;
  const o = state.opener;
  if (hadFocus && o?.isConnected && o.offsetParent) o.focus();
}
function drawerOpen() { return !$('drawer').hidden; }

// ------------------------------------------------------------------ progress view
const CIRC = 2 * Math.PI * 108;
$('ringFill').style.strokeDasharray = CIRC.toFixed(2);

function resetProgressView(name) {
  $('prog').classList.remove('failed');
  $('progressName').textContent = name;
  $('progressName').title = name;
  setHint('');
  $('progressMsg').textContent = '';
  $('errorText').hidden = true;
  $('cancelBtn').hidden = false;
  $('retryBtn').hidden = true;
  $('otherBtn').hidden = true;
  state.eta = null;
}
function setHint(text) {
  $('progressHint').textContent = text;
  $('hintSep').hidden = !text;
}
function setRingWaiting(label) {
  const ring = $('ring');
  ring.classList.add('waiting');
  $('progressPct').textContent = label;
  $('pctSign').hidden = true;
  $('ringFill').style.strokeDashoffset = (CIRC * 0.78).toFixed(2);
  ring.removeAttribute('aria-valuenow');
  ring.setAttribute('aria-valuetext', label);
}
function setRingValue(frac) {
  const ring = $('ring');
  const pct = Math.round(frac * 100);
  ring.classList.remove('waiting');
  $('progressPct').textContent = pct;
  $('pctSign').hidden = false;
  $('ringFill').style.strokeDashoffset = (CIRC * (1 - frac)).toFixed(2);
  ring.setAttribute('aria-valuenow', String(pct));
  ring.removeAttribute('aria-valuetext');
}

// The steps a conversion goes through, in plain words, from the job's engine and options.
function stagesFor(job) {
  const n = { none: 1, channels: 4, full: 6 }[job.engine_options?.views];
  const views = n ? ` · ${n} view${n > 1 ? 's' : ''}` : '';
  const read = { label: 'Read audio', title: 'Reading your recording…' };
  const write = { label: 'Write MIDI', title: 'Writing your MIDI file…' };
  if (job.engine === 'ensemble') {
    return [read, { label: `Transkun V2${views}`, title: 'Listening to your recording…' },
      { label: 'Aria-AMT second opinion', title: 'Double-checking the tricky notes…' }, write];
  }
  const eng = state.info?.instruments.flatMap((i) => i.engines).find((e) => e.id === job.engine);
  return [read, { label: (eng ? engineShort(eng) : 'Transcribe') + views, title: 'Listening to your recording…' }, write];
}
function stageIndex(job, stages) {
  const p = job.progress || 0, msg = job.message || '';
  if (p >= 0.985 || /writing the midi|^done/i.test(msg)) return stages.length - 1;
  if (p < 0.04 && !/window|model/i.test(msg)) return 0;
  // Ensemble: Transkun V2 runs first, then Aria-AMT gives its second opinion (from ~37% overall).
  if (stages.length === 4 && (p >= 0.365 || /aria|second opinion/i.test(msg))) return 2;
  return 1;
}
function renderStages(stages, active) {
  $('stages').innerHTML = stages.map((s, i) => {
    const cls = i < active ? 'done' : i === active ? 'active' : '';
    return `<li class="stage ${cls}"${i === active ? ' aria-current="step"' : ''}><span class="st-ic">${i < active ? IC.check : ''}</span>${esc(s.label)}</li>`;
  }).join('');
}
function plannedJob() {
  return { engine: engineSettings().engine, engine_options: engineOptions() };
}

function etaText(job) {
  const now = performance.now();
  const e = state.eta;
  if (!e || e.id !== job.id || job.progress < e.p0) { state.eta = { id: job.id, t0: now, p0: job.progress }; return 'Estimating time left…'; }
  const dp = job.progress - e.p0, dt = (now - e.t0) / 1000;
  if (dp < 0.03 || dt < 3) return 'Estimating time left…';
  const left = (dt / dp) * (1 - job.progress);
  if (left < 8) return 'Almost done';
  if (left < 60) return `About ${left < 20 ? Math.round(left) : Math.round(left / 5) * 5} seconds left`;
  const m = Math.round(left / 60);
  return `About ${m} minute${m > 1 ? 's' : ''} left`;
}

function showQueued(job) {
  const n = job.queue_position;
  setRingWaiting(n > 0 ? `${n} ahead` : 'Up next');
  $('progTitle').textContent = 'Waiting for the converter…';
  setHint(n > 0 ? 'Starts when the conversions ahead finish' : 'Starts when the current conversion finishes');
  $('progressMsg').textContent = n > 0 ? `${n} conversion${n > 1 ? 's' : ''} ahead` : 'Starting soon';
  renderStages(stagesFor(job), -1);
}
function showRunning(job) {
  const stages = stagesFor(job);
  const idx = stageIndex(job, stages);
  setRingValue(job.progress || 0);
  $('progTitle').textContent = stages[idx].title;
  setHint(etaText(job));
  $('progressMsg').textContent = job.message || 'Working';
  renderStages(stages, idx);
}

function showError(msg) {
  $('prog').classList.add('failed');
  $('progTitle').textContent = 'Couldn’t convert this recording';
  $('errorText').textContent = msg;
  $('errorText').hidden = false;
  setHint('');
  $('cancelBtn').hidden = true;
  $('retryBtn').hidden = false;
  $('otherBtn').hidden = false;
  show('viewProgress');
}

// ------------------------------------------------------------------ conversion
function startConversion(file, rerunOf = null) {
  if (!file && !rerunOf) return;
  if (!state.info) { toast('Still starting up, try again in a moment.', null, 'error'); return; }
  if (file && file.size > MAX_UPLOAD) { toast('This file is larger than 2 GB.', null, 'error'); return; }
  closeDrawer();
  stopWatching();
  const seq = ++state.viewSeq;
  state.job = null;
  state.retry = file ? { file } : { job: rerunOf };
  resetProgressView(file ? file.name : rerunOf.filename);
  setRingWaiting(file ? 'Opening' : 'Starting');
  $('progTitle').textContent = file ? 'Opening your recording…' : 'Starting again…';
  $('progressMsg').textContent = file ? 'Uploading' : 'Starting';
  renderStages(stagesFor(plannedJob()), -1);
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
      .then((job) => { refreshRecent(); if (seq !== state.viewSeq) return; state.job = job; onJobUpdate(job); watch(job.id); })
      .catch((e) => { if (seq === state.viewSeq) showError(e.message); });
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
    if (e.lengthComputable && seq === state.viewSeq) $('progressMsg').textContent = `Uploading ${Math.round((100 * e.loaded) / e.total)}%`;
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      refreshRecent();
      if (seq !== state.viewSeq) return; // the user moved on; the job still appears in Recent
      state.job = xhr.response;
      onJobUpdate(state.job);
      watch(state.job.id);
    } else if (seq === state.viewSeq) {
      showError(xhr.response?.detail || `Upload failed (${xhr.status}).`);
    }
  };
  xhr.onerror = () => { if (seq === state.viewSeq) showError('Could not reach the converter. Is it still running?'); };
  state.uploadXhr = xhr;
  xhr.send(fd);
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

function onJobUpdate(job) {
  updateRecentStatus(job);
  if (state.job && job.id !== state.job.id) return;
  state.job = job;
  if (job.status === 'queued') {
    showQueued(job);
  } else if (job.status === 'running') {
    showRunning(job);
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
    toast('Conversion cancelled', null, 'info');
    goHome();
    refreshRecent();
  }
}

// Progress view for a job that already exists (opened from Recent, or handed over by the desktop shell).
function showJobProgress(job) {
  closeDrawer();
  stopWatching();
  state.viewSeq++;
  state.job = job;
  state.retry = { job };
  resetProgressView(job.filename);
  show('viewProgress');
  onJobUpdate(job);
  watch(job.id);
}

// ------------------------------------------------------------------ result view
async function openResult(job) {
  const seq = ++state.viewSeq;
  state.job = job;
  setHash(job.id);
  try {
    // The job as it is now: the copy from Recent or the hash can predate a re-export (other output options).
    const [jr, r] = await Promise.all([
      fetch(`/api/jobs/${job.id}`, { cache: 'no-store' }),
      fetch(`/api/jobs/${job.id}/notes`, { cache: 'no-store' }),
    ]);
    if (!r.ok) throw new Error();
    const data = await r.json();
    const fresh = jr.ok ? await jr.json() : null;
    if (seq !== state.viewSeq) return; // another job was opened meanwhile
    if (fresh?.id === job.id) job = state.job = fresh;
    resetSaved();
    show('viewResult');
    applyResultData(job, data);
    player.setAudio(`/api/jobs/${job.id}/audio`, data.duration);
    markCurrentRecent();
    renderDrawer();
  } catch {
    if (seq !== state.viewSeq) return;
    toast('Could not open this result.', null, 'error');
    goHome();
  }
}

function applyResultData(job, data, keepView = false) {
  const notes = data.tracks.flatMap((t) => t.notes);
  const pedals = data.tracks.flatMap((t) => t.pedals);
  state.result = { notes, pedals, duration: data.duration };
  roll.setData({ notes, pedals, duration: data.duration }, { keepView });
  player.setNotes(notes, data.duration);
  setPlaying(false);
  updateTime();
  const st = data.stats || job.stats || {};
  $('resultName').textContent = stem(job.filename);
  $('resultName').title = job.filename;
  const sustain = pedals.filter((p) => p[2] === 64).length;
  const pedal = job.output_options?.pedal;
  const nNotes = st.notes ?? notes.length;
  const bits = [
    esc(`${fmtTime(data.duration)} long`),
    `<b>${nNotes.toLocaleString()}</b> note${nNotes === 1 ? '' : 's'}`,
    esc(pedal === 'extend' ? 'pedal baked into notes' : pedal === 'none' ? 'no pedal' : `${sustain.toLocaleString()} pedal press${sustain === 1 ? '' : 'es'}`),
    st.engine_name ? esc(stripParen(st.engine_name)) : null,
    st.seconds_total ? esc(`converted in ${fmtTook(st.seconds_total)}`) : null,
  ].filter(Boolean);
  $('resultMeta').innerHTML = bits.join('<span class="dot" aria-hidden="true">·</span>');
  const dl = $('downloadBtn');
  dl.href = `/api/jobs/${job.id}/midi?v=${job.version}`;
  dl.setAttribute('download', job.midi_name || 'transcription.mid');
  updateFileNow();
}

// Output options apply to the open result at once: re-write its MIDI file, keep zoom and position.
function scheduleReexport() {
  const job = state.job;
  if (!job || job.status !== 'done' || $('viewResult').hidden) return;
  clearTimeout(state.exportTimer);
  if (!outputDiffers(job)) { updateFileNow(); return; }
  updateFileNow(true);
  state.exportTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/jobs/${job.id}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output_options: outputOptions() }),
      });
      if (!r.ok) throw new Error();
      const updated = await r.json();
      const n = await (await fetch(`/api/jobs/${job.id}/notes`, { cache: 'no-store' })).json();
      if (state.job?.id !== job.id || $('viewResult').hidden) return; // the user moved on
      const t = player.time;
      const wasPlaying = player.playing;
      state.job = updated;
      state.recent = state.recent.map((j) => (j.id === updated.id ? updated : j));
      applyResultData(updated, n, true);
      player.seek(t);
      if (wasPlaying) { setPlaying(true); player.play(); }
      roll.setTime(t, player.playing);
      updateTime();
      toast('MIDI updated');
    } catch {
      if (state.job?.id === job.id) { updateFileNow(); toast('Could not update the MIDI file.', null, 'error'); }
    }
  }, 350);
}

function goHome() {
  stopWatching();
  state.viewSeq++;
  state.job = null;
  state.result = null;
  setHash(null);
  show('viewDrop');
  markCurrentRecent();
}

function setHash(id) {
  const h = id ? `#/job/${id}` : '';
  if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
}

// ------------------------------------------------------------------ recent
function ringIcon(p) {
  const r = 14, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 34 34" aria-hidden="true"><circle class="trk" cx="17" cy="17" r="${r}"/>` +
    `<circle class="val" cx="17" cy="17" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" transform="rotate(-90 17 17)"/></svg>`;
}
function recentIcon(job) {
  const kind = { done: ['done', IC.check], queued: ['queued', IC.clock], error: ['error', IC.alert], cancelled: ['cancelled', IC.stop] }[job.status];
  if (job.status === 'running') return `<span class="ri-icon running">${ringIcon(job.progress || 0)}</span>`;
  return `<span class="ri-icon ${kind?.[0] || 'queued'}">${kind?.[1] || IC.clock}</span>`;
}
function recentMeta(job) {
  const st = job.stats || {};
  switch (job.status) {
    case 'done':
      return esc([ext(job.filename), st.duration ? fmtTime(st.duration) : null, st.notes != null ? `${st.notes.toLocaleString()} notes` : null,
        friendlyWhen(job.created)].filter(Boolean).join(' · '));
    case 'running': return `<span class="live">Converting · ${Math.round((job.progress || 0) * 100)}%</span>`;
    case 'queued': return 'Waiting to start';
    case 'error': return esc(`Couldn’t convert: ${job.error || 'unknown error'}`);
    case 'cancelled': return esc(`Cancelled · ${friendlyWhen(job.created)}`);
    default: return esc(job.status);
  }
}

function updateRecentStatus(job) {
  if (job.status !== 'running' && job.status !== 'queued') return;
  const li = [...$('recentList').children].find((x) => x.dataset.id === job.id);
  if (!li) return;
  li.querySelector('.ri-icon').outerHTML = recentIcon(job);
  li.querySelector('.ri-meta').innerHTML = recentMeta(job);
}

async function refreshRecent() {
  try {
    state.recent = await (await fetch('/api/jobs', { cache: 'no-store' })).json();
  } catch { return; }
  const list = $('recentList');
  list.innerHTML = '';
  const items = state.recent.slice(0, 12);
  $('recent').hidden = items.length === 0;
  $('recent').classList.toggle('over6', items.length > 6);
  $('recent').classList.toggle('over4', items.length > 4);
  updateRecentMore();
  for (const job of items) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.dataset.id = job.id;
    li.tabIndex = 0;
    li.title = job.filename;
    li.innerHTML = recentIcon(job) +
      `<span class="ri-text"><span class="ri-name">${esc(stem(job.filename))}</span>` +
      `<span class="ri-meta${job.status === 'error' ? ' err' : ''}">${recentMeta(job)}</span></span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ri-del';
    del.title = 'Remove';
    del.setAttribute('aria-label', `Remove ${job.filename}`);
    del.innerHTML = IC.cross;
    del.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
      if (state.job?.id === job.id) goHome();
      refreshRecent();
    };
    li.append(del);
    const open = () => openJob(job);
    li.onclick = open;
    li.onkeydown = (e) => { if (e.key === 'Enter' && e.target === li) open(); };
    list.append(li);
  }
  markCurrentRecent();
  // Jobs nobody is watching (e.g. a second file handed over) still move: refresh while any is active.
  clearTimeout(state.recentTimer);
  if (state.recent.some((j) => j.status === 'queued' || j.status === 'running')) {
    state.recentTimer = setTimeout(refreshRecent, 2500);
  }
}

function updateRecentMore() {
  const open = $('recent').classList.contains('expanded');
  const n = Math.min(state.recent.length, 12);
  $('recentMore').textContent = open ? 'Show fewer' : `Show all ${n}`;
  $('recentMore').setAttribute('aria-expanded', String(open));
}

function markCurrentRecent() {
  for (const li of $('recentList').children) li.classList.toggle('current', li.dataset.id === state.job?.id && !$('viewResult').hidden);
}

function openJob(job) {
  if (job.status === 'done') { stopWatching(); openResult(job); return; }
  if (job.status === 'queued' || job.status === 'running') { showJobProgress(job); return; }
  state.viewSeq++;
  if (job.status === 'error') {
    stopWatching();
    state.job = job;
    state.retry = { job };
    resetProgressView(job.filename);
    showError(job.error || 'The conversion failed.');
  } else {
    toast('This conversion was cancelled.', null, 'info');
  }
}

// ------------------------------------------------------------------ transport
function setPlaying(on) {
  $('playBtn').classList.toggle('playing', on);
  $('playBtn').setAttribute('aria-pressed', String(on));
  $('playLabel').textContent = on ? 'Pause' : 'Play preview';
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
  // A press while the first play is still loading (piano sounds, audio) cancels it, like a pause.
  if (player.playing || state.playPending) {
    state.playPending = null;
    if (player.playing) player.pause(); else player.stop();
    setPlaying(false);
    roll.setTime(player.time, false);
    return;
  }
  const pending = (state.playPending = {});
  setPlaying(true);
  await player.play();
  if (state.playPending === pending) state.playPending = null;
  if (!player.playing && !state.playPending) setPlaying(false);
}
function setMix(mix) {
  for (const b of $('mixSeg').querySelectorAll('button')) {
    const on = b.dataset.mix === mix;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  player.setMix(mix);
  document.documentElement.dataset.mix = mix; // "Original" draws the muted MIDI quieter
  roll.refreshColors();
}

// ------------------------------------------------------------------ wiring
function bind() {
  const input = $('fileInput');
  input.onchange = () => { if (input.files[0]) startConversion(input.files[0]); input.value = ''; };
  $('dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const setDragging = (on) => {
    document.body.classList.toggle('dragging', on);
    // On the home view the drop target itself says "Let go to convert"; elsewhere the whole window does.
    $('dropOverlay').hidden = !on || (!$('viewDrop').hidden && !drawerOpen());
  };
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; setDragging(true); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) startConversion(f);
  });

  $('instBtn').onclick = (e) => { e.stopPropagation(); if ($('instMenu').hidden) openMenu(); else closeMenu(); };
  document.addEventListener('click', (e) => { if (!$('instMenu').contains(e.target)) closeMenu(); });
  $('instMenu').addEventListener('keydown', (e) => {
    const items = [...$('instMenu').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  });

  $('openAdvanced').onclick = openDrawer;
  $('settingsLine').onclick = openDrawer;
  $('optsResult').onclick = openDrawer;
  $('closeAdvanced').onclick = closeDrawer;
  $('doneBtn').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;
  $('moreBtn').onclick = () => { state.more = !state.more; renderDrawer(); };
  $('resetBtn').onclick = () => {
    const inst = instrumentInfo();
    state.settings.engines = { ...(state.settings.engines || {}), [inst.id]: { engine: inst.default_engine, options: {} } };
    state.settings.output = {};
    saveSettings();
    renderAll();
    scheduleReexport();
    toast('Options reset to defaults');
  };
  bindDrawer();

  $('cancelBtn').onclick = async () => {
    if (state.uploadXhr && state.uploadXhr.readyState !== 4) { state.uploadXhr.abort(); goHome(); return; }
    if (state.job) await fetch(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }).catch(() => {});
  };
  $('retryBtn').onclick = () => {
    // A job the server tried converts again from its saved copy; a failed upload is sent again.
    if (state.job?.status === 'error') startConversion(null, state.job);
    else if (state.retry?.file) startConversion(state.retry.file);
    else if (state.retry?.job) startConversion(null, state.retry.job);
    else goHome();
  };
  $('otherBtn').onclick = () => { goHome(); input.click(); };
  $('newBtn').onclick = goHome;
  $('downloadBtn').onclick = saveMidi;
  $('home').onclick = (e) => { e.preventDefault(); closeDrawer(); goHome(); };
  $('recentMore').onclick = () => { $('recent').classList.toggle('expanded'); updateRecentMore(); };

  $('playBtn').onclick = togglePlay;
  for (const b of $('mixSeg').querySelectorAll('button')) b.onclick = () => setMix(b.dataset.mix);
  $('zoomIn').onclick = () => roll.zoom(1.5);
  $('zoomOut').onclick = () => roll.zoom(1 / 1.5);

  // Arrow keys move between the choices of a radio group (Options, Listen to).
  document.addEventListener('keydown', (e) => {
    const r = e.target.closest?.('[role="radio"]');
    if (!r || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const group = r.closest('[role="radiogroup"]');
    if (!group) return;
    const items = [...group.querySelectorAll('[role="radio"]')].filter((x) => x === r || x.getAttribute('aria-disabled') !== 'true');
    const next = items[(items.indexOf(r) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    e.preventDefault();
    if (!next || next === r) return;
    const sel = controlSelector(next);
    next.click();
    (next.isConnected ? next : sel && $('dlgBody').querySelector(sel))?.focus();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen()) { e.preventDefault(); closeDrawer(); return; }
    if (e.key === 'Escape' && !$('instMenu').hidden) { closeMenu(true); return; }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.code === 'Space' && !typing && !$('viewResult').hidden && !drawerOpen()) {
      e.preventDefault();
      togglePlay();
    }
  });
}

async function init() {
  bind();
  requestAnimationFrame(frame);
  const savedReq = fetch('/api/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    state.info = await (await fetch('/api/info')).json();
  } catch {
    document.body.innerHTML = '<p style="padding:40px;font:16px var(--font);color:var(--ink)">The converter engine is not responding. Close MIDI Converter and open it again.</p>';
    return;
  }
  const saved = await savedReq;
  if (saved && typeof saved === 'object' && Object.keys(saved).length) state.settings = saved;
  state.settingsLoaded = true;
  applyAppearance();
  if (state.settings.instrument && state.info.instruments.some((i) => i.id === state.settings.instrument)) state.instrument = state.settings.instrument;
  const dev = state.info.device;
  const gpu = dev.kind === 'gpu';
  $('device').hidden = false;
  $('deviceName').textContent = gpu ? dev.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '') : 'CPU only (slow)';
  $('device').classList.toggle('cpu', !gpu);
  $('device').dataset.tip = gpu ? `Converting on your ${dev.name}` : 'No NVIDIA graphics card found, so conversions will be slow';
  $('device').setAttribute('aria-label', gpu ? `Graphics card: ${dev.name}` : 'No NVIDIA graphics card found, so conversions will be slow');
  renderAll();
  await refreshRecent();
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
  window.midiconvReady = true;
}

// #/job/<id> opens that conversion (the app itself keeps the hash in step with replaceState).
function routeFromHash() {
  const m = location.hash.match(/^#\/job\/(\w+)/);
  if (!m || state.job?.id === m[1]) return;
  const job = state.recent.find((j) => j.id === m[1]);
  if (job) openJob(job); else setHash(null);
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
      if (!r.ok) { toast(job.detail || 'Could not open that file.', null, 'error'); continue; }
      if (first) {
        first = false;
        showJobProgress(job);
      }
    } catch {
      toast('Could not open that file.', null, 'error');
    }
  }
  if (paths.length > 1) toast(`${paths.length} files added`);
  refreshRecent();
};

init();
