// Knobs, faders, buttons and the shared tooltip.

const SVGNS = 'http://www.w3.org/2000/svg';
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ARC = 270; // degrees of travel
const A0 = -135;

export function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

// ------------------------------------------------------------------ tooltip
let tipEl = null;
export function tooltip(text, anchor) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'status');
    document.body.appendChild(tipEl);
  }
  if (!text) {
    tipEl.classList.remove('show');
    return;
  }
  tipEl.textContent = text;
  const r = anchor.getBoundingClientRect();
  tipEl.classList.add('show');
  const tw = tipEl.offsetWidth;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
  let y = r.top - tipEl.offsetHeight - 8;
  if (y < 6) y = r.bottom + 8;
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

// Shared drag helper: vertical (and a little horizontal) movement adjusts.
function dragValue(el, getRaw, setRaw, { range = 220, onStart, onEnd } = {}) {
  let startY = 0, startX = 0, startV = 0, id = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    id = e.pointerId;
    el.setPointerCapture(id);
    startY = e.clientY;
    startX = e.clientX;
    startV = getRaw();
    el.classList.add('active');
    if (onStart) onStart();
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const fine = e.shiftKey ? 0.2 : 1;
    const d = ((startY - e.clientY) + (e.clientX - startX) * 0.35) / range;
    setRaw(clamp01(startV + d * fine));
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('active');
    if (onEnd) onEnd();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------- knob
export class Knob {
  // opts: { label, def, value, bipolar, steps, size, style ('dark'|'silver'|'cap'), fmt, onChange, title }
  constructor(opts) {
    this.o = opts;
    this.def = opts.def ?? 0;
    this.value = opts.value ?? this.def;
    this.raw = this.value;
    this.display = this.value;
    const size = opts.size || 28;
    const pad = 9;
    const S = size + pad * 2;
    this.el = document.createElement('div');
    this.el.className = `knob knob-${opts.style || 'dark'}${size >= 44 ? ' big' : ''}`;
    this.el.style.width = `${S}px`;
    this.el.style.height = `${S}px`;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', opts.title || opts.label || 'knob');
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
    const s = svg('svg', { viewBox: `0 0 ${S} ${S}`, width: S, height: S, 'aria-hidden': 'true' }, this.el);
    const c = S / 2;
    const ringR = size / 2 + 4.5;
    this.n = size >= 44 ? 17 : 11;
    this.dots = [];
    for (let i = 0; i < this.n; i++) {
      const a = ((A0 + (ARC * i) / (this.n - 1)) * Math.PI) / 180;
      this.dots.push(svg('circle', { cx: c + ringR * Math.sin(a), cy: c - ringR * Math.cos(a), r: size >= 44 ? 1.9 : 1.5, class: 'led' }, s));
    }
    const r = size / 2;
    svg('circle', { cx: c, cy: c + 1.5, r: r, class: 'k-shadow' }, s);
    svg('circle', { cx: c, cy: c, r: r, class: 'k-body' }, s);
    svg('circle', { cx: c, cy: c, r: r * 0.78, class: 'k-cap' }, s);
    this.ptr = svg('line', { x1: c, y1: c - r * 0.2, x2: c, y2: c - r * 0.92, class: 'k-ptr' }, s);
    this.c = c;
    this.render();

    dragValue(this.el, () => this.raw, (v) => this.userSet(v), {
      range: size >= 44 ? 240 : 200,
      onStart: () => this.showTip(),
      onEnd: () => tooltip(null),
    });
    this.el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.raw = this.def;
      this.userSet(this.def);
      this.showTip();
      setTimeout(() => tooltip(null), 700);
    });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const st = opts.steps ? 1 / (opts.steps - 1) : e.shiftKey ? 0.004 : 0.02;
      this.raw = clamp01(this.value + dir * st);
      this.userSet(this.raw);
      this.showTip();
      clearTimeout(this.tipT);
      this.tipT = setTimeout(() => tooltip(null), 700);
    }, { passive: false });
    this.el.addEventListener('keydown', (e) => {
      const st = opts.steps ? 1 / (opts.steps - 1) : e.shiftKey ? 0.002 : 0.01;
      let v = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = this.value + st;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = this.value - st;
      else if (e.key === 'PageUp') v = this.value + st * 10;
      else if (e.key === 'PageDown') v = this.value - st * 10;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 1;
      if (v === null) return;
      e.preventDefault();
      this.raw = clamp01(v);
      this.userSet(this.raw);
    });
    this.el.addEventListener('pointerenter', () => {
      if (!this.el.classList.contains('active')) this.showTip();
    });
    this.el.addEventListener('pointerleave', () => {
      if (!this.el.classList.contains('active')) tooltip(null);
    });
    this.el.addEventListener('focus', () => this.showTip());
    this.el.addEventListener('blur', () => tooltip(null));
  }

  snap(v) {
    const st = this.o.steps;
    return st ? Math.round(v * (st - 1)) / (st - 1) : v;
  }

  userSet(raw) {
    this.raw = raw;
    const v = this.snap(raw);
    if (v !== this.value) {
      this.value = v;
      this.display = v;
      this.render();
      if (this.o.onChange) this.o.onChange(v);
      this.showTip();
    }
  }

  showTip() {
    const t = `${this.o.title || this.o.label}: ${this.o.fmt ? this.o.fmt(this.value) : Math.round(this.value * 100) + '%'}`;
    tooltip(t, this.el);
  }

  // External value change (patch load, dice roll).
  set(v) {
    this.value = this.raw = this.display = clamp01(v);
    this.render();
  }

  // Modulated value from the engine (moves the LED ring, not the pointer).
  setDisplay(v) {
    if (Math.abs(v - this.display) < 0.004) return;
    this.display = v;
    this.renderRing();
  }

  renderRing() {
    const n = this.n;
    const d = this.display;
    if (this.o.bipolar) {
      const mid = (n - 1) / 2;
      const at = d * (n - 1);
      for (let i = 0; i < n; i++) {
        const lit = (i >= mid && i <= at + 0.5) || (i <= mid && i >= at - 0.5);
        this.dots[i].classList.toggle('on', lit);
      }
    } else {
      const at = d * (n - 1);
      for (let i = 0; i < n; i++) this.dots[i].classList.toggle('on', i <= at + 0.01);
    }
  }

  render() {
    const ang = A0 + ARC * this.value;
    this.ptr.setAttribute('transform', `rotate(${ang} ${this.c} ${this.c})`);
    this.el.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
    this.el.setAttribute('aria-valuetext', this.o.fmt ? this.o.fmt(this.value) : `${Math.round(this.value * 100)}%`);
    this.renderRing();
  }
}

