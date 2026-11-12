// Canvas piano roll: notes (opacity = velocity), pedal-sustained tails, sustain pedal lane, playhead.
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
export const noteName = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1);
const isBlack = (p) => BLACK.has(p % 12);

export function fmtTime(t, showTenths = false) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return showTenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

export class PianoRoll {
  constructor(el, { onSeek } = {}) {
    this.el = el;
    this.onSeek = onSeek || (() => {});
    this.keys = document.createElement('canvas');
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    el.append(this.keys, this.canvas, this.tip);
    this.keyW = 56;
    this.axisH = 24;
    this.pedalH = 20;
    this.pxPerSec = 90;
    this.scrollX = 0;
    this.time = 0;
    this.playing = false;
    this.userScrolledAt = 0;
    this.notes = [];
    this.pedals = [];
    this.duration = 0;
    this.lo = 48;
    this.hi = 84;
    this.hover = null;
    this._raf = 0;
    this._readColors();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this._readColors(); this.requestDraw(); });
    new ResizeObserver(() => this._resize()).observe(el);
    this._bind();
  }

  setData({ notes, pedals, duration }, { keepView = false } = {}) {
    // notes: [start, end, pitch, velocity, soundingEnd, confidence]
    this.notes = [...notes].sort((a, b) => a[0] - b[0]);
    this.pedals = pedals || [];
    this.duration = Math.max(duration || 0, ...this.notes.map((n) => n[4] || n[1]), 1);
    this.maxSpan = this.notes.reduce((m, n) => Math.max(m, (n[4] || n[1]) - n[0]), 0);
    if (this.notes.length) {
      let lo = 127, hi = 0;
      for (const n of this.notes) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); }
      lo = Math.max(21, lo - 2); hi = Math.min(108, hi + 2);
      while (hi - lo < 30) { if (lo > 21) lo--; if (hi - lo < 30 && hi < 108) hi++; if (lo === 21 && hi === 108) break; }
      this.lo = lo; this.hi = hi;
    }
    if (!keepView) {
      const viewW = Math.max(200, this.el.clientWidth - this.keyW);
      this.pxPerSec = Math.min(160, Math.max(viewW / Math.min(this.duration, 24), 20));
      this.scrollX = 0;
      this.time = 0;
    }
    this.hover = null;
    this._resize();
  }

  setTime(t, playing) {
    this.time = t;
    this.playing = playing;
    const viewSec = this._viewW() / this.pxPerSec;
    const recentlyScrolled = performance.now() - this.userScrolledAt < 2500;
    if (playing && !recentlyScrolled && (t > this.scrollX + viewSec * 0.85 || t < this.scrollX)) {
      this.scrollX = this._clampScroll(t - viewSec * 0.12);
    }
    this.requestDraw();
  }

  revealTime(t) {
    const viewSec = this._viewW() / this.pxPerSec;
    if (t < this.scrollX || t > this.scrollX + viewSec) this.scrollX = this._clampScroll(t - viewSec * 0.12);
    this.requestDraw();
  }

  zoom(factor, anchorPx = null) {
    const ax = anchorPx ?? this._viewW() / 2;
    const tAnchor = this.scrollX + ax / this.pxPerSec;
    this.pxPerSec = Math.min(1500, Math.max(6, this.pxPerSec * factor));
    this.scrollX = this._clampScroll(tAnchor - ax / this.pxPerSec);
    this.requestDraw();
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  // ------------------------------------------------------------------ internals
  _readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.c = {
      bg: v('--roll-bg'), black: v('--roll-black-row'), grid: v('--roll-grid'), octave: v('--roll-octave'),
      text: v('--roll-text'), keyW: v('--roll-key-white'), keyB: v('--roll-key-black'), keyLine: v('--roll-key-line'),
      note: v('--note'), tail: v('--note-tail'), pedal: v('--pedal'), playhead: v('--playhead'), ink: v('--ink'),
    };
  }

  _viewW() { return Math.max(1, this.el.clientWidth - this.keyW); }
  _noteH() { return Math.max(1, this.el.clientHeight - this.axisH - this.pedalH); }
  _rowH() { return this._noteH() / (this.hi - this.lo + 1); }
  _rowY(p) { return this.axisH + (this.hi - p) * this._rowH(); }
  _x(t) { return (t - this.scrollX) * this.pxPerSec; }
  _clampScroll(s) {
    const viewSec = this._viewW() / this.pxPerSec;
    return Math.max(0, Math.min(s, Math.max(0, this.duration - viewSec * 0.5)));
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const [cv, cw, left] of [[this.keys, this.keyW, 0], [this.canvas, w - this.keyW, this.keyW]]) {
      cv.style.left = left + 'px';
      cv.style.width = Math.max(1, cw) + 'px';
      cv.style.height = h + 'px';
      cv.width = Math.max(1, Math.round(cw * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
    }
    this.scrollX = this._clampScroll(this.scrollX);
    this._drawKeys();
    this.requestDraw();
  }

  _drawKeys() {
    const ctx = this.keys.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.keyW, h = this.el.clientHeight, rh = this._rowH();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.c.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = this.c.keyW;
    ctx.fillRect(0, this.axisH, w, this._noteH());
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this._rowY(p);
      if (isBlack(p)) {
        ctx.fillStyle = this.c.keyB;
        ctx.beginPath();
        ctx.roundRect(0, y + 0.5, w * 0.6, rh - 1, [0, 2, 2, 0]);
        ctx.fill();
      } else if (!isBlack(p + 1) && p < this.hi) {
        ctx.fillStyle = this.c.keyLine;  // boundary between adjacent white keys (B|C, E|F)
        ctx.fillRect(0, y - 0.5, w, 1);
      }
      if (p % 12 === 0 && rh >= 5) {
        ctx.fillStyle = this.c.text;
        ctx.font = `${Math.min(11, Math.max(8, rh))}px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(noteName(p), w - 6, y + rh / 2);
      }
    }
    ctx.fillStyle = this.c.keyLine;
    ctx.fillRect(w - 1, this.axisH, 1, this._noteH());
    // pedal lane label
    ctx.fillStyle = this.c.text;
    ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('Pedal', w - 6, h - this.pedalH / 2);
  }

  _draw() {
    const ctx = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this._viewW(), H = this.el.clientHeight, rh = this._rowH();
    const t0 = this.scrollX, t1 = this.scrollX + W / this.pxPerSec;
    const c = this.c;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);

    // rows
    for (let p = this.lo; p <= this.hi; p++) {
      const y = this._rowY(p);
      if (isBlack(p)) { ctx.fillStyle = c.black; ctx.fillRect(0, y, W, rh); }
      if (p % 12 === 0) { ctx.fillStyle = c.octave; ctx.fillRect(0, y + rh - 0.5, W, 1); }
    }

    // time grid
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * this.pxPerSec >= 72) || 600;
    ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(this._x(t)) + 0.5;
      ctx.fillStyle = c.grid;
      ctx.fillRect(x - 0.5, this.axisH, 1, H - this.axisH);
      ctx.fillStyle = c.text;
      ctx.fillText(step < 1 ? fmtTime(t, true) : fmtTime(t), x + 4, this.axisH / 2);
    }
    ctx.fillStyle = c.grid;
    ctx.fillRect(0, this.axisH - 1, W, 1);
    ctx.fillRect(0, H - this.pedalH, W, 1);

    // pedal lane (sustain full height, soft pedal as a thin bar)
    for (const [s, e, cc] of this.pedals) {
      if (e < t0 || s > t1) continue;
      const x0 = this._x(s), x1 = this._x(e);
      ctx.fillStyle = c.pedal;
      if (cc === 64) {
        ctx.beginPath();
        ctx.roundRect(x0, H - this.pedalH + 4, Math.max(2, x1 - x0), this.pedalH - 8, 3);
        ctx.fill();
      } else {
        ctx.fillRect(x0, H - 3, Math.max(2, x1 - x0), 2);
      }
    }

    // notes
    const notes = this.notes;
    let i = lowerBound(notes, t0 - this.maxSpan - 0.01);
    const h = Math.max(1, rh - (rh > 6 ? 1.5 : 0.5));
    const radius = Math.min(3, h / 2);
    for (; i < notes.length; i++) {
      const n = notes[i];
      const [s, e, p, v, snd] = n;
      if (s > t1) break;
      const sound = snd || e;
      if (sound < t0 || p < this.lo || p > this.hi) continue;
      const y = this._rowY(p) + (rh - h) / 2;
      const x0 = this._x(s), x1 = this._x(e), xs = this._x(sound);
      if (xs > x1 + 1) {
        ctx.fillStyle = c.tail;
        ctx.fillRect(x1, y + h * 0.2, xs - x1, h * 0.6);
      }
      ctx.globalAlpha = 0.28 + 0.72 * Math.min(1, v / 110);
      ctx.fillStyle = c.note;
      ctx.beginPath();
      ctx.roundRect(x0, y, Math.max(2, x1 - x0), h, radius);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (this.hover === n) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // playhead
    const px = this._x(this.time);
    if (px >= -2 && px <= W + 2) {
      ctx.fillStyle = c.playhead;
      ctx.fillRect(Math.round(px) - 0.75, 0, 1.5, H);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.closePath();
      ctx.fill();
    }
  }

  _hit(x, y) {
    const t = this.scrollX + x / this.pxPerSec;
    const p = this.hi - Math.floor((y - this.axisH) / this._rowH());
    if (y < this.axisH || p < this.lo || p > this.hi) return null;
    let i = lowerBound(this.notes, t - this.maxSpan - 0.01);
    let best = null;
    for (; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n[0] > t) break;
      if (n[2] === p && t <= (n[4] || n[1])) best = n;
    }
    return best;
  }

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        this.zoom(Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left);
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const px = e.deltaMode === 1 ? d * 30 : d;
        this.scrollX = this._clampScroll(this.scrollX + px / this.pxPerSec);
        this.userScrolledAt = performance.now();
        this.requestDraw();
      }
    }, { passive: false });

    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, scroll: this.scrollX, moved: false };
    });
    cv.addEventListener('pointermove', (e) => {
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) {
          this.scrollX = this._clampScroll(drag.scroll - dx / this.pxPerSec);
          this.userScrolledAt = performance.now();
          this.requestDraw();
          cv.style.cursor = 'grabbing';
          return;
        }
      }
      const n = this._hit(x, y);
      if (n !== this.hover) { this.hover = n; this.requestDraw(); }
      if (n) {
        const dur = n[1] - n[0];
        this.tip.textContent = `${noteName(n[2])}  ·  velocity ${n[3]}  ·  ${dur < 1 ? Math.round(dur * 1000) + ' ms' : dur.toFixed(2) + ' s'}`;
        this.tip.style.left = (x + this.keyW) + 'px';
        this.tip.style.top = y + 'px';
        this.tip.hidden = false;
        cv.style.cursor = 'pointer';
      } else {
        this.tip.hidden = true;
        cv.style.cursor = 'crosshair';
      }
    });
    const end = (e) => {
      if (drag && !drag.moved && e.type === 'pointerup') {
        const rect = cv.getBoundingClientRect();
        const t = this.scrollX + (e.clientX - rect.left) / this.pxPerSec;
        this.onSeek(Math.max(0, Math.min(this.duration, t)));
      }
      drag = null;
      cv.style.cursor = 'crosshair';
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.tip.hidden = true; if (this.hover) { this.hover = null; this.requestDraw(); } });
  }
}

function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid][0] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
