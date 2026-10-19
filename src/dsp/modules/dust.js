import { Effect } from '../module.js';
import { DelayLine, SVF, Biquad, OnePole, Env, expMap, dbToGain, gainToDb, smoothCoef, TAU, clamp, flush } from '../util.js';

// Dust Engine: vinyl and tape noise.
//
// Noise hygiene: the surface noise is pink and low-passed (it opens toward
// "hiss" only up to ~5 kHz), it ducks under the music, and a silence gate fades
// the noise and crackle out entirely when no signal has been playing for a
// moment, so the rack never sits there hissing on its own.
export class DustEngine extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.pink = [new Float64Array(3), new Float64Array(3)];
    this.noiseLp = [new SVF(sr), new SVF(sr)];
    this.noiseHp = [new OnePole(sr, 70), new OnePole(sr, 70)];
    this.busLp = [new Biquad(sr).lowpass(7000, 0.6), new Biquad(sr).lowpass(7000, 0.6)];
    this.popLp = [new Biquad(sr).lowpass(7000, 0.6), new Biquad(sr).lowpass(7000, 0.6)];
    this.tick = [new SVF(sr), new SVF(sr)];
    this.thump = [new SVF(sr), new SVF(sr)];
    this.inEnv = new Env(sr, 0.01, 0.3);
    this.silent = 0;
    this.gate = 0;
    this.gOpen = smoothCoef(0.05, sr);
    this.gClose = smoothCoef(0.8, sr);
    this.warp = [new DelayLine(sr * 0.01), new DelayLine(sr * 0.01)];
    this.warpPh = 0;
    this.hold = [0, 0];
    this.holdPh = 0;
    this.oxLp = [new SVF(sr), new SVF(sr)];
    this.compEnv = 0;
    this.compA = smoothCoef(0.005, sr);
    this.compR = smoothCoef(0.09, sr);
    this.compG = 1;
    this.compGc = smoothCoef(0.01, sr);
    this.popPulse = 0;
  }

  reset() {
    for (const p of this.pink) p.fill(0);
    for (const f of this.noiseLp) f.reset();
    for (const f of this.noiseHp) f.reset();
    for (const f of this.busLp) f.reset();
    for (const f of this.popLp) f.reset();
    for (const f of this.tick) f.reset();
    for (const f of this.thump) f.reset();
    for (const d of this.warp) d.clear();
    for (const f of this.oxLp) f.reset();
    this.hold[0] = this.hold[1] = 0;
    this.inEnv.reset();
    this.gate = 0;
    this.silent = 10; // stay closed until signal arrives (no noise out of a reset)
    this.compEnv = 0;
    this.compG = 1;
  }

  pinkNoise(c) {
    const b = this.pink[c];
    const w = this.rng.bi();
    b[0] = 0.99765 * b[0] + w * 0.099046;
    b[1] = 0.963 * b[1] + w * 0.2965164;
    b[2] = 0.57 * b[2] + w * 1.0526913;
    return (b[0] + b[1] + b[2] + w * 0.1848) * 0.2;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr, rng = this.rng;
    const L = this.loop;
    const wear = p.wear;
    const noiseLevel = Math.pow(wear, 1.5) * dbToGain(-24);
    const noiseCut = expMap(wear, 500, 5000);
    this.noiseLp[0].set(noiseCut, 0.6);
    this.noiseLp[1].set(noiseCut, 0.6);
    const popRate = p.dust * p.dust * 14 + L * 2;
    const ox = clamp(p.oxidize + L * 0.25, 0, 1);
    const decim = ox > 0.001 ? expMap(ox, 1, 0.09) : 1;
    // each trip around a loop costs bit depth, but at most 2 bits: in a quiet
    // self-sustaining loop, deeper undithered quantisation becomes a hiss floor
    const bits = clamp(16 - p.bit * 13 - L * 2, 2.5, 16);
    const q = Math.pow(2, bits - 1);
    const quantise = bits < 15.9;
    // fidelity low-pass after decimation / quantisation: keeps the grit, drops the fizz
    const oxCut = Math.min(clamp(sr * decim * 0.45, 2500, 16000), expMap(clamp((bits - 2.5) / 13.5, 0, 1), 4500, 16000));
    const fidelity = decim < 1 || quantise;
    this.oxLp[0].set(oxCut, 0.6);
    this.oxLp[1].set(oxCut, 0.6);
    const warp = (p.warp - 0.5) * 2;
    const wDepth = Math.abs(warp) * 0.0016 * sr;
    const wRate = (0.4 + Math.abs(warp) * 5) / sr;
    const wDir = warp >= 0 ? 1 : -1;
    const comp = p.comp;
    const dt = 1 / sr;
    let popped = false;
    for (let i = 0; i < 64; i++) {
      const xl = inL[i], xr = inR[i];
      const e = this.inEnv.process(Math.max(Math.abs(xl), Math.abs(xr)));
      // silence gate for the noise bed
      if (e < 0.001) this.silent += dt;
      else this.silent = 0;
      const gWant = this.silent > 1.2 ? 0 : 1;
      this.gate = flush(this.gate + (gWant > this.gate ? this.gOpen : this.gClose) * (gWant - this.gate));
      // --- music path: warp -> oxidize -> bit depth
      this.warpPh += wRate;
      if (this.warpPh >= 1) this.warpPh -= 1;
      const ang = TAU * this.warpPh;
      const dl = 2 + wDepth * (1 + Math.sin(ang));
      const dr = 2 + wDepth * (1 + wDir * Math.cos(ang));
      this.warp[0].write(xl);
      this.warp[1].write(xr);
      let l = wDepth > 0 ? this.warp[0].tapHermite(dl + 1) : xl;
      let r = wDepth > 0 ? this.warp[1].tapHermite(dr + 1) : xr;
      if (decim < 1) {
        this.holdPh += decim;
        if (this.holdPh >= 1) {
          this.holdPh -= 1;
          this.hold[0] = l;
          this.hold[1] = r;
        }
        l = this.hold[0];
        r = this.hold[1];
      }
      if (quantise) {
        // no dither: digital silence stays silent
        l = Math.round(l * q) / q;
        r = Math.round(r * q) / q;
      }
      if (fidelity) {
        l = this.oxLp[0].process(l);
        r = this.oxLp[1].process(r);
      }
      // --- noise bed, ducked under the music
      const duck = 1 / (1 + 8 * e);
      let nl = 0, nr = 0;
      if (noiseLevel > 0 && this.gate > 1e-4) {
        const g = noiseLevel * duck * this.gate;
        let a = this.noiseLp[0].process(this.pinkNoise(0));
        let b = this.noiseLp[1].process(this.pinkNoise(1));
        a -= this.noiseHp[0].process(a);
        b -= this.noiseHp[1].process(b);
        nl = a * g;
        nr = b * g;
      }
      // --- crackle: bright ticks with a share of deeper woody thumps.
      // A unit kick into the filter state rings at ~0.8-0.9 peak, so the
      // loudest pop peaks near -16 dBFS.
      if (this.gate > 1e-3 && rng.next() < popRate * dt) {
        const amp = dbToGain(-38 + 22 * rng.next()) * this.gate * 1.15;
        const pan = rng.next();
        const gl = Math.cos(pan * 1.5708), gr = Math.sin(pan * 1.5708);
        if (rng.next() < 0.75) {
          const f = 1800 + 2600 * rng.next();
          for (const t of this.tick) t.set(f, 1.6);
          this.tick[0].ic1 += amp * gl;
          this.tick[1].ic1 += amp * gr;
        } else {
          const f = 220 + 380 * rng.next();
          for (const t of this.thump) t.set(f, 2.5);
          this.thump[0].ic1 += amp * gl * 0.8;
          this.thump[1].ic1 += amp * gr * 0.8;
        }
        popped = true;
      }
      this.tick[0].process(0);
      this.tick[1].process(0);
      this.thump[0].process(0);
      this.thump[1].process(0);
      l += this.busLp[0].process(nl);
      r += this.busLp[1].process(nr);
      let rush = 1;
      // --- OTT-style compression: squash peaks, lift quiet passages (never silence)
      if (comp > 0) {
        const a = Math.max(Math.abs(l), Math.abs(r));
        this.compEnv = flush(this.compEnv + (a > this.compEnv ? this.compA : this.compR) * (a - this.compEnv));
        const lvl = gainToDb(this.compEnv);
        let gdb = 0;
        if (lvl > -20) gdb = -(lvl + 20) * 0.75 * comp;
        else if (lvl > -62) gdb = Math.min(-(lvl + 20) * 0.5, 14) * comp * smoothstepLin(-62, -50, lvl);
        const gt = dbToGain(gdb);
        this.compG += (gt - this.compG) * this.compGc;
        l *= this.compG;
        r *= this.compG;
        // crackle "rushes in between hits": it follows the upward gain, bounded
        rush = Math.min(2, Math.max(1, this.compG));
      }
      // pops join after the compressor so a pop can never ride a lifted gain
      // into a spike
      l += this.popLp[0].process(this.tick[0].bp + this.thump[0].lp) * rush;
      r += this.popLp[1].process(this.tick[1].bp + this.thump[1].lp) * rush;
      wetL[i] = l;
      wetR[i] = r;
    }
    if (popped) this.popPulse = 2;
    this.cur['cvout:crack'].fill(this.popPulse > 0 ? 1 : 0);
    if (this.popPulse > 0) this.popPulse--;
  }
}

function smoothstepLin(a, b, x) {
  return clamp((x - a) / (b - a), 0, 1);
}
