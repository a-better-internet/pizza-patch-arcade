import { ModuleBase } from '../module.js';
import { expMap, clamp, TAU } from '../util.js';
import { LFO_SYNC_DIVS, NOTE_DIVS, stepIndex } from '../../spec.js';

function wave(ph, shape) {
  // sine -> triangle -> square across the lower two thirds of the Shape knob
  ph -= Math.floor(ph);
  const s = Math.sin(TAU * ph);
  const tri = ph < 0.25 ? ph * 4 : ph < 0.75 ? 2 - ph * 4 : ph * 4 - 4;
  const sq = Math.tanh(s * 6) / Math.tanh(6);
  const k = Math.min(shape, 2 / 3) * 3;
  if (k < 1) return s + (tri - s) * k;
  return tri + (sq - tri) * (k - 1);
}

// Orbit LFO: two outputs in quadrature tracing an orbit. Gravity warps the
// phase so the point accelerates through part of the cycle; the gravity well
// itself slowly revolves so the pattern never repeats exactly.
export class OrbitLFO extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    this.ph = 0;
    this.well = 0;
    this.stepHeld = [0, 0];
    this.lastStep = -1;
    this.x = 0;
    this.y = 0;
  }

  reset() {
    this.ph = 0;
    this.lastStep = -1;
  }

  rateHz() {
    const p = this.p;
    if (this.btn.sync) {
      const beats = NOTE_DIVS[LFO_SYNC_DIVS[stepIndex(p.rate, LFO_SYNC_DIVS.length)]];
      return this.engine.bpm / 60 / beats;
    }
    return expMap(p.rate, 0.02, 20);
  }

  process() {
    const p = this.p, sr = this.sr, eng = this.engine;
    const hz = this.rateHz();
    const radius = p.radius;
    const off = (p.axis - 0.5) * 2;
    const grav = p.gravity * 0.15;
    const mY = p.phase;
    const shape = p.shape;
    const stepped = shape > 2 / 3 ? (shape - 2 / 3) * 3 : 0;
    const nSteps = Math.round(16 - 14 * stepped);
    const X = this.cur['cvout:x'], Y = this.cur['cvout:y'];
    const sync = this.btn.sync;
    const bps = eng.bpm / 60 / sr;
    const beatsPerCycle = sync ? NOTE_DIVS[LFO_SYNC_DIVS[stepIndex(p.rate, LFO_SYNC_DIVS.length)]] : 0;
    for (let i = 0; i < 64; i++) {
      if (sync) this.ph = (eng.beat + i * bps) / beatsPerCycle;
      else {
        this.ph += hz / sr;
        if (this.ph >= 1e6) this.ph -= 1e6;
      }
      this.well += 0.03 / sr;
      if (this.well >= 1) this.well -= 1;
      const base = this.ph - Math.floor(this.ph);
      const ph = base + grav * Math.sin(TAU * (base - this.well));
      let x, y;
      if (stepped > 0) {
        const st = Math.floor(ph * nSteps);
        if (st !== this.lastStep) {
          this.lastStep = st;
          const q = (st + 0.5) / nSteps;
          const rx = this.rng.bi(), ry = this.rng.bi();
          this.stepHeld[0] = wave(q, 1) * (1 - stepped) + rx * stepped;
          this.stepHeld[1] = (wave(q + 0.25, 1) * (1 - mY) + wave(2 * q, 1) * mY) * (1 - stepped) + ry * stepped;
        }
        x = this.stepHeld[0];
        y = this.stepHeld[1];
      } else {
        x = wave(ph, shape);
        // Phase: 0 = circle (quadrature), 90 degrees = figure-eight
        y = wave(ph + 0.25, shape) * (1 - mY) + wave(2 * ph, shape) * mY;
      }
      X[i] = clamp(x * radius + off, -1, 1);
      Y[i] = clamp(y * radius + off, -1, 1);
    }
    this.x = X[63];
    this.y = Y[63];
  }

  led() {
    return [this.x, this.y, this.rateHz()];
  }
}
