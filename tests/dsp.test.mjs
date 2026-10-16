import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, render, applyModel, signals, peak, rmsDb, bandRatioDb, bandLevelDb, countNonFinite, SR } from './harness.mjs';
import { MODULES, BLOCK, OUTPUT_CEILING_DB } from '../src/spec.js';
import { PatchModel } from '../src/patch.js';
import { Rng, Oversampler, fastSin } from '../src/dsp/util.js';

const CEIL = Math.pow(10, OUTPUT_CEILING_DB / 20) + 1e-6;
const cab = (id, fm, fj, tm, tj) => ({ id, from: { m: fm, j: fj }, to: { m: tm, j: tj } });
const stereo = (id, fm, fj, tm, tj) => [cab(`${id}L`, fm, `${fj}L`, tm, `${tj}L`), cab(`${id}R`, fm, `${fj}R`, tm, `${tj}R`)];

// Patch that puts one module between host input 1 and the host output.
function isolate(spec) {
  if (spec.kind === 'effect') return [...stereo('a', 'host', 'from1', spec.id, 'in1'), ...stereo('b', spec.id, 'out1', 'host', 'to')];
  if (spec.id === 'splitter') return [...stereo('a', 'host', 'from1', 'splitter', 'aIn'), ...stereo('b', 'splitter', 'aOut1', 'host', 'to')];
  if (spec.id === 'merger') return [...stereo('a', 'host', 'from1', 'merger', 'aIn1'), ...stereo('b', 'merger', 'aOut', 'host', 'to')];
  if (spec.id === 'mixer') return [...stereo('a', 'host', 'from1', 'mixer', 'ch1'), ...stereo('b', 'mixer', 'out', 'host', 'to')];
  if (spec.id === 'tamer') return [...stereo('a', 'host', 'from1', 'tamer', 'in1'), ...stereo('b', 'tamer', 'out1', 'host', 'to')];
  // modulators: modulate every CV input of Prism Engine, which sits in the path
  const outs = spec.cvOuts.map((c) => c.id);
  const prism = MODULES.find((m) => m.id === 'prism');
  return [
    ...stereo('a', 'host', 'from1', 'prism', 'in1'),
    ...stereo('b', 'prism', 'out1', 'host', 'to'),
    ...prism.params.map((p, i) => cab(`cv${i}`, spec.id, `cvout:${outs[i % outs.length]}`, 'prism', `cv:${p.id}`)),
  ];
}

test('oversampler: linear phase with an exact integer latency', () => {
  for (const L of [2, 4]) {
    const o = new Oversampler(L);
    let err = 0;
    for (let i = 0; i < SR / 2; i++) {
      const y = o.downsample(o.upsample(Math.sin((2 * Math.PI * 1000 * i) / SR)));
      if (i > 500) err = Math.max(err, Math.abs(y - Math.sin((2 * Math.PI * 1000 * (i - o.latency)) / SR)));
    }
    assert.ok(err < 1e-3, `L=${L} alignment error ${err}`);
  }
  let e = 0;
  for (let x = -50; x < 50; x += 0.001) e = Math.max(e, Math.abs(fastSin(x) - Math.sin(x)));
  assert.ok(e < 1e-5);
});

test('every module survives extreme settings without NaN, faults or overs', () => {
  const sigs = [() => signals.noise(0.95, 9), () => signals.square(2900, 0.95), () => signals.bursts(220, 0.8)];
  for (const spec of MODULES) {
    for (const setting of ['min', 'max', 'rand1', 'rand2']) {
      const e = makeEngine();
      e.setSource(0, 'input');
      e.setPatch(isolate(spec));
      const r = new Rng(setting.length * 101 + spec.id.length);
      for (const p of spec.params) {
        const v = setting === 'min' ? 0 : setting === 'max' ? 1 : r.next();
        e.setParam(spec.id, p.id, v);
      }
      for (const b of spec.buttons) if (b.toggle && b.id !== 'freeze') e.setButton(spec.id, b.id, setting !== 'min');
      const m = e.modules.get(spec.id);
      let modPeak = 0;
      const sig = sigs[(setting.length + spec.id.length) % sigs.length]();
      const out = render(e, 1.5, {
        input: sig,
        onBlock: () => {
          for (const k of m.outKeys) for (let n = 0; n < BLOCK; n++) modPeak = Math.max(modPeak, Math.abs(m.cur[k][n]));
        },
      });
      const where = `${spec.id}/${setting}`;
      assert.equal(countNonFinite(out.L) + countNonFinite(out.R), 0, `${where}: non-finite output`);
      assert.equal(e.faults, 0, `${where}: module fault`);
      assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, `${where}: output over ceiling`);
      assert.ok(modPeak < 8, `${where}: module output ${modPeak} out of bounds`);
    }
  }
});

