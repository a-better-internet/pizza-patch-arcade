import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, render, applyModel, peak, rmsDb, bandRatioDb, countNonFinite, SR } from './harness.mjs';
import { PatchModel } from '../src/patch.js';
import { PRESETS, CATEGORIES, applyPreset } from '../src/presets.js';
import { OUTPUT_CEILING_DB } from '../src/spec.js';

const CEIL = Math.pow(10, OUTPUT_CEILING_DB / 20) + 1e-6;

test('every factory patch is complete and uniquely named', () => {
  const names = new Set();
  for (const p of PRESETS) {
    assert.ok(p.name && !names.has(p.name), `duplicate or missing name: ${p.name}`);
    names.add(p.name);
    assert.ok(CATEGORIES.includes(p.category), `${p.name}: unknown category`);
    assert.ok(p.desc && p.desc.length < 100, `${p.name}: description`);
    assert.ok(p.bpm >= 40 && p.bpm <= 240, `${p.name}: tempo`);
    assert.equal(p.sources.length, 3);
  }
  assert.ok(PRESETS.length >= 27);
});

for (const p of PRESETS) {
  test(`factory patch "${p.name}" plays cleanly and ${p.drone ? 'stays bounded' : 'falls silent'}`, () => {
    const model = new PatchModel();
    applyPreset(model, p);
    const e = makeEngine();
    applyModel(e, model);
    e.setGlobal('bpm', p.bpm);
    p.sources.forEach((s, h) => e.setSource(h, s));
    const out = render(e, 9);
    const tail = out.L.subarray(SR * 3);
    assert.equal(countNonFinite(out.L) + countNonFinite(out.R), 0);
    assert.equal(e.faults, 0, 'module fault');
    assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, 'over the ceiling');
    const lvl = rmsDb(tail);
    assert.ok(lvl > -32 && lvl < -12, `level ${lvl.toFixed(1)} dBFS is outside the factory range`);
    const hf = bandRatioDb(tail, 12000);
    assert.ok(hf < -24, `too much energy above 12 kHz (${hf.toFixed(1)} dB)`);
    p.sources.forEach((s, h) => e.setSource(h, 'off'));
    render(e, 14);
    const after = render(e, 2);
    if (p.drone) assert.ok(peak(after.L) <= CEIL);
    else assert.ok(rmsDb(after.L) < -80, `still ${rmsDb(after.L).toFixed(1)} dBFS 14 s after the sources stopped`);
  });
}
