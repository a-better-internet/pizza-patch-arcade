// Output protection. Everything the rack produces passes through this chain on
// its way to the speakers, whatever the patch does:
//
//   DC blocker -> 20 Hz subsonic HP -> 15.5 kHz 8th-order Butterworth LP
//   (flat to ~13 kHz; removes ultrasonic aliasing and digital fizz)
//   -> Shrill Guard (dynamic high shelf that only acts on sustained brightness)
//   -> runaway leveler -> master volume -> silence gate (kills residual noise
//   floor when nothing is playing) -> look-ahead brickwall limiter at -1 dBFS
//   -> final hard clamp.

import { OUTPUT_CEILING_DB } from '../spec.js';
import { Biquad, SVF, DCBlocker, DelayLine, dbToGain, gainToDb, smoothCoef, flush, clamp } from './util.js';

const CEIL = dbToGain(OUTPUT_CEILING_DB);

class SlidingMin {
  // Monotonic deque sliding-window minimum over the last `w` values.
  constructor(w) {
    this.w = w;
    this.val = new Float64Array(w + 2);
    this.idx = new Int32Array(w + 2);
    this.cap = w + 2;
    this.head = 0;
    this.tail = 0;
    this.n = 0;
  }
  push(v) {
    const cap = this.cap;
    while (this.tail !== this.head) {
      const last = (this.tail - 1 + cap) % cap;
      if (this.val[last] >= v) this.tail = last;
      else break;
    }
    this.val[this.tail] = v;
    this.idx[this.tail] = this.n;
    this.tail = (this.tail + 1) % cap;
    while (this.idx[this.head] <= this.n - this.w) this.head = (this.head + 1) % cap;
    this.n++;
    return this.val[this.head];
  }
  reset() {
    this.head = this.tail = 0;
    this.n = 0;
  }
}

export class LookaheadLimiter {
  constructor(sr, ceiling = CEIL, lookaheadMs = 3, releaseMs = 90) {
    this.sr = sr;
    this.ceil = ceiling;
    this.W = Math.max(8, Math.round((lookaheadMs / 1000) * sr));
    this.dl = new DelayLine(this.W + 8);
    this.dr = new DelayLine(this.W + 8);
    this.min = new SlidingMin(this.W);
    this.box = new Float64Array(this.W);
    this.boxSum = this.W;
    this.box.fill(1);
    this.boxI = 0;
    this.g = 1;
    this.rel = smoothCoef(releaseMs / 1000, sr);
    this.gr = 0; // most recent gain reduction (dB, positive)
    this.latency = this.W;
  }
  process(l, r) {
    const pk = Math.max(Math.abs(l), Math.abs(r));
    const need = pk > this.ceil ? this.ceil / pk : 1;
    const held = this.min.push(need);
    // box-average the held minimum: the ramp reaches the held value exactly as
    // the peak leaves the delay line, so there is no overshoot.
    this.boxSum += held - this.box[this.boxI];
    this.box[this.boxI] = held;
    if (++this.boxI >= this.W) this.boxI = 0;
    const target = this.boxSum / this.W;
    if (target < this.g) this.g = target;
    else this.g += (target - this.g) * this.rel;
    const dl = this.dl.tapInt(this.W);
    const dr = this.dr.tapInt(this.W);
    this.dl.write(l);
    this.dr.write(r);
    this.gr = this.g;
    this.outL = dl * this.g;
    this.outR = dr * this.g;
  }
  reset() {
    this.dl.clear();
    this.dr.clear();
    this.min.reset();
    this.box.fill(1);
    this.boxSum = this.W;
    this.g = 1;
  }
}

