// The rack engine: routes cables between modules in 64-sample blocks, handles
// feedback loops, host inputs and the output safety chain.
//
// Routing model
//  * Modules are processed in depth-first order from the From Host inputs.
//  * A cable whose source has already run this block carries the current block
//    (zero latency). A cable pointing backwards in the order (a feedback edge)
//    carries the source's previous block, i.e. one block of delay.
//  * Cables fade in/out over 12 ms when patched or removed, so patching never
//    clicks.
//  * Modules that cannot reach To Host are idle and skipped.
//  * Audio on a feedback edge passes a "cable loss" stage: 80 Hz high-pass,
//    gentle 6 kHz low-pass and a soft bound. Loops therefore darken as they
//    recirculate (they recede into a wash) instead of building fizzy harmonics,
//    and cannot sink into an inaudible sub-bass rumble either.
//  * Every loop's feedback gain is managed by the loop ecology (ecology.js):
//    Life holds each loop near a target energy so it can exist with no input
//    at all, Breath keeps that target moving, Unrest carves away any resonance
//    the loop settles on. A single one-sample impulse (Strike, or a cable that
//    closes a new loop) is the only energy the instrument needs.
//  * At Life 0 the legacy governor applies instead: a loop may bloom to +3 dB
//    above what feeds it but fades once the input stops (a Splitter or Merger
//    gain past centre inside the loop still opens it into a bounded bloom).

import { MODULES, BLOCK, HOST_ID, jackMap, utilGainDb } from '../spec.js';
import { processOrder, loopModules, loopComponents, neededModules } from '../graph.js';
import { MasterChain } from './master.js';
import { createSource, InputConditioner, SOURCE_NAMES } from './sources.js';
import { MODULE_CLASSES } from './modules/index.js';
import { softLimit, sat, smoothCoef, HALF_PI, clamp, Biquad, dbToGain } from './util.js';
import { LoopEcology } from './ecology.js';

const STRIKE = 0.3; // the one-sample impulse placed on each From Host output that is not Off

const CABLE_FADE_S = 0.012;
const SOURCE_FADE_S = 0.015;

class HostNode {
  constructor() {
    this.id = HOST_ID;
    this.processed = true;
    this.cur = {};
    for (let h = 1; h <= 3; h++) {
      this.cur[`from${h}L`] = new Float32Array(BLOCK);
      this.cur[`from${h}R`] = new Float32Array(BLOCK);
    }
    this.prev = this.cur;
    this.in = { toL: new Float32Array(BLOCK), toR: new Float32Array(BLOCK) };
    this.inConnected = { toL: false, toR: false };
    this.inW = { toL: 0, toR: 0 };
    this.inWPrev = { toL: 0, toR: 0 };
    this.inCables = { toL: [], toR: [] };
  }
}

export class Engine {
  constructor(sr) {
    this.sr = sr;
    this.modules = new Map();
    for (const spec of MODULES) {
      const C = MODULE_CLASSES[spec.id];
      const m = new C(this, spec);
      m.inCables = {};
      for (const j of m.jacks) if (j.dir === 'in') m.inCables[j.id] = [];
      m.outKeys = [];
      const seen = new Set();
      for (const j of m.jacks) {
        if (j.dir !== 'out') continue;
        const b = m.cur[j.id];
        if (!seen.has(b)) {
          seen.add(b);
          m.outKeys.push(j.id);
        }
      }
      this.modules.set(spec.id, m);
    }
    this.moduleList = [...this.modules.values()];
    this.host = new HostNode();
    this.cables = new Map();
    this.order = this.moduleList.slice();
    this.dirty = true;
    this.fadeStep = 1 / (CABLE_FADE_S * sr);

    // transport
    this.bpm = 120;
    this.beat = 0;

    // host inputs
    this.hosts = [0, 1, 2].map(() => ({
      name: 'off',
      pending: null,
      source: null,
      gain: 0,
      cond: new InputConditioner(sr),
      L: new Float32Array(BLOCK),
      R: new Float32Array(BLOCK),
    }));
    this.srcFade = 1 / (SOURCE_FADE_S * sr);

    // global strip
    this.mix = 1;
    this.mixTarget = 1;
    this.mixCoef = smoothCoef(0.03, sr / BLOCK);
    this.bypass = 0;
    this.bypassTarget = 0;
    this.bypassCoef = smoothCoef(0.02, sr / BLOCK);
    this.master = new MasterChain(sr);
    this.dryL = new Float32Array(BLOCK);
    this.dryR = new Float32Array(BLOCK);
    this.outL = new Float32Array(BLOCK);
    this.outR = new Float32Array(BLOCK);
    this.faults = 0;
    this.blocks = 0;
    // loop governor
    this.loopsInfo = [];
    const bs = BLOCK / sr;
    this.govDown = Math.pow(10, (-12 / 20) * bs); // -12 dB/s
    this.govUp = Math.pow(10, (20 / 20) * bs); // +20 dB/s, only while the loop is being fed
    this.inAtt = smoothCoef(0.05, sr / BLOCK);
    this.inRel = smoothCoef(0.4, sr / BLOCK);
    this.inHold = Math.round((0.8 * sr) / BLOCK); // bridges gaps between notes
    this.fbCoef = smoothCoef(0.1, sr / BLOCK);
    this.ecology = new LoopEcology(sr, BLOCK);
    this.strikeQueued = false;
  }

