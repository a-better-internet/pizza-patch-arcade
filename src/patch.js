// Patch model: cables, knob values and the patching rules from the manual.
// Pure logic (no DOM), shared by the UI and the test suite.
//
// Rules (Standard mode):
//  1. Output to input only.            2. Audio to audio, CV to CV.
//  3. One source per audio input; a new cable replaces the old one.
//     To Host sums, and CV inputs are additive.
//  4. Stereo auto-follow: patching a left output into a left input also wires
//     the right pair. Right-first does not, and either cable can be removed.

import {
  MODULES, MODULE_BY_ID, HOST_ID, getJack, defaultParams, defaultButtons, GLOBAL_PARAMS,
  DICE_EFFECTS, DICE_MODULATORS, stepIndex, stepValue, RACK_VERSION,
} from './spec.js';
import { Rng } from './dsp/util.js';
import { closesLoop } from './graph.js';

export const ORIGIN_HAND = 'hand';
export const ORIGIN_DICE = 'dice';
export const ORIGIN_TRUNK = 'trunk';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class PatchModel {
  constructor() {
    this.listeners = new Set();
    this.nextId = 1;
    this.init();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners) fn(type, detail);
  }

  init() {
    this.name = 'Init';
    this.cables = [];
    this.params = defaultParams();
    this.buttons = defaultButtons();
    this.globals = Object.fromEntries(GLOBAL_PARAMS.map((g) => [g.id, g.def]));
    this.addTrunk();
    this.emit('load');
  }

  // The shared trunk: mixer -> Feedback Tamer -> To Host.
  addTrunk() {
    this.connect({ m: 'mixer', j: 'outL' }, { m: 'tamer', j: 'in1L' }, { origin: ORIGIN_TRUNK, silent: true });
    this.connect({ m: 'tamer', j: 'out1L' }, { m: HOST_ID, j: 'toL' }, { origin: ORIGIN_TRUNK, silent: true });
  }

  // ------------------------------------------------------------------ cables
  newId() {
    return `c${this.nextId++}`;
  }

  cablesAt(m, j) {
    return this.cables.filter((c) => (c.from.m === m && c.from.j === j) || (c.to.m === m && c.to.j === j));
  }

  // Validate a drag between two jacks. Returns { from, to } (normalised so
  // `from` is the output) or { error }.
  static check(a, b) {
    const ja = getJack(a.m, a.j), jb = getJack(b.m, b.j);
    if (!ja || !jb) return { error: 'unknown jack' };
    if (a.m === b.m && a.j === b.j) return { error: 'same jack' };
    if (ja.dir === jb.dir) return { error: ja.dir === 'out' ? 'output to output' : 'input to input' };
    if (ja.type !== jb.type) return { error: 'audio and CV never mix' };
    return ja.dir === 'out' ? { from: a, to: b, fromJack: ja, toJack: jb } : { from: b, to: a, fromJack: jb, toJack: ja };
  }

  // Connect two jacks following the rules. Returns the cables created.
  connect(a, b, { origin = ORIGIN_HAND, route = 0, follow = true, silent = false } = {}) {
    const chk = PatchModel.check(a, b);
    if (chk.error) return [];
    const made = [];
    const one = (from, to, toJack) => {
      if (this.cables.some((c) => c.from.m === from.m && c.from.j === from.j && c.to.m === to.m && c.to.j === to.j)) return;
      if (!toJack.multi) this.cables = this.cables.filter((c) => !(c.to.m === to.m && c.to.j === to.j));
      const loop = closesLoop(this.cables, from.m, to.m);
      const cab = { id: this.newId(), from: { ...from }, to: { ...to }, origin, route, loop };
      this.cables.push(cab);
      made.push(cab);
    };
    one(chk.from, chk.to, chk.toJack);
    if (follow && chk.fromJack.type === 'audio' && chk.fromJack.pair && chk.toJack.pair) {
      const toR = getJack(chk.to.m, chk.toJack.pair);
      one({ m: chk.from.m, j: chk.fromJack.pair }, { m: chk.to.m, j: chk.toJack.pair }, toR);
    }
    if (made.length && !silent) this.emit('cables', { added: made });
    return made;
  }

  removeCable(id) {
    const before = this.cables.length;
    this.cables = this.cables.filter((c) => c.id !== id);
    if (this.cables.length !== before) this.emit('cables', { removed: [id] });
  }

  removeWhere(pred, silent = false) {
    const gone = this.cables.filter(pred).map((c) => c.id);
    if (!gone.length) return 0;
    this.cables = this.cables.filter((c) => !pred(c));
    if (!silent) this.emit('cables', { removed: gone });
    return gone.length;
  }

  clearAllCables() {
    this.cables = [];
    this.addTrunk();
    this.emit('cables', {});
  }

  // ------------------------------------------------------------------ params
  setParam(m, p, v, silent = false) {
    if (!this.params[m] || !(p in this.params[m])) return;
    const spec = MODULE_BY_ID[m].params.find((x) => x.id === p);
    let val = clamp01(+v || 0);
    if (spec && spec.steps) val = stepValue(stepIndex(val, spec.steps), spec.steps);
    this.params[m][p] = val;
    if (!silent) this.emit('param', { m, p, v: val });
  }

  setButton(m, b, v) {
    if (!this.buttons[m]) return;
    this.buttons[m][b] = !!v;
    this.emit('button', { m, b, v: !!v });
  }

  setGlobal(key, v) {
    this.globals[key] = clamp01(+v || 0);
    this.emit('global', { key, v: this.globals[key] });
  }

  // ------------------------------------------------------------------ dice
  // Modules whose audio is in use by hand cables or by another route.
  busyModules(route) {
    const busy = new Set();
    for (const c of this.cables) {
      const audio = getJack(c.from.m, c.from.j).type === 'audio';
      if (!audio) continue;
      if (c.origin === ORIGIN_DICE && c.route === route) continue;
      busy.add(c.from.m);
      busy.add(c.to.m);
    }
    busy.delete(HOST_ID);
    return busy;
  }

  clearRoute(route, silent = false) {
    return this.removeWhere((c) => c.origin === ORIGIN_DICE && c.route === route, silent);
  }

  rollKnobs(moduleId, rng) {
    const spec = MODULE_BY_ID[moduleId];
    for (const p of spec.params) {
      if (!p.roll) continue;
      const [mu, sigma, lo, hi] = p.roll;
      const v = Math.min(hi, Math.max(lo, mu + sigma * rng.gauss()));
      this.setParam(moduleId, p.id, v, true);
    }
    for (const b of spec.buttons) if (b.toggle && b.id !== 'freeze') this.buttons[moduleId][b.id] = rng.next() < 0.3;
    if (this.buttons[moduleId].freeze !== undefined) this.buttons[moduleId].freeze = false;
  }

  // Build a random chain for one From Host route. Never touches hand-patched
  // cables or another route's audio. Returns the modules used (or null).
  // With `seed` (the route carries only the Strike impulse) the chain is always
  // closed into a loop, since nothing else would ever make a sound, and the Fdbk
  // knob instead sets the chance of extra tangle: a second loop and the chain
  // listening to itself through its own CV outputs.
  rollRoute(route, rng = new Rng((Math.random() * 2 ** 31) | 0), { seed = false } = {}) {
    this.clearRoute(route, true);
    const busy = this.busyModules(route);
    const pool = DICE_EFFECTS.filter(([id]) => !busy.has(id));
    if (!pool.length) {
      this.emit('cables', {});
      return null;
    }
    const want = Math.min(pool.length, 2 + rng.int(3));
    const picks = [];
    const avail = pool.slice();
    while (picks.length < want && avail.length) {
      const total = avail.reduce((s, [, w]) => s + w, 0);
      let x = rng.next() * total;
      let k = 0;
      for (; k < avail.length - 1; k++) {
        x -= avail[k][1];
        if (x <= 0) break;
      }
      picks.push(avail[k][0]);
      avail.splice(k, 1);
    }
    const opts = { origin: ORIGIN_DICE, route, silent: true };
    let src = { m: HOST_ID, j: `from${route}L` };
    for (const fx of picks) {
      this.connect(src, { m: fx, j: 'in1L' }, opts);
      src = { m: fx, j: 'out1L' };
      this.rollKnobs(fx, rng);
    }
    // into this route's mixer channel, unless a hand cable owns it
    const chIn = `ch${route}L`;
    const owned = this.cables.some((c) => c.to.m === 'mixer' && (c.to.j === chIn || c.to.j === `ch${route}R`) && !(c.origin === ORIGIN_DICE && c.route === route));
    this.connect(src, owned ? { m: HOST_ID, j: 'toL' } : { m: 'mixer', j: chIn }, opts);

    if (seed) {
      // no input: the last module feeds back into an earlier one (or itself)
      const last = picks.length - 1;
      const i = rng.int(picks.length);
      this.connect({ m: picks[last], j: 'out2L' }, { m: picks[i], j: 'in2L' }, opts);
      // Dust Engine is the one module that adds its own noise: keep it a patina
      if (picks.includes('dust')) {
        this.setParam('dust', 'dust', Math.min(this.params.dust.dust, 0.2), true);
        this.setParam('dust', 'wear', Math.min(this.params.dust.wear, 0.15), true);
      }
      if (rng.next() < this.globals.fdbkChance) {
        // tangle: a second, inner loop and a module listening to the chain
        if (picks.length >= 3) {
          const k = 1 + rng.int(last - 1);
          if (k - 1 !== i) this.connect({ m: picks[k], j: 'out2L' }, { m: picks[k - 1], j: 'in2L' }, opts);
        }
        const listeners = picks.filter((id) => MODULE_BY_ID[id].cvOuts.length);
        const from = listeners.length ? listeners[rng.int(listeners.length)] : 'tamer';
        const outs = MODULE_BY_ID[from].cvOuts;
        const fx = picks[rng.int(picks.length)];
        const targets = MODULE_BY_ID[fx].params.filter((p) => p.cv);
        const tp = targets[rng.int(targets.length)];
        this.connect({ m: from, j: `cvout:${outs[rng.int(outs.length)].id}` }, { m: fx, j: `cv:${tp.id}` }, opts);
      }
    } else if (picks.length >= 2 && rng.next() < this.globals.fdbkChance) {
      // a chance of a stereo feedback loop: a later module back into an earlier In 2
      const j = 1 + rng.int(picks.length - 1);
      const i = rng.int(j);
      this.connect({ m: picks[j], j: 'out2L' }, { m: picks[i], j: 'in2L' }, opts);
    }

    // 1-2 modulators into the chain's CV inputs (CV is shared between routes)
    const nMods = 1 + rng.int(2);
    const mods = DICE_MODULATORS.slice();
    for (let k = 0; k < nMods && mods.length; k++) {
      const mod = mods.splice(rng.int(mods.length), 1)[0];
      const inUse = this.cables.some((c) => c.from.m === mod);
      if (!inUse) this.rollKnobs(mod, rng);
      const outs = MODULE_BY_ID[mod].cvOuts;
      const out = outs[rng.int(outs.length)].id;
      const fx = picks[rng.int(picks.length)];
      const targets = MODULE_BY_ID[fx].params.filter((p) => p.cv);
      const tp = targets[rng.int(targets.length)];
      this.connect({ m: mod, j: `cvout:${out}` }, { m: fx, j: `cv:${tp.id}` }, opts);
    }
    this.emit('cables', { rolled: route });
    this.emit('params', {});
    return picks;
  }

  // ------------------------------------------------------------- persistence
  toJSON() {
    return {
      format: 'patch-arcade',
      version: RACK_VERSION,
      name: this.name,
      params: this.params,
      buttons: this.buttons,
      globals: this.globals,
      cables: this.cables.map(({ id, from, to, origin, route }) => ({ id, from, to, origin, route })),
    };
  }

  load(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.cables)) throw new Error('Not a Patch Arcade patch');
    this.name = typeof data.name === 'string' ? data.name.slice(0, 40) : 'Untitled';
    this.params = defaultParams();
    this.buttons = defaultButtons();
    for (const m of MODULES) {
      const src = data.params && data.params[m.id];
      if (src) for (const p of m.params) if (typeof src[p.id] === 'number') this.setParam(m.id, p.id, src[p.id], true);
      const bs = data.buttons && data.buttons[m.id];
      if (bs) for (const b of m.buttons) if (b.toggle && typeof bs[b.id] === 'boolean') this.buttons[m.id][b.id] = bs[b.id];
    }
    this.globals = Object.fromEntries(GLOBAL_PARAMS.map((g) => [g.id, g.def]));
    if (data.globals) for (const g of GLOBAL_PARAMS) if (typeof data.globals[g.id] === 'number') this.globals[g.id] = clamp01(data.globals[g.id]);
    this.cables = [];
    for (const c of data.cables) {
      if (!c || !c.from || !c.to) continue;
      const chk = PatchModel.check(c.from, c.to);
      if (chk.error) continue;
      if (!chk.toJack.multi) this.cables = this.cables.filter((x) => !(x.to.m === chk.to.m && x.to.j === chk.to.j));
      if (this.cables.some((x) => x.from.m === chk.from.m && x.from.j === chk.from.j && x.to.m === chk.to.m && x.to.j === chk.to.j)) continue;
      const origin = [ORIGIN_HAND, ORIGIN_DICE, ORIGIN_TRUNK].includes(c.origin) ? c.origin : ORIGIN_HAND;
      const route = [1, 2, 3].includes(c.route) ? c.route : 0;
      this.cables.push({ id: this.newId(), from: { m: chk.from.m, j: chk.from.j }, to: { m: chk.to.m, j: chk.to.j }, origin, route, loop: false });
    }
    this.emit('load');
  }
}