test('the master output never exceeds -1 dBFS, even with a +12 dB feedback loop', () => {
  const e = makeEngine();
  e.setSource(0, 'input');
  e.setPatch([
    ...stereo('a', 'host', 'from1', 'merger', 'aIn1'),
    ...stereo('b', 'merger', 'aOut', 'splitter', 'aIn'),
    ...stereo('c', 'splitter', 'aOut1', 'merger', 'aIn2'), // loop
    ...stereo('d', 'splitter', 'aOut2', 'host', 'to'),
    ...stereo('e', 'splitter', 'aOut3', 'host', 'to'),
  ]);
  e.setParam('merger', 'gainA', 1);
  e.setParam('splitter', 'gainA', 1);
  e.setGlobal('volume', 1);
  const out = render(e, 6, { input: signals.noise(0.98, 4) });
  assert.ok(peak(out.L) <= CEIL, `peak ${peak(out.L)}`);
  assert.ok(peak(out.R) <= CEIL);
  assert.equal(countNonFinite(out.L), 0);
});

test('random dice patches with 100% feedback stay bounded, stable and dark', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const model = new PatchModel();
    model.setGlobal('fdbkChance', 1);
    const rng = new Rng(seed * 7);
    for (const r of [1, 2, 3]) model.rollRoute(r, rng);
    const e = makeEngine();
    applyModel(e, model);
    e.setSource(0, 'keys');
    e.setSource(1, 'beat');
    e.setSource(2, 'pad');
    const out = render(e, 22);
    const tail = out.L.subarray(SR * 8);
    const where = `seed ${seed}`;
    assert.equal(countNonFinite(out.L), 0, where);
    assert.equal(e.faults, 0, `${where}: faults`);
    assert.ok(peak(out.L) <= CEIL && peak(out.R) <= CEIL, `${where}: over ceiling`);
    const hf12 = bandRatioDb(tail, 12000);
    const hf16 = bandRatioDb(tail, 16000);
    assert.ok(hf12 < -24, `${where}: too much energy above 12 kHz (${hf12.toFixed(1)} dB)`);
    assert.ok(hf16 < -45, `${where}: too much energy above 16 kHz (${hf16.toFixed(1)} dB)`);
    assert.ok(rmsDb(tail) > -45, `${where}: patch went silent`);
  }
});

test('no hiss: with nothing playing the rack goes fully silent', () => {
  const model = new PatchModel();
  const rng = new Rng(99);
  model.rollRoute(1, rng);
  // force the noisiest modules into the chain
  model.connect({ m: 'host', j: 'from2L' }, { m: 'dust', j: 'in1L' });
  model.connect({ m: 'dust', j: 'out1L' }, { m: 'overmind', j: 'in1L' });
  model.connect({ m: 'overmind', j: 'out1L' }, { m: 'mixer', j: 'ch2L' });
  model.setParam('dust', 'wear', 1);
  model.setParam('dust', 'dust', 1);
  model.setParam('dust', 'comp', 1);
  model.setParam('dust', 'bit', 0.8);
  model.setParam('overmind', 'drive', 1);
  const e = makeEngine();
  applyModel(e, model);
  e.setSource(0, 'keys');
  e.setSource(1, 'beat');
  render(e, 4);
  e.setSource(0, 'off');
  e.setSource(1, 'off');
  const out = render(e, 14);
  const last = out.L.subarray(SR * 10);
  const lvl = rmsDb(last);
  assert.ok(lvl < -100, `idle output should be silent, got ${lvl.toFixed(1)} dBFS`);
});

