// Base classes for rack modules.

import { BLOCK, CV_SCALE, jacksFor } from '../spec.js';
import { Rng, FixedDelay, clamp01, HALF_PI, smoothCoef } from './util.js';

const PARAM_SMOOTH_S = 0.02; // 20 ms knob/CV smoothing (no zipper noise)
const LOOP_RISE_S = 20; // loop age reaches full in ~20 s
const LOOP_FALL_S = 5; // and falls back ~4x faster when the loop breaks

let seedCounter = 0x5eed;

export class ModuleBase {
  constructor(engine, spec) {
    this.engine = engine;
    this.spec = spec;
    this.id = spec.id;
    this.sr = engine.sr;
    this.B = BLOCK;
    this.rng = new Rng((seedCounter = (seedCounter * 1103515245 + 12345) >>> 0));

    // parameters
    this.paramIds = spec.params.map((p) => p.id);
    this.cvJackIds = spec.params.map((p) => `cv:${p.id}`);
    this.stepped = spec.params.map((p) => !!p.steps);
    this.knob = {};
    this.cv = {};
    this.p = {}; // smoothed effective values for this block
    this.pPrev = {}; // values for the previous block (for per-sample ramps)
    for (const p of spec.params) {
      this.knob[p.id] = p.def;
      this.cv[p.id] = 0;
      this.p[p.id] = p.def;
      this.pPrev[p.id] = p.def;
    }
    this.pCoef = smoothCoef(PARAM_SMOOTH_S, this.sr / BLOCK);
    this.btn = {};
    for (const b of spec.buttons || []) this.btn[b.id] = false;

    // jacks: input buffers are filled by the router; outputs double-buffered
    this.jacks = jacksFor(spec);
    this.in = {};
    this.inConnected = {};
    this.inW = {}; // summed cable fade gain per input jack (0..1), this block
    this.inWPrev = {}; // ... and the previous block
    this.cur = {};
    this.prev = {};
    for (const j of this.jacks) {
      if (j.dir === 'in') {
        this.in[j.id] = new Float32Array(BLOCK);
        this.inConnected[j.id] = false;
        this.inW[j.id] = 0;
        this.inWPrev[j.id] = 0;
      } else {
        this.cur[j.id] = new Float32Array(BLOCK);
        this.prev[j.id] = new Float32Array(BLOCK);
      }
    }
    this.processed = false;
    this.active = false;
    this.loop = 0;
    this.inLoop = false;
    this.fault = 0;
  }

  // Alias an output jack to another one's buffers (Out 2 = mult of Out 1).
  alias(jack, target) {
    this.cur[jack] = this.cur[target];
    this.prev[jack] = this.prev[target];
  }

  swapBuffers() {
    const t = this.cur;
    this.cur = this.prev;
    this.prev = t;
  }

  clearOutputs() {
    for (const k in this.cur) this.cur[k].fill(0);
    for (const k in this.prev) this.prev[k].fill(0);
  }

  setKnob(id, v) {
    if (id in this.knob) this.knob[id] = clamp01(+v || 0);
  }

  setButton(id, v) {
    if (!(id in this.btn) && !(this.spec.buttons || []).some((b) => b.id === id)) return;
    this.btn[id] = !!v;
    this.onButton(id, !!v);
  }

  onButton() {}

  // Read a stereo input pair with mono normalisation: a side with no cable
  // takes the other side's signal. The copy is crossfaded with the cables'
  // own fade gains, so patching or unpatching one side never clicks.
  readPair(lId, rId, dL, dR, add = false) {
    const L = this.in[lId], R = this.in[rId];
    const wl0 = this.inWPrev[lId], wl1 = this.inW[lId], wr0 = this.inWPrev[rId], wr1 = this.inW[rId];
    if (wl0 === 1 && wl1 === 1 && wr0 === 1 && wr1 === 1) {
      if (add) {
        for (let n = 0; n < BLOCK; n++) {
          dL[n] += L[n];
          dR[n] += R[n];
        }
      } else {
        dL.set(L);
        dR.set(R);
      }
      return;
    }
    const dl = (wl1 - wl0) / BLOCK, dr = (wr1 - wr0) / BLOCK;
    for (let n = 0; n < BLOCK; n++) {
      const cl = 1 - (wl0 + dl * n), cr = 1 - (wr0 + dr * n);
      const l = L[n] + cl * R[n], r = R[n] + cr * L[n];
      if (add) {
        dL[n] += l;
        dR[n] += r;
      } else {
        dL[n] = l;
        dR[n] = r;
      }
    }
  }

  pairWeight(lId, rId) {
    return Math.max(this.inW[lId], this.inW[rId]);
  }

  // Called once per block by the engine, before process().
  updateParams() {
    const dt = BLOCK / this.sr;
    if (this.inLoop) this.loop = Math.min(1, this.loop + dt / LOOP_RISE_S);
    else this.loop = Math.max(0, this.loop - dt / LOOP_FALL_S);
    for (let i = 0; i < this.paramIds.length; i++) {
      const id = this.paramIds[i];
      const jid = this.cvJackIds[i];
      const cvJack = this.in[jid];
      let cv = 0;
      if (cvJack && this.inConnected[jid]) {
        let s = 0;
        for (let n = 0; n < BLOCK; n++) s += cvJack[n];
        cv = (s / BLOCK) * CV_SCALE;
        if (!(cv > -10 && cv < 10)) cv = 0; // NaN / runaway guard
      }
      this.cv[id] = cv;
      const target = clamp01(this.knob[id] + cv);
      this.pPrev[id] = this.p[id];
      let v = this.stepped[i] ? target : this.p[id] + (target - this.p[id]) * this.pCoef;
      if (v - target < 1e-5 && target - v < 1e-5) v = target; // land exactly (Mix 0 = untouched)
      this.p[id] = v;
    }
  }

