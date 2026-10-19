// Loop ecology: the conditions a sound must satisfy in order to exist.
//
// Patch Arcade has no generator. A single one-sample impulse ("Strike") seeds
// the network; everything after that is the system listening to itself. This
// file holds the three rules that decide what that self-listening becomes. They
// act on the feedback cables of every loop:
//
//  LIFE    Each loop's feedback gain leans in by up to a ceiling set by Life
//          and is compressed back as the loop's energy rises past a target, like
//          the lamp in an oscillator's feedback path. A loop whose own gain plus
//          that ceiling reaches unity settles near the target and lives; one
//          that cannot, fades: that is the condition it must satisfy to exist.
//          The compressor form is stable for loops of any length, from a module
//          patched into itself (1.3 ms) to a long delay. At Life 0 there is no
//          help at all: a loop only lives while something feeds it.
//  BREATH  The target is never still. It swells and recedes on a cycle whose
//          length, depth and shape are re-drawn every breath, so no two breaths
//          match and the loop never settles into a static howl.
//  UNREST  When a loop locks onto one steady resonance, a tracking notch slowly
//          carves that frequency away and lets it go again once the loop has
//          moved on. The loop keeps hunting for a configuration it can hold.
//
// Everything stays bounded: the regulator ceiling, the soft bounds on every
// cable and module, the Feedback Tamer and the output limiter all still apply.

import { Rng, SVF, smoothstep, expMap, clamp } from './util.js';

const KICK = 0.3; // amplitude of the one-sample impulse

export class LoopEcology {
  constructor(sr, block) {
    this.sr = sr;
    this.dt = block / sr;
    this.life = 0.6;
    this.breath = 0.5;
    this.unrest = 0.4;
    this.rng = new Rng(0xb4ea7);
    this.state = new Map(); // loop key -> breathing state (kept across re-patching)
  }

  set(key, v) {
    if (key === 'life') this.life = clamp(+v, 0, 1);
    else if (key === 'breath') this.breath = clamp(+v, 0, 1);
    else if (key === 'unrest') this.unrest = clamp(+v, 0, 1);
  }

  // Called after the engine re-analyses the patch. Returns the loops that are
  // new, so the engine can seed each one with a single impulse.
  sync(loops) {
    const fresh = [];
    const keep = new Set();
    for (const L of loops) {
      L.key = L.members.slice().sort().join('+');
      keep.add(L.key);
      let s = this.state.get(L.key);
      if (!s) {
        s = this.newState();
        this.state.set(L.key, s);
        fresh.push(L);
      }
      L.s = s;
      for (const c of L.backs) {
        if (!c.unrest) c.unrest = newNotch(this.sr);
        if (c.gDb === undefined) c.gDb = 0;
      }
    }
    for (const k of [...this.state.keys()]) if (!keep.has(k)) this.state.delete(k);
    return fresh;
  }

  newState() {
    const s = { gDb: 0, ph: this.rng.next(), rf: 1, df: 1, skew: 0.5, eDb: -200, dip: 0 };
    this.redraw(s);
    return s;
  }

  // a new breath: its own length, depth and shape
  redraw(s) {
    s.rf = 0.65 + 0.8 * this.rng.next();
    s.df = 0.6 + 0.6 * this.rng.next();
    s.skew = 0.25 + 0.5 * this.rng.next();
  }


  // forget a tracked resonance and lift its notch
  calm(u) {
    u.svf.reset();
    u.hold = u.depth = u.f = u.fn = 0;
    u.zc = u.count = 0;
  }

  // Seed a loop: one sample on its first feedback cable.
  kick(L) {
    if (L.backs.length) L.backs[0].kick = KICK;
  }