export class MasterChain {
  constructor(sr) {
    this.sr = sr;
    const lpHz = Math.min(15500, sr * 0.42);
    // Butterworth 8th order = four biquads with these Qs
    const BW8 = [0.5098, 0.6013, 0.9000, 2.5629];
    const mk = () => ({
      dc: new DCBlocker(sr, 5),
      hp: new Biquad(sr).highpass(20, 0.7071),
      lp: BW8.map((q) => new Biquad(sr).lowpass(lpHz, q)),
      split: new Biquad(sr).highpass(4500, 0.7071), // detector only
      shelf: new SVF(sr), // dynamic high shelf that applies the cut
    });
    this.ch = [mk(), mk()];
    for (const c of this.ch) c.shelf.setHighShelf(5000, 0.7071, 1);
    this.shelfGain = 1;
    // shrill guard detectors (power envelopes, ~30 ms: reacts to sustained
    // brightness, not to individual hi-hat transients)
    this.envHi = 0;
    this.envAll = 0;
    this.pCoef = smoothCoef(0.03, sr);
    this.hiGain = 1;
    this.hiGainCoefDown = smoothCoef(0.015, sr);
    this.hiGainCoefUp = smoothCoef(0.3, sr);
    this.shrillAmount = 0.6;
    // runaway leveler
    this.rms = 0;
    this.rmsCoef = smoothCoef(0.3, sr);
    this.levGain = 1;
    this.levDown = smoothCoef(0.25, sr);
    this.levUp = smoothCoef(1.5, sr);
    // silence gate
    this.gateEnv = 0;
    this.gateEnvAtt = smoothCoef(0.005, sr);
    this.gateEnvRel = smoothCoef(0.35, sr);
    this.gateGain = 1;
    this.gateOpen = smoothCoef(0.004, sr);
    this.gateClose = smoothCoef(0.25, sr);
    // master volume
    this.volume = dbToGain(-3);
    this.volTarget = this.volume;
    this.volCoef = smoothCoef(0.03, sr);
    this.limiter = new LookaheadLimiter(sr);
    // telemetry
    this.peakL = 0;
    this.peakR = 0;
    this.minLimGain = 1;
    this.minHiGain = 1;
    this.minLevGain = 1;
    this.faults = 0;
  }

  setVolume(v01) {
    // 0..1 knob -> -inf..+6 dB, 0.8 = -3 dB
    this.volTarget = v01 <= 0.001 ? 0 : Math.pow(v01 / 0.8, 2.2) * dbToGain(-3);
    this.volTarget = Math.min(this.volTarget, dbToGain(6));
  }

  setShrillGuard(v01) {
    this.shrillAmount = clamp(v01, 0, 1);
  }

