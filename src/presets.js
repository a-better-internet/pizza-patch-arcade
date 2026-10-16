// Factory patches. Each builds on the shared trunk (mixer -> tamer -> To Host)
// and suggests demo sources for the From Host inputs.

const H = 'host';
const st = (model, a, b, opts) => model.connect(a, b, opts);

function setAll(model, m, values) {
  for (const k in values) model.setParam(m, k, values[k], true);
}

export const PRESETS = [
  {
    name: 'Warm Start',
    sources: ['keys', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'tape', j: 'in1L' });
      st(m, { m: 'tape', j: 'out1L' }, { m: 'echoforge', j: 'in1L' });
      st(m, { m: 'echoforge', j: 'out1L' }, { m: 'mixer', j: 'ch1L' });
      setAll(m, 'tape', { wear: 0.35, wow: 0.3, flutter: 0.2, mix: 0.8, memory: 0.15 });
      setAll(m, 'echoforge', { mix: 0.35, fdbk: 0.4, density: 0.35, diffuse: 0.45 });
    },
  },
  {
    name: 'Ghost Choir',
    sources: ['pad', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'prism', j: 'in1L' });
      st(m, { m: 'prism', j: 'out1L' }, { m: 'ghost', j: 'in1L' });
      st(m, { m: 'ghost', j: 'out1L' }, { m: 'mixer', j: 'ch1L' });
      st(m, { m: 'orbit', j: 'cvout:x' }, { m: 'prism', j: 'cv:bands' });
      setAll(m, 'prism', { bands: 0.42, detune: 0.8, res: 0.62, morph: 0.5, mix: 0.75, sep: 0.3 });
      setAll(m, 'ghost', { shimmer: 0.45, decay: 0.55, blur: 0.5, mix: 0.5, time: 0.55, pitch: 0.3 });
      setAll(m, 'orbit', { rate: 0.3, radius: 0.3, shape: 0.1 });
    },
  },
  {
    name: 'Shred Beat',
    sources: ['off', 'beat', 'off'],
    build(m) {
      st(m, { m: H, j: 'from2L' }, { m: 'glitch', j: 'in1L' });
      st(m, { m: 'glitch', j: 'out1L' }, { m: 'chrono', j: 'in1L' });
      st(m, { m: 'chrono', j: 'out1L' }, { m: 'mixer', j: 'ch2L' });
      st(m, { m: 'drift', j: 'cvout:walk' }, { m: 'chrono', j: 'cv:pitch' });
      st(m, { m: 'glitch', j: 'cvout:gate' }, { m: 'drift', j: 'cv:chaos' });
      setAll(m, 'glitch', { chance: 0.3, intense: 0.65, mix: 1, muta: 0.25, intel: 0.4 });
      setAll(m, 'chrono', { stretch: 0.25, reverse: 0.3, mix: 0.4, spray: 0.3, fdbk: 0.15 });
      setAll(m, 'drift', { rate: 0.5, depth: 0.25, smooth: 0.15, chaos: 0.3 });
      m.buttons.drift.sync = true;
    },
  },
  {
    name: 'Dusty Keys',
    sources: ['keys', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'dust', j: 'in1L' });
      st(m, { m: 'dust', j: 'out1L' }, { m: 'tape', j: 'in1L' });
      st(m, { m: 'tape', j: 'out1L' }, { m: 'bloom', j: 'in1L' });
      st(m, { m: 'bloom', j: 'out1L' }, { m: 'mixer', j: 'ch1L' });
      setAll(m, 'dust', { wear: 0.22, dust: 0.4, mix: 0.7, comp: 0.3 });
      setAll(m, 'tape', { wear: 0.5, wow: 0.45, flutter: 0.3, mix: 1, age: 0.6 });
      setAll(m, 'bloom', { mix: 0.35, bloom: 0.55, reverb: 0.45 });
    },
  },
  {
    name: 'Bass Reactor',
    sources: ['off', 'off', 'bass'],
    build(m) {
      st(m, { m: H, j: 'from3L' }, { m: 'reactor', j: 'in1L' });
      st(m, { m: 'reactor', j: 'out1L' }, { m: 'subverter', j: 'in1L' });
      st(m, { m: 'subverter', j: 'out1L' }, { m: 'mixer', j: 'ch3L' });
      st(m, { m: 'orbit', j: 'cvout:y' }, { m: 'reactor', j: 'cv:fm' });
      setAll(m, 'reactor', { freq: 0.3, fm: 0.4, mix: 0.7, env: 0.75, mod: 0.3 });
      setAll(m, 'subverter', { width: 0.65, hp: 0.35, move: 0.3, drive: 0.25 });
      setAll(m, 'orbit', { rate: 0.38, radius: 0.35 });
    },
  },
  {
    name: 'Game Over',
    sources: ['arp', 'beat', 'off'],
    build(m) {
      // route 1: a feedback loop throttled by the merger gain
      st(m, { m: H, j: 'from1L' }, { m: 'overmind', j: 'in1L' });
      st(m, { m: 'overmind', j: 'out1L' }, { m: 'echoforge', j: 'in1L' });
      st(m, { m: 'echoforge', j: 'out1L' }, { m: 'splitter', j: 'aInL' });
      st(m, { m: 'splitter', j: 'aOut1L' }, { m: 'mixer', j: 'ch1L' });
      st(m, { m: 'splitter', j: 'aOut2L' }, { m: 'merger', j: 'aIn1L' });
      st(m, { m: 'merger', j: 'aOutL' }, { m: 'overmind', j: 'in2L' });
      // route 2: probability-gated beat
      st(m, { m: H, j: 'from2L' }, { m: 'pgate', j: 'in1L' });
      st(m, { m: 'pgate', j: 'out1L' }, { m: 'mixer', j: 'ch2L' });
      st(m, { m: 'orbit', j: 'cvout:x' }, { m: 'echoforge', j: 'cv:diffuse' });
      setAll(m, 'overmind', { shape: 0.4, fold: 0.35, drive: 0.25, mix: 0.6 });
      setAll(m, 'echoforge', { mix: 0.5, fdbk: 0.45, density: 0.45 });
      setAll(m, 'merger', { gainA: 0.42 });
      setAll(m, 'pgate', { prob: 0.45, mode: 1, rate: 0.5, swing: 0.2 });
      setAll(m, 'tamer', { focus: 0.6 });
      setAll(m, 'orbit', { rate: 0.25, radius: 0.4 });
      m.globals.fdbkChance = 0.5;
    },
  },
  {
    name: 'Init',
    sources: ['keys', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'mixer', j: 'ch1L' });
    },
  },
];

export function applyPreset(model, preset) {
  model.load({ name: preset.name, cables: [] });
  model.addTrunk();
  preset.build(model);
  model.name = preset.name;
  model.emit('load');
}