  // Snap smoothed values to their targets (used after a reset / patch load).
  settleParams() {
    for (const id of this.paramIds) {
      this.p[id] = this.pPrev[id] = clamp01(this.knob[id]);
    }
  }

  process() {}
  reset() {}

  // Safety check run by the engine after process(): NaN/Inf or absurd levels
  // reset the module instead of letting garbage propagate through the rack.
  verify() {
    let bad = false;
    for (const k in this.cur) {
      const b = this.cur[k];
      const a = b[0], z = b[BLOCK - 1], m = b[BLOCK >> 1];
      if (!(a > -64 && a < 64) || !(z > -64 && z < 64) || !(m > -64 && m < 64)) {
        bad = true;
        break;
      }
    }
    if (bad) {
      this.fault++;
      try {
        this.reset();
      } catch {
        /* ignore */
      }
      this.clearOutputs();
    }
    return !bad;
  }
}

// Shared behaviour for every audio effect: In 1 + In 2 are summed (with mono
// normalisation per pair), the wet signal is blended against the dry using an
// equal-power crossfade, and Out 2 is a mult of Out 1.
export class Effect extends ModuleBase {
  constructor(engine, spec, { latency = 0, separateOut2 = false } = {}) {
    super(engine, spec);
    this.inL = new Float32Array(BLOCK);
    this.inR = new Float32Array(BLOCK);
    this.wetL = new Float32Array(BLOCK);
    this.wetR = new Float32Array(BLOCK);
    this.dryL = this.inL;
    this.dryR = this.inR;
    this.latency = latency;
    this.dryDelayL = new FixedDelay(latency);
    this.dryDelayR = new FixedDelay(latency);
    this.dryOverride = null; // modules may supply phase-matched dry buffers
    if (!separateOut2) {
      this.alias('out2L', 'out1L');
      this.alias('out2R', 'out1R');
    }
    this.mixSmoothed = this.p.mix;
  }

  gatherInput() {
    this.readPair('in1L', 'in1R', this.inL, this.inR);
    if (this.in2IsInput !== false) this.readPair('in2L', 'in2R', this.inL, this.inR, true);
  }

  process() {
    this.gatherInput();
    this.processWet(this.inL, this.inR, this.wetL, this.wetR);
    this.mixOut();
  }

  // processWet(inL, inR, wetL, wetR) is implemented by subclasses.
  processWet() {}

  // Equal-power crossfade, compensated for correlation between dry and wet.
  // Plain sin/cos gains add up to +3 dB when the wet signal resembles the dry
  // one, which makes every feedback loop through a half-wet effect grow. Here
  // the gains are scaled by 1/sqrt(1 + rho*sin(2*theta)), so output power stays
  // constant whatever the correlation: equal-power for unrelated signals, and
  // never above unity for identical ones ("a crossfade cannot exceed unity").
  mixOut() {
    const oL = this.cur.out1L, oR = this.cur.out1R;
    const dL = this.dryOverride ? this.dryOverride[0] : this.inL;
    const dR = this.dryOverride ? this.dryOverride[1] : this.inR;
    const m0 = this.pPrev.mix, m1 = this.p.mix;
    const wL = this.wetL, wR = this.wetR;
    const lat = this.latency;
    const xd = this.dryAligned || (this.dryAligned = [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    const aL = xd[0], aR = xd[1];
    let sdw = 0, sdd = 0, sww = 0;
    for (let n = 0; n < BLOCK; n++) {
      const xl = lat ? this.dryDelayL.process(dL[n]) : dL[n];
      const xr = lat ? this.dryDelayR.process(dR[n]) : dR[n];
      aL[n] = xl;
      aR[n] = xr;
      sdw += xl * wL[n] + xr * wR[n];
      sdd += xl * xl + xr * xr;
      sww += wL[n] * wL[n] + wR[n] * wR[n];
    }
    if (m0 <= 0 && m1 <= 0) {
      // fully dry: passthrough (bit-exact when there is no latency to align)
      oL.set(aL);
      oR.set(aR);
      return;
    }
    const rhoBlock = sdd > 1e-12 && sww > 1e-12 ? sdw / Math.sqrt(sdd * sww) : 0;
    const rho0 = this.rho || 0;
    const rho1 = rho0 + ((rhoBlock > 0 ? rhoBlock : 0) - rho0) * 0.3;
    this.rho = rho1;
    // gains at both block edges, linearly interpolated in between
    const th0 = m0 * HALF_PI, th1 = m1 * HALF_PI;
    const k0 = 1 / Math.sqrt(1 + rho0 * Math.sin(2 * th0));
    const k1 = 1 / Math.sqrt(1 + rho1 * Math.sin(2 * th1));
    const gd0 = Math.cos(th0) * k0, gw0 = Math.sin(th0) * k0;
    const dd = (Math.cos(th1) * k1 - gd0) / BLOCK, dw = (Math.sin(th1) * k1 - gw0) / BLOCK;
    for (let n = 0; n < BLOCK; n++) {
      const gd = gd0 + dd * n, gw = gw0 + dw * n;
      oL[n] = aL[n] * gd + wL[n] * gw;
      oR[n] = aR[n] * gd + wR[n] * gw;
    }
  }

  resetDry() {
    this.dryDelayL.clear();
    this.dryDelayR.clear();
  }
}

// Fill a CV output buffer with a constant value.
export function fillConst(buf, v) {
  for (let n = 0; n < buf.length; n++) buf[n] = v;
}
