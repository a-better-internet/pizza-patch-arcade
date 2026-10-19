// Built-in demo instruments for the From Host inputs, plus the input
// conditioner that every host signal passes through before it reaches a cable.
//
// All oscillators are band-limited (sines, PolyBLEP saws, Karplus-Strong) and
// every voice is low-passed, so the sources themselves add no aliasing fizz.

import { TAU, Rng, SVF, Biquad, DCBlocker, OnePole, flush, softLimit, dbToGain, smoothCoef, fastSin } from './util.js';

export const SOURCE_NAMES = ['off', 'impulse', 'keys', 'pad', 'beat', 'bass', 'arp', 'input'];
export const SOURCE_LABELS = {
  off: 'Off', impulse: 'Impulse only', keys: 'Demo: Keys', pad: 'Demo: Pad', beat: 'Demo: Beat', bass: 'Demo: Bass',
  arp: 'Demo: Arp', input: 'External input',
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Four-bar progression in A minor: Am9 - Fmaj7 - Cadd9 - G6
const CHORDS = [
  { root: 45, notes: [57, 60, 64, 67, 71] },
  { root: 41, notes: [57, 60, 64, 65, 69] },
  { root: 48, notes: [55, 60, 62, 64, 67] },
  { root: 43, notes: [55, 59, 62, 64, 67] },
];
const chordAt = (beat) => CHORDS[Math.floor(beat / 4) % 4];

function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Base: tracks 16th-note steps and fires onStep(step, offsetSamples).
class Sequenced {
  constructor(sr) {
    this.sr = sr;
    this.lastStep = -1;
    this.rng = new Rng(77);
  }
  render(L, R, n, beat, bps) {
    this.secPerBeat = 1 / (bps * this.sr);
    for (let i = 0; i < n; i++) {
      const b = beat + i * bps;
      const step = Math.floor(b * 4 + 1e-9);
      if (step !== this.lastStep) {
        this.lastStep = step;
        this.onStep(step, b);
      }
      this.tick(L, R, i);
    }
  }
  reset() {
    this.lastStep = -1;
  }
}

class EPVoice {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.amp = 0;
  }
  start(f, vel, len, pan) {
    this.on = true;
    this.f = f;
    this.ph = 0;
    this.mph = 0;
    this.t = 0;
    this.vel = vel;
    this.len = len;
    this.pl = Math.cos(pan * Math.PI * 0.5);
    this.pr = Math.sin(pan * Math.PI * 0.5);
    this.decay = Math.exp(-1 / (this.sr * (1.6 * Math.pow(220 / f, 0.35))));
    this.rel = Math.exp(-1 / (this.sr * 0.12));
    this.amp = 0;
    this.env = 1;
  }
  sample() {
    const sr = this.sr;
    const t = this.t++ / sr;
    const att = t < 0.004 ? t / 0.004 : 1;
    this.env *= t > this.len ? this.rel : this.decay;
    if (this.env < 1e-4) {
      this.on = false;
      return 0;
    }
    const idx = 1.1 * Math.exp(-t / 0.18) + 0.12;
    this.mph += this.f / sr;
    if (this.mph >= 1) this.mph -= 1;
    this.ph += this.f / sr;
    if (this.ph >= 1) this.ph -= 1;
    return fastSin(TAU * this.ph + idx * fastSin(TAU * this.mph)) * this.env * att * this.vel;
  }
}