  // One one-sample impulse into every From Host output and every loop.
  strike() {
    this.strikeQueued = true;
  }

  // ------------------------------------------------------------------ control
  setBpm(bpm) {
    this.bpm = clamp(+bpm || 120, 30, 300);
  }

  setGlobal(key, value) {
    if (key === 'mix') this.mixTarget = clamp(+value, 0, 1);
    else if (key === 'bypass') this.bypassTarget = value ? 1 : 0;
    else if (key === 'volume') this.master.setVolume(+value);
    else if (key === 'shrill') this.master.setShrillGuard(+value);
    else if (key === 'bpm') this.setBpm(value);
    else if (key === 'life' || key === 'breath' || key === 'unrest') this.ecology.set(key, value);
  }

  setParam(moduleId, paramId, value) {
    const m = this.modules.get(moduleId);
    if (m) m.setKnob(paramId, value);
  }

  setButton(moduleId, buttonId, value) {
    const m = this.modules.get(moduleId);
    if (m) m.setButton(buttonId, value);
  }

  setSource(h, name, trimDb) {
    const host = this.hosts[h];
    if (!host) return;
    if (typeof trimDb === 'number') host.cond.setTrimDb(trimDb);
    if (name && SOURCE_NAMES.includes(name) && name !== host.name) host.pending = name;
  }

  panic() {
    for (const m of this.moduleList) {
      m.reset();
      if (m.resetDry) m.resetDry();
      m.clearOutputs();
    }
    for (const c of this.cables.values()) this.resetCable(c);
    this.master.reset();
  }

  resetCable(c) {
    if (c.cond) {
      c.cond.lp.reset();
      c.cond.dc.reset();
    }
    c.pow = 0;
    c.lg = c.lgPrev = 1;
    c.kick = 0;
    c.gDb = 0;
    if (c.unrest) this.ecology.calm(c.unrest);
  }

  // cables: [{ id, from: { m, j }, to: { m, j } }]
  setPatch(list) {
    const want = new Map();
    for (const c of list || []) {
      if (!c || !c.id || !c.from || !c.to) continue;
      const fj = jackMap(c.from.m) && jackMap(c.from.m)[c.from.j];
      const tj = jackMap(c.to.m) && jackMap(c.to.m)[c.to.j];
      if (!fj || !tj || fj.dir !== 'out' || tj.dir !== 'in' || fj.type !== tj.type) continue;
      want.set(c.id, c);
    }
    // removals fade out
    for (const [id, cab] of this.cables) {
      const w = want.get(id);
      if (!w || w.from.m !== cab.from.m || w.from.j !== cab.from.j || w.to.m !== cab.to.m || w.to.j !== cab.to.j) {
        cab.target = 0;
        if (w) {
          // same id re-used for a different connection: retire the old one
          this.cables.delete(id);
          cab.id = `${id}#old${this.blocks}`;
          this.cables.set(cab.id, cab);
        }
      }
    }
    for (const [id, c] of want) {
      const cur = this.cables.get(id);
      if (cur) {
        cur.target = 1;
        continue;
      }
      const src = c.from.m === HOST_ID ? this.host : this.modules.get(c.from.m);
      const dst = c.to.m === HOST_ID ? this.host : this.modules.get(c.to.m);
      if (!src || !dst) continue;
      const audio = jackMap(c.from.m)[c.from.j].type === 'audio';
      const cab = {
        id, from: c.from, to: c.to, src, srcJack: c.from.j, dst, dstJack: c.to.j, g: 0, target: 1, back: false,
        track: false, pow: 0, lg: 1, lgPrev: 1, hold: 0, ceil: 1.5,
        cond: audio ? { lp: new Biquad(this.sr).lowpass(6000, 0.7071), dc: new Biquad(this.sr).highpass(80, 0.7071) } : null,
      };
      this.cables.set(id, cab);
      dst.inCables[c.to.j].push(cab);
    }
    this.dirty = true;
  }