  // Processes buffers in place.
  process(L, R, n) {
    const [a, b] = this.ch;
    const amt = this.shrillAmount;
    // Ratio of high-band (>4.5 kHz) to full-band level above which the guard
    // acts (about -13 dB at the default amount), the absolute high-band level
    // where it always acts, and the deepest cut it may apply.
    const ratioThresh = 0.45 * Math.pow(1 - amt, 1.2) + 0.08;
    const absThresh = dbToGain(-8 - 14 * amt);
    const maxCut = dbToGain(-18 * amt);
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (!(l > -1e4 && l < 1e4)) {
        l = 0;
        this.faults++;
      }
      if (!(r > -1e4 && r < 1e4)) {
        r = 0;
        this.faults++;
      }
      l = a.hp.process(a.dc.process(l));
      r = b.hp.process(b.dc.process(r));
      for (let s = 0; s < 4; s++) {
        l = a.lp[s].process(l);
        r = b.lp[s].process(r);
      }

      // --- Shrill Guard: complementary split, so with no reduction it is transparent.
      const hl = a.split.process(l), hr = b.split.process(r);
      this.envHi = flush(this.envHi + this.pCoef * (0.5 * (hl * hl + hr * hr) - this.envHi));
      this.envAll = flush(this.envAll + this.pCoef * (0.5 * (l * l + r * r) - this.envAll));
      let want = 1;
      if (amt > 0 && this.envHi > 1e-9) {
        const hiAmp = Math.sqrt(this.envHi);
        const ratio = Math.sqrt(this.envHi / (this.envAll + 1e-12));
        if (ratio > ratioThresh) want = Math.min(want, Math.pow(ratioThresh / ratio, 1.2));
        if (hiAmp > absThresh) want = Math.min(want, Math.pow(absThresh / hiAmp, 0.8));
        if (want < maxCut) want = maxCut;
      }
      this.hiGain += (want < this.hiGain ? this.hiGainCoefDown : this.hiGainCoefUp) * (want - this.hiGain);
      if ((i & 15) === 0 && Math.abs(this.hiGain - this.shelfGain) > 1e-4) {
        this.shelfGain = this.hiGain;
        a.shelf.setHighShelf(5000, 0.7071, this.hiGain);
        b.shelf.setHighShelf(5000, 0.7071, this.hiGain);
      }
      if (this.shelfGain < 0.9999) {
        l = a.shelf.processShelf(l);
        r = b.shelf.processShelf(r);
      } else {
        // keep the shelf state warm so engaging it is seamless
        a.shelf.processShelf(l);
        b.shelf.processShelf(r);
      }
      if (this.hiGain < this.minHiGain) this.minHiGain = this.hiGain;

      // --- Runaway leveler: slow RMS compressor above -9 dBFS (ratio 3:1).
      const p = 0.5 * (l * l + r * r);
      this.rms = flush(this.rms + this.rmsCoef * (p - this.rms));
      const rmsDb = 10 * Math.log10(this.rms + 1e-12);
      let lev = 1;
      if (rmsDb > -9) lev = dbToGain(Math.max(-14, -(rmsDb + 9) * (2 / 3)));
      this.levGain += (lev < this.levGain ? this.levDown : this.levUp) * (lev - this.levGain);
      if (this.levGain < this.minLevGain) this.minLevGain = this.levGain;

      l *= this.levGain;
      r *= this.levGain;

      // --- Silence gate: below -80 dBFS for a moment, fade out completely, so
      // residual reverb tails, quantisation and noise never sit as a hiss floor.
      // Measured before the volume knob so quiet listening levels are unaffected.
      const e = Math.max(Math.abs(l), Math.abs(r));
      this.gateEnv = flush(this.gateEnv + (e > this.gateEnv ? this.gateEnvAtt : this.gateEnvRel) * (e - this.gateEnv));
      const gwant = this.gateEnv > 2e-4 ? 1 : this.gateEnv < 1e-4 ? 0 : (this.gateEnv - 1e-4) / 1e-4;
      this.gateGain = flush(this.gateGain + (gwant > this.gateGain ? this.gateOpen : this.gateClose) * (gwant - this.gateGain));

      // --- volume
      this.volume += (this.volTarget - this.volume) * this.volCoef;
      const g = this.gateGain * this.volume;
      l *= g;
      r *= g;

      // --- brickwall
      this.limiter.process(l, r);
      l = this.limiter.outL;
      r = this.limiter.outR;
      if (this.limiter.gr < this.minLimGain) this.minLimGain = this.limiter.gr;
      // hard clamp: mathematically unreachable after the limiter, kept as insurance
      if (l > CEIL) l = CEIL;
      else if (l < -CEIL) l = -CEIL;
      if (r > CEIL) r = CEIL;
      else if (r < -CEIL) r = -CEIL;
      L[i] = l;
      R[i] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > this.peakL) this.peakL = al;
      if (ar > this.peakR) this.peakR = ar;
    }
  }

  readTelemetry() {
    const t = {
      peakL: this.peakL,
      peakR: this.peakR,
      limGrDb: -gainToDb(this.minLimGain),
      hiGrDb: -gainToDb(this.minHiGain),
      levGrDb: -gainToDb(this.minLevGain),
      gate: this.gateGain,
    };
    this.peakL = this.peakR = 0;
    this.minLimGain = this.minHiGain = this.minLevGain = 1;
    return t;
  }

  reset() {
    for (const c of this.ch) {
      c.dc.reset();
      c.hp.reset();
      for (const f of c.lp) f.reset();
      c.split.reset();
      c.shelf.reset();
    }
    this.envHi = this.envAll = 0;
    this.hiGain = 1;
    this.rms = 0;
    this.levGain = 1;
    this.limiter.reset();
  }
}