test('feedback loops never sustain themselves: dice patches fade to silence', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const model = new PatchModel();
    model.setGlobal('fdbkChance', 1);
    const rng = new Rng(seed * 13 + 5);
    for (const r of [1, 2, 3]) model.rollRoute(r, rng);
    const e = makeEngine();
    applyModel(e, model);
    e.setSource(0, 'keys');
    e.setSource(1, 'beat');
    e.setSource(2, 'pad');
    const playing = rmsDb(render(e, 8).L.subarray(SR * 4));
    e.setSource(0, 'off');
    e.setSource(1, 'off');
    e.setSource(2, 'off');
    render(e, 14);
    const after = rmsDb(render(e, 4).L);
    assert.ok(after < -70, `seed ${seed}: still ${after.toFixed(1)} dBFS 14 s after the input stopped (was ${playing.toFixed(1)})`);
  }
});

test('a loop throttled open past centre may bloom, but stays bounded', () => {
  const e = makeEngine();
  e.setSource(0, 'keys');
  e.setPatch([
    ...stereo('a', 'host', 'from1', 'echoforge', 'in1'),
    ...stereo('b', 'echoforge', 'out1', 'merger', 'aIn1'),
    ...stereo('c', 'merger', 'aOut', 'splitter', 'aIn'),
    ...stereo('d', 'splitter', 'aOut1', 'echoforge', 'in2'),
    ...stereo('e', 'splitter', 'aOut2', 'host', 'to'),
  ]);
  e.setParam('merger', 'gainA', 0.85);
  const out = render(e, 12);
  assert.ok(peak(out.L) <= CEIL, 'over ceiling');
  assert.equal(countNonFinite(out.L), 0);
  assert.equal(e.faults, 0);
});

test('patching one side of a stereo input crossfades (no click)', () => {
  const e = makeEngine();
  e.setSource(0, 'input');
  // L-only cable: R input is fed by mono normalisation
  e.setPatch([cab('l', 'host', 'from1L', 'mixer', 'ch1L'), ...stereo('o', 'mixer', 'out', 'host', 'to')]);
  render(e, 0.5, { input: () => 0.25 });
  const m = e.modules.get('mixer');
  let maxStep = 0, last = null;
  const watch = () => {
    for (let n = 0; n < BLOCK; n++) {
      const v = m.cur.outR[n];
      if (last !== null) maxStep = Math.max(maxStep, Math.abs(v - last));
      last = v;
    }
  };
  // now patch R with a different signal (zero): R must glide, not jump
  e.setPatch([cab('l', 'host', 'from1L', 'mixer', 'ch1L'), cab('r', 'host', 'from2R', 'mixer', 'ch1R'), ...stereo('o', 'mixer', 'out', 'host', 'to')]);
  render(e, 0.1, { input: () => 0.25, onBlock: watch });
  e.setPatch([cab('l', 'host', 'from1L', 'mixer', 'ch1L'), ...stereo('o', 'mixer', 'out', 'host', 'to')]);
  render(e, 0.1, { input: () => 0.25, onBlock: watch });
  assert.ok(maxStep < 0.01, `largest sample step ${maxStep}`);
});

test('long grains and glitches at slow tempos stay inside their buffers', () => {
  for (const id of ['chrono', 'glitch']) {
    const e = makeEngine();
    e.setSource(0, 'input');
    e.setGlobal('bpm', 40);
    e.setPatch(isolate(MODULES.find((m) => m.id === id)));
    const spec = MODULES.find((m) => m.id === id);
    for (const p of spec.params) e.setParam(id, p.id, 1);
    e.setParam(id, 'chance', 0.5);
    const m = e.modules.get(id);
    const bufs = m.buf;
    let bad = 0;
    const origRead = bufs[0].readHermite.bind(bufs[0]);
    bufs[0].readHermite = (pos) => {
      const w = bufs[0].pos;
      if (pos > w - 1 || pos < w - bufs[0].size + 2) bad++;
      return origRead(pos);
    };
    render(e, 12, { input: signals.bursts(220, 0.5) });
    assert.equal(bad, 0, `${id}: ${bad} reads outside the recorded window`);
  }
});