  analyze() {
    const all = [...this.cables.values()];
    const live = all.filter((c) => c.target > 0);
    const ids = this.moduleList.map((m) => m.id);
    this.order = processOrder(ids, all).map((id) => this.modules.get(id)).filter(Boolean);
    const pos = new Map(this.order.map((m, i) => [m, i]));
    for (const c of all) {
      const a = pos.get(c.src), b = pos.get(c.dst);
      c.back = a !== undefined && b !== undefined && a >= b;
    }
    const loops = loopModules(live);
    const needed = neededModules(all);
    for (const c of all) c.track = false;
    this.loopsInfo = loopComponents(live).map((members) => {
      const set = new Set(members);
      const entries = all.filter((c) => c.cond && set.has(c.to.m) && !set.has(c.from.m));
      const backs = all.filter((c) => c.cond && c.back && set.has(c.to.m) && set.has(c.from.m));
      for (const c of entries) c.track = true;
      for (const c of backs) c.track = true;
      const utils = members.filter((id) => id === 'merger' || id === 'splitter').map((id) => this.modules.get(id));
      return { members, entries, backs, utils };
    });
    // a cable that closes a new loop seeds it with a single impulse
    for (const L of this.ecology.sync(this.loopsInfo)) this.ecology.kick(L);
    for (const m of this.moduleList) {
      m.inLoop = loops.has(m.id);
      const act = needed.has(m.id);
      if (act && !m.active) {
        m.reset();
        if (m.resetDry) m.resetDry();
        m.clearOutputs();
        m.settleParams();
      } else if (!act && m.active) {
        m.clearOutputs();
      }
      m.active = act;
    }
    this.dirty = false;
  }