  // Once per block: update every loop's feedback gain. `legacy` handles Life 0.
  update(loops, legacy) {
    for (const L of loops) {
      if (!L.s) continue;
      let e = 0;
      for (const c of L.backs) e += c.pow;
      L.s.eDb = 10 * Math.log10(e + 1e-20);
    }
    if (this.life < 0.02) {
      for (const L of loops) for (const c of L.backs) c.ceil += (1.5 - c.ceil) * 0.05;
      legacy();
      return;
    }
    const dt = this.dt;
    const targetDb = -40 + 26 * this.life; // recirculating energy the loop is held near
    const maxDb = 3 + 21 * this.life; // how hard the regulator may lean in
    const depthDb = 3 + 21 * this.breath;
    const period = 34 * (1 - 0.75 * this.breath);
    for (const L of loops) {
      if (!L.backs.length) continue;
      const s = L.s;
      // breathing target
      s.ph += dt / (period * s.rf);
      if (s.ph >= 1) {
        s.ph -= 1;
        this.redraw(s);
      }
      const w = s.ph < s.skew ? (0.5 * s.ph) / s.skew : 0.5 + (0.5 * (s.ph - s.skew)) / (1 - s.skew);
      s.dip = 0.5 - 0.5 * Math.cos(2 * Math.PI * w);
      // the target is shared out between the loop's feedback cables (usually
      // its left and right channels)
      const want = targetDb - depthDb * s.df * s.dip - 10 * Math.log10(L.backs.length);
      // Each feedback cable is regulated on its own, so a weaker channel is
      // held alive too instead of starving beside a stronger one. Feedback
      // compressor: full lean-in below the target, 2 dB of gain cut per dB of
      // energy above it (energy is power, so this is a steep curve).
      // A soft amplitude ceiling ~16 dB above the target catches any overshoot
      // within the sample, like the saturation in a real feedback oscillator,
      // so the regulator itself can move gently: a loop that circulates every
      // 1.3 ms would be wiped out by a sudden deep duck before the (slow)
      // energy meter even noticed.
      const ceil = clamp(6 * Math.pow(10, want / 20), 0.03, 1.5);
      let gSum = 0;
      for (const c of L.backs) {
        const over = 10 * Math.log10(c.pow + 1e-20) - want;
        const gWant = over > 0 ? Math.max(-45, maxDb - 1.5 * over) : maxDb;
        c.gDb += (gWant - c.gDb) * (gWant < c.gDb ? 0.08 : 0.05);
        c.lg = Math.pow(10, c.gDb / 20);
        c.ceil += (ceil - c.ceil) * 0.2;
        gSum += c.gDb;
      }
      s.gDb = gSum / L.backs.length;
    }
  }

  // Unrest: per feedback cable, track the dominant frequency by zero crossings;
  // if it has held steady for a while, carve it with a notch.
  restless(c, t, n) {
    const u = c.unrest;
    if (!u) return;
    const unrest = this.unrest;
    // zero-crossing frequency tracker over ~23 ms windows
    for (let i = 0; i < n; i++) {
      const sgn = t[i] >= 0;
      if (sgn !== u.sign) {
        u.zc++;
        u.sign = sgn;
      }
    }
    u.count += n;
    if (u.count >= 1024) {
      const f = (u.zc * this.sr) / (2 * u.count);
      const win = u.count / this.sr;
      if (u.f > 0 && Math.abs(f - u.f) < 0.04 * u.f && f > 60) u.hold += win;
      else u.hold = Math.max(0, u.hold - 2 * win);
      u.f = u.f > 0 ? u.f + 0.5 * (f - u.f) : f;
      u.zc = 0;
      u.count = 0;
    }
    const settleS = expMap(1 - unrest, 1.5, 25); // how long a resonance may hold before it is carved
    const want = unrest > 0.01 ? smoothstep(0.5 * settleS, settleS, u.hold) * (0.4 + 0.6 * unrest) : 0;
    u.depth += (want - u.depth) * (want > u.depth ? 0.004 : 0.0015);
    if (u.depth < 0.01) {
      u.fn = u.f;
      return;
    }
    u.svf.set(clamp(u.fn, 60, 9000), 5);
    const k = u.svf.k * u.depth;
    for (let i = 0; i < n; i++) {
      u.svf.process(t[i]);
      t[i] -= k * u.svf.bp;
    }
  }
}

function newNotch(sr) {
  return { svf: new SVF(sr), zc: 0, count: 0, sign: true, f: 0, fn: 0, hold: 0, depth: 0 };
}
