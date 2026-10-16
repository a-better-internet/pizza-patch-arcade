import { Effect } from '../module.js';
import { FDN4, Env, Oversampler, OnePole, sat, expMap, smoothstep, smoothCoef, clamp, flush } from '../util.js';

const PARTIALS = 8;
const OS2_LATENCY = new Oversampler(2).latency;

// Two-pole modal resonator normalised to a unit-amplitude impulse response.
class Mode {
  constructor() {
    this.y1 = 0;
    this.y2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.b0 = 0;
  }
  set(hz, t60, sr) {
    const w = (2 * Math.PI * hz) / sr;
    const r = Math.exp(-6.91 / (t60 * sr));
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -r * r;
    this.b0 = Math.sin(w) * (1 - r) * 160; // input normalisation (sustained gain ~80)
  }
  process(x) {
    let y = this.b0 * x + this.a1 * this.y1 + this.a2 * this.y2;
    if (y > 1.5 || y < -1.5) {
      // keep a sustained, exactly-tuned input from building without bound
      y = 1.5 * sat(y / 1.5);
      this.y1 = 1.5 * sat(this.y1 / 1.5);
    }
    this.y2 = this.y1;
    this.y1 = flush(y);
    return y;
  }
  reset() {
    this.y1 = this.y2 = 0;
  }
}

// Static Bloom: transients strike a bank of tuned partials that ring, saturate
// and smear into a reverb tail. Partials above ~6.5 kHz are never generated, so
// the bloom stays bell-like instead of glassy.
export class StaticBloom extends Effect {
  constructor(engine, spec) {
    super(engine, spec, { latency: OS2_LATENCY });
    const sr = this.sr;
    this.modes = [Array.from({ length: PARTIALS }, () => new Mode()), Array.from({ length: PARTIALS }, () => new Mode())];
    this.w = new Float64Array(PARTIALS);
    this.fast = new Env(sr, 0.0005, 0.02);
    this.slow = new Env(sr, 0.02, 0.25);
    this.os = [new Oversampler(2), new Oversampler(2)];
    this.rev = new FDN4(sr, [29.7, 37.1, 41.1, 43.7], 4500);
    this.lazy = 0;
    this.lazyAtt = smoothCoef(0.25, sr);
    this.lazyRel = smoothCoef(1.2, sr);
    this.lastKey = '';
    this.preLp = [new OnePole(sr, 7000), new OnePole(sr, 7000)];
    this.wetLp = [new OnePole(sr, 9000), new OnePole(sr, 9000)];
    // the wet path's resonators react instantly; dry is aligned to the oversampler
  }

  reset() {
    for (const ch of this.modes) for (const m of ch) m.reset();
    this.fast.reset();
    this.slow.reset();
    for (const o of this.os) o.reset();
    this.rev.clear();
    this.lazy = 0;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr;
    const L = this.loop;
    const f0 = expMap(p.color, 55, 440);
    const t60 = expMap(p.bloom, 0.15, 6) * (1 + 1.5 * L);
    const stretch = p.harm * 0.0035;
    const alpha = 1.6 - 1.9 * p.texture; // partial tilt: warm .. bright
    let wsum = 0;
    for (let k = 0; k < PARTIALS; k++) {
      const n = k + 1;
      const hz = f0 * n * (1 + stretch * (n - 1) * n);
      const fade = 1 - smoothstep(4000, 6500, hz);
      this.w[k] = Math.pow(n, -alpha) * fade;
      wsum += this.w[k];
      this.modes[0][k].set(Math.min(hz, 7000), t60, sr);
      this.modes[1][k].set(Math.min(hz * 1.004, 7000), t60, sr);
    }
    const norm = wsum > 0 ? 1.6 / wsum : 0;
    for (let k = 0; k < PARTIALS; k++) this.w[k] *= norm;
    const density = clamp(p.density + 0.5 * L, 0, 1.4);
    const drive = 1 + 3 * p.harm;
    const revAmt = p.reverb;
    this.rev.setDecay(0.8 + 3.5 * revAmt);
    const ins = [inL, inR], outs = [wetL, wetR];
    const res = [0, 0];
    for (let i = 0; i < 64; i++) {
      const mono = 0.5 * (inL[i] + inR[i]);
      const f = this.fast.process(mono), s = this.slow.process(mono);
      const tr = clamp((f - 1.15 * s) / (s + 2e-3), 0, 1);
      const exGain = density * (0.02 + 1.6 * tr);
      for (let c = 0; c < 2; c++) {
        const x = this.preLp[c].process(ins[c][i]) * exGain;
        const ms = this.modes[c];
        let y = 0;
        for (let k = 0; k < PARTIALS; k++) y += ms[k].process(x) * this.w[k];
        // harmonic generation, 2x oversampled
        const up = this.os[c].upsample(y);
        up[0] = sat(up[0] * drive) / Math.sqrt(drive);
        up[1] = sat(up[1] * drive) / Math.sqrt(drive);
        res[c] = this.os[c].downsample(up);
      }
      this.rev.process(res[0] * revAmt, res[1] * revAmt, 0);
      const l = res[0] + this.rev.outL * 0.45 * revAmt;
      const r = res[1] + this.rev.outR * 0.45 * revAmt;
      outs[0][i] = this.wetLp[0].process(l);
      outs[1][i] = this.wetLp[1].process(r);
      const e = Math.abs(l) + Math.abs(r);
      this.lazy += (e > this.lazy ? this.lazyAtt : this.lazyRel) * (e - this.lazy);
    }
    this.cur['cvout:bloom'].fill(clamp(this.lazy * 2, 0, 1));
  }
}
