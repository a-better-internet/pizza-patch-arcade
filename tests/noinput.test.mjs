// The instrument has no generator. These tests check the no-input behaviour:
// one impulse is the only energy, loops live on it, breathe, and stay clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, render, applyModel, peak, rmsDb, bandRatioDb, countNonFinite, flatness, SR } from './harness.mjs';
import { MODULES, BLOCK, OUTPUT_CEILING_DB } from '../src/spec.js';
import { PatchModel } from '../src/patch.js';
import { Rng } from '../src/dsp/util.js';
import { LoopEcology } from '../src/dsp/ecology.js';
import { closesLoop } from '../src/graph.js';

const CEIL = Math.pow(10, OUTPUT_CEILING_DB / 20) + 1e-6;
const cab = (id, fm, fj, tm, tj) => ({ id, from: { m: fm, j: fj }, to: { m: tm, j: tj } });
const stereo = (id, fm, fj, tm, tj) => [cab(`${id}L`, fm, `${fj}L`, tm, `${tj}L`), cab(`${id}R`, fm, `${fj}R`, tm, `${tj}R`)];

// echo <-> ghost, heard from the ghost
const ECHO_GHOST = [
  ...stereo('a', 'host', 'from1', 'echoforge', 'in1'),
  ...stereo('b', 'echoforge', 'out1', 'ghost', 'in1'),
  ...stereo('c', 'ghost', 'out2', 'echoforge', 'in2'),
  ...stereo('d', 'ghost', 'out1', 'host', 'to'),
];
// Prism Engine patched into itself: a loop that circulates every 1.3 ms
const SELF_PRISM = [...stereo('a', 'prism', 'out2', 'prism', 'in2'), ...stereo('b', 'prism', 'out1', 'host', 'to')];

const seconds = (buf) => {
  const out = [];
  for (let t = 0; t + SR <= buf.length; t += SR) out.push(rmsDb(buf.subarray(t, t + SR)));
  return out;
};
const impulseOnly = (e) => [0, 1, 2].forEach((h) => e.setSource(h, 'impulse'));

test('no generator: without a loop, a Strike is one click and then silence', () => {
  const e = makeEngine();
  impulseOnly(e);
  e.setPatch([...stereo('a', 'host', 'from1', 'echoforge', 'in1'), ...stereo('b', 'echoforge', 'out1', 'host', 'to')]);
  assert.ok(rmsDb(render(e, 1).L) < -120, 'sound before any Strike');
  e.strike();
  const out = render(e, 12);
  assert.ok(peak(out.L) > 1e-3, 'the Strike was not heard');
  assert.ok(rmsDb(out.L.subarray(SR * 10)) < -100, 'something kept sounding without a loop');
});

test('one impulse is enough: a struck loop is still alive a minute later and never clips', () => {
  const e = makeEngine();
  impulseOnly(e);
  e.setPatch(ECHO_GHOST);
  e.strike();
  const out = render(e, 60);
  const lv = seconds(out.L);
  assert.equal(countNonFinite(out.L) + countNonFinite(out.R), 0);
  assert.equal(e.faults, 0);
  assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, 'over the ceiling');
  assert.ok(Math.min(...lv.slice(3)) > -60, `the loop collapsed (${Math.min(...lv.slice(3)).toFixed(1)} dBFS)`);
  assert.ok(rmsDb(out.L.subarray(SR * 50)) > -45, 'the loop faded away');
  assert.ok(bandRatioDb(out.L.subarray(SR * 30), 8000) < -30, 'the loop turned bright');
});

test('a loop that circulates every 1.3 ms survives its own breathing', () => {
  for (let k = 0; k < 3; k++) {
    makeEngine(); // shifts the modules' random seeds, so each pass hunts differently
    const e = makeEngine();
    e.setPatch(SELF_PRISM); // closing a new loop seeds it with one impulse
    const lv = seconds(render(e, 40).L);
    const low = Math.min(...lv.slice(3));
    assert.ok(low > -60, `pass ${k}: the self-loop collapsed (${low.toFixed(1)} dBFS)`);
    assert.equal(e.faults, 0);
  }
});

test('Breath: loops swell and recede', () => {
  const spread = (breath) => {
    const e = makeEngine();
    e.setGlobal('breath', breath);
    e.setPatch(ECHO_GHOST);
    const lv = seconds(render(e, 60).L).slice(10);
    return Math.max(...lv) - Math.min(...lv);
  };
  const still = spread(0), deep = spread(1);
  assert.ok(deep > 15, `Breath 1 only moves the level by ${deep.toFixed(1)} dB`);
  assert.ok(deep > still + 6, `Breath 1 (${deep.toFixed(1)} dB) is not deeper than Breath 0 (${still.toFixed(1)} dB)`);
});

