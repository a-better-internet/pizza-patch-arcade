import { Effect } from '../module.js';
import { DelayLine, Allpass, OnePole, DCBlocker, sat, expMap, smoothCoef, TAU, clamp } from '../util.js';
import { stepIndex, ECHO_RATE_STEPS } from '../../spec.js';

// Echoforge: tempo-synced delay whose repeats can melt into a diffuse wash.
// The regeneration path is low-passed, high-passed and soft-saturated, so even
// near-unity feedback settles into a bounded tail instead of running away.
export class Echoforge extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    const maxS = sr * 6.6;
    this.dl = [new DelayLine(maxS), new DelayLine(maxS)];
    const ap = (ms) => Math.round((ms / 1000) * sr);
    this.diff = [
      [ap(4.7), ap(7.1), ap(11.3), ap(17.9)].map((n) => new Allpass(n)),
      [ap(5.3), ap(7.9), ap(12.1), ap(19.3)].map((n) => new Allpass(n)),
    ];
    this.lp = [new OnePole(sr, 8000), new OnePole(sr, 8000)];
    this.hp = [new OnePole(sr, 70), new OnePole(sr, 70)];
    this.dc = [new DCBlocker(sr, 10), new DCBlocker(sr, 10)];
    this.time = [sr * 0.375, sr * 0.375];
    this.glide = smoothCoef(0.09, sr);
    this.ph = [0, 0.25];
    this.inGain = 1;
    this.freezeG = 0;
    this.fz = smoothCoef(0.03, sr);
  }

  reset() {
    for (const d of this.dl) d.clear();
    for (const ch of this.diff) for (const a of ch) a.clear();
    for (const f of this.lp) f.reset();
    for (const f of this.hp) f.reset();
    for (const f of this.dc) f.reset();
  }

  processWet(inL, inR, wetL, wetR) {
    const sr = this.sr, p = this.p;
    const bar = (4 * 60) / this.engine.bpm;
    const n = stepIndex(p.rate, ECHO_RATE_STEPS) + 1;
    // in a loop the repeats progressively shorten, tightening into a shimmer
    const base = (n / 32) * bar * (1 - 0.72 * this.loop);
    const s = (p.spread - 0.5) * 2;
    const tgt = [clamp(base * (1 - 0.25 * s), 0.01, 6.2) * sr, clamp(base * (1 + 0.25 * s), 0.01, 6.2) * sr];
    const freeze = this.btn.freeze;
    const fb = 0.98 * p.fdbk;
    const g = 0.72 * p.density;
    const dif = p.diffuse;
    const cut = expMap(1 - dif, 1400, 15000);
    this.lp[0].set(cut);
    this.lp[1].set(cut);
    const chorus = dif * 0.0025 * sr * (freeze ? 0 : 1);
    const rates = [0.31 / sr, 0.37 / sr];
    const ins = [inL, inR], outs = [wetL, wetR];
    const fzTarget = freeze ? 1 : 0;
    let fzg = this.freezeG;
    for (let c = 0; c < 2; c++) {
      const dl = this.dl[c], dif4 = this.diff[c], lp = this.lp[c], hp = this.hp[c], dc = this.dc[c];
      const x = ins[c], y = outs[c];
      let t = this.time[c], ph = this.ph[c];
      fzg = this.freezeG;
      for (let i = 0; i < 64; i++) {
        t += (tgt[c] - t) * this.glide;
        ph += rates[c];
        if (ph >= 1) ph -= 1;
        fzg += (fzTarget - fzg) * this.fz;
        const d = t + chorus * (1 + Math.sin(TAU * ph));
        let r = dl.tapHermite(d);
        r = dif4[0].process(r, g);
        r = dif4[1].process(r, g);
        r = dif4[2].process(r, g * 0.9);
        r = dif4[3].process(r, g * 0.8);
        y[i] = r;
        // regeneration: filtered + bounded normally, lossless when frozen
        let f = lp.process(r);
        f = f - hp.process(f);
        f = sat(fb * dc.process(f));
        const w = (1 - fzg) * (x[i] + f) + fzg * r;
        dl.write(w);
      }
      this.time[c] = t;
      this.ph[c] = ph;
    }
    this.freezeG = fzg;
  }
}