test('Dust Engine noise floor stays warm (no high hiss) while music plays', () => {
  const e = makeEngine();
  e.setSource(0, 'input');
  e.setPatch(isolate(MODULES.find((m) => m.id === 'dust')));
  e.setParam('dust', 'wear', 1);
  e.setParam('dust', 'dust', 0.6);
  e.setParam('dust', 'mix', 1);
  const out = render(e, 6, { input: signals.sine(220, 0.02), skip: 1 });
  assert.ok(bandRatioDb(out.L, 9000) < -30, `noise above 9 kHz: ${bandRatioDb(out.L, 9000).toFixed(1)} dB`);
});

test('Shrill Guard: tames harsh material, leaves normal material alone', () => {
  const harsh = (amount) => {
    const e = makeEngine();
    e.setSource(0, 'input');
    e.setPatch(stereo('a', 'host', 'from1', 'host', 'to'));
    e.setGlobal('shrill', amount);
    const out = render(e, 3, { input: signals.noise(0.4, 5), skip: 1 });
    return bandLevelDb(out.L, 8000, 16000);
  };
  const off = harsh(0), on = harsh(0.6);
  assert.ok(off - on > 8, `white noise above 8 kHz only reduced by ${(off - on).toFixed(1)} dB`);
  const e = makeEngine();
  e.setPatch(stereo('a', 'host', 'from1', 'host', 'to'));
  e.setSource(0, 'keys');
  render(e, 4);
  assert.ok(e.master.readTelemetry().hiGrDb < 0.5, 'keys trigger the guard');
});

test('Mix at 0 passes audio untouched (latency aligned)', () => {
  for (const spec of MODULES.filter((m) => m.kind === 'effect' && m.id !== 'subverter')) {
    const e = makeEngine();
    e.setSource(0, 'input');
    e.setPatch(isolate(spec));
    e.setParam(spec.id, 'mix', 0);
    const m = e.modules.get(spec.id);
    const hist = [];
    let err = 0;
    render(e, 0.6, {
      input: signals.bursts(330, 0.5),
      onBlock: (b) => {
        for (let n = 0; n < BLOCK; n++) hist.push(m.inL[n]);
        if (b < 20) return;
        for (let n = 0; n < BLOCK; n++) err = Math.max(err, Math.abs(m.cur.out1L[n] - hist[b * BLOCK + n - m.latency]));
      },
    });
    assert.ok(err < 1e-6, `${spec.id}: mix 0 deviates by ${err}`);
  }
});

test('patching fades cables in and out (no clicks)', () => {
  const e = makeEngine();
  e.setSource(0, 'input');
  render(e, 0.2, { input: signals.sine(100, 0.9) });
  e.setPatch(stereo('a', 'host', 'from1', 'host', 'to'));
  let first = null;
  render(e, 0.05, {
    input: signals.sine(100, 0.9),
    onBlock: (b) => {
      if (b === 0) first = 1;
    },
  });
  const out = render(e, 0.02, { input: signals.sine(100, 0.9) });
  assert.ok(first === 1 && peak(out.L) > 0.1);
  // a hard connect would jump straight to ~0.9; the fade keeps the first block small
  const e2 = makeEngine();
  e2.setSource(0, 'input');
  render(e2, 0.2, { input: () => 0.5 });
  e2.setPatch(stereo('a', 'host', 'from1', 'host', 'to'));
  const o2 = render(e2, BLOCK / SR, { input: () => 0.5 });
  assert.ok(o2.L[0] < 0.05, `first sample after patching ${o2.L[0]}`);
});

test('CPU budget: a dense three-route patch renders well faster than real time', () => {
  const model = new PatchModel();
  model.setGlobal('fdbkChance', 1);
  const rng = new Rng(3);
  for (const r of [1, 2, 3]) model.rollRoute(r, rng);
  const e = makeEngine();
  applyModel(e, model);
  e.setSource(0, 'keys');
  e.setSource(1, 'beat');
  e.setSource(2, 'pad');
  render(e, 1);
  const t0 = performance.now();
  render(e, 10);
  const ms = performance.now() - t0;
  const load = ms / 10000;
  console.log(`    dense patch CPU load: ${(load * 100).toFixed(1)}% of one core`);
  assert.ok(load < 0.6, `too slow: ${(load * 100).toFixed(1)}% of a core`);
});
