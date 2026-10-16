import { Effect } from '../module.js';
import { DelayLine, Allpass, OnePole, FDN4, DCBlocker, sat, expMap, smoothCoef, TAU, clamp, flush } from '../util.js';

// Octave-up pitch shifter: two crossfaded read heads sweeping a short window.
class OctaveUp {
  constructor(sr) {
    this.W = Math.round(0.06 * sr);
    this.dl = new DelayLine(this.W + 8);
    this.ph = 0;
  }
  process(x) {
    this.ph += 1 / this.W;
    if (this.ph >= 1) this.ph -= 1;
    const p2 = this.ph + 0.5 >= 1 ? this.ph - 0.5 : this.ph + 0.5;
    const a = this.dl.tap(2 + this.W * (1 - this.ph));
    const b = this.dl.tap(2 + this.W * (1 - p2));
    const s1 = Math.sin(Math.PI * this.ph), s2 = Math.sin(Math.PI * p2);
    this.dl.write(x);
    return a * s1 * s1 + b * s2 * s2;
  }
  clear() {
    this.dl.clear();
  }
}

// Spectral Ghost: delay with cascaded blur, pitch drift and a shimmer tank.
// The shimmer loop is band-limited (200 Hz .. 5 kHz) and its gain stays below
// unity, so stacked octaves fade out before they can turn shrill.
export class SpectralGhost extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.dl = [new DelayLine(sr * 1.25), new DelayLine(sr * 1.25)];
    const ms = (v) => Math.round((v / 1000) * sr);
    this.blur = [
      [3.1, 5.3, 8.9, 13.7, 21.1].map((v) => new Allpass(ms(v))),
      [3.7, 6.1, 9.7, 14.9, 22.7].map((v) => new Allpass(ms(v))),
    ];
    this.lp = [new OnePole(sr, 7000), new OnePole(sr, 7000)];
    this.hp = [new OnePole(sr, 80), new OnePole(sr, 80)];
    this.dc = [new DCBlocker(sr, 10), new DCBlocker(sr, 10)];
    this.tank = new FDN4(sr, [47.3, 59.9, 71.3, 83.9], 4200);
    this.tank.setDecay(4.5);
    this.shift = [new OctaveUp(sr), new OctaveUp(sr)];
    this.shLp = [new OnePole(sr, 5000), new OnePole(sr, 5000)];
    this.shHp = [new OnePole(sr, 200), new OnePole(sr, 200)];
    this.shFb = [0, 0];
    this.time = [0.2 * sr, 0.2 * sr];
    this.glide = smoothCoef(0.15, sr);
    this.drift = 0;
    this.driftT = 0;
    this.driftTarget = 0;
    this.driftPh = 0;
    this.fz = 0;
    this.fzc = smoothCoef(0.03, sr);
    this.recover = 1;
    this.recoverState = 0; // 0 idle, 1 fading out, 2 fading in
  }

  onButton(id, v) {
    if (id === 'recover' && v) this.recoverState = 1;
  }

  clearAll() {
    for (const d of this.dl) d.clear();
    for (const ch of this.blur) for (const a of ch) a.clear();
    for (const f of this.lp) f.reset();
    for (const f of this.hp) f.reset();
    this.tank.clear();
    for (const s of this.shift) s.clear();
    this.shFb[0] = this.shFb[1] = 0;
  }

  reset() {
    this.clearAll();
    this.recover = 1;
    this.recoverState = 0;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr, rng = this.rng;
    const dt = 64 / sr;
    const base = expMap(p.time, 0.02, 0.9) * sr;
    const wd = p.width;
    const tgt = [base, clamp(base * (1 + 0.25 * wd), 0, 1.15 * sr)];
    const freeze = this.btn.freeze;
    const fb = 0.92 * p.decay;
    const g = 0.68 * p.blur;
    const xfeed = 0.25 * wd;
    // pitch drift: slow random detune of the tail; grows the longer it loops
    if ((this.driftT -= dt) <= 0) {
      this.driftT = 1 + 2 * rng.next();
      this.driftTarget = rng.bi();
    }
    this.drift += (this.driftTarget - this.drift) * Math.min(1, dt * 0.6);
    const driftDepth = (p.pitch * 0.004 + this.loop * 0.004) * sr;
    const shim = p.shimmer;
    // Recover: quick fade, wipe buffers and tank, fade back in
    if (this.recoverState === 1) {
      this.recover -= dt / 0.02;
      if (this.recover <= 0) {
        this.recover = 0;
        this.clearAll();
        this.recoverState = 2;
      }
    } else if (this.recoverState === 2) {
      this.recover += dt / 0.02;
      if (this.recover >= 1) {
        this.recover = 1;
        this.recoverState = 0;
      }
    }
    const rec = this.recover;
    const fzT = freeze ? 1 : 0;
    const ins = [inL, inR], outs = [wetL, wetR];
    const rd = [0, 0];
    for (let i = 0; i < 64; i++) {
      this.fz += (fzT - this.fz) * this.fzc;
      const fz = this.fz;
      this.driftPh += 0.17 / sr;
      if (this.driftPh >= 1) this.driftPh -= 1;
      const mod = driftDepth * (1 + 0.6 * this.drift + 0.4 * Math.sin(TAU * this.driftPh));
      for (let c = 0; c < 2; c++) {
        this.time[c] += (tgt[c] - this.time[c]) * this.glide;
        let r = this.dl[c].tapHermite(this.time[c] + mod + 2);
        const bl = this.blur[c];
        for (let k = 0; k < bl.length; k++) r = bl[k].process(r, g * (1 - 0.08 * k));
        rd[c] = r;
      }
      for (let c = 0; c < 2; c++) {
        const other = rd[1 - c];
        let f = this.lp[c].process(rd[c] * (1 - xfeed) + other * xfeed);
        f = f - this.hp[c].process(f);
        f = sat(fb * this.dc[c].process(f));
        const w = (1 - fz) * (ins[c][i] * rec + f) + fz * rd[c];
        this.dl[c].write(w);
      }
      // shimmer: tail -> tank; tank -> octave up -> back into the tank
      let sl = 0, sr2 = 0;
      if (shim > 0.001) {
        this.tank.process((rd[0] + this.shFb[0]) * shim, (rd[1] + this.shFb[1]) * shim, 0);
        for (let c = 0; c < 2; c++) {
          const t = c === 0 ? this.tank.outL : this.tank.outR;
          let u = this.shift[c].process(t);
          u = this.shLp[c].process(u);
          u -= this.shHp[c].process(u);
          this.shFb[c] = flush(sat(u * 0.5) * 0.9);
        }
        sl = this.tank.outL;
        sr2 = this.tank.outR;
      } else {
        this.shFb[0] = this.shFb[1] = 0;
      }
      outs[0][i] = (rd[0] + sl * 0.35 * shim) * rec;
      outs[1][i] = (rd[1] + sr2 * 0.35 * shim) * rec;
    }
  }
}
