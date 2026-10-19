import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, render, applyModel, peak, rmsDb, bandRatioDb, bandLevelDb, countNonFinite, flatness, SR } from './harness.mjs';
import { PatchModel } from '../src/patch.js';
import { PRESETS, CATEGORIES, applyPreset } from '../src/presets.js';
import { OUTPUT_CEILING_DB } from '../src/spec.js';

const CEIL = Math.pow(10, OUTPUT_CEILING_DB / 20) + 1e-6;
const noInput = (p) => p.sources.every((s) => s === 'impulse');

function load(p) {
  const model = new PatchModel();
  applyPreset(model, p);
  const e = makeEngine();
  applyModel(e, model);
  e.setGlobal('bpm', p.bpm);
  p.sources.forEach((s, h) => e.setSource(h, s));
  return e;
}

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
  assert.ok(PRESETS.filter(noInput).length >= 20, 'no-input patches');
  assert.ok(noInput(PRESETS[0]), 'the first patch should need no input');
  assert.ok(PRESETS.length >= 47);
});

for (const p of PRESETS.filter(noInput)) {
  test(`no-input patch "${p.name}" lives on one impulse, breathes, and stays clean`, () => {
    const e = load(p);
    e.strike();
    const secs = 45;
    const out = render(e, secs);
    const lv = [];
    for (let t = 0; t < secs; t++) lv.push(rmsDb(out.L.subarray(t * SR, (t + 1) * SR)));
    assert.equal(countNonFinite(out.L) + countNonFinite(out.R), 0);
    assert.equal(e.faults, 0, 'module fault');
    assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, 'over the ceiling');
    assert.ok(lv[1] > -45, `not alive after a second (${lv[1].toFixed(1)} dBFS)`);
    const late = lv.slice(5);
    assert.ok(Math.min(...late) > -60, `the loops collapsed (${Math.min(...late).toFixed(1)} dBFS)`);
    const mean = 10 * Math.log10(late.reduce((a, v) => a + 10 ** (v / 10), 0) / late.length);
    assert.ok(mean > -32 && mean < -14, `level ${mean.toFixed(1)} dBFS is outside the factory range`);
    assert.ok(Math.max(...late) - Math.min(...late) > 6, 'the patch does not breathe');
    const tail = out.L.subarray(SR * (secs - 15));
    assert.ok(lv.slice(-10).every((v) => v > -50), 'the patch is fading away');
    const hf12 = bandRatioDb(tail, 12000);
    assert.ok(hf12 < -30, `too much energy above 12 kHz (${hf12.toFixed(1)} dB)`);
    assert.ok(bandLevelDb(tail, 12000) < -60, 'audible energy above 12 kHz');
    const fl = flatness(tail), hf4 = bandRatioDb(tail, 4000);
    assert.ok(fl < 0.4 || hf4 < -40, `hiss (flatness ${fl.toFixed(2)} with ${hf4.toFixed(1)} dB above 4 kHz)`);
  });
}

for (const p of PRESETS.filter((x) => !noInput(x))) {
  test(`input patch "${p.name}" plays cleanly and ${p.drone ? 'stays bounded' : 'falls silent'}`, () => {
    const e = load(p);
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
