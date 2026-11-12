/* MIDI Converter · Library — prototype logic (classic script, no backend). */
(function () {
  'use strict';

  const M = window.MOCK;
  const { PianoRoll, fmtTime } = window.MCRoll;
  const params = new URLSearchParams(location.search);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DPR = () => Math.min(2, window.devicePixelRatio || 1);

  /* ------------------------------------------------------------------ icons */
  const ICONS = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    'add-file': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    library: '<rect x="3.5" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="4" width="4" height="16" rx="1"/><path d="m15.4 5.4 3.7-1 3.4 14.6-3.7 1z"/>',
    running: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V8h-3.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V8h-3.5"/>',
    alert: '<path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2v.1"/>',
    star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M4 19V7a2 2 0 0 1 2-2h3.5l2 2H17a2 2 0 0 1 2 2v1.5"/><path d="M4 19l2.6-7.2A1.5 1.5 0 0 1 8 10.8h12.3a1 1 0 0 1 .95 1.3L19.4 18a1.5 1.5 0 0 1-1.4 1z"/>',
    chevron: '<path d="m6 15 6-6 6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
    'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    piano: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 19v-5M12 19v-5M16 19v-5"/><path d="M8 5v9M12 5v9M16 5v9" stroke-width="3.2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.34-5.66"/><path d="M4 4.5V8h3.5"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.8"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
    spinner: '<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    next: '<path d="M6 6v12l8.5-6zM18 6v12"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    search_x: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M9 9l4 4M13 9l-4 4"/>',
  };
  const svg = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const I = (n, cls) => `<i data-icon="${n}"${cls ? ` class="${cls}"` : ''}>${svg(n)}</i>`;
  function hydrateIcons(root) { $$('i[data-icon]', root || document).forEach((el) => { if (!el.firstElementChild) el.innerHTML = svg(el.dataset.icon); }); }

  /* ------------------------------------------------------------------ schema */
  const PIANO = M.info.instruments[0];
  const ENGINES = PIANO.engines;
  const OUT = M.info.output_options;
  const engineById = (id) => ENGINES.find((e) => e.id === id);
  const optOf = (engId, key) => (engineById(engId).options || []).find((o) => o.key === key) || engineById('transkun').options.find((o) => o.key === key);
  const ENGINE_SHORT = { ensemble: 'Ensemble', transkun: 'Transkun V2', aria: 'Aria-AMT' };
  const ENGINE_SUB = {
    ensemble: 'The most accurate setting.',
    transkun: 'About 4× faster, almost as accurate.',
    aria: 'On its own, for comparison.',
  };
  const ENGINE_SPEED = { ensemble: 'about 20–25 s per 2-minute piece', transkun: 'about 6 s per 2-minute piece', aria: 'with Aria-AMT on its own' };
  const VIEWS_SHORT = { none: 'Single view', channels: 'Stereo views 4x', full: 'Stereo + tone views 6x' };
  const VIEWS_N = { none: 1, channels: 4, full: 6 };
  const RESCUE_SHORT = { '0.1': 'Generous', '0.3': 'Balanced', '0.5': 'Cautious' };
  const defEng = (engine) => ({ engine: engine || PIANO.default_engine, views: 'channels', rescue: '0.3', velocity: 'mode', merge_fix: true });
  const defOut = () => { const o = {}; OUT.forEach((op) => { o[op.key] = op.default; }); return o; };

  /* ------------------------------------------------------------------ library data */
  const META = {
    '3f9c2a71b0de': { hue: 214, ts: 1112.1432, format: M.file.format, size: M.file.size_mb + ' MB', engine: 'ensemble', pedals: M.job.stats.pedals, soft: M.job.stats.soft_pedals, secs: M.job.stats.seconds_total, aria: M.job.stats.notes_added_by_aria, conf: M.job.stats.mean_confidence, coll: ['recital'] },
    'a81d5c0e9f12': { hue: 268, ts: 1112.1435, format: 'M4A · AAC 256 kbps · 48 kHz · stereo', size: '8.6 MB', engine: 'ensemble', etaTotal: 54, coll: ['recital'] },
    'c2e4b6a8d0f1': { hue: 150, ts: 1112.1436, format: 'WAV · 16-bit · 44.1 kHz · stereo', size: '34.9 MB', engine: 'ensemble' },
    '9b7d5f3e1a2c': { hue: 192, ts: 1111.2114, format: 'FLAC · 24-bit · 96 kHz · stereo', size: '112 MB', engine: 'ensemble', pedals: 214, soft: 12, secs: 57.4, aria: 31, conf: 0.994, fav: true, coll: ['recital'] },
    '4e6a8c0b2d4f': { hue: 18, ts: 1111.1702, format: 'MP4 video · 1080p', size: '41.2 MB', engine: 'ensemble', coll: ['lessons'] },
    '7f1e3d5c7b9a': { hue: 36, ts: 1109.1010, format: 'MP3 · 256 kbps · 44.1 kHz · stereo', size: '4.5 MB', engine: 'ensemble', pedals: 18, soft: 0, secs: 27.1, aria: 12, conf: 0.997, fav: true },
  };
  const EXTRA = [
    { id: 'e1b2c3d4e5f6', filename: 'Beethoven - Für Elise.mp3', status: 'done', duration: 175, notes: 1412, when: 'Mon', ts: 1109.0915, hue: 340, format: 'MP3 · 192 kbps · 44.1 kHz · stereo', size: '4.1 MB', engine: 'transkun', pedals: 61, soft: 0, secs: 9.2, aria: 0, conf: 0.996 },
    { id: 'b7c8d9e0f1a2', filename: 'Liszt - La Campanella (live, Wigmore Hall).flac', status: 'done', duration: 288, notes: 4215, when: 'Sun', ts: 1108.2040, hue: 6, format: 'FLAC · 24-bit · 48 kHz · stereo', size: '98.3 MB', engine: 'ensemble', pedals: 176, soft: 3, secs: 55.3, aria: 47, conf: 0.991, fav: true, coll: ['recital'] },
    { id: 'd1e2f3a4b5c6', filename: 'Rehearsal 2026-11-08 take 2.wav', status: 'done', duration: 372, notes: 3084, when: 'Sun', ts: 1108.1130, hue: 84, format: 'WAV · 24-bit · 48 kHz · stereo', size: '107 MB', engine: 'transkun', pedals: 241, soft: 9, secs: 19.6, aria: 0, conf: 0.987, coll: ['lessons'] },
    { id: 'f0e1d2c3b4a5', filename: 'Concert 2026-10-18 full (4K).mov', status: 'error', error: 'This file is larger than 2 GB.', duration: 5412, when: 'Sat', ts: 1107.1900, hue: 28, format: 'MOV video · 4K', size: '3.4 GB', engine: 'ensemble' },
    { id: 'a9b8c7d6e5f4', filename: 'Mozart - Sonata K. 545, I. Allegro.mp3', status: 'done', duration: 227, notes: 2377, when: '6 Nov', ts: 1106.1615, hue: 46, format: 'MP3 · 320 kbps · 44.1 kHz · stereo', size: '8.9 MB', engine: 'ensemble', pedals: 22, soft: 0, secs: 43.8, aria: 19, conf: 0.998 },
    { id: 'c5d6e7f8a9b0', filename: 'Grieg - Arietta, Op. 12 No. 1.ogg', status: 'cancelled', duration: 112, when: '5 Nov', ts: 1105.1200, hue: 178, format: 'OGG Vorbis · 160 kbps · 44.1 kHz', size: '2.3 MB', engine: 'ensemble' },
    { id: 'e4f5a6b7c8d9', filename: 'Rachmaninoff - Prelude in C-sharp minor.m4a', status: 'done', duration: 221, notes: 1986, when: '4 Nov', ts: 1104.2210, hue: 244, format: 'M4A · ALAC · 44.1 kHz · stereo', size: '27.5 MB', engine: 'ensemble', pedals: 96, soft: 4, secs: 42.5, aria: 22, conf: 0.993 },
    { id: 'b3c4d5e6f7a8', filename: 'Joplin - The Entertainer.mp3', status: 'done', duration: 204, notes: 2233, when: '2 Nov', ts: 1102.1030, hue: 128, format: 'MP3 · 256 kbps · 44.1 kHz · stereo', size: '6.5 MB', engine: 'transkun', pedals: 12, soft: 0, secs: 10.6, aria: 0, conf: 0.997 },
    { id: 'a2b3c4d5e6f7', filename: 'Glass - Opening (Glassworks).aiff', status: 'done', duration: 384, notes: 3456, when: '30 Oct', ts: 1030.2000, hue: 300, format: 'AIFF · 16-bit · 44.1 kHz · stereo', size: '64.6 MB', engine: 'ensemble', pedals: 58, soft: 0, secs: 73.1, aria: 28, conf: 0.996 },
  ];
  let items = M.recent.map((r) => Object.assign({}, r, META[r.id])).concat(EXTRA.map((x) => Object.assign({}, x)));
  items.forEach((it) => {
    it.fav = !!it.fav;
    it.coll = it.coll || [];
    it.eng = defEng(it.engine);
    it.out = defOut();
    if (!it.etaTotal) it.etaTotal = Math.max(8, it.duration * 0.19 * (it.engine === 'transkun' ? 0.27 : 1));
  });
  const COLLECTIONS = { recital: 'December recital', lessons: 'Lessons' };
  const byId = (id) => items.find((i) => i.id === id);
  const SCHUBERT = M.job.id;

  /* ------------------------------------------------------------------ helpers */
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const fmtInt = (n) => Number(n).toLocaleString('en-GB');
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }
  function fmtLong(s) {
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const ext = (f) => (f.split('.').pop() || '').toUpperCase();
  const title = (it) => it.filename.replace(/\.[^.]+$/, '');
  const midiName = (it) => title(it) + '.mid';
  // seconds left: the simulated run when one is going, otherwise the estimate for this file
  const etaLeft = (it) => (it.sim ? Math.max(0, (it.sim.start + it.sim.dur - performance.now()) / 1000) : it.etaTotal * (1 - (it.progress || 0)));
  const etaText = (s) => (s < 1.5 ? 'Almost done' : s < 60 ? `About ${Math.round(s)} s left` : `About ${Math.round(s / 60)} min left`);

  /* --- notes for every item: the real Schubert data, or plausible material re-cut from it */
  const dataCache = new Map();
  function dataFor(it) {
    if (dataCache.has(it.id)) return dataCache.get(it.id);
    let notes, pedals;
    if (it.id === SCHUBERT) { notes = M.notes; pedals = M.pedals; }
    else {
      const r = rng(hashStr(it.id));
      const D = Math.min(it.duration, 900);
      notes = []; pedals = [];
      let t = 0;
      while (t < D) {
        const len = 6 + r() * 10;
        const src = r() * (M.duration - len);
        const shift = Math.round((r() - 0.5) * 12);
        const vm = 0.7 + r() * 0.55;
        const dt = t - src;
        for (const n of M.notes) {
          if (n[0] < src || n[0] >= src + len) continue;
          const s = n[0] + dt;
          if (s >= D) continue;
          notes.push([s, Math.min(D, n[1] + dt), clamp(n[2] + shift, 21, 108), clamp(Math.round(n[3] * vm), 8, 127), Math.min(D, n[4] + dt), n[5]]);
        }
        for (const p of M.pedals) {
          if (p[2] !== 64 || p[0] < src || p[0] >= src + len) continue;
          pedals.push([p[0] + dt, Math.min(D, Math.min(p[1], src + len) + dt), 64, 127]);
        }
        t += len;
      }
      notes.sort((a, b) => a[0] - b[0]);
      const target = it.notes || Math.round(D * 9.5);
      if (notes.length > target) { const keep = target / notes.length; notes = notes.filter(() => r() < keep); }
      if (it.soft) pedals.push([D * 0.22, D * 0.34, 67, 127], [D * 0.61, D * 0.7, 67, 127]);
    }
    let lo = 127, hi = 0;
    for (const n of notes) { if (n[2] < lo) lo = n[2]; if (n[2] > hi) hi = n[2]; }
    if (hi - lo < 24) { lo -= 6; hi += 6; }
    const d = { notes, pedals, duration: it.duration, lo, hi };
    dataCache.set(it.id, d);
    return d;
  }
  // audio peaks (0..1) at time t, tiled from the real waveform
  const WF = M.waveform;
  function peakAt(it, t) {
    if (it.error === 'The audio track is empty.') return 0.012;
    const off = (hashStr(it.id) % 2400) * WF.hop_seconds;
    const len = WF.peak.length * WF.hop_seconds;
    const idx = Math.floor(((t + off) % len) / WF.hop_seconds);
    return WF.peak[clamp(idx, 0, WF.peak.length - 1)];
  }

  /* --- applying output options (instant, like the real app) */
  function derived(it) {
    const d = dataFor(it), o = it.out;
    let notes = d.notes, pedals = d.pedals;
    if (o.min_note_ms > 0) notes = notes.filter((n) => (n[1] - n[0]) * 1000 >= o.min_note_ms);
    if (o.velocity === 'flat') notes = notes.map((n) => [n[0], n[1], n[2], o.flat_velocity, n[4], n[5]]);
    if (o.pedal === 'extend') {
      notes = notes.map((n) => { const e = Math.max(n[1], n[4] || n[1]); return [n[0], e, n[2], n[3], e, n[5]]; });
      pedals = pedals.filter((p) => p[2] !== 64);
    } else if (o.pedal === 'none') {
      notes = notes.map((n) => [n[0], n[1], n[2], n[3], n[1], n[5]]);
      pedals = pedals.filter((p) => p[2] !== 64);
    }
    if (!o.soft_pedal) pedals = pedals.filter((p) => p[2] !== 67);
    const dropped = d.notes.length - notes.length;
    const noteCount = it.id === SCHUBERT ? notes.length : Math.max(0, (it.notes || d.notes.length) - dropped);
    return { notes, pedals, duration: it.duration, dropped, noteCount };
  }

  /* ------------------------------------------------------------------ covers */
  function drawCover(cv, it, size) {
    const dpr = DPR();
    size = size || cv.clientWidth || 44;
    const px = Math.round(size * dpr);
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = size, h = it.hue, st = it.status;
    const dim = st === 'queued' || st === 'cancelled' || st === 'error';
    const sat = dim ? 10 : 52;
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, `hsl(${h}, ${sat}%, 97%)`);
    g.addColorStop(1, `hsl(${h}, ${sat + 6}%, ${dim ? 90 : 88}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const pad = Math.max(4, S * 0.11);
    const w = S - pad * 2;
    const T = Math.min(it.duration, S > 90 ? 22 : 13);
    const until = st === 'done' ? T : st === 'running' ? T * (it.progress || 0) : st === 'queued' && it.paused ? T * it.paused : 0;
    if (until < T) {
      const mid = S / 2, amp = S * 0.3;
      const step = Math.max(1.5, S / 36);
      ctx.fillStyle = st === 'error' ? 'hsla(4, 55%, 42%, .45)' : st === 'running' ? `hsla(${h}, 30%, 40%, .3)` : `hsla(${h}, ${sat}%, 30%, .32)`;
      for (let x = pad + (until / T) * w; x < S - pad; x += step) {
        const a = Math.max(0.5, peakAt(it, ((x - pad) / w) * T) * amp);
        ctx.fillRect(x, mid - a, Math.max(1, step * 0.55), a * 2);
      }
    }
    if (until > 0) {
      const d = dataFor(it);
      const span = d.hi - d.lo + 1;
      const nh = Math.max(1, (S - pad * 2) / span * (S > 90 ? 1.2 : 1.6));
      const big = S > 90;
      for (const n of d.notes) {
        if (n[0] > until) break;
        const x0 = pad + (n[0] / T) * w;
        const y = pad + ((d.hi - n[2]) / span) * (S - pad * 2 - nh);
        if (big && n[4] > n[1]) {
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = `hsl(${h}, 55%, 40%)`;
          ctx.fillRect(x0, y + nh * 0.25, (Math.min(n[4], until, T) - n[0]) / T * w, nh * 0.5);
        }
        ctx.globalAlpha = 0.4 + 0.6 * Math.min(1, n[3] / 105);
        ctx.fillStyle = `hsl(${h}, 60%, ${big ? 34 : 32}%)`;
        ctx.fillRect(x0, y, Math.max(1, ((Math.min(n[1], until) - n[0]) / T) * w), nh);
      }
      ctx.globalAlpha = 1;
      if (st === 'running') {
        const x = pad + (until / T) * w;
        ctx.fillStyle = '#1b58b0';
        ctx.fillRect(x, pad * 0.5, Math.max(1.2, S / 50), S - pad);
      }
    }
    if (st === 'error' || st === 'cancelled') {
      ctx.strokeStyle = st === 'error' ? 'hsla(4, 60%, 40%, .14)' : 'rgba(0,0,0,.06)';
      ctx.lineWidth = 1;
      for (let k = -S; k < S; k += Math.max(4, S / 9)) { ctx.beginPath(); ctx.moveTo(k, S); ctx.lineTo(k + S, 0); ctx.stroke(); }
    }
  }
  function drawCovers(root) {
    $$('canvas[data-cover]', root).forEach((cv) => { const it = byId(cv.dataset.cover); if (it) drawCover(cv, it, cv.clientWidth || 44); });
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    view: 'home',
    nav: 'add',
    q: '',
    sort: { key: 'added', dir: -1 },
    display: 'list',
    sel: new Set(),
    anchor: null,
    cursor: null,
    focus: false,
    focusBeforeOpts: false,
    optsOpen: false,
    playing: false,
    time: 12,
    mix: 'both',
    queueOpen: true,
    defaults: { eng: defEng(), out: defOut() },
  };

  const NAV_TITLES = { all: 'All conversions', running: 'Running', failed: 'Failed', fav: 'Favourites', 'c:recital': COLLECTIONS.recital, 'c:lessons': COLLECTIONS.lessons };
  function navMatch(it, nav) {
    if (nav === 'running') return it.status === 'running' || it.status === 'queued';
    if (nav === 'failed') return it.status === 'error';
    if (nav === 'fav') return it.fav;
    if (nav.indexOf('c:') === 0) return it.coll.indexOf(nav.slice(2)) >= 0;
    return true;
  }
  const STATUS_ORDER = { running: 0, queued: 1, error: 2, cancelled: 3, done: 4 };
  function visible() {
    let arr = items.filter((it) => navMatch(it, S.nav === 'add' ? 'all' : S.nav));
    if (S.q) { const q = S.q.toLowerCase(); arr = arr.filter((it) => it.filename.toLowerCase().indexOf(q) >= 0); }
    const k = S.sort.key, dir = S.sort.dir;
    const val = (it) => k === 'name' ? title(it).toLowerCase() : k === 'length' ? it.duration : k === 'notes' ? (it.status === 'done' ? it.notes : -1) : k === 'status' ? STATUS_ORDER[it.status] : k === 'engine' ? ENGINE_SHORT[it.engine] : it.ts;
    arr.sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir || b.ts - a.ts; });
    return arr;
  }
  function mode() {
    if (S.view === 'home') return 'home';
    if (S.sel.size !== 1) return 'list';
    return S.focus ? 'focus' : 'split';
  }
  const openItem = () => (S.sel.size === 1 ? byId(S.sel.values().next().value) : null);

  /* ------------------------------------------------------------------ chips / rows */
  function chip(it) {
    switch (it.status) {
      case 'done': return `<span class="chip done">${I('check')}Ready</span>`;
      case 'running': { const p = Math.round((it.progress || 0) * 100); return `<span class="chip running"><span class="mini-bar"><span style="width:${p}%"></span></span>${p}%</span>`; }
      case 'queued': return it.paused ? `<span class="chip queued">${I('pause')}Paused</span>` : `<span class="chip queued">${I('clock')}Waiting</span>`;
      case 'error': return `<span class="chip error">${I('alert')}Failed</span>`;
      default: return '<span class="chip cancelled">Cancelled</span>';
    }
  }
  function badge(it) {
    const ic = { running: 'spinner', queued: it.paused ? 'pause' : 'clock', error: 'alert', cancelled: 'stop' }[it.status];
    return ic ? `<span class="badge ${it.status}">${I(ic, it.status === 'running' ? 'spin' : '')}</span>` : '';
  }
  const subLine = (it) => `${ext(it.filename)} · ${it.size}`;
  function meta2(it) {
    if (it.status === 'done') return `${fmtDur(it.duration)} · ${fmtInt(it.notes)} notes · ${it.when}`;
    if (it.status === 'error') return it.error;
    if (it.status === 'running') return `${fmtDur(it.duration)} · ${etaText(etaLeft(it))}`;
    if (it.status === 'queued') return it.paused ? `${fmtDur(it.duration)} · paused at ${Math.round(it.paused * 100)}%, continues next` : `${fmtDur(it.duration)} · waiting in queue`;
    return `${fmtDur(it.duration)} · cancelled ${it.when}`;
  }
  // one line for the home shelf, under the title
  function shelfLine(it) {
    if (it.status === 'done') return `${fmtInt(it.notes)} notes · ${fmtDur(it.duration)}`;
    if (it.status === 'running') return `${Math.round((it.progress || 0) * 100)}% · ${etaText(etaLeft(it)).replace('About', 'about')}`;
    if (it.status === 'queued') return it.paused ? `Paused at ${Math.round(it.paused * 100)}%` : `Waiting · ${fmtDur(it.duration)}`;
    if (it.status === 'error') return it.error;
    return `Cancelled · ${fmtDur(it.duration)}`;
  }
  function rowHTML(it) {
    const sel = S.sel.has(it.id);
    const open = sel && S.sel.size === 1;
    const dash = '<span class="dash" aria-label="none">—</span>';
    return `<div class="row${open ? ' focus-open' : ''}" role="row" data-id="${it.id}" aria-selected="${sel}" tabindex="-1">
      <span class="c-check" role="gridcell"><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} aria-label="Select ${esc(title(it))}"></span>
      <span class="c-cover" role="gridcell"><canvas class="cover" data-cover="${it.id}" width="44" height="44" aria-hidden="true"></canvas>${badge(it)}</span>
      <span class="c-name" role="gridcell"><span class="nm" title="${esc(it.filename)}">${esc(title(it))}</span><span class="sub">${esc(subLine(it))}</span><span class="meta2">${esc(meta2(it))}</span></span>
      <span class="c-status" role="gridcell">${chip(it)}</span>
      <span class="c-len" role="gridcell">${fmtDur(it.duration)}</span>
      <span class="c-notes" role="gridcell">${it.status === 'done' ? fmtInt(it.notes) : dash}</span>
      <span class="c-engine" role="gridcell">${it.status === 'done' || it.status === 'running' ? ENGINE_SHORT[it.engine] : dash}</span>
      <span class="c-added" role="gridcell">${esc(it.when)}</span>
      <span class="c-fav" role="gridcell"><button class="icon-btn fav-btn" data-fav tabindex="-1" aria-pressed="${it.fav}" aria-label="Favourite">${I('star')}</button></span>
    </div>`;
  }
  function cardHTML(it) {
    const sel = S.sel.has(it.id);
    return `<div class="card" role="row" data-id="${it.id}" aria-selected="${sel}" tabindex="-1">
      <canvas class="cover" data-cover="${it.id}" aria-hidden="true"></canvas>
      <span class="card-check"><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} aria-label="Select ${esc(title(it))}"></span>
      <span class="card-status">${chip(it)}</span>
      <span class="c-name"><span class="nm" title="${esc(it.filename)}">${it.fav ? '<span class="sr-fav" title="Favourite">★ </span>' : ''}${esc(title(it))}</span><span class="meta2">${esc(meta2(it))}</span></span>
    </div>`;
  }
  function shelfHTML(it) {
    const label = `${title(it)}, ${{ done: 'ready', running: 'converting', queued: it.paused ? 'paused' : 'waiting', error: 'failed', cancelled: 'cancelled' }[it.status]}`;
    return `<div class="shelf-item" role="listitem"><button class="shelf-btn" data-open="${it.id}" title="${esc(it.filename)}" aria-label="${esc(label)}">
      <span class="shelf-art"><canvas class="cover" data-cover="${it.id}" aria-hidden="true"></canvas>${it.status !== 'done' ? `<span class="shelf-chip">${chip(it)}</span>` : ''}</span>
      <span class="nm">${it.fav ? '<span class="sr-fav" aria-hidden="true">★ </span>' : ''}${esc(title(it))}</span>
      <span class="s1${it.status === 'error' ? ' bad' : ''}">${esc(shelfLine(it))}</span>
      <span class="s2">${esc(it.when)} · ${esc(ext(it.filename))}</span>
    </button></div>`;
  }

  /* ------------------------------------------------------------------ render: shell */
  const content = $('#content');
  function render() {
    content.dataset.mode = mode();
    renderSidebar();
    renderQueue();
    renderGpu();
    if (S.view === 'home') renderHome(); else renderLibrary();
    renderDetail();
  }

  function renderSidebar() {
    const counts = {
      all: items.length,
      running: items.filter((i) => i.status === 'running' || i.status === 'queued').length,
      failed: items.filter((i) => i.status === 'error').length,
      fav: items.filter((i) => i.fav).length,
      'c:recital': items.filter((i) => i.coll.indexOf('recital') >= 0).length,
      'c:lessons': items.filter((i) => i.coll.indexOf('lessons') >= 0).length,
    };
    $$('[data-count]').forEach((el) => {
      const k = el.dataset.count, n = counts[k];
      el.textContent = n ? String(n) : '';
      el.classList.toggle('hot', k === 'running' && n > 0);
      el.classList.toggle('bad', k === 'failed' && n > 0);
    });
    $$('.nav-item[data-nav]').forEach((b) => {
      const on = S.view === 'home' ? b.dataset.nav === 'add' : b.dataset.nav === S.nav;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      const lbl = b.querySelector('.nav-label');
      const cnt = b.querySelector('.nav-count');
      b.title = lbl ? lbl.textContent + (cnt && cnt.textContent ? ` (${cnt.textContent})` : '') : '';
    });
    $('#allCount').textContent = String(items.length);
  }

  // queue order: whatever runs first, then by rank (a paused job or "Convert next" jumps ahead), then by date added
  const qRank = (it) => (it.qrank != null ? it.qrank : it.ts);
  function queueItems() {
    return items.filter((i) => i.status === 'running' || i.status === 'queued')
      .sort((a, b) => (a.status === b.status ? qRank(a) - qRank(b) : a.status === 'running' ? -1 : 1));
  }
  function renderQueue() {
    const q = queueItems();
    const run = q.filter((i) => i.status === 'running'), wait = q.filter((i) => i.status === 'queued');
    $('#qSum').textContent = q.length ? `${q.length} ${q.length === 1 ? 'file' : 'files'}` : 'Idle';
    const ring = $('#qRing');
    const avg = run.length ? run.reduce((s, i) => s + (i.progress || 0), 0) / run.length : 0;
    ring.style.setProperty('--p', Math.round(avg * 100));
    ring.classList.toggle('idle', !run.length);
    $('#qHead').setAttribute('aria-expanded', String(S.queueOpen));
    $('#qHead').title = q.length ? `Queue: ${[run.length ? `${run.length} converting` : '', wait.length ? `${wait.length} waiting` : ''].filter(Boolean).join(', ')}` : 'Queue is empty';
    const list = $('#qList');
    list.hidden = !S.queueOpen;
    if (!q.length) { list.innerHTML = '<li class="q-empty">Nothing waiting. Drop files anywhere to add them.</li>'; return; }
    list.innerHTML = q.map((it, k) => {
      const p = Math.round((it.progress || 0) * 100);
      const sub = it.status === 'running'
        ? `<span class="mini-bar"><span style="width:${p}%"></span></span><span class="num">${p}%</span>`
        : `<span>${k === run.length ? 'Next' : 'Waiting'} · ${it.paused ? `paused at ${Math.round(it.paused * 100)}%` : fmtDur(it.duration)}</span>`;
      return `<li class="q-item" data-open="${it.id}" tabindex="0" title="${esc(it.filename)}"><canvas data-cover="${it.id}" width="32" height="32" aria-hidden="true"></canvas><span class="q-nm">${esc(title(it))}</span><span class="q-sub">${sub}</span></li>`;
    }).join('');
    drawCovers(list);
  }
  function renderGpu() {
    const busy = items.some((i) => i.status === 'running');
    $('#gpu').classList.toggle('busy', busy);
    $('#gpuText').textContent = busy ? 'Converting' : 'Ready';
  }

  /* ------------------------------------------------------------------ render: home */
  function renderHome() {
    const order = M.recent.map((r) => byId(r.id)).filter(Boolean);
    const extraRecent = items.filter((i) => order.indexOf(i) < 0 && i.when === 'Just now');
    const list = extraRecent.concat(order).slice(0, 6);
    $('#recentList').innerHTML = list.length ? list.map(shelfHTML).join('')
      : `<div class="home-empty"><span class="empty-art">${I('music')}</span><span><b>Your library is empty</b>Converted recordings appear here with a preview, ready to check and save as MIDI.</span></div>`;
    $('#recentList').classList.toggle('is-empty', !list.length);
    $('#showAll').hidden = !items.length;
    drawCovers($('#recentList'));
    const e = S.defaults.eng;
    $('#caEngine').textContent = ENGINE_SHORT[e.engine];
    $('#caViews').textContent = e.engine === 'aria' ? 'single pass' : VIEWS_SHORT[e.views];
    $('#dzNote').textContent = `Files wait in the queue and convert one after another, ${ENGINE_SPEED[e.engine]}.`;
  }

  /* ------------------------------------------------------------------ render: library */
  const libBody = $('#libBody');
  function renderLibrary() {
    const arr = visible();
    renderLibHead(arr);
    const cols = $('#libCols');
    cols.hidden = S.display !== 'list' || !arr.length;
    if (!cols.hidden) {
      const allSel = arr.length && arr.every((i) => S.sel.has(i.id));
      const someSel = !allSel && arr.some((i) => S.sel.has(i.id));
      const th = (k, label, cls) => {
        const on = S.sort.key === k;
        return `<span class="${cls}" role="columnheader"${on ? ` aria-sort="${S.sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button data-sort="${k}"${on ? ' class="on"' : ''}>${label}${on ? I(S.sort.dir > 0 ? 'arrow-up' : 'arrow-down') : ''}</button></span>`;
      };
      cols.innerHTML = `<span class="c-check"><input type="checkbox" class="check${someSel ? ' mixed' : ''}" id="selAll" ${allSel ? 'checked' : ''} aria-label="Select all"></span><span></span>`
        + th('name', 'Name', 'c-name') + th('status', 'Status', 'c-status') + th('length', 'Length', 'c-len') + th('notes', 'Notes', 'c-notes')
        + th('engine', 'Engine', 'c-engine') + th('added', 'Added', 'c-added') + '<span></span>';
    }
    if (!arr.length) {
      libBody.className = 'lib-body';
      libBody.innerHTML = emptyHTML();
      hydrateIcons(libBody);
      return;
    }
    const hadFocus = libBody.contains(document.activeElement);
    libBody.className = S.display === 'grid' ? 'lib-body lib-grid' : 'lib-body';
    libBody.innerHTML = arr.map(S.display === 'grid' ? cardHTML : rowHTML).join('');
    if (!S.cursor || !arr.some((i) => i.id === S.cursor)) S.cursor = (arr.find((i) => S.sel.has(i.id)) || arr[0]).id;
    const cur = libBody.querySelector(`[data-id="${S.cursor}"]`);
    if (cur) cur.tabIndex = 0;
    if (hadFocus && cur) cur.focus({ preventScroll: true });
    drawCovers(libBody);
  }
  function emptyHTML() {
    if (S.q) return `<div class="empty"><span class="empty-art">${I('search_x')}</span><h2>No conversions match “${esc(S.q)}”</h2><p>Check the spelling, or search for part of the file name.</p><button class="btn" data-act="clear-search">Clear search</button></div>`;
    const map = {
      running: ['running', 'Nothing is converting', 'Files you add wait here while they convert.'],
      failed: ['check', 'No failed conversions', 'Files that could not be converted show up here with the reason.'],
      fav: ['star', 'No favourites yet', 'Star a conversion to keep it at hand.'],
    };
    const [ic, h, p] = map[S.nav] || ['folder', 'This collection is empty', 'Select conversions, then choose Add to collection.'];
    return `<div class="empty"><span class="empty-art">${I(ic)}</span><h2>${h}</h2><p>${p}</p>${S.nav === 'all' ? '' : '<button class="btn" data-act="go-all">Show all conversions</button>'}</div>`;
  }
  function renderLibHead(arr) {
    const head = $('#libHead');
    const n = S.sel.size;
    if (n >= 2) {
      const allSel = arr.length && arr.every((i) => S.sel.has(i.id));
      head.className = 'lib-head batch';
      head.innerHTML = `
        <input type="checkbox" class="check${allSel ? '' : ' mixed'}" id="selAll2" ${allSel ? 'checked' : ''} aria-label="Select all">
        <span class="batch-count num">${n} selected</span><span class="batch-sep"></span>
        <button class="btn sm primary" data-act="save-sel" aria-label="Save selected">${I('download')}<span class="lbl-long">Save selected</span></button>
        <button class="btn sm" data-act="reconvert-sel" aria-label="Re-convert with settings">${I('refresh')}<span class="lbl-long">Re-convert with settings</span></button>
        <button class="btn sm" data-act="collect-sel" aria-label="Add to collection">${I('folder-plus')}<span class="lbl-long">Add to collection</span></button>
        <button class="btn sm danger" data-act="remove-sel" aria-label="Remove">${I('trash')}<span class="lbl-long">Remove</span></button>
        <span class="spacer"></span>
        <button class="icon-btn sm" data-act="clear-sel" title="Clear selection (Esc)" aria-label="Clear selection">${I('close')}</button>`;
      return;
    }
    head.className = 'lib-head';
    const ready = arr.filter((i) => i.status === 'done').length;
    const total = arr.reduce((s, i) => s + (i.status === 'done' ? i.duration : 0), 0);
    const sortLabel = { added: 'Date added', name: 'Name', length: 'Length', notes: 'Notes', status: 'Status', engine: 'Engine' }[S.sort.key];
    head.innerHTML = `
      <button class="icon-btn film-back" data-act="unfocus" title="Show the list" aria-label="Show the list">${I('list')}</button>
      <div class="lib-title"><h1>${esc(S.q ? `Results for “${S.q}”` : NAV_TITLES[S.nav] || 'All conversions')}</h1>
        <p class="num">${arr.length} ${arr.length === 1 ? 'conversion' : 'conversions'}${ready ? ` · ${ready} ready<span class="lbl-long"> to save · ${fmtLong(total)} of piano</span>` : ''}</p></div>
      <button class="btn ghost sm sort-btn" data-act="sort-menu" aria-haspopup="menu" title="Sort by ${sortLabel}">${I('sort')}<span class="lbl-long"><span class="lbl-k">Sort:</span> ${sortLabel}</span></button>
      <div class="view-toggle" role="group" aria-label="View">
        <button data-display="list" aria-pressed="${S.display === 'list'}" title="List">${I('list')}</button>
        <button data-display="grid" aria-pressed="${S.display === 'grid'}" title="Grid">${I('grid')}</button>
      </div>`;
  }

  /* ------------------------------------------------------------------ render: detail */
  const views = { result: $('#dResult'), progress: $('#dProgress'), state: $('#dState') };
  let shown = { id: null, kind: null };
  function showView(kind) { Object.keys(views).forEach((k) => { views[k].hidden = k !== kind; }); }
  function renderDetail() {
    const it = openItem();
    if (!it || S.view === 'home') { showView(null); shown = { id: null, kind: null }; stopPlay(); return; }
    const kind = it.status === 'done' ? 'result' : it.status === 'running' ? 'progress' : 'state';
    if (shown.id !== it.id) { stopPlay(); S.time = it.id === SCHUBERT ? 12 : Math.min(12, it.duration / 5); }
    showView(kind);
    if (kind === 'result') renderResult(it, shown.id !== it.id || shown.kind !== 'result');
    else if (kind === 'progress') renderProgress(it);
    else renderState(it);
    shown = { id: it.id, kind };
  }

  /* --- result */
  let roll = null, rollKey = '';
  function rollColors(hue) {
    const st = document.documentElement.style;
    st.setProperty('--note', `hsl(${hue}, 58%, 40%)`);
    st.setProperty('--note-tail', `hsla(${hue}, 58%, 40%, 0.2)`);
    if (roll) { roll._readColors(); roll._drawKeys(); roll.requestDraw(); }
  }
  function renderResult(it, fresh) {
    $('#dName').textContent = title(it);
    $('#dName').title = it.filename;
    // the full format line, or just the file type when the header shares its row with the actions
    $('#dMeta').innerHTML = `<span class="m-long">${esc(it.format)}</span><span class="m-short">${esc(ext(it.filename))}</span> · ${esc(it.size)} · Added ${esc(it.when === 'Just now' ? 'just now' : it.when)}`;
    $('#dMeta').title = `${it.format} · ${it.size}`;
    drawCover($('#dCover'), it, 56);
    $('#dFav').setAttribute('aria-pressed', String(it.fav));
    $('#dFav').title = it.fav ? 'Remove from favourites' : 'Add to favourites';
    $('#dExpand').setAttribute('aria-pressed', String(S.focus));
    $('#dExpand').title = S.focus ? 'Show the list again' : 'Focus on this file';
    $('#saveMidi').title = `Save “${midiName(it)}”`;
    $('#optToggle').setAttribute('aria-expanded', String(S.optsOpen));
    $('#opts').classList.toggle('open', S.optsOpen);
    views.result.classList.toggle('opts-open', S.optsOpen);
    $('#optsBody').hidden = !S.optsOpen;
    $('#optsBar').setAttribute('aria-expanded', String(S.optsOpen));
    if (fresh) rollColors(it.hue);
    if (!roll) {
      roll = new PianoRoll($('#roll'), { onSeek: (t) => { S.time = t; roll.setTime(t, S.playing); updateTime(); } });
    }
    updateRoll(it, fresh);
    renderStats(it);
    if (fresh || !$('#optHost').firstElementChild || $('#optHost').dataset.for !== it.id) renderOptions($('#optHost'), it, 'item');
    updateOptsSummary(it);
    updateTime();
    updateMix();
  }
  function updateRoll(it, fresh) {
    const key = it.id + JSON.stringify(it.out);
    if (key === rollKey && !fresh) return;
    const d = derived(it);
    roll.setData({ notes: d.notes, pedals: d.pedals, duration: it.duration }, { keepView: !fresh });
    rollKey = key;
    if (fresh) { roll.setTime(S.time, false); roll.revealTime(S.time); }
    else roll.setTime(S.time, S.playing);
  }
  function renderStats(it) {
    const d = derived(it), o = it.out;
    const pedalCount = d.pedals.filter((p) => p[2] === 64).length;
    const softCount = d.pedals.filter((p) => p[2] === 67).length;
    const softTxt = o.soft_pedal && softCount ? `<small>+ ${softCount} soft</small>` : '';
    const pedal = o.pedal === 'cc' ? `${it.id === SCHUBERT ? pedalCount : it.pedals}${softTxt}` : o.pedal === 'extend' ? 'Baked in' : 'Left out';
    const cells = [
      ['Length', fmtDur(it.duration)],
      ['Notes', `${fmtInt(d.noteCount)}${d.dropped ? `<small class="delta">−${fmtInt(d.dropped)}</small>` : ''}`],
      ['Pedal presses', pedal],
      ['Engine', ENGINE_SHORT[it.engine], ENGINES.find((e) => e.id === it.engine).name],
      ['Converted in', `${it.secs.toFixed(1)} s`, `${it.secs.toFixed(1)} s on NVIDIA GeForce RTX 5070 Ti`],
      ['Confidence', `${(it.conf * 100).toFixed(1)}%`, it.aria ? `Average model confidence. Aria-AMT added ${it.aria} notes.` : 'Average model confidence.'],
    ];
    $('#dStats').innerHTML = cells.map(([k, v, t]) => `<div class="stat"${t ? ` title="${esc(t)}"` : ''}><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
  function updateOptsSummary(it) {
    const o = it.out, e = it.eng;
    const parts = [
      { cc: 'Pedal events (CC64)', extend: 'Pedal baked in', none: 'No pedal' }[o.pedal],
      o.velocity === 'flat' ? `Flat velocity ${o.flat_velocity}` : 'Dynamics as played',
      o.min_note_ms ? `Notes ≥ ${o.min_note_ms} ms` : null,
      `${o.tempo} BPM`,
      `${ENGINE_SHORT[e.engine]}${e.engine !== 'aria' ? ', ' + VIEWS_SHORT[e.views] : ''}`,
    ].filter(Boolean);
    $('#optsSum').textContent = parts.join(' · ');
  }
  function updateTime() {
    const it = openItem();
    if (!it) return;
    $('#time').textContent = `${fmtTime(S.time)} / ${fmtTime(it.duration)}`;
  }
  function updateMix() {
    $$('#mixSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mix === S.mix)));
    $('#listenCap').textContent = { original: 'Your recording', both: 'Recording + MIDI piano', midi: 'MIDI piano only' }[S.mix];
    lastOv = '';
  }

  /* --- overview strip under the roll */
  let lastOv = '';
  function drawOverview() {
    const it = openItem();
    if (!it || !roll || views.result.hidden) return;
    const cv = $('#overview');
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const viewSec = roll._viewW() / roll.pxPerSec;
    const key = [w, h, it.id, roll.scrollX.toFixed(3), viewSec.toFixed(3), S.time.toFixed(2), S.mix, rollKey].join('|');
    if (key === lastOv) return;
    lastOv = key;
    const dpr = DPR();
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const D = it.duration, padX = 8, iw = w - padX * 2;
    const X = (t) => padX + (t / D) * iw;
    // audio
    const showWave = S.mix !== 'midi';
    ctx.fillStyle = showWave ? 'rgba(69, 67, 75, .42)' : 'rgba(69, 67, 75, .14)';
    for (let x = 0; x < iw; x += 2) {
      const a = Math.max(0.5, peakAt(it, (x / iw) * D) * (h / 2 - 4));
      ctx.fillRect(padX + x, h / 2 - a, 1.2, a * 2);
    }
    // notes
    if (S.mix !== 'original') {
      const d = derived(it), src = dataFor(it);
      ctx.fillStyle = `hsla(${it.hue}, 60%, 40%, .75)`;
      const span = src.hi - src.lo + 1;
      for (const n of d.notes) ctx.fillRect(X(n[0]), 3 + ((src.hi - n[2]) / span) * (h - 7), Math.max(1, ((n[1] - n[0]) / D) * iw), 1.2);
    }
    // viewport + playhead
    const vx0 = X(clamp(roll.scrollX, 0, D)), vx1 = X(clamp(roll.scrollX + viewSec, 0, D));
    ctx.fillStyle = 'rgba(180, 35, 90, .07)';
    ctx.fillRect(vx0, 1, vx1 - vx0, h - 2);
    ctx.strokeStyle = 'rgba(180, 35, 90, .55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(vx0 + 0.5, 1.5, Math.max(4, vx1 - vx0 - 1), h - 3, 3); ctx.stroke();
    ctx.fillStyle = '#b4235a';
    ctx.fillRect(Math.round(X(S.time)) - 0.75, 0, 1.5, h);
    $('#zoomVal').textContent = `${viewSec >= 10 ? Math.round(viewSec) : viewSec.toFixed(1)} s`;
  }

  /* --- progress */
  function jobInfo(it) {
    const p = clamp(it.progress || 0, 0, 1);
    const windows = Math.max(1, Math.ceil((it.duration - 16) / 5.5) + 1);
    const ens = it.eng.engine === 'ensemble';
    const tkEnd = ens ? 0.8 : 0.95;
    let stage, msg, win = 0;
    if (p < 0.05) { stage = 0; msg = 'Reading audio'; }
    else if (p < tkEnd) { stage = 1; win = Math.min(windows, Math.floor(((p - 0.05) / (tkEnd - 0.05)) * windows) + 1); msg = `Transcribing window ${win} of ${windows}`; }
    else if (ens && p < 0.96) { stage = 2; win = windows; msg = 'Getting a second opinion from Aria-AMT'; }
    else { stage = 3; win = windows; msg = 'Merging and writing MIDI'; }
    if (it.id === SCHUBERT && Math.abs(p - M.progress.progress) < 0.001) msg = M.progress.message;
    const eta = it.id === SCHUBERT && Math.abs(p - M.progress.progress) < 0.001 ? M.progress.eta_seconds : etaLeft(it);
    return { p, stage, msg, win, windows, eta, ens };
  }
  function renderProgress(it) {
    $('#pName').textContent = title(it);
    $('#pName').title = it.filename;
    $('#pMeta').textContent = `${it.format} · ${it.size} · ${fmtDur(it.duration)}`;
    drawCover($('#pCover'), it, 56);
    const j = jobInfo(it);
    const pct = Math.round(j.p * 100);
    $('#pgPct').innerHTML = `${pct}<span>%</span>`;
    $('#pgStep').textContent = j.msg;
    $('#pgEta').textContent = etaText(j.eta);
    $('#pgBar').style.width = pct + '%';
    $('#pgBarWrap').setAttribute('aria-valuenow', String(pct));
    const n = VIEWS_N[it.eng.views];
    const stages = [
      { label: M.progress.stages[0].label, sub: j.stage > 0 ? '0.4 s' : 'Decoding…' },
      { label: `Transkun V2 · ${n} ${n === 1 ? 'view' : 'views'}`, sub: j.stage === 1 ? `Window ${j.win} of ${j.windows}` : j.stage > 1 ? `${j.windows} windows` : 'Waiting' },
    ];
    if (j.ens) stages.push({ label: M.progress.stages[2].label, sub: j.stage === 2 ? 'Checking unsure notes' : j.stage > 2 ? `${it.id === SCHUBERT ? 9 : 'Some'} notes added` : 'Waiting' });
    stages.push({ label: M.progress.stages[3].label, sub: j.stage === 3 ? 'Writing file' : 'Waiting' });
    const lastIdx = stages.length - 1;
    const stIdx = (k) => (j.ens ? k : k >= 2 ? k + 1 : k);
    $('#pgStages').style.gridTemplateColumns = `repeat(${stages.length}, minmax(0, 1fr))`;
    $('#pgStages').innerHTML = stages.map((s, k) => {
      const real = stIdx(k);
      const state = real < j.stage || (k === lastIdx && j.p >= 1) ? 'done' : real === j.stage ? 'active' : 'pending';
      const ic = state === 'done' ? I('check') : state === 'active' ? I('spinner', 'spin') : '';
      return `<li class="stage ${state}"><span class="st-ic">${ic}</span><span class="st-txt"><span class="st-lbl">${esc(s.label)}</span><span class="st-sub">${esc(s.sub)}</span></span></li>`;
    }).join('');
    const e = it.eng;
    $('#pgSettings').innerHTML = `<span>Engine <b>${ENGINE_SHORT[e.engine]}</b></span>${e.engine !== 'aria' ? `<span>Analysis <b>${VIEWS_SHORT[e.views]}</b></span>` : ''}${e.engine === 'ensemble' ? `<span>Second opinion <b>${RESCUE_SHORT[e.rescue]}</b></span>` : ''}<span>On <b>RTX 5070 Ti</b></span>`;
    if (!$('#pgLog').dataset.for || $('#pgLog').dataset.for !== it.id + j.win) {
      $('#pgLog').innerHTML = logFor(it, j).map((l) => `<div>${esc(l)}</div>`).join('');
      $('#pgLog').dataset.for = it.id + j.win;
      $('#pgLog').scrollTop = 1e6;
    }
    drawLive(it);
  }
  function logFor(it, j) {
    if (it.id === SCHUBERT && j.win === 5 && j.stage === 1) return M.log;
    const lines = [`14:40:00.112  job ${it.id}  queued  engine=${it.eng.engine} views=${it.eng.views}${it.eng.engine === 'ensemble' ? ' rescue=' + it.eng.rescue : ''}`];
    if (j.stage >= 1) lines.push(`14:40:00.130  decode  ${ext(it.filename).toLowerCase()} 44100 Hz 2 ch  ${it.duration.toFixed(2)} s  (0.41 s)`);
    const r = rng(hashStr(it.id + 'log'));
    for (let w = 1; w < Math.min(j.win, j.windows + 1); w++) {
      const ms = 544 + w * 772;
      lines.push(`14:40:${String(Math.floor(ms / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}  transkun  window ${w}/${j.windows}  notes+=${90 + Math.floor(r() * 50)}  pedal+=${1 + Math.floor(r() * 3)}`);
    }
    if (j.stage >= 2 && j.ens) lines.push('14:40:09.004  aria  second opinion  threshold=0.3');
    if (j.stage >= 3) lines.push('14:40:10.611  fuse  writing MIDI');
    return lines.slice(-8);
  }
  function drawLive(it) {
    const cv = $('#pgCanvas');
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = DPR();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const j = jobInfo(it);
    const D = Math.min(it.duration, 900);
    const top = 24, bot = h - 8, ih = bot - top;
    const segs = j.windows <= 24 ? j.windows : 24; // group windows when there are many
    const per = j.windows / segs;
    const segW = w / segs;
    const doneSegs = j.stage > 1 ? segs : j.stage === 1 ? Math.floor((j.win - 1) / per) : 0;
    const d = dataFor(it);
    const span = d.hi - d.lo + 1;
    const rh = ih / span;
    const tNow = performance.now() / 1000;
    for (let k = 0; k < segs; k++) {
      const x0 = k * segW;
      const state = k < doneSegs ? 'done' : k === doneSegs && j.stage === 1 ? 'active' : 'pending';
      if (state === 'active') {
        ctx.fillStyle = 'rgba(27, 88, 176, .07)';
        ctx.fillRect(x0, top, segW, ih);
        const sx = x0 + ((tNow * 0.6) % 1) * segW;
        const gr = ctx.createLinearGradient(sx - segW * 0.5, 0, sx, 0);
        gr.addColorStop(0, 'rgba(27, 88, 176, 0)');
        gr.addColorStop(1, 'rgba(27, 88, 176, .16)');
        ctx.fillStyle = gr;
        ctx.fillRect(Math.max(x0, sx - segW * 0.5), top, Math.min(segW * 0.5, sx - x0), ih);
      }
      if (state !== 'done') {
        ctx.fillStyle = state === 'active' ? 'rgba(27, 88, 176, .35)' : 'rgba(69, 67, 75, .2)';
        for (let x = x0 + 2; x < x0 + segW - 2; x += 3) {
          const a = Math.max(0.5, peakAt(it, (x / w) * D) * ih * 0.42);
          ctx.fillRect(x, top + ih / 2 - a, 1.5, a * 2);
        }
      }
      if (k > 0) {
        ctx.fillStyle = '#e7e4df';
        ctx.fillRect(Math.round(x0), top - 6, 1, ih + 6);
      }
      ctx.fillStyle = state === 'active' ? '#1b58b0' : state === 'done' ? '#45434b' : '#6f6c75';
      ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textBaseline = 'middle';
      const label = per > 1 ? `${Math.round(k * per) + 1}` : String(k + 1);
      if (segW > 18) ctx.fillText(label, x0 + 6, 12);
    }
    // notes for finished windows
    const tDone = (doneSegs / segs) * D;
    const nh = Math.max(2, Math.min(5, rh - 0.6));
    const yOf = (p) => top + (d.hi - p) * rh + (rh - nh) / 2;
    // pedal-held tails first, faint, then the key-down part on top
    ctx.fillStyle = `hsla(${it.hue}, 58%, 40%, .16)`;
    for (const n of d.notes) {
      if (n[0] >= tDone) break;
      if (!(n[4] > n[1])) continue;
      const x0 = (n[1] / D) * w, x1 = (Math.min(n[4], tDone) / D) * w;
      if (x1 > x0) ctx.fillRect(x0, yOf(n[2]) + nh * 0.2, x1 - x0, nh * 0.6);
    }
    ctx.fillStyle = `hsl(${it.hue}, 58%, 38%)`;
    for (const n of d.notes) {
      if (n[0] >= tDone) break;
      ctx.globalAlpha = 0.45 + 0.55 * Math.min(1, n[3] / 100);
      const x = (n[0] / D) * w;
      ctx.fillRect(x, yOf(n[2]), Math.max(2, ((Math.min(n[1], tDone) - n[0]) / D) * w), nh);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e7e4df';
    ctx.fillRect(0, top - 1, w, 1);
  }

  /* --- waiting / failed / cancelled */
  function renderState(it) {
    $('#sName').textContent = title(it);
    $('#sName').title = it.filename;
    $('#sMeta').textContent = `${it.format} · ${it.size} · ${fmtDur(it.duration)}`;
    drawCover($('#sCover'), it, 56);
    const card = $('#stateCard');
    const e = it.eng;
    const settings = `${ENGINE_SHORT[e.engine]}${e.engine !== 'aria' ? ' · ' + VIEWS_SHORT[e.views] : ''}${e.engine === 'ensemble' ? ' · Second opinion: ' + RESCUE_SHORT[e.rescue] : ''}`;
    if (it.status === 'queued') {
      const q = queueItems();
      const ahead = q.filter((x) => x.status === 'running');
      const waiting = q.filter((x) => x.status === 'queued');
      const before = waiting.slice(0, Math.max(0, waiting.indexOf(it)));
      const wait = ahead.reduce((s, x) => s + etaLeft(x), 0) + before.reduce((s, x) => s + x.etaTotal * (1 - (x.paused || 0)), 0);
      const first = ahead[0] || before[0];
      const more = ahead.length + before.length - 1;
      const when = etaText(wait).replace('About', 'in about').replace(' left', '').replace('Almost done', 'in a moment');
      const verb = it.paused ? 'Continues' : 'Starts';
      card.className = 'state-card';
      card.innerHTML = `<div class="sc-top"><span class="sc-ic">${I(it.paused ? 'pause' : 'clock')}</span><div><div class="sc-title">${it.paused ? `Paused at ${Math.round(it.paused * 100)}%` : 'Waiting in the queue'}</div>
        <p class="sc-text">${first ? `${verb} after ${esc(title(first))}${more > 0 ? ` and ${more} more` : ''}, ${when}.` : `${verb} in a moment.`}${it.paused ? ' The finished part is kept.' : ''}</p></div></div>
        <canvas class="sc-wave" id="scWave" aria-hidden="true"></canvas>
        <dl class="sc-kv"><dt>Will use</dt><dd>${esc(settings)}</dd><dt>${it.paused ? 'Still to do' : 'Expected time'}</dt><dd>${etaText(it.etaTotal * (1 - (it.paused || 0))).replace(' left', '')} on RTX 5070 Ti</dd><dt>File</dt><dd>${esc(it.filename)}</dd></dl>
        <div class="sc-actions"><button class="btn primary" data-act="convert-next" data-id="${it.id}">${I('next')}Convert next</button><button class="btn" data-act="remove-one" data-id="${it.id}">${I('trash')}Remove from queue</button></div>`;
      requestAnimationFrame(() => drawWave($('#scWave'), it));
    } else if (it.status === 'error') {
      const tips = it.error === 'This file is larger than 2 GB.'
        ? ['Export only the sound: a 90-minute WAV is under 1 GB and an MP3 under 200 MB.', 'Or trim the video down to the piece you want, then add it again.']
        : ['Play the file and check that you can hear the piano.', 'If it plays fine elsewhere, export the sound as MP3 or WAV and add that file instead.'];
      card.className = 'state-card error';
      card.innerHTML = `<div class="sc-top"><span class="sc-ic">${I('alert')}</span><div><div class="sc-title">This file could not be converted</div><p class="sc-text">${esc(it.error)}</p></div></div>
        <ul class="sc-tips">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="sc-actions">${it.error === 'This file is larger than 2 GB.' ? '' : `<button class="btn primary" data-act="retry" data-id="${it.id}">${I('refresh')}Try again</button>`}<button class="btn" data-act="show-file">${I('folder-open')}Show file</button><button class="btn" data-act="remove-one" data-id="${it.id}">${I('trash')}Remove</button></div>`;
    } else {
      card.className = 'state-card';
      card.innerHTML = `<div class="sc-top"><span class="sc-ic">${I('stop')}</span><div><div class="sc-title">Conversion cancelled</div><p class="sc-text">It was stopped before it finished, so there is no MIDI file yet.</p></div></div>
        <canvas class="sc-wave" id="scWave" aria-hidden="true"></canvas>
        <dl class="sc-kv"><dt>Will use</dt><dd>${esc(settings)}</dd><dt>Expected time</dt><dd>${etaText(it.etaTotal).replace(' left', '')} on RTX 5070 Ti</dd></dl>
        <div class="sc-actions"><button class="btn primary" data-act="retry" data-id="${it.id}">${I('refresh')}Convert again</button><button class="btn" data-act="remove-one" data-id="${it.id}">${I('trash')}Remove</button></div>`;
      requestAnimationFrame(() => drawWave($('#scWave'), it));
    }
  }
  function drawWave(cv, it) {
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = DPR();
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = `hsla(${it.hue}, 25%, 35%, .4)`;
    for (let x = 6; x < w - 6; x += 2) {
      const a = Math.max(0.5, peakAt(it, (x / w) * Math.min(it.duration, 600)) * (h / 2 - 8));
      ctx.fillRect(x, h / 2 - a, 1.2, a * 2);
    }
  }

  /* ------------------------------------------------------------------ options */
  function seg(group, key, choices, value, label) {
    return `<div class="seg full" role="radiogroup" aria-label="${esc(label)}">${choices.map((c) => `<button type="button" role="radio" data-grp="${group}" data-k="${key}" data-v="${esc(c.value)}" aria-checked="${String(c.value) === String(value)}" title="${esc(c.title || c.label)}">${esc(c.label)}</button>`).join('')}</div>`;
  }
  function select(group, key, choices, value, id) {
    return `<select class="select" id="${id}" data-grp="${group}" data-k="${key}">${choices.map((c) => `<option value="${esc(c.value)}"${String(c.value) === String(value) ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
  }
  function sw(group, key, value, id) {
    return `<button type="button" class="switch" role="switch" id="${id}" data-grp="${group}" data-k="${key}" aria-checked="${!!value}"></button>`;
  }
  let optUid = 0;
  function renderOptions(host, target, scope) {
    const u = 'o' + (++optUid);
    const e = target.eng, o = target.out;
    const isItem = scope === 'item';
    const viewsOpt = optOf('ensemble', 'views'), rescueOpt = optOf('ensemble', 'rescue');
    const velOpt = optOf('transkun', 'velocity'), mergeOpt = optOf('transkun', 'merge_fix');
    const outOpt = (k) => OUT.find((x) => x.key === k);
    const changed = isItem && (e.engine !== target.engine || e.views !== 'channels' && target.status === 'done' && false);
    const used = isItem ? target.usedEng || defEng(target.engine) : null;
    const differs = isItem && JSON.stringify(e) !== JSON.stringify(used);

    const engCards = ENGINES.map((en) => `<button type="button" class="eng" role="radio" data-grp="eng" data-k="engine" data-v="${en.id}" aria-checked="${e.engine === en.id}" ${en.available ? '' : 'disabled'}>
        <span class="radio"></span><span class="eng-name">${esc(en.name)}${en.id === PIANO.default_engine ? '<span class="tag live">Default</span>' : ''}</span>
        <span class="eng-sub">${esc(ENGINE_SUB[en.id])}</span></button>`).join('');

    const tkFields = `
      <div class="field"><div class="f-label"><label for="${u}vel">${esc(velOpt.label)}</label><span class="f-hint">how loudness is read</span></div>${select('eng', 'velocity', velOpt.choices, e.velocity, u + 'vel')}</div>
      <div class="switch-row"><span class="sw-text"><label class="lbl" for="${u}merge">${esc(mergeOpt.label)}</label><span class="f-hint" title="${esc(mergeOpt.help)}">Keeps long pedal presses whole</span></span>${sw('eng', 'merge_fix', e.merge_fix, u + 'merge')}</div>`;

    let engSettings = '';
    if (e.engine !== 'aria') {
      engSettings += `<div class="field"><div class="f-label"><label for="${u}views">${esc(viewsOpt.label)}</label><span class="f-hint">per 16-s window, averaged</span></div>${select('eng', 'views', viewsOpt.choices, e.views, u + 'views')}</div>`;
    }
    if (e.engine === 'ensemble') {
      engSettings += `<div class="field"><div class="f-label"><span class="lbl" id="${u}resc">${esc(rescueOpt.label)}</span><span class="f-hint">lower adds more notes</span></div>
        ${seg('eng', 'rescue', rescueOpt.choices.map((c) => ({ value: c.value, label: RESCUE_SHORT[c.value], title: c.label })), e.rescue, rescueOpt.label)}</div>`;
    }
    if (e.engine === 'transkun') engSettings += tkFields;
    else engSettings += `<details class="subgroup" open data-sub><summary>${I('chevron-down')}<span class="lbl">Transkun V2 only</span><span class="f-hint">when it runs alone</span></summary>${tkFields}</details>`;
    if (e.engine === 'aria') engSettings = `<p class="no-opts">Aria-AMT has no settings of its own.</p>` + engSettings;

    const pedalOpt = outOpt('pedal'), softOpt = outOpt('soft_pedal'), dynOpt = outOpt('velocity'), flatOpt = outOpt('flat_velocity'), minOpt = outOpt('min_note_ms'), tempoOpt = outOpt('tempo');
    const minFill = (o.min_note_ms - minOpt.min) / (minOpt.max - minOpt.min) * 100;
    const outFields = `
      <div class="field"><div class="f-label"><label for="${u}ped">${esc(pedalOpt.label)}</label><span class="f-hint">CC64</span></div>${select('out', 'pedal', pedalOpt.choices, o.pedal, u + 'ped')}</div>
      <div class="switch-row"><span class="sw-text"><label class="lbl" for="${u}soft">${esc(softOpt.label)}</label><span class="f-hint">${esc(softOpt.help.replace(/\.$/, ''))}</span></span>${sw('out', 'soft_pedal', o.soft_pedal, u + 'soft')}</div>
      <div class="field"><div class="f-label"><span class="lbl">${esc(dynOpt.label)}</span><span class="f-hint">${o.velocity === 'flat' ? 'every note the same' : 'transcribed loudness'}</span></div>
        <div class="dyn-row">${seg('out', 'velocity', dynOpt.choices, o.velocity, dynOpt.label)}${o.velocity === 'flat' ? `<label class="flat-vel">${esc(flatOpt.label.replace('Flat ', ''))}<input class="num-in" type="number" id="${u}flat" data-grp="out" data-k="flat_velocity" min="${flatOpt.min}" max="${flatOpt.max}" step="1" value="${o.flat_velocity}" aria-label="${esc(flatOpt.label)}"></label>` : ''}</div></div>
      <div class="field"><div class="f-label"><label for="${u}min">${esc(minOpt.label)}</label><span class="f-hint">drops shorter notes</span></div>
        <div class="range-row"><input type="range" id="${u}min" data-grp="out" data-k="min_note_ms" min="${minOpt.min}" max="${minOpt.max}" step="${minOpt.step}" value="${o.min_note_ms}" style="--fill:${minFill}%"><output for="${u}min">${o.min_note_ms ? o.min_note_ms + ' ms' : 'Keep all'}</output></div></div>
      <div class="field"><div class="f-label"><label for="${u}tempo">${esc(tempoOpt.label)}</label><span class="f-hint">only moves bar lines</span></div>
        <div class="tempo-row"><span class="stepper"><button type="button" data-step="-1" data-grp="out" data-k="tempo" aria-label="Slower">${I('minus')}</button><input id="${u}tempo" type="number" data-grp="out" data-k="tempo" min="${tempoOpt.min}" max="${tempoOpt.max}" step="1" value="${o.tempo}"><button type="button" data-step="1" data-grp="out" data-k="tempo" aria-label="Faster">${I('plus')}</button></span><span class="unit">${esc(tempoOpt.unit)}</span></div></div>`;

    host.innerHTML = `<div class="opt-cols">
      <section class="opt-col c-eng"><h3>${isItem ? 'Engine' : 'Transcription'}${isItem ? `<span class="tag later">${I('refresh')}Needs re-convert</span>` : ''}</h3>
        <div class="engine-list" role="radiogroup" aria-label="Engine">${engCards}</div>
        ${isItem ? `<div class="reconv"><button class="btn sm${differs ? ' primary' : ''}" data-act="reconvert-one">${I('refresh')}Re-convert with these settings</button>
          <span class="reconv-note">${differs ? '<b>Changed from this file’s settings.</b> ' : 'Same settings as this file. '}${etaText(target.etaTotal * (e.engine === 'transkun' ? 0.27 : e.engine === 'aria' ? 0.75 : 1)).replace(' left', '')} on RTX 5070 Ti.</span></div>` : ''}
      </section>
      <section class="opt-col c-eng2"><h3>Engine settings</h3><div class="fields">${engSettings}</div></section>
      <section class="opt-col c-out"><h3>MIDI file${isItem ? `<span class="tag live">${I('bolt')}Applies instantly</span>` : ''}</h3><div class="fields">${outFields}</div></section>
    </div>`;
    host.dataset.for = isItem ? target.id : 'defaults';
    host._target = target;
    host._scope = scope;
    void changed;
  }
  function onOptionChange(host, grp, k, v, rerender) {
    const target = host._target;
    const obj = grp === 'eng' ? target.eng : target.out;
    const old = obj[k];
    obj[k] = v;
    if (old === v && !rerender) return;
    if (host._scope === 'item') {
      if (grp === 'out') { updateRoll(target, false); renderStats(target); }
      updateOptsSummary(target);
    } else renderHome();
    if (rerender) {
      const ae = document.activeElement;
      const restore = ae && host.contains(ae) ? (ae.id ? '#' + ae.id.replace(/^o\d+/, '') : `[data-grp="${grp}"][data-k="${k}"][data-v="${ae.dataset && ae.dataset.v}"]`) : null;
      const openSub = host.querySelector('details[data-sub]');
      const subOpen = openSub ? openSub.open : true;
      renderOptions(host, target, host._scope);
      const sub = host.querySelector('details[data-sub]');
      if (sub) sub.open = subOpen;
      if (restore) {
        let el = null;
        if (restore[0] === '#') el = host.querySelector(`[id$="${restore.slice(1)}"]`);
        else el = host.querySelector(restore);
        if (el) el.focus();
      }
    }
  }
  function bindOptions(host) {
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-grp]');
      if (!b || !host.contains(b)) return;
      const grp = b.dataset.grp, k = b.dataset.k;
      const obj = grp === 'eng' ? host._target.eng : host._target.out;
      if (b.dataset.step) {
        const op = OUT.find((x) => x.key === k);
        const v = clamp(Number(obj[k]) + Number(b.dataset.step), op.min, op.max);
        onOptionChange(host, grp, k, v, false);
        const inp = b.parentElement.querySelector('input');
        if (inp) inp.value = v;
        return;
      }
      if (b.getAttribute('role') === 'switch') { onOptionChange(host, grp, k, !obj[k], true); return; }
      onOptionChange(host, grp, k, b.dataset.v, true);
    });
    host.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t.dataset || !t.dataset.grp) return;
      if (t.tagName === 'SELECT') onOptionChange(host, t.dataset.grp, t.dataset.k, t.value, true);
      else if (t.type === 'number') {
        const op = OUT.find((x) => x.key === t.dataset.k);
        const v = clamp(Math.round(Number(t.value) || op.default), op.min, op.max);
        t.value = v;
        onOptionChange(host, t.dataset.grp, t.dataset.k, v, false);
      }
    });
    host.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.type !== 'range') return;
      const v = Number(t.value);
      t.style.setProperty('--fill', (v / Number(t.max)) * 100 + '%');
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = v ? v + ' ms' : 'Keep all';
      onOptionChange(host, t.dataset.grp, t.dataset.k, v, false);
    });
    host.addEventListener('keydown', (ev) => {
      // arrow keys inside radio groups
      const b = ev.target.closest('[role="radio"]');
      if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
      const group = Array.from(b.parentElement.querySelectorAll('[role="radio"]:not([disabled])'));
      const i = group.indexOf(b);
      const next = group[(i + (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? group.length - 1 : 1)) % group.length];
      ev.preventDefault();
      next.click();
      const again = host.querySelector(`[role="radio"][data-k="${next.dataset.k}"][data-v="${next.dataset.v}"]`);
      if (again) again.focus();
    });
  }

  /* ------------------------------------------------------------------ actions */
  function select1(id, opts) {
    S.sel = new Set([id]);
    S.anchor = id;
    S.cursor = id;
    if (opts && opts.view) S.view = 'library';
    render();
  }
  function goLibrary(nav) {
    S.view = 'library';
    if (nav) S.nav = nav;
    render();
  }
  function goHome() {
    S.view = 'home';
    S.sel.clear();
    S.focus = false;
    S.optsOpen = false;
    render();
  }

  // The graphics card converts one file at a time (like the real backend's single GPU worker).
  // A file you add and open yourself goes first: whatever was converting pauses, keeps its
  // finished windows and continues right after.
  function runNow(it, durMs) {
    const paused = [];
    items.forEach((x) => {
      if (x === it || x.status !== 'running') return;
      x.sim = null; x.status = 'queued'; x.paused = Math.max(0.01, x.progress || 0); x.qrank = 0;
      paused.push(x);
    });
    it.status = 'running'; it.progress = 0;
    delete it.paused; delete it.qrank;
    it.sim = { dur: durMs, start: performance.now(), from: 0 };
    return paused;
  }
  const shortName = (it) => title(it).split(' - ')[0];

  // the demo "drop": the Schubert recording comes in and converts
  function demoDrop() {
    const it = byId(SCHUBERT) || restoreSchubert();
    it.when = 'Just now';
    it.ts = 1112.1445;
    it.eng = JSON.parse(JSON.stringify(S.defaults.eng));
    it.out = JSON.parse(JSON.stringify(S.defaults.out));
    it.usedEng = JSON.parse(JSON.stringify(it.eng));
    const paused = runNow(it, 3000);
    S.view = 'library';
    S.nav = 'all';
    S.sort = { key: 'added', dir: -1 };
    S.q = ''; $('#search').value = '';
    S.focus = false; S.optsOpen = false;
    select1(it.id);
    toast({ icon: 'add-file', text: `<b>${esc(title(it))}</b> added`, sub: paused.length ? `Converting now · ${shortName(paused[0])} is paused and continues next` : 'Converting now · ready in a few seconds' });
  }
  function restoreSchubert() {
    const it = Object.assign({}, M.recent[0], META[SCHUBERT]);
    it.fav = false; it.coll = ['recital']; it.eng = defEng('ensemble'); it.out = defOut(); it.etaTotal = 26;
    items.unshift(it);
    return it;
  }
  const FAKE_NAMES = ['Schumann - Träumerei.mp3', 'Brahms - Intermezzo Op. 118 No. 2.flac', 'Lesson 4 - scales and arpeggios.m4a'];
  function addFiles(files) {
    const now = 1112.15;
    const added = files.map((f, k) => {
      const name = f.name;
      const sizeMb = f.size ? f.size / 1048576 : 6 + k * 3;
      const it = {
        id: (hashStr(name + Date.now() + k) >>> 0).toString(16).padStart(12, '0').slice(0, 12),
        filename: name, status: 'queued', duration: Math.round(90 + (hashStr(name) % 240)), when: 'Just now', ts: now + k * 0.0001,
        hue: hashStr(name) % 360, format: `${ext(name)} · added from your PC`, size: sizeMb >= 1024 ? (sizeMb / 1024).toFixed(1) + ' GB' : sizeMb.toFixed(1) + ' MB',
        engine: S.defaults.eng.engine, fav: false, coll: [], eng: JSON.parse(JSON.stringify(S.defaults.eng)), out: JSON.parse(JSON.stringify(S.defaults.out)), simulate: true,
      };
      it.etaTotal = 4;
      it.notes = Math.round(it.duration * 9.4);
      return it;
    });
    items = added.concat(items);
    S.view = 'library';
    if (S.nav === 'add') S.nav = 'all';
    toast({ icon: 'add-file', text: `<b>${added.length} ${added.length === 1 ? 'file' : 'files'}</b> added to the queue`, sub: added.map((a) => title(a)).join(', ') });
    render();
    pump();
  }
  // start (or continue) the next job; jobs are sped up to a few seconds each for the prototype
  function simulate(it) {
    const from = it.status === 'running' ? (it.progress || 0) : (it.paused || 0);
    const left = Math.min(it.etaTotal * (1 - from), 6);
    it.status = 'running'; it.progress = from;
    delete it.paused; delete it.qrank;
    it.sim = { dur: Math.max(1200, left * 1000), start: performance.now(), from };
  }
  function pump() {
    const running = items.find((i) => i.status === 'running');
    if (running) { if (!running.sim) simulate(running); return; }
    const next = items.filter((i) => i.status === 'queued').sort((a, b) => qRank(a) - qRank(b))[0];
    if (!next) return;
    simulate(next);
    render();
  }
  function finish(it) {
    it.sim = null;
    const isOpen = openItem() === it;
    if (it.failWith) {
      it.status = 'error';
      it.error = it.failWith;
      delete it.failWith;
      toast({ icon: 'alert', text: `<b>${esc(title(it))}</b> failed again`, sub: it.error, bad: true });
      render(); pump(); return;
    }
    it.status = 'done';
    it.progress = 1;
    it.engine = it.eng.engine;
    it.usedEng = JSON.parse(JSON.stringify(it.eng));
    if (it.id === SCHUBERT) { it.notes = M.job.stats.notes; it.secs = M.job.stats.seconds_total; it.pedals = M.job.stats.pedals; it.soft = 2; it.aria = 9; it.conf = M.job.stats.mean_confidence; }
    else {
      dataCache.delete(it.id);
      it.notes = it.notes || Math.round(it.duration * 9.4);
      it.secs = it.secs || +(it.duration * 0.19 * (it.engine === 'transkun' ? 0.27 : 1)).toFixed(1);
      it.pedals = it.pedals || Math.round(it.duration * 0.7);
      it.soft = it.soft || 0;
      it.aria = it.engine === 'ensemble' ? Math.round(it.duration / 9) : 0;
      it.conf = it.conf || 0.995;
    }
    if (isOpen) { rollKey = ''; shown.kind = null; } // a file finishing in the background leaves the open roll alone
    render();
    toast({ icon: 'check', text: `<b>${esc(title(it))}</b> is ready`, sub: `${fmtInt(it.notes)} notes · converted in ${it.secs.toFixed(1)} s`, action: { label: 'Save MIDI', fn: () => saveItems([it]) } });
    pump();
  }
  function cancel(it) {
    it.sim = null;
    it.status = 'cancelled';
    it.progress = 0;
    render();
    toast({ icon: 'stop', text: 'Conversion cancelled', sub: title(it) });
    pump();
  }
  function requeue(list, eng) {
    let n = 0;
    list.forEach((it) => {
      if (it.status === 'running') return;
      if (it.error === 'This file is larger than 2 GB.') return;
      if (eng) it.eng = JSON.parse(JSON.stringify(eng));
      if (it.error === 'The audio track is empty.') it.failWith = it.error;
      it.status = 'queued'; it.simulate = true; it.progress = 0; delete it.error; delete it.paused;
      it.qrank = 1112.16 + n * 0.0001; // to the end of the queue, in the order selected
      n++;
    });
    render();
    pump();
    return n;
  }
  function saveItems(list) {
    const ready = list.filter((i) => i.status === 'done');
    const skipped = list.length - ready.length;
    if (!ready.length) { toast({ icon: 'alert', text: 'Nothing to save yet', sub: 'Only finished conversions can be saved.', bad: true }); return; }
    toast({
      icon: 'check',
      text: ready.length === 1 ? `Saved <b>${esc(midiName(ready[0]))}</b>` : `Saved <b>${ready.length} MIDI files</b>`,
      sub: `Music › MIDI Converter${skipped ? ` · ${skipped} not ready, skipped` : ''}`,
      action: { label: 'Show in folder', fn: () => toast({ icon: 'folder-open', text: 'Opening the folder in File Explorer…' }) },
    });
  }
  function removeItems(list) {
    const snapshot = items.slice();
    const ids = new Set(list.map((i) => i.id));
    list.forEach((i) => { i.sim = null; });
    items = items.filter((i) => !ids.has(i.id));
    ids.forEach((id) => S.sel.delete(id));
    render();
    pump();
    toast({
      icon: 'trash',
      text: list.length === 1 ? `Removed <b>${esc(title(list[0]))}</b>` : `Removed <b>${list.length} conversions</b>`,
      sub: 'Your original recordings were not touched.',
      action: { label: 'Undo', fn: () => { items = snapshot; render(); } },
    });
  }

  /* ------------------------------------------------------------------ simulation + animation loop */
  // tick() runs every animation frame; a slow timer keeps conversions moving when frames are
  // throttled (window in the background), like the real queue would.
  let lastFrame = performance.now();
  let lastLive = 0;
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    // simulated jobs
    let finished = null, any = false;
    for (const it of items) {
      if (!it.sim) continue;
      any = true;
      const p = it.sim.from + (1 - it.sim.from) * clamp((now - it.sim.start) / it.sim.dur, 0, 1);
      it.progress = p;
      if (p >= 1 && !finished) finished = it;
    }
    if (finished) finish(finished);
    else if (any && now - lastLive > 90) { lastLive = now; refreshLive(); }
    // playback
    if (S.playing) {
      const it = openItem();
      if (!it || it.status !== 'done') stopPlay();
      else {
        S.time += dt;
        if (S.time >= it.duration) { S.time = it.duration; stopPlay(); }
        roll.setTime(S.time, S.playing);
        updateTime();
      }
    }
    // live preview sweep
    const open = openItem();
    if (open && open.status === 'running' && !views.progress.hidden && now - lastLive > 40 && !any) drawLive(open);
    drawOverview();
  }
  function frame() { tick(); requestAnimationFrame(frame); }
  setInterval(() => { if (performance.now() - lastFrame > 120) tick(); }, 100);
  function refreshLive() {
    renderQueue();
    renderGpu();
    for (const it of items) {
      if (it.status !== 'running') continue;
      const shelf = S.view === 'home' && $(`#recentList [data-open="${it.id}"]`);
      if (shelf) {
        const c = shelf.querySelector('.shelf-chip');
        if (c) c.innerHTML = chip(it);
        shelf.querySelector('.s1').textContent = shelfLine(it);
        const cv = shelf.querySelector('canvas[data-cover]');
        if (cv) drawCover(cv, it, cv.clientWidth || 140);
      }
      const row = libBody.querySelector(`[data-id="${it.id}"]`);
      if (row) {
        const st = row.querySelector('.c-status, .card-status');
        if (st) st.innerHTML = chip(it);
        const m = row.querySelector('.meta2');
        if (m) m.textContent = meta2(it);
        const cv = row.querySelector('canvas[data-cover]');
        if (cv) drawCover(cv, it, cv.clientWidth || 44);
      }
    }
    const open = openItem();
    if (open && open.status === 'running') renderProgress(open);
  }
  function togglePlay() {
    const it = openItem();
    if (!it || it.status !== 'done') return;
    S.playing = !S.playing;
    if (S.playing && S.time >= it.duration - 0.05) S.time = 0;
    $('#play').classList.toggle('playing', S.playing);
    $('#play').setAttribute('aria-label', S.playing ? 'Pause (Space)' : 'Play (Space)');
    if (roll) roll.setTime(S.time, S.playing);
  }
  function stopPlay() {
    S.playing = false;
    const b = $('#play');
    b.classList.remove('playing');
    b.setAttribute('aria-label', 'Play (Space)');
  }

  /* ------------------------------------------------------------------ toasts + menus */
  function toast({ icon, text, sub, action, bad }) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${I(icon || 'check')}<span class="t-text">${text}${sub ? `<span class="t-sub">${esc(sub)}</span>` : ''}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    if (bad) el.querySelector('i').style.color = '#ff9b8f';
    const host = $('#toasts');
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    let timer = setTimeout(close, action ? 6000 : 3800);
    function close() { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 220); }
    if (action) el.querySelector('button').addEventListener('click', () => { close(); action.fn(); });
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2500); });
  }
  const menu = $('#menu');
  let menuAnchor = null;
  function openMenu(anchor, title, entries) {
    menuAnchor = anchor;
    menu.innerHTML = (title ? `<div class="menu-h">${esc(title)}</div>` : '') + entries.map((e, k) => `<button role="menuitemradio" aria-checked="${!!e.on}" data-k="${k}">${I('check')}${esc(e.label)}</button>`).join('');
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = clamp(r.right - mw, 8, innerWidth - mw - 8) + 'px';
    menu.style.top = (r.bottom + 6 + mh > innerHeight ? r.top - mh - 6 : r.bottom + 6) + 'px';
    menu._entries = entries;
    const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
    if (first) first.focus();
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && menuAnchor && document.contains(menuAnchor)) menuAnchor.focus();
  }
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-k]');
    if (!b) return;
    const e = menu._entries[Number(b.dataset.k)];
    closeMenu(false);
    e.fn();
  });
  menu.addEventListener('keydown', (ev) => {
    const bs = $$('button', menu);
    const i = bs.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); closeMenu(true); }
  });
  document.addEventListener('pointerdown', (ev) => { if (!menu.hidden && !menu.contains(ev.target) && ev.target.closest('[aria-haspopup]') !== menuAnchor) closeMenu(false); });

  function sortMenu(anchor) {
    const keys = [['added', 'Date added'], ['name', 'Name'], ['length', 'Length'], ['notes', 'Notes'], ['status', 'Status'], ['engine', 'Engine']];
    openMenu(anchor, 'Sort by', keys.map(([k, l]) => ({ label: l, on: S.sort.key === k, fn: () => { S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' || k === 'engine' || k === 'status' ? 1 : -1) }; render(); } })));
  }
  function collectMenu(anchor, list) {
    openMenu(anchor, 'Add to collection', Object.keys(COLLECTIONS).map((k) => ({
      label: COLLECTIONS[k], on: false,
      fn: () => { list.forEach((i) => { if (i.coll.indexOf(k) < 0) i.coll.push(k); }); render(); toast({ icon: 'folder-plus', text: `Added ${list.length} to <b>${esc(COLLECTIONS[k])}</b>` }); },
    })));
  }

  /* ------------------------------------------------------------------ drawer (defaults) */
  const drawer = $('#drawer'), scrim = $('#scrim');
  let drawerReturn = null;
  function openDrawer() {
    drawerReturn = document.activeElement;
    renderOptions($('#drawerHost'), S.defaults, 'defaults');
    scrim.hidden = false;
    drawer.removeAttribute('inert');
    drawer.setAttribute('aria-hidden', 'false');
    void drawer.offsetWidth;
    drawer.classList.add('open');
    setTimeout(() => $('#drawerClose').focus(), 60);
  }
  function closeDrawer() {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('inert', '');
    scrim.hidden = true;
    if (drawerReturn && document.contains(drawerReturn)) drawerReturn.focus();
  }

  /* ------------------------------------------------------------------ events */
  hydrateIcons();
  bindOptions($('#optHost'));
  bindOptions($('#drawerHost'));

  $('#brand').addEventListener('click', (e) => { e.preventDefault(); goHome(); });
  $('#newFile').addEventListener('click', demoDrop);
  $('#dropzone').addEventListener('click', (e) => { if (!e.target.closest('button')) demoDrop(); });
  $('#chooseFiles').addEventListener('click', demoDrop);
  $('#chooseFolder').addEventListener('click', () => addFiles(FAKE_NAMES.map((name) => ({ name }))));
  $('#openDefaults').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('#drawerReset').addEventListener('click', () => {
    S.defaults = { eng: defEng(), out: defOut() };
    renderOptions($('#drawerHost'), S.defaults, 'defaults');
    renderHome();
    toast({ icon: 'reset', text: 'Options reset', sub: 'New conversions use the recommended settings.' });
  });
  $('#showAll').addEventListener('click', () => { S.sel.clear(); goLibrary('all'); });
  $('#recentList').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) { S.nav = 'all'; select1(b.dataset.open, { view: true }); } });

  $('#sidebar').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item[data-nav]');
    if (b) {
      if (b.dataset.nav === 'add') { goHome(); return; }
      S.nav = b.dataset.nav;
      S.view = 'library';
      S.sel.clear();
      render();
      return;
    }
    const q = e.target.closest('.q-item[data-open]');
    if (q) { S.nav = S.nav === 'add' ? 'all' : S.nav; if (!navMatch(byId(q.dataset.open), S.nav)) S.nav = 'all'; select1(q.dataset.open, { view: true }); }
  });
  $('#qList').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.q-item')) { e.preventDefault(); e.target.click(); } });
  $('#qHead').addEventListener('click', () => {
    if (matchMedia('(max-width: 1099px)').matches) { S.nav = 'running'; S.view = 'library'; S.sel.clear(); render(); return; }
    S.queueOpen = !S.queueOpen; renderQueue();
  });
  $('#newCollection').addEventListener('click', () => toast({ icon: 'folder-plus', text: 'New collection', sub: 'Collections are part of this design proposal.' }));
  $('#cleanUp').addEventListener('click', () => toast({ icon: 'trash', text: 'Clean up', sub: 'Would remove audio copies older than 30 days (about 900 MB).' }));

  let searchT = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      S.q = e.target.value.trim();
      if (S.q && S.view === 'home') { S.view = 'library'; S.nav = 'all'; }
      S.sel.clear();
      render();
    }, 120);
  });

  // library header (sort, view, batch)
  $('#libHead').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.display) { S.display = b.dataset.display; render(); return; }
    const sel = items.filter((i) => S.sel.has(i.id));
    switch (b.dataset.act) {
      case 'sort-menu': sortMenu(b); break;
      case 'save-sel': saveItems(sel); break;
      case 'reconvert-sel': { const n = requeue(sel, S.defaults.eng); toast({ icon: 'refresh', text: `<b>${n} ${n === 1 ? 'file' : 'files'}</b> queued again`, sub: `${ENGINE_SHORT[S.defaults.eng.engine]} · ${VIEWS_SHORT[S.defaults.eng.views]}` }); break; }
      case 'collect-sel': collectMenu(b, sel); break;
      case 'remove-sel': removeItems(sel); break;
      case 'clear-sel': S.sel.clear(); render(); break;
      case 'unfocus': if (S.focus) { S.focus = false; render(); } else closeDetail(); break;
    }
  });
  $('#libHead').addEventListener('change', (e) => { if (e.target.id === 'selAll2') toggleAll(e.target.checked); });
  $('#libCols').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' || k === 'engine' || k === 'status' ? 1 : -1) };
    render();
  });
  $('#libCols').addEventListener('change', (e) => { if (e.target.id === 'selAll') toggleAll(e.target.checked); });
  function toggleAll(on) {
    const arr = visible();
    if (on) arr.forEach((i) => S.sel.add(i.id)); else S.sel.clear();
    render();
  }

  // rows
  libBody.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'clear-search') { S.q = ''; $('#search').value = ''; render(); }
      if (act.dataset.act === 'go-all') { S.nav = 'all'; render(); }
      return;
    }
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    S.cursor = id;
    if (e.target.closest('[data-fav]')) { const it = byId(id); it.fav = !it.fav; render(); return; }
    if (e.target.matches('.check')) {
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.anchor = id;
      render();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.anchor = id;
    } else if (e.shiftKey && S.anchor) {
      const arr = visible().map((i) => i.id);
      const a = arr.indexOf(S.anchor), b = arr.indexOf(id);
      if (a >= 0 && b >= 0) { S.sel = new Set(arr.slice(Math.min(a, b), Math.max(a, b) + 1)); }
    } else {
      S.sel = new Set([id]);
      S.anchor = id;
    }
    render();
    const r = libBody.querySelector(`[data-id="${id}"]`);
    if (r) r.focus({ preventScroll: true });
  });
  libBody.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const arr = visible();
    const i = arr.findIndex((x) => x.id === row.dataset.id);
    const grid = S.display === 'grid';
    let cols = 1;
    if (grid) { const first = libBody.children[0]; cols = Math.max(1, Math.round(libBody.clientWidth / (first ? first.offsetWidth + 16 : 180))); }
    let to = -1;
    if (e.key === 'ArrowDown') to = i + cols;
    else if (e.key === 'ArrowUp') to = i - cols;
    else if (e.key === 'ArrowRight' && grid) to = i + 1;
    else if (e.key === 'ArrowLeft' && grid) to = i - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = arr.length - 1;
    if (to >= 0 || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      to = clamp(to, 0, arr.length - 1);
      const id = arr[to].id;
      S.cursor = id;
      if (e.shiftKey && S.anchor) {
        const ids = arr.map((x) => x.id), a = ids.indexOf(S.anchor);
        S.sel = new Set(ids.slice(Math.min(a, to), Math.max(a, to) + 1));
      } else { S.sel = new Set([id]); S.anchor = id; }
      render();
      const r = libBody.querySelector(`[data-id="${id}"]`);
      if (r) { r.focus(); r.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      const id = row.dataset.id;
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.anchor = id;
      render();
      const r = libBody.querySelector(`[data-id="${id}"]`);
      if (r) r.focus();
    } else if (e.key === 'Enter') {
      select1(row.dataset.id);
      const it = byId(row.dataset.id);
      setTimeout(() => { const t = it.status === 'done' ? $('#saveMidi') : null; if (t) t.focus(); }, 0);
    } else if (e.key === 'Delete') {
      const sel = items.filter((x) => S.sel.has(x.id));
      if (sel.length) removeItems(sel);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      toggleAll(true);
    }
  });

  // detail
  $('#dClose').addEventListener('click', closeDetail);
  $('#pClose').addEventListener('click', closeDetail);
  $('#sClose').addEventListener('click', closeDetail);
  function closeDetail() {
    const id = S.cursor;
    S.sel.clear(); S.focus = false; S.optsOpen = false;
    render();
    const r = libBody.querySelector(`[data-id="${id}"]`);
    if (r) r.focus();
  }
  $('#dFav').addEventListener('click', () => { const it = openItem(); if (it) { it.fav = !it.fav; render(); } });
  $('#dExpand').addEventListener('click', () => { S.focus = !S.focus; render(); });
  $('#saveMidi').addEventListener('click', () => { const it = openItem(); if (it) saveItems([it]); });
  $('#showFolder').addEventListener('click', () => toast({ icon: 'folder-open', text: 'Opening the folder in File Explorer…', sub: 'Music › MIDI Converter' }));
  function setOpts(open) {
    if (open === S.optsOpen) return;
    S.optsOpen = open;
    if (open) { S.focusBeforeOpts = S.focus; if (innerWidth >= 1000) S.focus = true; }
    else S.focus = S.focusBeforeOpts;
    render();
    if (open) setTimeout(() => { const f = $('#optHost .eng[aria-checked="true"]'); if (f) f.focus({ preventScroll: true }); }, 0);
  }
  $('#optToggle').addEventListener('click', () => setOpts(!S.optsOpen));
  $('#optsBar').addEventListener('click', () => setOpts(true));
  $('#optsClose').addEventListener('click', () => { setOpts(false); $('#optToggle').focus(); });
  $('#optsReset').addEventListener('click', () => {
    const it = openItem();
    if (!it) return;
    it.out = defOut();
    it.eng = JSON.parse(JSON.stringify(it.usedEng || defEng(it.engine)));
    renderOptions($('#optHost'), it, 'item');
    updateRoll(it, false); renderStats(it); updateOptsSummary(it);
    toast({ icon: 'reset', text: 'Options reset', sub: 'MIDI-file options are back to the defaults.' });
  });
  $('#optHost').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="reconvert-one"]');
    if (!b) return;
    const it = openItem();
    if (!it) return;
    const paused = runNow(it, 3000);
    S.optsOpen = false; S.focus = S.focusBeforeOpts;
    render();
    toast({ icon: 'refresh', text: `Converting <b>${esc(title(it))}</b> again`, sub: `${ENGINE_SHORT[it.eng.engine]}${it.eng.engine !== 'aria' ? ' · ' + VIEWS_SHORT[it.eng.views] : ''}${paused.length ? ` · ${shortName(paused[0])} continues next` : ''}` });
  });
  $('#play').addEventListener('click', togglePlay);
  $('#mixSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-mix]'); if (b) { S.mix = b.dataset.mix; updateMix(); } });
  $('#mixSeg').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const order = ['original', 'both', 'midi'];
    S.mix = order[(order.indexOf(S.mix) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    updateMix();
    $(`#mixSeg [data-mix="${S.mix}"]`).focus();
    e.preventDefault();
  });
  $('#zoomIn').addEventListener('click', () => roll && roll.zoom(1.4));
  $('#zoomOut').addEventListener('click', () => roll && roll.zoom(1 / 1.4));
  (function bindOverview() {
    const cv = $('#overview');
    let drag = false;
    const seek = (e) => {
      const it = openItem();
      if (!it || !roll) return;
      const r = cv.getBoundingClientRect();
      const t = clamp(((e.clientX - r.left - 8) / (r.width - 16)) * it.duration, 0, it.duration);
      S.time = t;
      const viewSec = roll._viewW() / roll.pxPerSec;
      roll.scrollX = roll._clampScroll(t - viewSec / 2);
      roll.userScrolledAt = performance.now();
      roll.setTime(t, S.playing);
      updateTime();
    };
    cv.addEventListener('pointerdown', (e) => { drag = true; cv.setPointerCapture(e.pointerId); seek(e); });
    cv.addEventListener('pointermove', (e) => { if (drag) seek(e); });
    cv.addEventListener('pointerup', () => { drag = false; });
  })();
  $('#pgCancel').addEventListener('click', () => { const it = openItem(); if (it) cancel(it); });
  $('#dState').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const it = byId(b.dataset.id) || openItem();
    switch (b.dataset.act) {
      case 'convert-next': {
        it.simulate = true; it.qrank = Math.min(-1, ...items.map((x) => (x.qrank != null ? x.qrank : 0))) - 1; // ahead of everything waiting
        render();
        pump();
        toast({ icon: 'next', text: `<b>${esc(title(it))}</b> is next`, sub: 'It starts as soon as the graphics card is free.' });
        break;
      }
      case 'retry': requeue([it]); toast({ icon: 'refresh', text: `Trying <b>${esc(title(it))}</b> again` }); break;
      case 'remove-one': removeItems([it]); break;
      case 'show-file': toast({ icon: 'folder-open', text: 'Opening the file location…', sub: it.filename }); break;
    }
  });

  // global keys
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); demoDrop(); return; }
    if (e.key === 'Escape') {
      if (!menu.hidden) { closeMenu(true); return; }
      if (drawer.classList.contains('open')) { closeDrawer(); return; }
      if (typing && e.target.id === 'search' && S.q) return;
      if (S.optsOpen) { setOpts(false); return; }
      if (S.sel.size) { closeDetail(); return; }
    }
    if (e.key === ' ' && !typing && !e.target.closest('button, [role="row"], summary, a') && !views.result.hidden) { e.preventDefault(); togglePlay(); }
  });

  // real drag and drop of files onto the window
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; $('#dropzone').classList.add('over'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $('#dropOverlay').hidden = true; $('#dropzone').classList.remove('over'); } });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    $('#dropzone').classList.remove('over');
    const files = Array.from(e.dataTransfer.files || []).map((f) => ({ name: f.name, size: f.size }));
    if (files.length) addFiles(files);
  });

  window.addEventListener('resize', () => { lastOv = ''; requestAnimationFrame(() => drawCovers(S.view === 'library' ? libBody : $('#recentList'))); });

  /* ------------------------------------------------------------------ initial state from the URL */
  const STATES = ['home', 'progress', 'result', 'advanced', 'library', 'grid', 'empty'];
  const state = STATES.indexOf(params.get('state')) >= 0 ? params.get('state') : 'home';
  const sch = byId(SCHUBERT);
  if (sch) sch.usedEng = defEng('ensemble');
  items.forEach((it) => { if (!it.usedEng) it.usedEng = defEng(it.engine); });
  if (state === 'progress') {
    sch.status = 'running'; sch.progress = M.progress.progress; sch.when = 'Just now'; sch.ts = 1112.1445; sch.etaTotal = 26;
    // one file at a time: the Chopin job that was converting waits, paused, until Schubert is done
    items.forEach((it) => { if (it !== sch && it.status === 'running') { it.status = 'queued'; it.paused = it.progress; it.qrank = 0; } });
    S.view = 'library'; S.nav = 'all'; S.sel = new Set([SCHUBERT]); S.cursor = SCHUBERT;
  } else if (state === 'result' || state === 'advanced') {
    S.view = 'library'; S.nav = 'all'; S.sel = new Set([SCHUBERT]); S.cursor = SCHUBERT;
    if (state === 'advanced') { S.optsOpen = true; S.focus = innerWidth >= 1000; }
  } else if (state === 'library') {
    S.view = 'library'; S.nav = 'all';
    S.sel = new Set(['9b7d5f3e1a2c', '7f1e3d5c7b9a', 'b7c8d9e0f1a2']); S.cursor = '9b7d5f3e1a2c'; S.anchor = '9b7d5f3e1a2c';
  } else if (state === 'grid') {
    S.view = 'library'; S.nav = 'all'; S.display = 'grid';
  } else if (state === 'empty') {
    items = [];
  }
  $('#pgLogBox').open = innerHeight > 760;

  // reviewer state switcher
  if (params.get('clean') !== '1') {
    document.body.classList.add('has-switcher');
    const sw = $('#switcher');
    const link = (s) => { const p = new URLSearchParams(location.search); p.set('state', s); return `?${p.toString()}`; };
    sw.innerHTML = `<button class="sw-cur" type="button" title="Prototype states">State: <b>${state}</b></button><span class="sw-links">`
      + STATES.map((s, k) => `${k === 4 ? '<span class="sw-sep"></span>' : ''}<a href="${link(s)}"${s === state ? ' aria-current="true"' : ''}>${s}</a>`).join('') + '</span>';
  } else $('#switcher').remove();

  render();
  if (params.get('open') === 'drawer') openDrawer();
  requestAnimationFrame(frame);
})();
