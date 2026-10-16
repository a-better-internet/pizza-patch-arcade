import { Effect } from '../module.js';
import { RecordBuffer, OnePole, Rng, clamp } from '../util.js';
import { GLITCH_DURS, NOTE_DIVS, stepIndex } from '../../spec.js';

const STEPS = 32;
const T_REVERSE = 0, T_STUTTER = 1, T_OCTAVE = 2, T_TAPESTOP = 3, T_CRUSH = 4, T_HALF = 5;

export function euclid(k, n, rot) {
  const out = new Array(n).fill(0);
  if (k <= 0) return out;
  if (k >= n) return out.fill(1);
  for (let i = 0; i < n; i++) out[(i + rot) % n] = Math.floor(((i + 1) * k) / n) - Math.floor((i * k) / n);
  return out;
}

// Glitch Oracle: Euclidean glitch sequencer. Every glitch is enveloped (4 ms
// fades) and every stutter repeat has short crossfaded edges, so the cuts are
// rhythmic rather than clicky.
export class GlitchOracle extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.buf = [new RecordBuffer(sr * 2.6), new RecordBuffer(sr * 2.6)];
    this.lastStep = -1;
    this.pattern = euclid(0, STEPS, 0);
    this.patKey = '';
    this.g = { on: false };
    this.crushLp = [new OnePole(sr, 5000), new OnePole(sr, 5000)];
    this.hold = [0, 0];
    this.holdPh = 0;
    this.gate = 0;
    this.edge = Math.round(0.004 * sr);
    this.rep = Math.round(0.002 * sr);
  }

  reset() {
    for (const b of this.buf) b.clear();
    this.g.on = false;
    this.lastStep = -1;
    for (const f of this.crushLp) f.reset();
  }

  buildPattern(cycle) {
    const p = this.p;
    const chance = clamp(p.chance + this.loop * 0.3, 0, 1);
    const k = Math.round(chance * STEPS);
    const seed = Math.round(p.intel * 99);
    const rot = Math.round(p.intel * 31);
    const key = `${k}:${seed}:${cycle}:${Math.round(p.muta * 50)}`;
    if (key === this.patKey) return;
    this.patKey = key;
    const base = euclid(k, STEPS, rot);
    const r = new Rng(seed * 7919 + cycle * 104729 + 13);
    this.mutated = new Array(STEPS).fill(false);
    for (let i = 0; i < STEPS; i++) {
      if (r.next() < p.muta * 0.3) {
        base[i] = base[i] ? 0 : 1;
        this.mutated[i] = true;
      }
    }
    this.pattern = base;
  }

  start(step, cycle) {
    const p = this.p, sr = this.sr;
    const seed = Math.round(p.intel * 99);
    const r = new Rng(seed * 31337 + step * 977 + (cycle % 4) * 7 + 1);
    const nTypes = 2 + Math.min(4, Math.floor(p.intense * 4.999));
    const type = r.int(nTypes);
    const beats = NOTE_DIVS[GLITCH_DURS[stepIndex(p.dur, GLITCH_DURS.length)]];
    const len = Math.max(256, Math.round((beats * 60 * sr) / this.engine.bpm));
    let mult = 1;
    if (this.mutated[step]) mult = r.next() < 0.5 ? 1.5 : 0.5;
    const g = this.g;
    g.on = true;
    g.type = type;
    g.len = Math.min(len, Math.round(2 * sr));
    g.t = 0;
    g.cap = this.buf[0].pos;
    g.mult = mult;
    g.acc = 0;
    g.slice = Math.max(Math.round(sr * 0.02), Math.round(g.len / 4));
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr;
    const eng = this.engine;
    const bps = eng.bpm / 60 / sr;
    let beat = eng.beat;
    const tune = this.btn.tune;
    const bl = this.buf[0], br = this.buf[1];
    const gateLen = Math.round(0.005 * sr);
    let gateOut = 0;
    for (let i = 0; i < 64; i++, beat += bps) {
      const stepAbs = Math.floor(beat * 4 + 1e-9);
      if (stepAbs !== this.lastStep) {
        this.lastStep = stepAbs;
        const cycle = Math.floor(stepAbs / STEPS);
        const s = ((stepAbs % STEPS) + STEPS) % STEPS;
        this.buildPattern(cycle);
        if (this.pattern[s]) {
          this.gate = gateLen;
          if (!this.g.on) this.start(s, cycle);
        }
      }
      if (this.gate > 0) {
        this.gate--;
        gateOut = 1;
      }
      bl.write(inL[i]);
      br.write(inR[i]);
      const g = this.g;
      if (!g.on) {
        wetL[i] = inL[i];
        wetR[i] = inR[i];
        continue;
      }
      const t = g.t;
      const env = Math.min(1, t / this.edge, (g.len - t) / this.edge);
      let l = 0, r = 0;
      let pitched = false;
      const m = g.mult;
      switch (g.type) {
        case T_REVERSE: {
          const pos = g.cap - 2 - t * m;
          l = bl.readHermite(pos);
          r = br.readHermite(pos);
          pitched = m !== 1;
          break;
        }
        case T_STUTTER: {
          const S = g.slice;
          const u = (t * m) % S;
          const e = Math.min(1, u / this.rep, (S - u) / this.rep);
          const pos = g.cap - S + u;
          l = bl.readHermite(pos) * e;
          r = br.readHermite(pos) * e;
          pitched = m !== 1;
          break;
        }
        case T_OCTAVE: {
          const S = g.slice * 2;
          const u = (t * 2 * m) % S;
          const e = Math.min(1, u / this.rep, (S - u) / this.rep);
          const pos = g.cap - S + u;
          l = bl.readHermite(pos) * e;
          r = br.readHermite(pos) * e;
          pitched = true;
          break;
        }
        case T_TAPESTOP: {
          const k = 1 - t / g.len;
          g.acc += k * k * Math.min(1, m);
          const pos = g.cap - 64 + g.acc;
          l = bl.readHermite(pos);
          r = br.readHermite(pos);
          break;
        }
        case T_CRUSH: {
          this.holdPh += 1 / 6;
          if (this.holdPh >= 1) {
            this.holdPh -= 1;
            this.hold[0] = Math.round(inL[i] * 16) / 16;
            this.hold[1] = Math.round(inR[i] * 16) / 16;
          }
          l = this.crushLp[0].process(this.hold[0]);
          r = this.crushLp[1].process(this.hold[1]);
          break;
        }
        default: {
          const pos = g.cap - g.len + t * 0.5 * m;
          l = bl.readHermite(pos);
          r = br.readHermite(pos);
          pitched = true;
        }
      }
      if (tune && pitched) {
        // harmonise: layer the pitched glitch over the live signal
        l = 0.6 * l + 0.6 * inL[i];
        r = 0.6 * r + 0.6 * inR[i];
      }
      wetL[i] = inL[i] * (1 - env) + l * env;
      wetR[i] = inR[i] * (1 - env) + r * env;
      if (++g.t >= g.len) g.on = false;
    }
    this.cur['cvout:gate'].fill(gateOut);
  }

  led() {
    return this.g.on ? 1 : 0;
  }
}