class Keys extends Sequenced {
  constructor(sr) {
    super(sr);
    this.voices = Array.from({ length: 12 }, () => new EPVoice(sr));
    this.lp = [new OnePole(sr, 5200), new OnePole(sr, 5200)];
    this.hits = { 0: 1.4, 6: 0.45, 10: 1.0, 14: 0.35 }; // 16th step -> length (beats)
  }
  onStep(step, beat) {
    const s = step % 16;
    if (!(s in this.hits)) return;
    const ch = chordAt(beat);
    const secPerBeat = this.secPerBeat || 0.5;
    const len = this.hits[s] * secPerBeat;
    const vel = s === 0 ? 0.2 : 0.14;
    const notes = s === 0 ? ch.notes : ch.notes.slice(1, 4);
    notes.forEach((m, k) => {
      const v = this.voices.find((x) => !x.on) || this.voices[k];
      v.start(mtof(m), vel * (1 - k * 0.06), len, 0.3 + 0.4 * (k / (notes.length - 1 || 1)));
    });
  }
  tick(L, R, i) {
    let l = 0, r = 0;
    for (const v of this.voices) {
      if (!v.on) continue;
      const s = v.sample();
      l += s * v.pl;
      r += s * v.pr;
    }
    L[i] += this.lp[0].process(l);
    R[i] += this.lp[1].process(r);
  }
}

class Pad extends Sequenced {
  constructor(sr) {
    super(sr);
    this.osc = []; // 5 notes x 2 detuned saws
    for (let k = 0; k < 10; k++) this.osc.push({ ph: Math.random(), f: 220, pan: (k % 2) ? 0.75 : 0.25 });
    this.env = 0;
    this.target = 0;
    this.svfL = new SVF(sr);
    this.svfR = new SVF(sr);
    this.lfo = 0;
    this.chord = null;
    this.glide = smoothCoef(0.25, sr);
    this.envCoef = smoothCoef(0.9, sr);
  }
  onStep(step, beat) {
    if (step % 16 !== 0) return;
    const ch = chordAt(beat);
    ch.notes.forEach((m, k) => {
      const f = mtof(m - 12);
      this.osc[2 * k].ft = f * 1.0035;
      this.osc[2 * k + 1].ft = f * 0.9965;
    });
    this.target = 1;
  }
  tick(L, R, i) {
    this.env += (this.target - this.env) * this.envCoef;
    this.lfo += 0.11 / this.sr;
    if (this.lfo >= 1) this.lfo -= 1;
    const cut = 900 + 500 * Math.sin(TAU * this.lfo);
    if ((i & 15) === 0) {
      this.svfL.set(cut, 0.8);
      this.svfR.set(cut * 1.05, 0.8);
    }
    let l = 0, r = 0;
    for (const o of this.osc) {
      if (o.ft) o.f += (o.ft - o.f) * this.glide;
      const dt = o.f / this.sr;
      o.ph += dt;
      if (o.ph >= 1) o.ph -= 1;
      const s = 2 * o.ph - 1 - polyblep(o.ph, dt);
      l += s * (1 - o.pan);
      r += s * o.pan;
    }
    const g = 0.085 * this.env;
    L[i] += this.svfL.process(l * g);
    R[i] += this.svfR.process(r * g);
  }
}

