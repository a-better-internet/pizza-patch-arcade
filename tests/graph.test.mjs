import test from 'node:test';
import assert from 'node:assert/strict';
import { processOrder, loopModules, closesLoop, neededModules, cableAncestry } from '../src/graph.js';
import { PatchModel, ORIGIN_DICE, ORIGIN_HAND } from '../src/patch.js';
import { getJack, MODULES } from '../src/spec.js';
import { Rng } from '../src/dsp/util.js';

const cab = (id, fm, fj, tm, tj) => ({ id, from: { m: fm, j: fj }, to: { m: tm, j: tj } });
const isAudio = (c) => getJack(c.from.m, c.from.j).type === 'audio';

test('processing order follows signal flow from the host', () => {
  const cables = [
    cab('a', 'host', 'from1L', 'tape', 'in1L'),
    cab('b', 'tape', 'out1L', 'echoforge', 'in1L'),
    cab('c', 'echoforge', 'out1L', 'host', 'toL'),
    cab('d', 'orbit', 'cvout:x', 'tape', 'cv:wow'),
  ];
  const order = processOrder(MODULES.map((m) => m.id), cables);
  assert.ok(order.indexOf('tape') < order.indexOf('echoforge'));
  assert.ok(order.indexOf('orbit') < order.indexOf('tape'), 'modulator runs before the module it modulates');
});

test('loops are detected through audio and CV, host chains are not loops', () => {
  const chain = [cab('a', 'host', 'from1L', 'tape', 'in1L'), cab('b', 'tape', 'out1L', 'host', 'toL')];
  assert.equal(loopModules(chain).size, 0);
  const loop = [...chain, cab('c', 'tape', 'out2L', 'tape', 'in2L')];
  assert.deepEqual([...loopModules(loop)], ['tape']);
  const cvLoop = [cab('x', 'orbit', 'cvout:x', 'drift', 'cv:rate'), cab('y', 'drift', 'cvout:walk', 'orbit', 'cv:rate')];
  assert.deepEqual([...loopModules(cvLoop)].sort(), ['drift', 'orbit']);
  assert.equal(closesLoop(chain, 'tape', 'tape'), true);
  assert.equal(closesLoop(chain, 'host', 'tape'), false);
});

test('idle modules are not needed', () => {
  const cables = [cab('a', 'host', 'from1L', 'tape', 'in1L'), cab('b', 'tape', 'out1L', 'host', 'toL'), cab('c', 'host', 'from2L', 'prism', 'in1L')];
  const need = neededModules(cables);
  assert.ok(need.has('tape'));
  assert.ok(!need.has('prism'), 'a module that never reaches To Host is idle');
});

test('cables are tinted by the host route they descend from', () => {
  const cables = [
    cab('a', 'host', 'from1L', 'tape', 'in1L'),
    cab('b', 'tape', 'out1L', 'mixer', 'ch1L'),
    cab('c', 'host', 'from2L', 'prism', 'in1L'),
    cab('d', 'prism', 'out1L', 'mixer', 'ch2L'),
    cab('e', 'mixer', 'outL', 'tamer', 'in1L'),
  ];
  const anc = cableAncestry(cables, isAudio);
  assert.deepEqual([...anc.get('b')], [1]);
  assert.deepEqual([...anc.get('d')], [2]);
  assert.deepEqual([...anc.get('e')].sort(), [1, 2]);
});

