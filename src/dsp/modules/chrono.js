import { Effect } from '../module.js';
import { RecordBuffer, OnePole, sat, smoothCoef, HALF_PI, TAU, clamp } from '../util.js';
import { GRAIN_DIVS, NOTE_DIVS, stepIndex } from '../../spec.js';

class Grain {
  constructor() {
    this.on = false;
  }
}

// Chrono Shredder: granular buffer scrambler. Grains are Hann-windowed with
// regular 50% overlap, so the grain stream sums to constant gain: no amplitude
// flicker and no clicks, however hard the material is scattered.
export class ChronoShredder extends Effect {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.size = 4 * sr;
    this.buf = [new RecordBuffer(this.size), new RecordBuffer(this.size)];
    this.size = this.buf[0].size;
    this.grains = Array.from({ length: 5 }, () => new Grain());
    this.ptr = -0.06 * sr;
    this.lastTrig = -1;
    this.fbLp = [new OnePole(sr, 5000), new OnePole(sr, 5000)];
    this.fbHp = [new OnePole(sr, 90), new OnePole(sr, 90)];
    this.fb = [0, 0];
    this.flut = 0;
    this.flutT = 0;
    this.stall = 0;
    this.stallT = 0;
    this.sh = 0;
    this.trigCount = 0;
  }

  reset() {
    for (const b of this.buf) b.clear();
    for (const g of this.grains) g.on = false;
    this.ptr = this.buf[0].pos - 0.06 * this.sr;
    for (const f of this.fbLp) f.reset();
    for (const f of this.fbHp) f.reset();
    this.fb[0] = this.fb[1] = 0;
  }

  spawn(G) {
    const p = this.p, rng = this.rng, sr = this.sr;
    const wpos = this.buf[0].pos;
    let g = this.grains.find((x) => !x.on);
    if (!g) g = this.grains.reduce((a, b) => (a.t / a.len > b.t / b.len ? a : b));
    const rate = Math.pow(2, ((p.pitch - 0.5) * 24) / 12);
    const rev = rng.next() < p.reverse + this.loop * 0.6 * (1 - p.reverse);
    const inc = rev ? -rate : rate;
    let start = this.ptr - rng.next() * p.spray * 0.6 * sr;
    if (rev) start += rate * G; // reversed grains read the same region backwards
    const hi = inc > 1 ? wpos - 4 - G * (inc - 1) : wpos - 4;
    const lo = inc < 1 ? wpos - this.size + 4 + G * (1 - inc) : wpos - this.size + 4;
    g.pos = clamp(start, lo, hi);
    g.inc = inc;
    g.len = G;
    g.t = 0;
    g.on = true;
    const pan = 0.5 + 0.5 * p.spray * rng.bi();
    g.gl = Math.min(1, Math.SQRT2 * Math.cos(pan * HALF_PI));
    g.gr = Math.min(1, Math.SQRT2 * Math.sin(pan * HALF_PI));
    this.sh = rng.bi();
  }

  processWet(inL, inR, wetL, wetR) {
    const sr = this.sr, p = this.p, rng = this.rng;
    const eng = this.engine;
    const bpm = eng.bpm;
    const gBeats = NOTE_DIVS[GRAIN_DIVS[stepIndex(p.grain, GRAIN_DIVS.length)]];
    const G = Math.max(64, Math.round((gBeats * 60 * sr) / bpm));
    const half = gBeats / 2;
    const bps = bpm / 60 / sr;
    const dt = 64 / sr;
    // tape-motor flutter and stalls scale with Stretch
    if ((this.flutT -= dt) <= 0) {
      this.flutT = 0.05 + 0.15 * rng.next();
      this.flutTarget = rng.bi();
    }
    this.flut += ((this.flutTarget || 0) - this.flut) * 0.2;
    if (this.stallT > 0) this.stallT -= dt;
    else if (p.stretch > 0.25 && rng.next() < (p.stretch - 0.25) * 0.8 * dt) this.stallT = 0.1 + 0.25 * rng.next();
    this.stall += ((this.stallT > 0 ? 1 : 0) - this.stall) * 0.08;
    const speed = Math.max(0, (1 - 0.9 * p.stretch) * (1 + p.stretch * 0.3 * this.flut) * (1 - 0.9 * this.stall));
    const minLag = 0.05 * sr;
    const maxLag = this.size * 0.55;
    const fbAmt = 0.85 * p.fdbk;
    const bufL = this.buf[0], bufR = this.buf[1];
    let beat = eng.beat;
    for (let i = 0; i < 64; i++, beat += bps) {
      const trig = Math.floor(beat / half);
      if (trig !== this.lastTrig) {
        this.lastTrig = trig;
        this.spawn(G);
      }
      // record input (+ recirculated grains)
      bufL.write(inL[i] + this.fb[0]);
      bufR.write(inR[i] + this.fb[1]);
      // source pointer
      this.ptr += speed;
      const lag = bufL.pos - this.ptr;
      if (lag < minLag || lag > maxLag) this.ptr = bufL.pos - minLag;
      let l = 0, r = 0;
      for (const g of this.grains) {
        if (!g.on) continue;
        const ph = g.t / g.len;
        const w = 0.5 - 0.5 * Math.cos(TAU * ph);
        l += bufL.readHermite(g.pos) * w * g.gl;
        r += bufR.readHermite(g.pos) * w * g.gr;
        g.pos += g.inc;
        if (++g.t >= g.len) g.on = false;
      }
      wetL[i] = l;
      wetR[i] = r;
      let fl = this.fbLp[0].process(l), fr = this.fbLp[1].process(r);
      fl -= this.fbHp[0].process(fl);
      fr -= this.fbHp[1].process(fr);
      this.fb[0] = sat(fl * fbAmt);
      this.fb[1] = sat(fr * fbAmt);
    }
    this.cur['cvout:spray'].fill(this.sh);
  }
}
