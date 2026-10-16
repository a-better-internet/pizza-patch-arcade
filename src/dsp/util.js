// DSP building blocks. Everything here is allocation-free in the audio path.
//
// Guiding rules for a clean, quiet signal chain:
//  * every recursive state is flushed to zero below 1e-15 (no denormal stalls,
//    no endless sub-audible tails that later get amplified into hiss);
//  * every nonlinearity is either bounded and smooth (sat) or oversampled;
//  * every parameter that touches gain or filter coefficients is smoothed.

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(g > 1e-12 ? g : 1e-12);
export const expMap = (t, lo, hi) => lo * Math.pow(hi / lo, t);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Fast sine for audio-rate use: range-reduce to a quarter wave, then a 9th-order
// odd polynomial (max error ~4e-6, i.e. below -100 dB).
const INV_TAU = 1 / (2 * Math.PI);
export function fastSin(x) {
  let t = x * INV_TAU;
  t -= Math.round(t);
  if (t > 0.25) t = 0.5 - t;
  else if (t < -0.25) t = -0.5 - t;
  const z = t * 2 * Math.PI;
  const z2 = z * z;
  return z * (1 + z2 * (-1 / 6 + z2 * (1 / 120 + z2 * (-1 / 5040 + z2 / 362880))));
}
export const fastCos = (x) => fastSin(x + Math.PI / 2);

// Flush denormal / vanishing values.
export const flush = (x) => (x > 1e-15 || x < -1e-15 ? x : 0);

// Smooth bounded saturator: a Pade tanh approximation that reaches exactly +/-1
// at |x| = 3 with zero slope, so it is C1-continuous and never overshoots.
export function sat(x) {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// Transparent below |x| < knee, then rolls smoothly into `ceil`.
export function softLimit(x, knee, ceil) {
  const a = x < 0 ? -x : x;
  if (a <= knee) return x;
  const room = ceil - knee;
  const y = knee + room * sat((a - knee) / room);
  return x < 0 ? -y : y;
}

// Deterministic PRNG (mulberry32) so dice rolls and tests are reproducible.
export class Rng {
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bi() {
    return this.next() * 2 - 1;
  }
  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  gauss() {
    let u = 0;
    while (u <= 1e-9) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * this.next());
  }
}

// One-pole lowpass with a cutoff in Hz.
export class OnePole {
  constructor(sr, hz = 1000) {
    this.sr = sr;
    this.y = 0;
    this.set(hz);
  }
  set(hz) {
    this.a = 1 - Math.exp((-TAU * Math.min(hz, this.sr * 0.45)) / this.sr);
  }
  process(x) {
    this.y = flush(this.y + this.a * (x - this.y));
    return this.y;
  }
  reset() {
    this.y = 0;
  }
}

// One-pole smoothing coefficient for a time constant in seconds at `rate` Hz.
export const smoothCoef = (seconds, rate) => (seconds <= 0 ? 1 : 1 - Math.exp(-1 / (seconds * rate)));

export class DCBlocker {
  constructor(sr, hz = 8) {
    this.r = 1 - (TAU * hz) / sr;
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = flush(y);
    return this.y1;
  }
  reset() {
    this.x1 = this.y1 = 0;
  }
}

// Envelope follower on |x| with separate attack and release.
export class Env {
  constructor(sr, attack = 0.005, release = 0.1) {
    this.sr = sr;
    this.v = 0;
    this.set(attack, release);
  }
  set(attack, release) {
    this.att = smoothCoef(attack, this.sr);
    this.rel = smoothCoef(release, this.sr);
  }
  process(x) {
    const a = x < 0 ? -x : x;
    this.v += (a > this.v ? this.att : this.rel) * (a - this.v);
    this.v = flush(this.v);
    return this.v;
  }
  reset() {
    this.v = 0;
  }
}

