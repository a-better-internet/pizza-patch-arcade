import { Effect } from '../module.js';
import { Oversampler, Biquad, DCBlocker, Env, sat, expMap, smoothCoef, TAU, clamp, flush } from '../util.js';

// Olli Niemitalo's 90-degree phase-difference allpass pair (Hilbert transformer).
const H1 = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737].map((a) => a * a);
const H2 = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278].map((a) => a * a);

const OS2_LATENCY = new Oversampler(2).latency;

class AllpassChain {
  constructor(coefs) {
    this.c = coefs;
    this.x1 = new Float64Array(coefs.length);
    this.x2 = new Float64Array(coefs.length);
    this.y1 = new Float64Array(coefs.length);
    this.y2 = new Float64Array(coefs.length);
  }
  process(x) {
    for (let k = 0; k < this.c.length; k++) {
      const y = this.c[k] * (x + this.y2[k]) - this.x2[k];
      this.x2[k] = this.x1[k];
      this.x1[k] = x;
      this.y2[k] = this.y1[k];
      this.y1[k] = flush(y);
      x = y;
    }
    return x;
  }
  reset() {
    this.x1.fill(0);
    this.x2.fill(0);
    this.y1.fill(0);
    this.y2.fill(0);
  }
}

class Hilbert {
  constructor() {
    this.a = new AllpassChain(H1);
    this.b = new AllpassChain(H2);
    this.d = 0;
  }
  process(x) {
    const re = this.d;
    this.d = this.a.process(x);
    this.re = re;
    this.im = this.b.process(x);
  }
  reset() {
    this.a.reset();
    this.b.reset();
    this.d = 0;
  }
}

// Subverter: stereo field manipulator. Polarity rotates the right channel's
// phase through a Hilbert pair; both channels (and the dry signal used by the
// Mix knob) share the same all-pass phase so partial mixes never comb-filter.
export class Subverter extends Effect {
  constructor(engine, spec) {
    super(engine, spec, { latency: OS2_LATENCY });
    const sr = this.sr;
    this.hL = new Hilbert();
    this.hR = new Hilbert();
    this.os = [new Oversampler(2), new Oversampler(2)];
    this.dc = [new DCBlocker(sr, 10), new DCBlocker(sr, 10)];
    this.sideHp1 = new Biquad(sr);
    this.sideHp2 = new Biquad(sr);
    this.fast = new Env(sr, 0.001, 0.03);
    this.slow = new Env(sr, 0.04, 0.4);
    this.duck = 0;
    this.duckRel = smoothCoef(0.15, sr);
    this.movePh = 0;
    this.midEnv = new Env(sr, 0.01, 0.25);
    this.sideEnv = new Env(sr, 0.01, 0.25);
    this.dryPL = new Float32Array(64);
    this.dryPR = new Float32Array(64);
    this.dryOverride = [this.dryPL, this.dryPR];
    this.makeup = 1;
    this.rIn = 1e-6;
    this.rOut = 1e-6;
    this.rc = smoothCoef(0.3, sr);
    this.hpHz = 0;
  }

  reset() {
    this.hL.reset();
    this.hR.reset();
    for (const o of this.os) o.reset();
    for (const d of this.dc) d.reset();
    this.sideHp1.reset();
    this.sideHp2.reset();
    this.duck = 0;
    this.makeup = 1;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr;
    const theta = Math.PI * p.polarity;
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const sym = p.symmetry * 0.8;
    const symOff = sat(sym);
    const drive = 1 + p.drive * 6;
    const symGain = 1 + p.symmetry * 0.5;
    const hpHz = expMap(p.hp, 20, 600);
    if (Math.abs(hpHz - this.hpHz) > 0.5) {
      this.hpHz = hpHz;
      this.sideHp1.highpass(hpHz, 0.7071);
      this.sideHp2.highpass(hpHz, 0.7071);
    }
    const width = p.width * 2 * (1 + 0.25 * this.loop);
    const move = p.move;
    const moveHz = 0.15 + move * 0.6;
    let midAcc = 0, sideAcc = 0;
    for (let i = 0; i < 64; i++) {
      this.hL.process(inL[i]);
      this.hR.process(inR[i]);
      const l0 = this.hL.re;
      const r0 = this.hR.re * cs + this.hR.im * sn;
      this.dryPL[i] = l0;
      this.dryPR[i] = this.hR.re;
      // asymmetric shaping + drive, 2x oversampled
      const xs = [l0, r0];
      const ys = [0, 0];
      for (let c = 0; c < 2; c++) {
        const up = this.os[c].upsample(xs[c]);
        for (let k = 0; k < 2; k++) {
          let u = up[k];
          if (sym > 0) u = sat(u * symGain + sym) - symOff;
          up[k] = sat(u * drive) / drive;
        }
        ys[c] = this.dc[c].process(this.os[c].downsample(up));
      }
      // gain compensation for drive / symmetry (tracks energy, holds in silence)
      const ein = l0 * l0 + r0 * r0, eout = ys[0] * ys[0] + ys[1] * ys[1];
      this.rIn += this.rc * (ein - this.rIn);
      this.rOut += this.rc * (eout - this.rOut);
      if (this.rIn > 1e-7) this.makeup += 0.001 * (clamp(Math.sqrt(this.rIn / (this.rOut + 1e-12)), 0.8, 2.5) - this.makeup);
      const l = ys[0] * this.makeup, r = ys[1] * this.makeup;
      // mid / side
      const M = 0.5 * (l + r);
      let S = 0.5 * (l - r);
      S = this.sideHp2.process(this.sideHp1.process(S));
      // loud centre transients momentarily collapse the image, then it blooms back
      const f = this.fast.process(M), s = this.slow.process(M);
      const tr = clamp((f - 1.4 * s) / (s + 1e-3), 0, 1);
      this.duck = tr > this.duck ? tr : this.duck + (tr - this.duck) * this.duckRel;
      const sg = width * (1 - 0.7 * this.duck);
      this.movePh += moveHz / sr;
      if (this.movePh >= 1) this.movePh -= 1;
      const pm = move * Math.sin(TAU * this.movePh);
      wetL[i] = M + S * sg * (1 + pm);
      wetR[i] = M - S * sg * (1 - pm);
      midAcc = this.midEnv.process(M);
      sideAcc = this.sideEnv.process(S * sg);
    }
    this.cur['cvout:mid'].fill(clamp(midAcc * 2.5, 0, 1));
    this.cur['cvout:side'].fill(clamp(sideAcc * 4, 0, 1));
  }
}

