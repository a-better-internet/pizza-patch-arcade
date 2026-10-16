import { Effect } from '../module.js';
import { DelayLine, SVF, Env, sat, expMap, clamp, TAU } from '../util.js';

// Reactor FM: phase modulation of the incoming audio (a modulated delay) by an
// internal sine, or by whatever is patched into the Mod input. The modulator is
// band-limited to 6 kHz and the output to 12 kHz, so deep FM gives sidebands
// rather than aliasing grit.
export class ReactorFM extends Effect {
  constructor(engine, spec) {
    const D0 = Math.round(0.0015 * engine.sr);
    super(engine, spec, { latency: D0 });
    this.D0 = D0;
    this.in2IsInput = false;
    const sr = this.sr;
    this.dl = [new DelayLine(D0 * 2 + 16), new DelayLine(D0 * 2 + 16)];
    this.modLp = [new SVF(sr), new SVF(sr)];
    this.post = [new SVF(sr), new SVF(sr)];
    for (const f of this.modLp) f.set(6000, 0.6);
    for (const f of this.post) f.set(9000, 0.6);
    this.env = new Env(sr, 0.003, 0.12);
    this.ph = 0;
    this.e = 0;
  }

  reset() {
    for (const d of this.dl) d.clear();
    for (const f of this.modLp) f.reset();
    for (const f of this.post) f.reset();
    this.env.reset();
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr;
    const c = this.inConnected;
    const extMod = c.in2L || c.in2R;
    const mL = c.in2L || !c.in2R ? this.in.in2L : this.in.in2R;
    const mR = c.in2R || !c.in2L ? this.in.in2R : this.in.in2L;
    const hz = expMap(p.freq, 20, 4000);
    const drive = 1 + p.mod * 8;
    const dnorm = 1 / sat(drive);
    const envAmt = (p.env - 0.5) * 2;
    const am = p.am;
    const maxDev = this.D0 - 3;
    // high modulator frequencies get a smaller index so deep FM stays musical
    const idxScale = extMod ? 1 : Math.min(1, Math.sqrt(600 / hz));
    const depth = Math.min(maxDev, 0.0012 * sr * p.fm * p.fm * idxScale);
    const ins = [inL, inR], outs = [wetL, wetR];
    for (let i = 0; i < 64; i++) {
      this.ph += hz / sr;
      if (this.ph >= 1) this.ph -= 1;
      const osc = Math.sin(TAU * this.ph);
      const e = this.env.process(0.5 * (inL[i] + inR[i]));
      this.e = e;
      const ev = Math.min(1, e * 3);
      // Env Follow: below centre ducks FM on transients, above pushes it forward
      const scale = envAmt < 0 ? 1 + envAmt * ev : 1 + envAmt * ev * 1.5;
      const dev = clamp(depth * scale, 0, maxDev);
      for (let ch = 0; ch < 2; ch++) {
        let m = extMod ? (ch === 0 ? mL[i] : mR[i]) * 2 : osc;
        m = this.modLp[ch].process(sat(m * drive) * dnorm);
        const x = ins[ch][i];
        const dl = this.dl[ch];
        dl.write(x);
        let y = dl.tapHermite(this.D0 + 1 + dev * m);
        y *= 1 - am + am * m;
        outs[ch][i] = this.post[ch].process(y);
      }
    }
    this.cur['cvout:env'].fill(clamp(this.e * 2.5, 0, 1));
  }
}
