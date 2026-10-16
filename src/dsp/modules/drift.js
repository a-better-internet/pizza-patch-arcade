import { ModuleBase } from '../module.js';
import { expMap, clamp } from '../util.js';
import { DRIFT_SYNC_DIVS, NOTE_DIVS, stepIndex } from '../../spec.js';

// Drift Field: a random walk. Chaos adds irregular timing, occasional oversized
// jumps and ratcheting bursts of 4-7 micro-steps.
export class DriftField extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    this.value = 0;
    this.target = 0;
    this.out = 0;
    this.timer = 0;
    this.burst = 0;
    this.burstLen = 0;
    this.lastBeatStep = -1;
  }

  reset() {
    this.value = this.target = this.out = 0;
    this.timer = 0;
    this.burst = 0;
  }

  periodS() {
    const p = this.p;
    if (this.btn.sync) {
      const beats = NOTE_DIVS[DRIFT_SYNC_DIVS[stepIndex(p.rate, DRIFT_SYNC_DIVS.length)]];
      return (beats * 60) / this.engine.bpm;
    }
    return 1 / expMap(p.rate, 0.1, 20);
  }

  newTarget(scale) {
    const p = this.p, rng = this.rng;
    let step = rng.gauss() * 0.35 * scale;
    if (rng.next() < p.chaos * 0.15) step *= 3; // oversized jump
    let t = this.target + step;
    // reflect at the walls
    if (t > 1) t = 2 - t;
    if (t < -1) t = -2 - t;
    this.target = clamp(t, -1, 1);
  }

  process() {
    const p = this.p, sr = this.sr, rng = this.rng;
    const period = this.periodS();
    const sync = this.btn.sync;
    const smooth = p.smooth;
    const out = this.cur['cvout:walk'];
    const bps = this.engine.bpm / 60 / sr;
    const beats = sync ? NOTE_DIVS[DRIFT_SYNC_DIVS[stepIndex(p.rate, DRIFT_SYNC_DIVS.length)]] : 1;
    // slew: stepped at 0, glassy at 1
    const tau = Math.max(0.0005, smooth * smooth * period);
    const coef = 1 - Math.exp(-1 / (tau * sr));
    for (let i = 0; i < 64; i++) {
      let fire = false;
      if (this.burst > 0) {
        this.timer -= 1 / sr;
        if (this.timer <= 0) {
          this.burst--;
          this.timer = this.burstLen;
          this.newTarget(0.45);
        }
      } else if (sync) {
        const st = Math.floor((this.engine.beat + i * bps) / beats);
        if (st !== this.lastBeatStep) {
          this.lastBeatStep = st;
          fire = true;
        }
      } else {
        this.timer -= 1 / sr;
        if (this.timer <= 0) {
          fire = true;
          // irregular timing
          this.timer = period * (1 + p.chaos * (rng.next() - 0.5) * 1.2);
        }
      }
      if (fire) {
        this.newTarget(1);
        if (rng.next() < p.chaos * 0.12) {
          this.burst = 4 + rng.int(4);
          this.burstLen = period / 6;
          this.timer = this.burstLen;
        }
      }
      this.value += (this.target - this.value) * coef;
      out[i] = clamp(this.value * p.depth + (p.bias - 0.5) * 2, -1, 1);
    }
    this.out = out[63];
  }

  led() {
    return [this.out, this.periodS()];
  }
}