class Beat extends Sequenced {
  constructor(sr) {
    super(sr);
    this.kick = { t: 1e9, ph: 0 };
    this.snare = { t: 1e9, ph: 0 };
    this.hat = { t: 1e9, open: false, vel: 0 };
    this.noiseBp = [new Biquad(sr).bandpass(1900, 0.8), new Biquad(sr).bandpass(1900, 0.8)];
    this.hatBp = new Biquad(sr).bandpass(6000, 1.1);
    this.hatLp = new Biquad(sr).lowpass(9000, 0.7);
    this.kickPat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0];
    this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];
    this.hatPat = [0.5, 0.25, 1, 0.25, 0.5, 0.25, 1, 0.3, 0.5, 0.25, 1, 0.25, 0.5, 0.3, 1, 0.4];
  }
  onStep(step) {
    const s = step % 16;
    if (this.kickPat[s]) this.kick = { t: 0, ph: 0 };
    if (this.snarePat[s]) this.snare = { t: 0, ph: 0, vel: s === 15 ? 0.35 : 1 };
    this.hat = { t: 0, open: s === 14, vel: this.hatPat[s] };
  }
  tick(L, R, i) {
    const sr = this.sr;
    let l = 0, r = 0;
    const k = this.kick;
    if (k.t < sr * 0.6) {
      const t = k.t / sr;
      const f = 46 + 120 * Math.exp(-t / 0.03);
      k.ph += f / sr;
      const s = Math.sin(TAU * k.ph) * Math.exp(-t / 0.28) * Math.min(1, t / 0.0015) * 0.6;
      l += s;
      r += s;
      k.t++;
    }
    const sn = this.snare;
    if (sn.t < sr * 0.5) {
      const t = sn.t / sr;
      sn.ph += 190 / sr;
      const tone = Math.sin(TAU * sn.ph) * Math.exp(-t / 0.07) * 0.22;
      const nz = this.rng.bi();
      const body = Math.exp(-t / 0.13) * 0.55 * Math.min(1, t / 0.001);
      const nl = this.noiseBp[0].process(nz) * body;
      const nr = this.noiseBp[1].process(this.rng.bi()) * body;
      l += (tone + nl) * sn.vel;
      r += (tone + nr) * sn.vel;
      sn.t++;
    }
    const h = this.hat;
    if (h.t < sr * 0.4) {
      const t = h.t / sr;
      const env = Math.exp(-t / (h.open ? 0.16 : 0.035)) * Math.min(1, t / 0.0008);
      const s = this.hatLp.process(this.hatBp.process(this.rng.bi())) * env * 0.13 * h.vel;
      l += s * 0.8;
      r += s;
      h.t++;
    }
    L[i] += l * 0.62;
    R[i] += r * 0.62;
  }
}

class Bass extends Sequenced {
  constructor(sr) {
    super(sr);
    this.ph = 0;
    this.sub = 0;
    this.f = 55;
    this.amp = 0;
    this.fenv = 0;
    this.svf = new SVF(sr);
    this.pat = [0, null, 0, null, 12, null, 0, 0, null, 0, null, 12, 0, null, 7, null];
    this.ampDecay = Math.exp(-1 / (sr * 0.22));
    this.fDecay = Math.exp(-1 / (sr * 0.09));
    this.glide = smoothCoef(0.012, sr);
  }
  onStep(step, beat) {
    const s = step % 16;
    const iv = this.pat[s];
    if (iv === null) return;
    const ch = chordAt(beat);
    this.ft = mtof(ch.root - 12 + iv);
    this.amp = 1;
    this.fenv = 1;
  }
  tick(L, R, i) {
    if (this.ft) this.f += (this.ft - this.f) * this.glide;
    const dt = this.f / this.sr;
    this.ph += dt;
    if (this.ph >= 1) this.ph -= 1;
    this.sub += dt * 0.5;
    if (this.sub >= 1) this.sub -= 1;
    const saw = 2 * this.ph - 1 - polyblep(this.ph, dt);
    this.amp *= this.ampDecay;
    this.fenv *= this.fDecay;
    if ((i & 7) === 0) this.svf.set(160 + 1400 * this.fenv, 1.4);
    const s = (this.svf.process(saw) * 0.5 + Math.sin(TAU * this.sub) * 0.45) * this.amp * 0.55;
    L[i] += s;
    R[i] += s;
  }
}

class Pluck {
  constructor(sr) {
    this.sr = sr;
    this.buf = new Float32Array(Math.ceil(sr / 40) + 4);
    this.on = false;
  }
  start(f, vel, rng, pan) {
    this.n = Math.min(this.buf.length - 2, this.sr / f);
    this.len = Math.floor(this.n);
    this.frac = this.n - this.len;
    // soft excitation: low-passed noise burst
    let y = 0;
    for (let i = 0; i < this.len; i++) {
      y += 0.22 * (rng.bi() - y);
      this.buf[i] = y * vel;
    }
    this.i = 0;
    this.last = 0;
    this.on = true;
    this.life = this.sr * 2.5;
    this.pan = pan;
  }
  sample() {
    if (!this.on) return 0;
    const i = this.i;
    const j = i + 1 >= this.len ? 0 : i + 1;
    const x = this.buf[i] * (1 - this.frac) + this.buf[j] * this.frac;
    const y = 0.996 * (0.5 * x + 0.5 * this.last);
    this.last = y;
    this.buf[i] = flush(y);
    this.i = j;
    if (--this.life <= 0) this.on = false;
    return x;
  }
}