test('Life sets how strongly loops live; Panic silences them until the next Strike', () => {
  const level = (life) => {
    const e = makeEngine();
    e.setGlobal('life', life);
    e.setGlobal('breath', 0);
    e.setPatch(ECHO_GHOST);
    return { e, db: rmsDb(render(e, 20).L.subarray(SR * 10)) };
  };
  const low = level(0.3), high = level(0.9);
  assert.ok(high.db > low.db + 8, `Life 0.9 (${high.db.toFixed(1)}) vs 0.3 (${low.db.toFixed(1)} dBFS)`);
  const { e } = high;
  impulseOnly(e);
  e.panic();
  render(e, 1);
  assert.ok(rmsDb(render(e, 3).L) < -100, 'Panic did not silence the loop');
  e.strike();
  assert.ok(rmsDb(render(e, 15).L.subarray(SR * 10)) > -45, 'a Strike did not bring the loop back');
});

test('Panic leaves nothing behind: every module patched into itself falls truly silent', () => {
  for (const spec of MODULES.filter((m) => m.kind === 'effect')) {
    const e = makeEngine();
    e.setGlobal('life', 0.9);
    const back = spec.id === 'reactor' ? 'in1' : 'in2'; // Reactor's In 2 is its modulator
    e.setPatch([...stereo('a', spec.id, 'out2', spec.id, back), ...stereo('b', spec.id, 'out1', 'host', 'to')]);
    render(e, 6);
    e.panic();
    const after = rmsDb(render(e, 4).L);
    assert.ok(after < -120, `${spec.id}: ${after.toFixed(1)} dBFS after Panic (state survived the reset)`);
  }
});

test('Life 0: a struck loop rings out and dies', () => {
  const e = makeEngine();
  e.setGlobal('life', 0);
  impulseOnly(e);
  e.setPatch(ECHO_GHOST);
  e.strike();
  render(e, 14);
  assert.ok(rmsDb(render(e, 2).L) < -80, 'a loop lived without Life');
});

test('Unrest carves a tone the loop has held, and only with Unrest up', () => {
  const carve = (unrest) => {
    const eco = new LoopEcology(SR, BLOCK);
    eco.set('unrest', unrest);
    const c = { pow: 0 };
    eco.sync([{ members: ['a'], backs: [c] }]);
    const t = new Float32Array(BLOCK);
    let ph = 0, pin = 0, pout = 0;
    const blocks = Math.round((30 * SR) / BLOCK);
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < BLOCK; i++) {
        t[i] = 0.1 * Math.sin(ph);
        ph += (2 * Math.PI * 700) / SR;
      }
      const last = b >= blocks - Math.round(SR / BLOCK);
      if (last) for (let i = 0; i < BLOCK; i++) pin += t[i] * t[i];
      eco.restless(c, t, BLOCK);
      if (last) for (let i = 0; i < BLOCK; i++) pout += t[i] * t[i];
    }
    return 10 * Math.log10(pout / pin);
  };
  assert.ok(Math.abs(carve(0)) < 0.1, 'Unrest 0 touched the tone');
  assert.ok(carve(1) < -6, `Unrest 1 only took ${carve(1).toFixed(1)} dB off a held tone`);
});

test('no-input dice: every roll closes a loop that lives on one impulse, bounded and free of hiss', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const model = new PatchModel();
    model.setGlobal('fdbkChance', seed % 2 ? 1 : 0); // with and without extra tangle
    const rng = new Rng(seed * 31 + 7);
    for (const r of [1, 2, 3]) model.rollRoute(r, rng, { seed: true });
    for (const r of [1, 2, 3]) {
      const route = model.cables.filter((c) => c.route === r);
      assert.ok(route.some((c) => closesLoop(route.filter((x) => x !== c), c.from.m, c.to.m)), `seed ${seed}: route ${r} has no loop`);
    }
    const e = makeEngine();
    applyModel(e, model);
    impulseOnly(e);
    e.strike();
    const out = render(e, 30);
    const tail = out.L.subarray(SR * 20);
    const where = `seed ${seed}`;
    assert.equal(countNonFinite(out.L) + countNonFinite(out.R), 0, where);
    assert.equal(e.faults, 0, `${where}: faults`);
    assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, `${where}: over the ceiling`);
    assert.ok(rmsDb(tail) > -50, `${where}: the patch died (${rmsDb(tail).toFixed(1)} dBFS)`);
    const hf12 = bandRatioDb(tail, 12000);
    assert.ok(hf12 < -24, `${where}: too much energy above 12 kHz (${hf12.toFixed(1)} dB)`);
    const fl = flatness(tail), hf4 = bandRatioDb(tail, 4000);
    assert.ok(fl < 0.4 || hf4 < -40, `${where}: hiss (flatness ${fl.toFixed(2)} with ${hf4.toFixed(1)} dB above 4 kHz)`);
  }
});