test('patch rules: output to input, same type, one source per audio input, stereo auto-follow', () => {
  const p = new PatchModel();
  const n0 = p.cables.length;
  assert.equal(p.connect({ m: 'tape', j: 'out1L' }, { m: 'prism', j: 'out1L' }).length, 0, 'output to output refused');
  assert.equal(p.connect({ m: 'tape', j: 'in1L' }, { m: 'prism', j: 'in1L' }).length, 0, 'input to input refused');
  assert.equal(p.connect({ m: 'orbit', j: 'cvout:x' }, { m: 'prism', j: 'in1L' }).length, 0, 'CV never meets audio');
  const made = p.connect({ m: 'host', j: 'from1L' }, { m: 'tape', j: 'in1L' });
  assert.equal(made.length, 2, 'left-first auto-follows the right pair');
  assert.equal(p.connect({ m: 'host', j: 'from2R' }, { m: 'prism', j: 'in1R' }).length, 1, 'right-first does not follow');
  // dragging from the input end works too
  assert.equal(p.connect({ m: 'echoforge', j: 'in1L' }, { m: 'prism', j: 'out1L' }).length, 2);
  // replacing: a new cable into tape In 1 L removes the old one
  p.connect({ m: 'prism', j: 'out2L' }, { m: 'tape', j: 'in1L' }, { follow: false });
  const into = p.cables.filter((c) => c.to.m === 'tape' && c.to.j === 'in1L');
  assert.equal(into.length, 1);
  assert.equal(into[0].from.m, 'prism');
  // To Host sums, CV inputs are additive
  p.connect({ m: 'prism', j: 'out1L' }, { m: 'host', j: 'toL' });
  assert.ok(p.cables.filter((c) => c.to.m === 'host' && c.to.j === 'toL').length >= 2);
  p.connect({ m: 'orbit', j: 'cvout:x' }, { m: 'prism', j: 'cv:bands' });
  p.connect({ m: 'drift', j: 'cvout:walk' }, { m: 'prism', j: 'cv:bands' });
  assert.equal(p.cables.filter((c) => c.to.j === 'cv:bands').length, 2);
  assert.ok(p.cables.length > n0);
});

test('dice never disturb hand cables or another route, and X clears only the route', () => {
  const p = new PatchModel();
  p.connect({ m: 'host', j: 'from3L' }, { m: 'ghost', j: 'in1L' });
  p.connect({ m: 'ghost', j: 'out1L' }, { m: 'mixer', j: 'ch3L' });
  const hand = p.cables.filter((c) => c.origin === ORIGIN_HAND).map((c) => c.id);
  const rng = new Rng(42);
  for (let i = 0; i < 40; i++) {
    const used1 = p.rollRoute(1, rng);
    const used2 = p.rollRoute(2, rng);
    assert.ok(used1 && used1.length >= 2 && used1.length <= 4);
    assert.ok(!used1.includes('ghost') && !used2.includes('ghost'), 'hand-patched module is never taken');
    assert.ok(!used1.some((m) => used2.includes(m)), 'routes never share audio modules');
    for (const id of hand) assert.ok(p.cables.some((c) => c.id === id), 'hand cable survives');
    // every input still has at most one audio source
    const seen = new Set();
    for (const c of p.cables) {
      const j = getJack(c.to.m, c.to.j);
      if (j.multi) continue;
      const k = `${c.to.m}.${c.to.j}`;
      assert.ok(!seen.has(k), `single source on ${k}`);
      seen.add(k);
    }
  }
  p.clearRoute(1);
  assert.equal(p.cables.filter((c) => c.origin === ORIGIN_DICE && c.route === 1).length, 0);
  assert.ok(p.cables.some((c) => c.origin === ORIGIN_DICE && c.route === 2));
  assert.ok(p.cables.some((c) => c.from.m === 'mixer' && c.to.m === 'tamer'), 'trunk survives');
});

test('patches round-trip through JSON', () => {
  const p = new PatchModel();
  p.rollRoute(1, new Rng(7));
  p.setParam('echoforge', 'fdbk', 0.77);
  const json = JSON.parse(JSON.stringify(p.toJSON()));
  const q = new PatchModel();
  q.load(json);
  assert.equal(q.cables.length, p.cables.length);
  assert.equal(q.params.echoforge.fdbk, 0.77);
  assert.throws(() => q.load({ nope: true }));
});