class Arp extends Sequenced {
  constructor(sr) {
    super(sr);
    this.voices = Array.from({ length: 6 }, () => new Pluck(sr));
    this.next = 0;
    this.order = [0, 2, 1, 3, 4, 3, 1, 2];
    this.lp = [new SVF(sr), new SVF(sr)];
    for (const f of this.lp) f.set(3200, 0.6);
  }
  onStep(step, beat) {
    if (step % 2 === 1 && this.rng.next() < 0.6) return;
    const ch = chordAt(beat);
    const k = this.order[step % 8];
    const m = ch.notes[k % ch.notes.length] + (step % 16 >= 8 ? 12 : 0);
    const v = this.voices[this.next++ % this.voices.length];
    v.start(mtof(m), 1.45, this.rng, step % 2 ? 0.7 : 0.3);
  }
  tick(L, R, i) {
    let l = 0, r = 0;
    for (const v of this.voices) {
      if (!v.on) continue;
      const s = v.sample();
      l += s * (1 - v.pan);
      r += s * v.pan;
    }
    L[i] += this.lp[0].process(l);
    R[i] += this.lp[1].process(r);
  }
}

const FACTORY = { keys: Keys, pad: Pad, beat: Beat, bass: Bass, arp: Arp };

export function createSource(name, sr) {
  const C = FACTORY[name];
  return C ? new C(sr) : null;
}

// Every host input passes through this before it reaches the rack:
// trim -> DC/rumble high-pass -> noise gate (external inputs only) -> soft limiter.
export class InputConditioner {
  constructor(sr) {
    this.sr = sr;
    this.dcL = new DCBlocker(sr, 10);
    this.dcR = new DCBlocker(sr, 10);
    this.hpL = new Biquad(sr).highpass(25, 0.7071);
    this.hpR = new Biquad(sr).highpass(25, 0.7071);
    this.gain = 1;
    this.gainTarget = 1;
    this.gCoef = smoothCoef(0.03, sr);
    this.env = 0;
    this.envAtt = smoothCoef(0.002, sr);
    this.envRel = smoothCoef(0.12, sr);
    this.gate = 0;
    this.gateOn = true;
    this.gateThresh = dbToGain(-58);
    this.gOpen = smoothCoef(0.002, sr);
    this.gClose = smoothCoef(0.15, sr);
    this.peak = 0;
  }
  setTrimDb(db) {
    this.gainTarget = dbToGain(Math.max(-36, Math.min(18, db)));
  }
  process(L, R, n, useGate) {
    for (let i = 0; i < n; i++) {
      this.gain += (this.gainTarget - this.gain) * this.gCoef;
      let l = L[i] * this.gain, r = R[i] * this.gain;
      if (!(l > -100 && l < 100)) l = 0;
      if (!(r > -100 && r < 100)) r = 0;
      l = this.hpL.process(this.dcL.process(l));
      r = this.hpR.process(this.dcR.process(r));
      if (useGate) {
        // downward expander: mic/line self-noise never reaches the effects
        const a = Math.max(Math.abs(l), Math.abs(r));
        this.env += (a > this.env ? this.envAtt : this.envRel) * (a - this.env);
        const t = this.gateThresh;
        const want = this.env >= t ? 1 : Math.pow(this.env / t, 2);
        this.gate += (want > this.gate ? this.gOpen : this.gClose) * (want - this.gate);
        l *= this.gate;
        r *= this.gate;
      }
      // keep hot inputs from overloading everything downstream
      l = softLimit(l, 0.6, 0.98);
      r = softLimit(r, 0.6, 0.98);
      L[i] = l;
      R[i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > this.peak) this.peak = a;
    }
  }
  readPeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }
}