// ------------------------------------------------------------------- fader
export class Fader {
  constructor({ label, def, value, h, fmt, onChange }) {
    this.def = def;
    this.value = value ?? def;
    this.fmt = fmt;
    this.label = label;
    this.onChange = onChange;
    this.h = h;
    this.el = document.createElement('div');
    this.el.className = 'fader';
    this.el.style.height = `${h}px`;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', label);
    this.el.innerHTML = '<div class="f-track"></div><div class="f-cap"></div>';
    this.cap = this.el.querySelector('.f-cap');
    this.render();
    dragValue(this.el, () => this.value, (v) => this.userSet(v), {
      range: h - 10,
      onStart: () => this.tip(),
      onEnd: () => tooltip(null),
    });
    this.el.addEventListener('dblclick', () => this.userSet(this.def));
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userSet(clamp01(this.value + (e.deltaY < 0 ? 0.02 : -0.02)));
      this.tip();
      clearTimeout(this.t);
      this.t = setTimeout(() => tooltip(null), 700);
    }, { passive: false });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') this.userSet(clamp01(this.value + 0.01));
      else if (e.key === 'ArrowDown') this.userSet(clamp01(this.value - 0.01));
      else return;
      e.preventDefault();
    });
    this.el.addEventListener('pointerenter', () => this.tip());
    this.el.addEventListener('pointerleave', () => {
      if (!this.el.classList.contains('active')) tooltip(null);
    });
  }
  tip() {
    tooltip(`${this.label}: ${this.fmt(this.value)}`, this.el);
  }
  userSet(v) {
    if (v === this.value) return;
    this.value = v;
    this.render();
    this.onChange(v);
    this.tip();
  }
  set(v) {
    this.value = clamp01(v);
    this.render();
  }
  render() {
    const travel = this.h - 14;
    this.cap.style.transform = `translateY(${Math.round((1 - this.value) * travel)}px)`;
    this.el.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
  }
}

// ------------------------------------------------------- vertical meter
// True dBFS: green below -25, amber to -10, red above.
export class Meter {
  constructor(h, segments = 14) {
    this.el = document.createElement('div');
    this.el.className = 'meter';
    this.el.style.height = `${h}px`;
    this.segs = [];
    for (let i = 0; i < segments; i++) {
      const s = document.createElement('i');
      const db = -48 + (48 * (i + 1)) / segments; // top segment = 0 dBFS
      s.className = db > -10 ? 'red' : db > -25 ? 'amber' : 'green';
      s.dataset.db = String(db);
      this.el.prepend(s);
      this.segs.push({ s, db });
    }
    this.level = -120;
  }
  set(peak) {
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    // fast attack, ~20 dB/s fall
    this.level = db > this.level ? db : Math.max(db, this.level - 0.7);
    for (const { s, db: d } of this.segs) s.classList.toggle('on', this.level >= d - 48 / this.segs.length);
  }
}
