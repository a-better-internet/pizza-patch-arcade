import { Effect } from '../module.js';
import { Oversampler, SVF, DCBlocker, Env, sat, expMap, dbToGain, clamp, smoothstep, fastSin, fastCos } from '../util.js';

const PI = Math.PI;
const HALF_PI_F = Math.PI / 2;
const OS4_LATENCY = new Oversampler(4).latency;

// Band-limited "digital wrap": a Lanczos-smoothed Fourier series of the
// sawtooth transfer curve. It wraps like an overflowing integer but has no
// discontinuity, so it cannot spray aliasing across the spectrum.
const WRAP_TERMS = 5;
const WRAP_COEF = [];
for (let k = 1; k <= WRAP_TERMS; k++) {
  const sigma = Math.sin((PI * k) / (WRAP_TERMS + 1)) / ((PI * k) / (WRAP_TERMS + 1));
  WRAP_COEF.push(((2 / PI) * (k % 2 ? 1 : -1) * sigma) / k);
}
function wrap(x) {
  // sin(k*t) by Chebyshev recurrence: two trig calls instead of five
  const t = PI * x;
  const s1 = fastSin(t), c2 = 2 * fastCos(t);
  let sPrev = 0, sCur = s1, y = WRAP_COEF[0] * s1;
  for (let k = 1; k < WRAP_TERMS; k++) {
    const sNext = c2 * sCur - sPrev;
    sPrev = sCur;
    sCur = sNext;
    y += WRAP_COEF[k] * sCur;
  }
  return y;
}

// The transfer curve: zone crossfade (soft clip -> fold -> wrap) followed by
// cascaded sine folding for the Harmonics knob.
function shapeCurve(u, fold, zoneA, a, harm) {
  let y;
  const folded = fastSin(HALF_PI_F * fold * u);
  if (zoneA) y = (1 - a) * sat(u) + a * folded;
  else y = (1 - a) * folded + a * wrap(0.5 * fold * u);
  if (harm > 0) {
    const h1 = fastSin(PI * y * (0.5 + harm));
    y = y + harm * (h1 - y);
    const h2 = fastSin(PI * y * (0.5 + 0.5 * harm));
    y = y + 0.5 * harm * (h2 - y);
  }
  return y;
}

// Overmind: wavefolder and distortion tour, 4x oversampled.
export class Overmind extends Effect {
  constructor(engine, spec) {
    super(engine, spec, { latency: OS4_LATENCY });
    const sr = this.sr;
    this.os = [new Oversampler(4), new Oversampler(4)];
    this.dc = [new DCBlocker(sr, 12), new DCBlocker(sr, 12)];
    this.lp = [new SVF(sr), new SVF(sr)];
    this.post = [new SVF(sr), new SVF(sr)];
    this.env = new Env(sr, 0.002, 0.12);
    this.hold = [0, 0];
    this.holdPh = 0;
    this.mut = [0, 0, 0];
    this.mutT = [0, 0, 0];
    this.mutTarget = [0, 0, 0];
    this.rIn = 0;
    this.rOut = 0;
    this.makeup = 0.5;
    this.rc = 1 - Math.exp(-1 / (0.3 * sr));
    this.mc = 1 - Math.exp(-1 / (0.25 * sr));
  }

  reset() {
    for (const o of this.os) o.reset();
    for (const d of this.dc) d.reset();
    for (const f of this.lp) f.reset();
    for (const f of this.post) f.reset();
    this.env.reset();
    this.rIn = this.rOut = 0;
    this.makeup = 0.5;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr, rng = this.rng;
    const dt = 64 / sr;
    // in a loop the transfer curve mutates so no two passes are shaped alike
    for (let k = 0; k < 3; k++) {
      if ((this.mutT[k] -= dt) <= 0) {
        this.mutT[k] = 0.4 + rng.next() * 1.6;
        this.mutTarget[k] = rng.bi();
      }
      this.mut[k] += (this.mutTarget[k] - this.mut[k]) * Math.min(1, dt * 1.5);
    }
    const L = this.loop;
    const drive = dbToGain(p.drive * 24);
    const fold = (1 + p.fold * 5) * (1 + 0.45 * L * this.mut[0]);
    const bias = (p.bias - 0.5) * 1.2 + 0.35 * L * this.mut[1];
    const harm = clamp(p.harm + 0.3 * L * this.mut[2], 0, 1);
    const shapeBase = p.shape;
    // Character: low-pass below 50%, sample-rate decimation above
    const ch = p.char;
    let lpHz = 18000, decim = 1;
    if (ch < 0.5) lpHz = expMap(ch * 2, 900, 18000);
    else decim = expMap((ch - 0.5) * 2, 1, 0.08);
    const decHz = sr * decim;
    const postHz = clamp(decim < 1 ? decHz * 0.9 : 12000, 1800, 12000);
    for (let c = 0; c < 2; c++) {
      this.lp[c].set(lpHz, 0.6);
      this.post[c].set(postHz, 0.65);
    }
    const ins = [inL, inR], outs = [wetL, wetR];
    for (let i = 0; i < 64; i++) {
      const e = this.env.process(0.5 * (inL[i] + inR[i]));
      // an envelope follower pushes the shape forward on transients
      const s = clamp(shapeBase + smoothstep(0.02, 0.4, e) * 0.3, 0, 1);
      const zoneA = s < 0.5;
      const a = zoneA ? s * 2 : (s - 0.5) * 2;
      // subtracting the curve's value at the bias point keeps silence silent:
      // a slowly moving Bias, Harmonics or loop mutation can never leak through
      const zero = shapeCurve(bias, fold, zoneA, a, harm);
      for (let c = 0; c < 2; c++) {
        const up = this.os[c].upsample(ins[c][i] * drive + bias);
        for (let k = 0; k < 4; k++) up[k] = shapeCurve(up[k], fold, zoneA, a, harm) - zero;
        let y = this.os[c].downsample(up);
        y = this.dc[c].process(y);
        if (decim < 1) {
          if (c === 0) {
            this.holdPh += decim;
            this.doHold = this.holdPh >= 1;
            if (this.doHold) this.holdPh -= 1;
          }
          if (this.doHold) this.hold[c] = y;
          y = this.hold[c];
        }
        y = this.lp[c].process(y);
        y = this.post[c].process(y);
        outs[c][i] = y;
      }
      // loudness compensation: match the wet energy to the input energy
      const xi = inL[i] * inL[i] + inR[i] * inR[i];
      const yo = wetL[i] * wetL[i] + wetR[i] * wetR[i];
      this.rIn += this.rc * (xi - this.rIn);
      this.rOut += this.rc * (yo - this.rOut);
      if (this.rIn > 1e-7) {
        // capped near unity so a loop through Overmind cannot pump itself up
        const want = clamp(Math.sqrt(this.rIn / (this.rOut + 1e-12)), 0.2, 1.15);
        this.makeup += (want - this.makeup) * this.mc;
      }
      wetL[i] *= this.makeup;
      wetR[i] *= this.makeup;
    }
  }
}