// Topology-preserving state variable filter (Zavalishin / Simper).
// Stable under fast modulation. Optional bounded resonance for self-oscillation.
export class SVF {
  constructor(sr) {
    this.sr = sr;
    this.ic1 = 0;
    this.ic2 = 0;
    this.lp = this.bp = this.hp = 0;
    this.set(1000, 0.707);
  }
  // k = 1/Q ; negative k (down to about -0.2) makes the filter self-oscillate.
  setK(hz, k) {
    const f = clamp(hz, 10, this.sr * 0.42);
    this.g = Math.tan((Math.PI * f) / this.sr);
    this.k = k;
    this.a1 = 1 / (1 + this.g * (this.g + k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  set(hz, q) {
    this.setK(hz, 1 / q);
  }
  // High shelf (Simper): `gain` is the linear gain above `hz`.
  setHighShelf(hz, q, gain) {
    const A = Math.sqrt(Math.max(1e-4, gain));
    const f = clamp(hz, 10, this.sr * 0.42);
    this.g = Math.tan((Math.PI * f) / this.sr) * Math.sqrt(A);
    this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
    this.m0 = A * A;
    this.m1 = this.k * (1 - A) * A;
    this.m2 = 1 - A * A;
  }
  processShelf(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = flush(2 * v1 - this.ic1);
    this.ic2 = flush(2 * v2 - this.ic2);
    return this.m0 * x + this.m1 * v1 + this.m2 * v2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = flush(2 * v1 - this.ic1);
    this.ic2 = flush(2 * v2 - this.ic2);
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
  // Same as process() but the band state is soft-bounded so a self-oscillating
  // filter settles into a stable sine instead of growing without limit.
  processBounded(x, limit) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = flush(limit * sat((2 * v1 - this.ic1) / limit));
    this.ic2 = flush(limit * 2 * sat((2 * v2 - this.ic2) / (limit * 2)));
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
    this.lp = this.bp = this.hp = 0;
  }
}

// RBJ biquad, transposed direct form II.
export class Biquad {
  constructor(sr) {
    this.sr = sr;
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = 0;
    this.z1 = this.z2 = 0;
  }
  _w(hz) {
    return (TAU * clamp(hz, 5, this.sr * 0.45)) / this.sr;
  }
  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }
  lowpass(hz, q = 0.7071) {
    const w = this._w(hz), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  highpass(hz, q = 0.7071) {
    const w = this._w(hz), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  bandpass(hz, q = 1) {
    const w = this._w(hz), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  highshelf(hz, db, s = 1) {
    const A = Math.pow(10, db / 40), w = this._w(hz), c = Math.cos(w), sn = Math.sin(w);
    const al = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    return this._set(
      A * (A + 1 + (A - 1) * c + sq), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sq),
      A + 1 - (A - 1) * c + sq, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sq,
    );
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = flush(this.b1 * x - this.a1 * y + this.z2);
    this.z2 = flush(this.b2 * x - this.a2 * y);
    return y;
  }
  reset() {
    this.z1 = this.z2 = 0;
  }
}

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

// Circular delay line. Always read before writing the current sample:
// tap(d) returns the sample written d samples ago (d >= 1).
export class DelayLine {
  constructor(maxSamples) {
    this.size = nextPow2(Math.max(8, Math.ceil(maxSamples) + 8));
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.max = this.size - 4;
  }
  write(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  tapInt(d) {
    return this.buf[(this.w - d) & this.mask];
  }
  tap(d) {
    if (d < 1) d = 1;
    else if (d > this.max) d = this.max;
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i) & this.mask];
    const b = this.buf[(this.w - i - 1) & this.mask];
    return a + (b - a) * f;
  }
  // 4-point Hermite interpolation, d >= 2.
  tapHermite(d) {
    if (d < 2) d = 2;
    else if (d > this.max - 2) d = this.max - 2;
    const i = Math.floor(d);
    const f = d - i;
    const m = this.mask, w = this.w, b = this.buf;
    const xm1 = b[(w - i + 1) & m];
    const x0 = b[(w - i) & m];
    const x1 = b[(w - i - 1) & m];
    const x2 = b[(w - i - 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  clear() {
    this.buf.fill(0);
  }
}

// Schroeder allpass diffuser with a fixed integer delay.
export class Allpass {
  constructor(samples) {
    this.n = Math.max(1, Math.round(samples));
    this.buf = new Float32Array(this.n);
    this.i = 0;
  }
  process(x, g) {
    const d = this.buf[this.i];
    const v = x + g * d;
    this.buf[this.i] = flush(v);
    if (++this.i >= this.n) this.i = 0;
    return d - g * v;
  }
  clear() {
    this.buf.fill(0);
  }
}

// Absolute-indexed record buffer for granular / glitch playback.
// read(pos) takes an absolute (fractional) sample position.
export class RecordBuffer {
  constructor(samples) {
    this.size = nextPow2(Math.ceil(samples));
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.pos = 0; // absolute index of the next write
  }
  write(x) {
    this.buf[this.pos & this.mask] = x;
    this.pos++;
  }
  read(p) {
    const i = Math.floor(p);
    const f = p - i;
    const m = this.mask;
    const a = this.buf[i & m];
    const b = this.buf[(i + 1) & m];
    return a + (b - a) * f;
  }
  readHermite(p) {
    const i = Math.floor(p);
    const f = p - i;
    const m = this.mask, b = this.buf;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  clear() {
    this.buf.fill(0);
  }
}

// Kaiser-windowed sinc lowpass prototype.
function bessel0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}
function designLowpass(n, cutoff, beta) {
  const h = new Float64Array(n);
  const mid = (n - 1) / 2;
  const i0b = bessel0(beta);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - mid;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(TAU * cutoff * t) / (Math.PI * t);
    const r = (2 * i) / (n - 1) - 1;
    const w = bessel0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

const HB_CACHE = new Map();

// Half-band lowpass (cutoff at a quarter of the high rate). Every even tap
// except the centre is exactly zero and the centre is exactly 0.5.
function designHalfband(n, beta) {
  const key = `${n}:${beta}`;
  if (HB_CACHE.has(key)) return HB_CACHE.get(key);
  const h = designLowpass(n, 0.25, beta);
  const mid = (n - 1) / 2;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (i === mid) continue;
    if ((i - mid) % 2 === 0) h[i] = 0;
    else odd += h[i];
  }
  for (let i = 0; i < n; i++) if (i !== mid && h[i] !== 0) h[i] *= 0.5 / odd;
  h[mid] = 0.5;
  HB_CACHE.set(key, h);
  return h;
}

// One 2x up/down stage built on a half-band filter. Only non-zero taps are
// evaluated, which halves the cost of a plain FIR.
class HalfbandStage {
  constructor(n, beta) {
    const h = designHalfband(n, beta);
    this.mid = (n - 1) / 2;
    // upsampler phases: y[2k+p] = 2 * sum_{i = p mod 2} h[i] x[k - (i - p)/2]
    this.upTaps = [0, 1].map((p) => {
      const c = [], d = [];
      for (let i = p; i < n; i += 2) {
        if (h[i] !== 0) {
          c.push(2 * h[i]);
          d.push((i - p) / 2);
        }
      }
      return { c: Float64Array.from(c), d: Int32Array.from(d) };
    });
    const dc = [], dd = [];
    for (let i = 0; i < n; i++) {
      if (h[i] !== 0) {
        dc.push(h[i]);
        dd.push(i);
      }
    }
    this.dnC = Float64Array.from(dc);
    this.dnD = Int32Array.from(dd);
    this.xLen = Math.ceil(n / 2) + 2;
    this.x = new Float64Array(2 * this.xLen);
    this.xi = 0;
    this.vLen = n + 2;
    this.v = new Float64Array(2 * this.vLen);
    this.vi = 0;
  }
  // x -> two high-rate samples written to out[o], out[o+1]
  up(x, out, o) {
    const len = this.xLen;
    if (++this.xi >= len) this.xi = 0;
    this.x[this.xi] = x;
    this.x[this.xi + len] = x;
    const base = this.xi + len;
    for (let p = 0; p < 2; p++) {
      const { c, d } = this.upTaps[p];
      let acc = 0;
      for (let k = 0; k < c.length; k++) acc += c[k] * this.x[base - d[k]];
      out[o + p] = acc;
    }
  }
  // two high-rate samples -> one low-rate sample
  down(a, b) {
    const len = this.vLen;
    if (++this.vi >= len) this.vi = 0;
    this.v[this.vi] = a;
    this.v[this.vi + len] = a;
    if (++this.vi >= len) this.vi = 0;
    this.v[this.vi] = b;
    this.v[this.vi + len] = b;
    // centre the decimator on the even (first) sample of the pair so the round
    // trip delay is exactly `mid` low-rate samples
    const base = this.vi + len - 1;
    const c = this.dnC, d = this.dnD, v = this.v;
    let acc = 0;
    for (let k = 0; k < c.length; k++) acc += c[k] * v[base - d[k]];
    return acc;
  }
  reset() {
    this.x.fill(0);
    this.v.fill(0);
  }
}

// 2x or 4x oversampler from cascaded half-band stages (linear phase).
// The round trip latency is an integer number of base-rate samples
// (`latency`), so dry paths can be aligned exactly. Pass band reaches ~17 kHz
// at 48 kHz; everything that would alias is removed by ~70 dB.
export class Oversampler {
  constructor(L = 2) {
    this.L = L === 4 ? 4 : 2;
    this.a = new HalfbandStage(33, 7);
    this.b = this.L === 4 ? new HalfbandStage(21, 6.5) : null;
    this.out = new Float64Array(this.L);
    this.mid2 = new Float64Array(2);
    this.latency = this.a.mid + (this.b ? this.b.mid / 2 : 0);
  }
  upsample(x) {
    if (!this.b) {
      this.a.up(x, this.out, 0);
      return this.out;
    }
    this.a.up(x, this.mid2, 0);
    this.b.up(this.mid2[0], this.out, 0);
    this.b.up(this.mid2[1], this.out, 2);
    return this.out;
  }
  downsample(arr) {
    if (!this.b) return this.a.down(arr[0], arr[1]);
    const m0 = this.b.down(arr[0], arr[1]);
    const m1 = this.b.down(arr[2], arr[3]);
    return this.a.down(m0, m1);
  }
  reset() {
    this.a.reset();
    if (this.b) this.b.reset();
    this.out.fill(0);
  }
}

// Integer sample delay, used to keep dry paths phase-aligned with oversampled
// or look-ahead wet paths (avoids comb filtering at partial mix).
export class FixedDelay {
  constructor(n) {
    this.n = n;
    this.buf = new Float32Array(Math.max(1, n));
    this.i = 0;
  }
  process(x) {
    if (this.n === 0) return x;
    const y = this.buf[this.i];
    this.buf[this.i] = x;
    if (++this.i >= this.n) this.i = 0;
    return y;
  }
  clear() {
    this.buf.fill(0);
  }
}

// Small 4-line feedback delay network reverb (Householder matrix).
export class FDN4 {
  constructor(sr, lengthsMs, damping = 5000) {
    this.sr = sr;
    this.lines = lengthsMs.map((ms) => new DelayLine((ms / 1000) * sr * 1.6 + 16));
    this.len = lengthsMs.map((ms) => Math.round((ms / 1000) * sr));
    this.lp = lengthsMs.map(() => new OnePole(sr, damping));
    this.g = [0.8, 0.8, 0.8, 0.8];
    this.o = new Float64Array(4);
    this.setDecay(2);
  }
  setDecay(t60) {
    for (let i = 0; i < 4; i++) this.g[i] = Math.pow(10, (-3 * this.len[i]) / (Math.max(0.05, t60) * this.sr));
  }
  setDamping(hz) {
    for (const f of this.lp) f.set(hz);
  }
  // Inputs in L/R, writes stereo out into this.outL / this.outR.
  process(inL, inR, mod = 0) {
    const o = this.o;
    for (let i = 0; i < 4; i++) {
      const d = this.len[i] + (i & 1 ? -mod : mod);
      o[i] = this.lp[i].process(this.lines[i].tap(d));
    }
    const s = 0.5 * (o[0] + o[1] + o[2] + o[3]);
    this.lines[0].write(flush((o[0] - s) * this.g[0] + inL));
    this.lines[1].write(flush((o[1] - s) * this.g[1] + inR));
    this.lines[2].write(flush((o[2] - s) * this.g[2] + inL));
    this.lines[3].write(flush((o[3] - s) * this.g[3] - inR));
    this.outL = o[0] + o[2];
    this.outR = o[1] + o[3];
  }
  clear() {
    for (const l of this.lines) l.clear();
    for (const f of this.lp) f.reset();
  }
}

// Musical time helpers.
export const beatsToSamples = (beats, bpm, sr) => (beats * 60 * sr) / bpm;
