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
//  * Audio on a feedback edge passes a "cable loss" stage: DC blocker, gentle
//    6 kHz low-pass and a soft bound. Loops therefore darken as they
//    recirculate (they recede into a wash) instead of building fizzy harmonics.

import { MODULES, BLOCK, HOST_ID, jackMap } from '../spec.js';
import { processOrder, loopModules, neededModules } from '../graph.js';
import { MasterChain } from './master.js';
import { createSource, InputConditioner, SOURCE_NAMES } from './sources.js';
import { MODULE_CLASSES } from './modules/index.js';
import { softLimit, sat, smoothCoef, HALF_PI, clamp, Biquad, DCBlocker } from './util.js';

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
    this.master.reset();
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
        cond: audio ? { lp: new Biquad(this.sr).lowpass(6000, 0.7071), dc: new DCBlocker(this.sr, 10) } : null,
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
      if (list.length === 0) {
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
    }
  }

  // Feedback-edge conditioning (see header). CV edges are only bounded.
  condition(c, s) {
    const t = this.tmp || (this.tmp = new Float32Array(BLOCK));
    if (c.cond) {
      const { lp, dc } = c.cond;
      for (let n = 0; n < BLOCK; n++) t[n] = 1.5 * sat(dc.process(lp.process(s[n])) / 1.5);
    } else {
      for (let n = 0; n < BLOCK; n++) t[n] = clamp(s[n], -2, 2);
    }
    return t;
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
      this.host.cur[`from${h + 1}L`].set(L);
      this.host.cur[`from${h + 1}R`].set(R);
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
      if (!m.verify()) this.faults++;
      for (let k = 0; k < m.outKeys.length; k++) {
        const b = m.cur[m.outKeys[k]];
        for (let n = 0; n < BLOCK; n++) {
          const x = b[n];
          if (x > 4 || x < -4) b[n] = softLimit(x, 4, 8);
        }
      }
      m.processed = true;
    }
    this.route(this.host);

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
      beat: this.beat,
      active: this.moduleList.filter((m) => m.active).map((m) => m.id),
    };
  }
}
