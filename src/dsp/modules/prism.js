import { Effect } from '../module.js';
import { SVF, sat, expMap, smoothstep, clamp } from '../util.js';
import { DETUNE_INTERVALS } from '../../spec.js';

// Resonance -> damping k. Above ~80% k goes negative and the band self-oscillates;
// the band state is soft-bounded so the oscillation settles at a fixed level.
// High bands get less resonance (and cannot self-oscillate above ~2.5 kHz), so
// the filter never whistles at ear-piercing frequencies.
function dampingFor(res, hz) {
  const guard = 1 - 0.55 * smoothstep(1800, 8000, hz);
  const r = res * guard;
  if (r < 0.8) return 1.4 * Math.pow(0.012 / 1.4, r / 0.8); // Q 0.7 .. ~80
  const over = (r - 0.8) / 0.2;
  return hz > 2500 ? 0.012 : -0.06 * over;
}

// Prism Engine: dual resonant multimode filter.
export class PrismEngine extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.f = [[new SVF(sr), new SVF(sr)], [new SVF(sr), new SVF(sr)]]; // [channel][band]
    this.drift = [0, 0];
    this.driftTarget = [0, 0];
    this.driftT = [0, 0];
    this.apart = 0;
  }

  reset() {
    for (const ch of this.f) for (const s of ch) s.reset();
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, rng = this.rng, sr = this.sr;
    const dt = 64 / sr;
    const f0 = expMap(p.bands, 100, 8000);
    const spread = (p.spread - 0.5) * 2;
    // detune glides between musical intervals, dwelling on each
    const pos = clamp(p.detune, 0, 1) * (DETUNE_INTERVALS.length - 1);
    const i0 = Math.min(DETUNE_INTERVALS.length - 2, Math.floor(pos));
    const t = smoothstep(0.3, 0.7, pos - i0);
    const semis = DETUNE_INTERVALS[i0] + (DETUNE_INTERVALS[i0 + 1] - DETUNE_INTERVALS[i0]) * t;
    // separation: each band random-walks on its own; in a loop they drift apart
    const sep = p.sep + this.loop * 0.6;
    for (let b = 0; b < 2; b++) {
      if ((this.driftT[b] -= dt) <= 0) {
        this.driftT[b] = 0.6 + 1.8 * rng.next();
        this.driftTarget[b] = rng.bi();
      }
      this.drift[b] += (this.driftTarget[b] - this.drift[b]) * Math.min(1, dt * 0.8);
    }
    this.apart = this.loop * 0.7;
    const res = p.res;
    const m = p.morph;
    const wLP = m < 0.5 ? 1 - m * 2 : 0;
    const wBP = m < 0.5 ? m * 2 : 2 - m * 2;
    const wHP = m < 0.5 ? 0 : m * 2 - 1;
    const ins = [inL, inR], outs = [wetL, wetR];
    for (let c = 0; c < 2; c++) {
      const chSpread = c === 0 ? -spread : spread;
      const fa = clamp(f0 * Math.pow(2, chSpread * 0.5 + sep * this.drift[0] * 0.8 - this.apart), 40, 9000);
      const fb = clamp(f0 * Math.pow(2, semis / 12 + chSpread * 0.5 + sep * this.drift[1] * 0.8 + this.apart), 40, 9000);
      const ka = dampingFor(res, fa), kb = dampingFor(res, fb);
      const [A, Bf] = this.f[c];
      A.setK(fa, ka);
      Bf.setK(fb, kb);
      // resonance gain compensation keeps the peak within ~+12 dB
      const ga = Math.min(1, Math.pow(Math.max(ka, 0.004) * 4, 0.4));
      const gb = Math.min(1, Math.pow(Math.max(kb, 0.004) * 4, 0.4));
      const x = ins[c], y = outs[c];
      for (let i = 0; i < 64; i++) {
        const xi = x[i];
        A.processBounded(xi * ga, 1.6);
        Bf.processBounded(xi * gb, 1.6);
        const a = wLP * A.lp + wBP * A.bp * Math.max(0.25, ka) * 1.4 + wHP * A.hp;
        const b = wLP * Bf.lp + wBP * Bf.bp * Math.max(0.25, kb) * 1.4 + wHP * Bf.hp;
        y[i] = 1.4 * sat(0.5 * (a + b) * 0.7);
      }
    }
  }
}