  // Sum the cables feeding every input jack of `node`.
  route(node) {
    const step = this.fadeStep;
    for (const jack in node.inCables) {
      const list = node.inCables[jack];
      const buf = node.in[jack];
      node.inWPrev[jack] = node.inW[jack];
      if (list.length === 0) {
        node.inW[jack] = 0;
        if (node.inConnected[jack]) {
          buf.fill(0);
          node.inConnected[jack] = false;
        }
        continue;
      }
      buf.fill(0);
      let removed = false;
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        let s = c.src.processed ? c.src.cur[c.srcJack] : c.src.prev[c.srcJack];
        if (c.back) s = this.condition(c, s);
        if (c.track) {
          let p = 0;
          for (let n = 0; n < BLOCK; n++) p += s[n] * s[n];
          p = (p / BLOCK) * c.g * c.g;
          if (c.back) c.pow += (p - c.pow) * this.fbCoef;
          else if (p >= c.pow) {
            c.pow += (p - c.pow) * this.inAtt;
            c.hold = this.inHold;
          } else if (c.hold > 0) c.hold--;
          else c.pow += (p - c.pow) * this.inRel;
          if (!(c.pow < 1e6)) c.pow = 0;
        }
        if (c.kick) {
          // the seed impulse bypasses the cable fade so it is never lost
          buf[0] += c.kick;
          c.kick = 0;
        }
        if (c.g === 1 && c.target === 1) {
          for (let n = 0; n < BLOCK; n++) buf[n] += s[n];
        } else {
          let g = c.g;
          const dir = c.target > g ? step : -step;
          for (let n = 0; n < BLOCK; n++) {
            g += dir;
            if (g > 1) g = 1;
            else if (g < 0) g = 0;
            buf[n] += s[n] * g;
          }
          c.g = g;
          if (g <= 0 && c.target === 0) removed = true;
        }
      }
      if (removed) {
        node.inCables[jack] = list.filter((c) => !(c.g <= 0 && c.target === 0));
        for (const c of list) if (c.g <= 0 && c.target === 0) this.cables.delete(c.id);
        this.dirty = true;
      }
      node.inConnected[jack] = node.inCables[jack].length > 0;
      let w = 0;
      for (const c of node.inCables[jack]) w += c.g;
      node.inW[jack] = w > 1 ? 1 : w;
    }
  }

  // Feedback-edge conditioning (see header). CV edges are only bounded.
  condition(c, s) {
    const t = this.tmp || (this.tmp = new Float32Array(BLOCK));
    if (c.cond) {
      const { lp, dc } = c.cond;
      const g0 = c.lgPrev, dg = (c.lg - c.lgPrev) / BLOCK;
      // gain -> soft amplitude ceiling (set per loop by the ecology) -> cable
      // loss, so the filters also smooth whatever the ceiling adds
      const k = c.ceil;
      for (let n = 0; n < BLOCK; n++) t[n] = dc.process(lp.process(k * sat((s[n] * (g0 + dg * n)) / k)));
      c.lgPrev = c.lg;
      if (c.unrest) this.ecology.restless(c, t, BLOCK);
      const z = t[BLOCK - 1];
      if (z !== z) {
        // a NaN reached the cable filters: clear them rather than let it stick
        this.resetCable(c);
        t.fill(0);
      }
    } else {
      for (let n = 0; n < BLOCK; n++) t[n] = clamp(s[n], -2, 2);
    }
    return t;
  }

  // Loop governor (see header): runs once per block, gains apply next block.
  governLoops() {
    for (const L of this.loopsInfo) {
      if (!L.backs.length) continue;
      let eIn = 0;
      for (const c of L.entries) eIn += c.pow;
      let thr = 1;
      for (const u of L.utils) thr = Math.max(thr, dbToGain(utilGainDb(Math.max(u.p.gainA, u.p.gainB))));
      const K = 2 * thr * thr * thr * thr; // power allowance relative to the input
      const floor = thr > 1.05 ? 2e-3 * (thr * thr - 1) : 0; // bounded self-sustain when throttled open
      const allowed = Math.max(K * eIn, floor, 1e-12);
      // a loop may only regain gain while something is feeding it (or the
      // throttle is open); otherwise it could regrow from numerical residue
      const fed = eIn > 1e-8 || floor > 0;
      for (const c of L.backs) {
        if (c.pow > allowed || !fed) c.lg = Math.max(1e-3, c.lg * this.govDown);
        else if (c.lg < 1) c.lg = Math.min(1, c.lg * this.govUp);
        else if (c.lg > 1) c.lg = Math.max(1, c.lg * this.govDown); // leaving Life: settle back to unity
      }
    }
  }

  renderHosts(inputs, bps) {
    for (let h = 0; h < 3; h++) {
      const host = this.hosts[h];
      const L = host.L, R = host.R;
      L.fill(0);
      R.fill(0);
      // source switching with a short fade
      const target = host.pending ? 0 : host.name === 'off' ? 0 : 1;
      if (host.pending && host.gain <= 0) {
        host.name = host.pending;
        host.pending = null;
        host.source = createSource(host.name, this.sr);
      }
      if (host.name === 'input') {
        const inp = inputs && inputs[h];
        if (inp) {
          L.set(inp[0]);
          R.set(inp[1]);
        }
      } else if (host.source) {
        host.source.render(L, R, BLOCK, this.beat, bps);
      }
      if (host.gain !== target || target !== 1) {
        let g = host.gain;
        const st = target > g ? this.srcFade : -this.srcFade;
        for (let n = 0; n < BLOCK; n++) {
          g = clamp(g + st, 0, 1);
          L[n] *= g;
          R[n] *= g;
        }
        host.gain = g;
      }
      host.cond.process(L, R, BLOCK, host.name === 'input');
      if (this.strikeQueued && host.name !== 'off') {
        L[0] += STRIKE;
        R[0] += STRIKE;
      }
      this.host.cur[`from${h + 1}L`].set(L);
      this.host.cur[`from${h + 1}R`].set(R);
    }
    if (this.strikeQueued) {
      this.strikeQueued = false;
      for (const Lp of this.loopsInfo) this.ecology.kick(Lp);
    }
  }

  processBlock(inputs, outL, outR) {
    if (this.dirty) this.analyze();
    const bps = this.bpm / 60 / this.sr;
    this.renderHosts(inputs, bps);

    for (const m of this.moduleList) {
      m.swapBuffers();
      m.processed = false;
    }
    for (const m of this.order) {
      if (!m.active) {
        m.processed = true;
        continue;
      }
      this.route(m);
      m.updateParams();
      m.process();
      // every output sample: soft-bound loud values, catch NaN/Inf
      let bad = !m.verify();
      for (let k = 0; k < m.outKeys.length; k++) {
        const b = m.cur[m.outKeys[k]];
        for (let n = 0; n < BLOCK; n++) {
          const x = b[n];
          if (x > 4 || x < -4) {
            if (x < 1e9 && x > -1e9) b[n] = softLimit(x, 4, 8);
            else {
              b[n] = 0;
              bad = true;
            }
          } else if (x !== x) {
            b[n] = 0;
            bad = true;
          }
        }
      }
      if (bad) {
        this.faults++;
        try {
          m.reset();
        } catch {
          /* ignore */
        }
        m.clearOutputs();
      }
      m.processed = true;
    }
    this.route(this.host);
    this.ecology.update(this.loopsInfo, () => this.governLoops());

    // global wet/dry against the summed host inputs, then bypass
    const dL = this.dryL, dR = this.dryR;
    dL.fill(0);
    dR.fill(0);
    for (let h = 1; h <= 3; h++) {
      const a = this.host.cur[`from${h}L`], b = this.host.cur[`from${h}R`];
      for (let n = 0; n < BLOCK; n++) {
        dL[n] += a[n];
        dR[n] += b[n];
      }
    }
    const m0 = this.mix;
    this.mix += (this.mixTarget - this.mix) * this.mixCoef;
    const b0 = this.bypass;
    this.bypass += (this.bypassTarget - this.bypass) * this.bypassCoef;
    if (Math.abs(this.bypass - this.bypassTarget) < 1e-4) this.bypass = this.bypassTarget;
    const wL = this.host.in.toL, wR = this.host.in.toR;
    for (let n = 0; n < BLOCK; n++) {
      const t = n / BLOCK;
      const mm = (m0 + (this.mix - m0) * t) * HALF_PI;
      const gd = Math.cos(mm), gw = Math.sin(mm);
      let l = dL[n] * gd + wL[n] * gw;
      let r = dR[n] * gd + wR[n] * gw;
      const bp = b0 + (this.bypass - b0) * t;
      if (bp > 0) {
        l = l * (1 - bp) + dL[n] * bp;
        r = r * (1 - bp) + dR[n] * bp;
      }
      outL[n] = l;
      outR[n] = r;
    }
    this.master.process(outL, outR, BLOCK);
    this.beat += BLOCK * bps;
    if (this.beat > 1e6) this.beat -= 1e6 - (1e6 % 16);
    this.blocks++;
  }

  telemetry() {
    const values = {};
    const loops = {};
    const leds = {};
    for (const m of this.moduleList) {
      values[m.id] = m.paramIds.map((id) => m.p[id]);
      loops[m.id] = m.loop;
      if (m.led) leds[m.id] = m.led();
    }
    const mixer = this.modules.get('mixer');
    const tamer = this.modules.get('tamer');
    return {
      hosts: this.hosts.map((h) => h.cond.readPeak()),
      mixer: mixer.readMeters(),
      tamer: tamer.readTelemetry(),
      master: this.master.readTelemetry(),
      values,
      loops,
      leds,
      faults: this.faults + this.master.faults,
      ecology: this.loopsInfo.filter((L) => L.s && L.backs.length).map((L) => ({ m: L.members, e: L.s.eDb, g: L.s.gDb, dip: L.s.dip })),
      beat: this.beat,
      active: this.moduleList.filter((m) => m.active).map((m) => m.id),
    };
  }
}
