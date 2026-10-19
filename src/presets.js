// Factory patches. Each builds on the shared trunk (mixer -> tamer -> To Host).
//
// The no-input patches come first. They have no source at all: each From Host
// carries only the one-sample impulse sent by Strike, and every sound after that
// is a feedback network listening to itself. Each sets the three conditions the
// sound must satisfy to exist (Life, Breath, Unrest, see src/dsp/ecology.js).
// tests/presets.test.mjs checks that every one of them comes alive from a single
// impulse, is still alive a minute later, keeps changing, and never hisses,
// shrills or clips.
//
// The "Input FX" patches that follow use the rack as an effect for the demo
// instruments or your own input. They set Life to 0, so their loops only bloom
// while something feeds them.

import { expMap } from './spec.js';

const H = 'host';
const st = (model, a, b, opts) => model.connect(a, b, opts);
// patch out -> in, by "module.jack" strings
const wire = (m, from, to) => {
  const [fm, fj] = from.split('.');
  const [tm, tj] = to.split('.');
  return m.connect({ m: fm, j: fj }, { m: tm, j: tj });
};

function setAll(model, m, values) {
  for (const k in values) model.setParam(m, k, values[k], true);
}

// knob value helpers
const step = (i, n) => i / (n - 1); // stepped knobs
const echo32 = (n) => step(n - 1, 32); // Echoforge rate: n/32 of a bar
const semis = (st12) => 0.5 + st12 / 24; // Chrono Shredder pitch
const expKnob = (v, lo, hi) => Math.log(v / lo) / Math.log(hi / lo); // inverse of expMap
const bloomHz = (f) => expKnob(f, 55, 440);
const bandsHz = (f) => expKnob(f, 100, 8000);
const ghostTime = (sec) => expKnob(sec, 0.02, 0.9);
const fmHz = (f) => expKnob(f, 20, 4000);
const lfoHz = (f) => expKnob(f, 0.02, 20);
const detune = { unison: 0, m3: 0.2, M3: 0.4, fourth: 0.6, fifth: 0.8, octave: 1 };
const mode = { skip: step(0, 6), swap: step(1, 6), repeat: step(2, 6), mirror: step(3, 6), invert: step(4, 6), random: step(5, 6) };
const gateRate = { '1/4': step(0, 5), '1/8': step(1, 5), '1/16': step(2, 5), '1/8T': step(3, 5), '1/32': step(4, 5) };
const grain = { '1/64': step(0, 6), '1/32': step(1, 6), '1/16': step(2, 6), '1/8': step(3, 6), '1/4': step(4, 6), '1/2': step(5, 6) };
const glitchDur = { '1/32': step(0, 5), '1/16': step(1, 5), '1/8': step(2, 5), '1/4': step(3, 5), '1/2': step(4, 5) };
const patt = (n) => step(n - 1, 100);
void expMap;

const IMPULSE = ['impulse', 'impulse', 'impulse'];
const conditions = (life, breath, unrest) => (m) => Object.assign(m.globals, { life, breath, unrest });

// ------------------------------------------------------------------ no input
const NO_INPUT = [
  // ----------------------------------------------------------------- seeds
  {
    name: 'First Light',
    desc: 'One impulse, one loop: an echo and a ghost listening to each other.',
    category: 'Seeds',
    bpm: 90,
    conditions: [0.6, 0.5, 0.4],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'echoforge.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      setAll(m, 'echoforge', { rate: echo32(6), density: 0.45, diffuse: 0.5, fdbk: 0.35, spread: 0.7, mix: 0.5 });
      setAll(m, 'ghost', { decay: 0.5, blur: 0.45, shimmer: 0.15, time: ghostTime(0.33), width: 0.6, mix: 0.5 });
    },
  },
  {
    name: 'Self-Listening',
    desc: 'Prism patched into itself. When it howls, the howl moves its bands.',
    category: 'Seeds',
    bpm: 90,
    conditions: [0.55, 0.45, 0.5],
    build(m) {
      wire(m, 'host.from1L', 'prism.in1L');
      wire(m, 'prism.out2L', 'prism.in2L');
      wire(m, 'prism.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'tamer.cvout:howl', 'prism.cv:bands');
      setAll(m, 'prism', { bands: bandsHz(320), detune: detune.fifth, res: 0.55, morph: 0.4, sep: 0.3, spread: 0.6, mix: 0.8 });
      setAll(m, 'ghost', { decay: 0.45, blur: 0.6, shimmer: 0.1, time: ghostTime(0.25), mix: 0.4 });
      setAll(m, 'mixer', { fader1: 1 });
      setAll(m, 'tamer', { focus: 0.55 });
    },
  },
  {
    name: 'Tape Organism',
    desc: 'A tape loop that never stops: its own wow and flutter steer the echo.',
    category: 'Seeds',
    bpm: 84,
    conditions: [0.6, 0.55, 0.35],
    build(m) {
      wire(m, 'host.from1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out2L', 'tape.in2L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      wire(m, 'tape.cvout:wowflut', 'echoforge.cv:diffuse');
      setAll(m, 'tape', { wear: 0.45, wow: 0.5, flutter: 0.3, age: 0.5, memory: 0.25, mix: 0.9 });
      setAll(m, 'echoforge', { rate: echo32(8), density: 0.35, diffuse: 0.4, fdbk: 0.3, spread: 0.6, mix: 0.55 });
    },
  },
  {
    name: 'Howl & Hush',
    desc: 'Fold, filter, return. The louder it howls, the more it thins itself.',
    category: 'Seeds',
    bpm: 96,
    conditions: [0.6, 0.6, 0.45],
    build(m) {
      wire(m, 'host.from1L', 'overmind.in1L');
      wire(m, 'overmind.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'subverter.in1L');
      wire(m, 'subverter.out2L', 'overmind.in2L');
      wire(m, 'subverter.out1L', 'mixer.ch1L');
      wire(m, 'tamer.cvout:howl', 'subverter.cv:hp');
      setAll(m, 'overmind', { shape: 0.3, fold: 0.35, drive: 0.25, char: 0.2, mix: 0.5 });
      setAll(m, 'prism', { bands: bandsHz(500), res: 0.5, morph: 0.35, detune: detune.octave, mix: 0.8 });
      setAll(m, 'subverter', { width: 0.7, hp: 0.2, move: 0.25, mix: 1 });
      setAll(m, 'tamer', { focus: 0.6 });
    },
  },
  // ------------------------------------------------------------ ecosystems
  {
    name: 'Tangle',
    desc: 'Three modules, two loops, one knot. Grains blur the ghost that feeds them.',
    category: 'Ecosystems',
    bpm: 92,
    conditions: [0.6, 0.5, 0.5],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'chrono.in1L');
      wire(m, 'chrono.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'echoforge.in2L');
      wire(m, 'chrono.out2L', 'chrono.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'chrono.out1L', 'mixer.ch2L');
      wire(m, 'chrono.cvout:spray', 'ghost.cv:blur');
      wire(m, 'drift.cvout:walk', 'echoforge.cv:density');
      setAll(m, 'echoforge', { rate: echo32(5), density: 0.4, diffuse: 0.55, fdbk: 0.3, mix: 0.5 });
      setAll(m, 'chrono', { stretch: 0.45, reverse: 0.35, grain: grain['1/8'], spray: 0.4, fdbk: 0.2, pitch: semis(0), mix: 0.5 });
      setAll(m, 'ghost', { decay: 0.45, blur: 0.5, shimmer: 0.12, time: ghostTime(0.3), mix: 0.5 });
      setAll(m, 'drift', { rate: 0.2, depth: 0.4, smooth: 0.85 });
      setAll(m, 'mixer', { fader2: 0.62, pan1: 0.35, pan2: 0.68 });
    },
  },
  {
    name: 'Chaos Garden',
    desc: 'Bloom and FM watch each other through their own envelopes.',
    category: 'Ecosystems',
    bpm: 100,
    conditions: [0.55, 0.55, 0.5],
    build(m) {
      wire(m, 'host.from1L', 'bloom.in1L');
      wire(m, 'bloom.out1L', 'reactor.in1L');
      wire(m, 'reactor.out2L', 'bloom.in2L');
      wire(m, 'reactor.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'reactor.cvout:env', 'bloom.cv:color');
      wire(m, 'bloom.cvout:bloom', 'reactor.cv:fm');
      wire(m, 'drift.cvout:walk', 'reactor.cv:freq');
      setAll(m, 'bloom', { color: bloomHz(110), density: 0.6, bloom: 0.5, reverb: 0.4, texture: 0.4, harm: 0.25, mix: 0.6 });
      setAll(m, 'reactor', { freq: fmHz(140), fm: 0.3, mod: 0.25, env: 0.6, mix: 0.6 });
      setAll(m, 'ghost', { decay: 0.4, blur: 0.5, shimmer: 0.1, time: ghostTime(0.28), mix: 0.35 });
      setAll(m, 'drift', { rate: 0.15, depth: 0.35, smooth: 0.9, chaos: 0.3 });
    },
  },
  {
    name: 'Pressure System',
    desc: 'Echo and bloom trade a slow front of air; each one sets the other\'s density.',
    category: 'Ecosystems',
    bpm: 76,
    conditions: [0.6, 0.75, 0.35],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'bloom.in1L');
      wire(m, 'bloom.out2L', 'echoforge.in2L');
      wire(m, 'bloom.out1L', 'mixer.ch1L');
      wire(m, 'bloom.cvout:bloom', 'echoforge.cv:density');
      wire(m, 'drift.cvout:walk', 'bloom.cv:reverb');
      setAll(m, 'echoforge', { rate: echo32(12), density: 0.5, diffuse: 0.75, fdbk: 0.4, spread: 0.75, mix: 0.6 });
      setAll(m, 'bloom', { color: bloomHz(82), density: 0.55, bloom: 0.7, reverb: 0.55, texture: 0.3, harm: 0.15, mix: 0.6 });
      setAll(m, 'drift', { rate: 0.1, depth: 0.45, smooth: 0.95 });
    },
  },
  {
    name: 'Granular Weather',
    desc: 'Grains scatter through a ghost; their spray turns the ghost\'s pitch.',
    category: 'Ecosystems',
    bpm: 88,
    conditions: [0.6, 0.6, 0.45],
    build(m) {
      wire(m, 'host.from1L', 'chrono.in1L');
      wire(m, 'chrono.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'chrono.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'chrono.cvout:spray', 'ghost.cv:pitch');
      wire(m, 'drift.cvout:walk', 'chrono.cv:spray');
      setAll(m, 'chrono', { stretch: 0.6, reverse: 0.4, grain: grain['1/16'], spray: 0.45, fdbk: 0.2, pitch: semis(-5), mix: 0.6 });
      setAll(m, 'ghost', { decay: 0.5, blur: 0.65, shimmer: 0.2, pitch: 0.25, time: ghostTime(0.4), width: 0.7, mix: 0.5 });
      setAll(m, 'drift', { rate: 0.25, depth: 0.4, smooth: 0.8, chaos: 0.2 });
    },
  },
  {
    name: 'Mid/Side Organism',
    desc: 'The loop\'s own side energy widens and narrows the echo that feeds it.',
    category: 'Ecosystems',
    bpm: 90,
    conditions: [0.6, 0.5, 0.4],
    build(m) {
      wire(m, 'host.from1L', 'subverter.in1L');
      wire(m, 'subverter.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out2L', 'subverter.in2L');
      wire(m, 'echoforge.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'subverter.cvout:side', 'echoforge.cv:spread');
      wire(m, 'subverter.cvout:mid', 'ghost.cv:width');
      setAll(m, 'subverter', { width: 0.8, polarity: 0.3, symmetry: 0.2, move: 0.45, hp: 0.3, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(7), density: 0.45, diffuse: 0.5, fdbk: 0.3, spread: 0.5, mix: 0.55 });
      setAll(m, 'ghost', { decay: 0.4, blur: 0.5, shimmer: 0.1, time: ghostTime(0.22), width: 0.5, mix: 0.4 });
    },
  },
  {
    name: 'Probability Weather',
    desc: 'A gate decides, step by step, whether the loop may hear itself.',
    category: 'Ecosystems',
    bpm: 104,
    conditions: [0.65, 0.4, 0.4],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'pgate.in1L');
      wire(m, 'pgate.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'echoforge.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'pgate.cvout:gate', 'ghost.cv:shimmer');
      wire(m, 'drift.cvout:walk', 'pgate.cv:prob');
      setAll(m, 'echoforge', { rate: echo32(3), density: 0.35, diffuse: 0.4, fdbk: 0.35, spread: 0.7, mix: 0.5 });
      setAll(m, 'pgate', { prob: 0.55, mode: 0, rate: gateRate['1/8'], swing: 0.2, patt: patt(17), mix: 1 });
      setAll(m, 'ghost', { decay: 0.55, blur: 0.4, shimmer: 0.1, time: ghostTime(0.36), mix: 0.45 });
      setAll(m, 'drift', { rate: 0.3, depth: 0.35, smooth: 0.7 });
      m.buttons.drift.sync = true;
    },
  },
  {
    name: 'Resonator Choir',
    desc: 'Twin resonant bands in fifths sing into a ghost and back.',
    category: 'Ecosystems',
    bpm: 72,
    conditions: [0.55, 0.65, 0.55],
    build(m) {
      wire(m, 'host.from1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'prism.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'orbit.cvout:x', 'prism.cv:bands');
      wire(m, 'tamer.cvout:howl', 'ghost.cv:blur');
      setAll(m, 'prism', { bands: bandsHz(440), detune: detune.fifth, res: 0.6, morph: 0.45, sep: 0.35, spread: 0.65, mix: 0.85 });
      setAll(m, 'ghost', { decay: 0.55, blur: 0.5, shimmer: 0.25, time: ghostTime(0.45), width: 0.7, mix: 0.5 });
      setAll(m, 'orbit', { rate: lfoHz(0.03), radius: 0.3, shape: 0.1 });
      setAll(m, 'mixer', { fader1: 1 });
      setAll(m, 'tamer', { focus: 0.6 });
    },
  },
  // -------------------------------------------------------------- machines
  {
    name: 'Glitch Colony',
    desc: 'Euclidean glitches inside an echo loop; each glitch stirs the diffusion.',
    category: 'Machines',
    bpm: 112,
    conditions: [0.6, 0.4, 0.45],
    build(m) {
      wire(m, 'host.from1L', 'glitch.in1L');
      wire(m, 'glitch.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out2L', 'glitch.in2L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      wire(m, 'glitch.cvout:gate', 'echoforge.cv:diffuse');
      setAll(m, 'glitch', { chance: 0.3, intense: 0.5, dur: glitchDur['1/16'], muta: 0.3, intel: 0.2, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(3), density: 0.3, diffuse: 0.3, fdbk: 0.35, spread: 0.65, mix: 0.5 });
    },
  },
  {
    name: 'Metal Lung',
    desc: 'A resonant filter phase-modulating itself: a struck plate that keeps inhaling.',
    category: 'Machines',
    bpm: 96,
    conditions: [0.55, 0.7, 0.6],
    build(m) {
      wire(m, 'host.from1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'reactor.in1L');
      wire(m, 'reactor.out2L', 'prism.in2L');
      wire(m, 'prism.out2L', 'reactor.in2L'); // the plate also phase-modulates itself
      wire(m, 'reactor.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'reactor.cvout:env', 'prism.cv:bands');
      setAll(m, 'reactor', { freq: fmHz(310), fm: 0.4, am: 0.15, mod: 0.3, env: 0.4, mix: 0.6 });
      setAll(m, 'prism', { bands: bandsHz(700), detune: detune.M3, res: 0.65, morph: 0.5, sep: 0.4, mix: 0.8 });
      setAll(m, 'ghost', { decay: 0.4, blur: 0.4, shimmer: 0.1, time: ghostTime(0.2), mix: 0.35 });
      setAll(m, 'mixer', { fader1: 0.95 });
    },
  },
  {
    name: 'Orbit Mechanics',
    desc: 'A tape and echo loop held in a slow orbit: X bends the tape, Y swings the echo.',
    category: 'Machines',
    bpm: 100,
    conditions: [0.6, 0.45, 0.4],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'tape.in1L');
      wire(m, 'tape.out2L', 'echoforge.in2L');
      wire(m, 'tape.out1L', 'mixer.ch1L');
      wire(m, 'orbit.cvout:x', 'tape.cv:wow');
      wire(m, 'orbit.cvout:y', 'echoforge.cv:spread');
      setAll(m, 'echoforge', { rate: echo32(6), density: 0.4, diffuse: 0.45, fdbk: 0.35, spread: 0.5, mix: 0.55 });
      setAll(m, 'tape', { wear: 0.35, wow: 0.3, flutter: 0.2, age: 0.35, memory: 0.15, mix: 0.85 });
      setAll(m, 'orbit', { rate: lfoHz(0.08), radius: 0.5, shape: 0.05, gravity: 0.3 });
    },
  },
  {
    name: 'Fold Ecology',
    desc: 'A wavefolder and a stereo field trade harmonics; the side signal sets the fold.',
    category: 'Machines',
    bpm: 108,
    conditions: [0.5, 0.55, 0.55],
    build(m) {
      wire(m, 'host.from1L', 'overmind.in1L');
      wire(m, 'overmind.out1L', 'subverter.in1L');
      wire(m, 'subverter.out2L', 'overmind.in2L');
      wire(m, 'subverter.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'mixer.ch1L');
      wire(m, 'subverter.cvout:side', 'overmind.cv:fold');
      setAll(m, 'overmind', { shape: 0.5, fold: 0.3, drive: 0.2, harm: 0.25, char: 0.15, mix: 0.45 });
      setAll(m, 'subverter', { width: 0.75, polarity: 0.5, symmetry: 0.3, move: 0.35, hp: 0.3, mix: 1 });
      setAll(m, 'prism', { bands: bandsHz(1200), morph: 0.1, res: 0.3, mix: 1 });
    },
  },
  {
    name: 'Vinyl Ghosts',
    desc: 'A record that plays only its own wear: dust, tape and a ghost in a loop.',
    category: 'Machines',
    bpm: 82,
    conditions: [0.55, 0.5, 0.35],
    build(m) {
      wire(m, 'host.from1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'dust.in1L');
      wire(m, 'dust.out2L', 'tape.in2L');
      wire(m, 'dust.out1L', 'mixer.ch1L');
      wire(m, 'dust.cvout:crack', 'ghost.cv:blur');
      setAll(m, 'tape', { wear: 0.5, wow: 0.4, flutter: 0.25, age: 0.6, memory: 0.2, mix: 0.9 });
      setAll(m, 'ghost', { decay: 0.5, blur: 0.5, shimmer: 0.1, time: ghostTime(0.3), mix: 0.5 });
      setAll(m, 'dust', { wear: 0.1, dust: 0.12, comp: 0.3, warp: 0.5, mix: 0.6 });
    },
  },
  // ---------------------------------------------------------------- drones
  {
    name: 'Dark Matter',
    desc: 'A low bloom held in a dark room. Slow, deep, almost still.',
    category: 'Drones',
    bpm: 60,
    conditions: [0.55, 0.3, 0.25],
    build(m) {
      wire(m, 'host.from1L', 'bloom.in1L');
      wire(m, 'bloom.out1L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'bloom.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'drift.cvout:walk', 'bloom.cv:color');
      setAll(m, 'bloom', { color: bloomHz(98), density: 0.7, bloom: 0.8, reverb: 0.6, texture: 0.3, harm: 0.3, mix: 0.7 });
      setAll(m, 'ghost', { decay: 0.6, blur: 0.75, shimmer: 0, pitch: 0, time: ghostTime(0.6), width: 0.8, mix: 0.55 });
      setAll(m, 'drift', { rate: 0.05, depth: 0.25, smooth: 1 });
    },
  },
  {
    name: 'Breathing Bloom',
    desc: 'Static Bloom patched into itself, Breath turned deep: it inhales for half a minute.',
    category: 'Drones',
    bpm: 70,
    conditions: [0.6, 0.9, 0.3],
    build(m) {
      wire(m, 'host.from1L', 'bloom.in1L');
      wire(m, 'bloom.out2L', 'bloom.in2L');
      wire(m, 'bloom.out1L', 'mixer.ch1L');
      wire(m, 'bloom.cvout:bloom', 'bloom.cv:texture');
      setAll(m, 'bloom', { color: bloomHz(147), density: 0.6, bloom: 0.65, reverb: 0.5, texture: 0.3, harm: 0.2, mix: 0.65 });
    },
  },
  {
    name: 'Resonant Lattice',
    desc: 'Short dense echoes and a detuned filter form a lattice that keeps reshaping.',
    category: 'Drones',
    bpm: 66,
    conditions: [0.55, 0.5, 0.8],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'prism.in1L');
      wire(m, 'prism.out2L', 'echoforge.in2L');
      wire(m, 'prism.out1L', 'mixer.ch1L');
      wire(m, 'drift.cvout:walk', 'prism.cv:bands');
      setAll(m, 'echoforge', { rate: echo32(1), density: 0.85, diffuse: 0.65, fdbk: 0.45, spread: 0.6, mix: 0.6 });
      setAll(m, 'prism', { bands: bandsHz(260), detune: detune.fourth, res: 0.55, morph: 0.3, sep: 0.4, spread: 0.6, mix: 0.8 });
      setAll(m, 'drift', { rate: 0.08, depth: 0.3, smooth: 0.95 });
      setAll(m, 'mixer', { fader1: 0.95 });
    },
  },
  {
    name: 'Two Rooms',
    desc: 'Two separate loops, left and right, listening to each other through a wall.',
    category: 'Drones',
    bpm: 72,
    conditions: [0.6, 0.6, 0.4],
    build(m) {
      // room one: an echo into itself
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out2L', 'echoforge.in2L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      // room two: a ghost into itself
      wire(m, 'host.from2L', 'ghost.in1L');
      wire(m, 'ghost.out2L', 'ghost.in2L');
      wire(m, 'ghost.out1L', 'mixer.ch2L');
      // the wall: each room's energy moves the other room's air
      wire(m, 'ghost.out1L', 'bloom.in1L');
      wire(m, 'bloom.cvout:bloom', 'echoforge.cv:diffuse');
      wire(m, 'echoforge.out1L', 'tape.in1L');
      wire(m, 'tape.cvout:wowflut', 'ghost.cv:pitch');
      setAll(m, 'echoforge', { rate: echo32(9), density: 0.55, diffuse: 0.55, fdbk: 0.35, spread: 0.4, mix: 0.6 });
      setAll(m, 'ghost', { decay: 0.55, blur: 0.6, shimmer: 0.2, time: ghostTime(0.5), width: 0.4, mix: 0.6 });
      setAll(m, 'bloom', { mix: 1 });
      setAll(m, 'tape', { wow: 0.4, flutter: 0.2 });
      setAll(m, 'mixer', { pan1: 0.15, pan2: 0.85 });
    },
  },
].map((p) => ({ ...p, sources: IMPULSE, build: chain(conditions(...p.conditions), p.build) }));

function chain(a, b) {
  return (m) => {
    a(m);
    b(m);
  };
}

// --------------------------------------------------------------- input FX
const INPUT_FX = [
  {
    name: 'Warm Start',
    desc: 'Keys through a worn tape machine into a soft, diffused echo.',
    category: 'Starters',
    bpm: 120,
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
    desc: 'A pad in fifths through a resonant filter, lifted by the shimmer tank.',
    category: 'Ambient',
    bpm: 100,
    sources: ['pad', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'prism', j: 'in1L' });
      st(m, { m: 'prism', j: 'out1L' }, { m: 'ghost', j: 'in1L' });
      st(m, { m: 'ghost', j: 'out1L' }, { m: 'mixer', j: 'ch1L' });
      st(m, { m: 'orbit', j: 'cvout:x' }, { m: 'prism', j: 'cv:bands' });
      setAll(m, 'prism', { bands: 0.42, detune: 0.8, res: 0.58, morph: 0.35, mix: 0.75, sep: 0.3 });
      setAll(m, 'mixer', { fader1: 0.95 });
      setAll(m, 'ghost', { shimmer: 0.45, decay: 0.55, blur: 0.5, mix: 0.5, time: 0.55, pitch: 0.3 });
      setAll(m, 'orbit', { rate: 0.3, radius: 0.3, shape: 0.1 });
    },
  },
  {
    name: 'Shred Beat',
    desc: 'Euclidean glitches into a granular scrambler; the gate pulses the random walk.',
    category: 'Rhythm',
    bpm: 124,
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
    desc: 'Vinyl crackle, wobbly tape and a little bloom on the keys.',
    category: 'Lo-fi',
    bpm: 90,
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
    desc: 'Bass phase-modulated by an orbiting LFO, widened above the low end.',
    category: 'Sound Design',
    bpm: 118,
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
    desc: 'An arp loops through Overmind and Echoforge, throttled by the Merger gain.',
    category: 'Feedback',
    bpm: 120,
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
  // ------------------------------------------------------------- ambient
  {
    name: 'Cathedral Keys',
    desc: 'Dense diffused echoes feeding an octave shimmer that slowly drifts.',
    category: 'Ambient',
    bpm: 84,
    sources: ['keys', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'orbit.cvout:x', 'ghost.cv:pitch');
      setAll(m, 'echoforge', { rate: echo32(8), density: 0.8, diffuse: 0.6, fdbk: 0.5, spread: 0.65, mix: 0.4 });
      setAll(m, 'ghost', { shimmer: 0.55, decay: 0.55, blur: 0.7, time: ghostTime(0.42), width: 0.7, mix: 0.45 });
      setAll(m, 'orbit', { rate: lfoHz(0.07), radius: 0.2 });
    },
  },
  {
    name: 'Granular Snowfall',
    desc: 'A pad stretched into octave-up grains that scatter and reverse.',
    category: 'Ambient',
    bpm: 90,
    sources: ['pad', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'chrono.in1L');
      wire(m, 'chrono.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'drift.cvout:walk', 'chrono.cv:spray');
      setAll(m, 'chrono', { stretch: 0.75, reverse: 0.45, grain: grain['1/8'], spray: 0.55, fdbk: 0.25, pitch: semis(12), mix: 0.55 });
      setAll(m, 'ghost', { shimmer: 0.3, decay: 0.5, blur: 0.6, time: ghostTime(0.3), mix: 0.4 });
      setAll(m, 'drift', { rate: 0.2, depth: 0.4, smooth: 0.9 });
    },
  },
  {
    name: 'Robot Choir',
    desc: 'Two resonant bands gliding between musical intervals under an LFO.',
    category: 'Ambient',
    bpm: 96,
    sources: ['pad', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'orbit.cvout:y', 'prism.cv:detune');
      setAll(m, 'prism', { bands: bandsHz(700), detune: detune.fourth, res: 0.62, morph: 0.35, sep: 0.35, spread: 0.6, mix: 0.85 });
      setAll(m, 'mixer', { fader1: 0.95 });
      setAll(m, 'ghost', { shimmer: 0.25, decay: 0.4, blur: 0.5, mix: 0.35 });
      setAll(m, 'orbit', { rate: lfoHz(0.12), radius: 0.45, shape: 0.15 });
    },
  },
  {
    name: 'Drift Garden',
    desc: 'Arp blooms and a filtered pad, wandering under slow random CV.',
    category: 'Ambient',
    bpm: 92,
    sources: ['arp', 'pad', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'bloom.in1L');
      wire(m, 'bloom.out1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch1L');
      wire(m, 'host.from2L', 'prism.in1L');
      wire(m, 'prism.out1L', 'mixer.ch2L');
      wire(m, 'drift.cvout:walk', 'ghost.cv:width');
      wire(m, 'orbit.cvout:x', 'prism.cv:bands');
      setAll(m, 'bloom', { color: bloomHz(220), density: 0.6, bloom: 0.65, reverb: 0.6, texture: 0.55, harm: 0.3, mix: 0.5 });
      setAll(m, 'ghost', { time: ghostTime(0.36), decay: 0.5, shimmer: 0.2, blur: 0.4, mix: 0.35 });
      setAll(m, 'prism', { bands: bandsHz(600), morph: 0.15, res: 0.45, mix: 1 });
      setAll(m, 'drift', { rate: 0.25, depth: 0.5, smooth: 0.95 });
      setAll(m, 'orbit', { rate: lfoHz(0.05), radius: 0.25 });
      setAll(m, 'mixer', { fader2: 0.68, pan1: 0.4, pan2: 0.62 });
    },
  },
  {
    name: 'Mid/Side Bloom',
    desc: 'Subverter\'s side energy drives the brightness of Static Bloom.',
    category: 'Ambient',
    bpm: 100,
    sources: ['keys', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'subverter.in1L');
      wire(m, 'subverter.out1L', 'bloom.in1L');
      wire(m, 'bloom.out1L', 'mixer.ch1L');
      wire(m, 'subverter.cvout:side', 'bloom.cv:texture');
      setAll(m, 'subverter', { width: 0.8, polarity: 0.25, hp: 0.4, move: 0.4, mix: 1 });
      setAll(m, 'bloom', { color: bloomHz(110), density: 0.7, bloom: 0.6, reverb: 0.55, texture: 0.35, harm: 0.25, mix: 0.5 });
    },
  },
  // --------------------------------------------------------------- lo-fi
  {
    name: 'Tape Memory',
    desc: 'Arp on a tape echo with dropouts and wandering age, then diffused.',
    category: 'Lo-fi',
    bpm: 108,
    sources: ['arp', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      setAll(m, 'tape', { wear: 0.45, wow: 0.35, flutter: 0.25, memory: 0.6, age: 0.7, drop: 0.25, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(6), fdbk: 0.35, diffuse: 0.7, density: 0.3, mix: 0.3 });
    },
  },
  {
    name: 'Vinyl Sunday',
    desc: 'Crackly, low-passed keys on old tape over a laid-back beat.',
    category: 'Lo-fi',
    bpm: 84,
    sources: ['keys', 'beat', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'dust.in1L');
      wire(m, 'dust.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'mixer.ch1L');
      wire(m, 'host.from2L', 'mixer.ch2L');
      setAll(m, 'dust', { wear: 0.25, dust: 0.45, comp: 0.35, warp: 0.56, mix: 0.8 });
      setAll(m, 'prism', { bands: bandsHz(1600), morph: 0, res: 0.3, mix: 1 });
      setAll(m, 'tape', { wear: 0.4, wow: 0.25, flutter: 0.15, mix: 0.7 });
      setAll(m, 'mixer', { fader2: 0.62 });
    },
  },
  {
    name: 'Ring Mod Radio',
    desc: 'Ring-modulated keys, decimated and band-limited like a transistor radio.',
    category: 'Lo-fi',
    bpm: 110,
    sources: ['keys', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'reactor.in1L');
      wire(m, 'reactor.out1L', 'dust.in1L');
      wire(m, 'dust.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'mixer.ch1L');
      setAll(m, 'reactor', { freq: fmHz(370), fm: 0.15, am: 0.55, mod: 0.1, env: 0.5, mix: 0.6 });
      setAll(m, 'dust', { oxidize: 0.45, bit: 0.3, wear: 0.3, dust: 0.3, mix: 0.6 });
      setAll(m, 'prism', { bands: bandsHz(2600), morph: 0.3, res: 0.4, spread: 0.5, mix: 1 });
      setAll(m, 'mixer', { fader1: 1 });
    },
  },
  {
    name: 'Half-Time Haze',
    desc: 'The beat glitches to half speed and tape stops; keys echo above it.',
    category: 'Lo-fi',
    bpm: 70,
    sources: ['keys', 'beat', 'off'],
    build(m) {
      wire(m, 'host.from2L', 'glitch.in1L');
      wire(m, 'glitch.out1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'mixer.ch2L');
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      setAll(m, 'glitch', { chance: 0.35, intense: 1, dur: glitchDur['1/4'], muta: 0.1, intel: 0.6, mix: 1 });
      setAll(m, 'tape', { wear: 0.5, wow: 0.4, flutter: 0.2, drop: 0.2, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(6), fdbk: 0.45, diffuse: 0.6, mix: 0.35 });
      setAll(m, 'mixer', { fader1: 0.7 });
    },
  },
  // -------------------------------------------------------------- rhythm
  {
    name: 'Bitcrushed Breaks',
    desc: 'A crunchy, compressed beat chopped by Euclidean glitches.',
    category: 'Rhythm',
    bpm: 96,
    sources: ['off', 'beat', 'off'],
    build(m) {
      wire(m, 'host.from2L', 'dust.in1L');
      wire(m, 'dust.out1L', 'glitch.in1L');
      wire(m, 'glitch.out1L', 'mixer.ch2L');
      setAll(m, 'dust', { oxidize: 0.5, bit: 0.5, comp: 0.5, wear: 0.1, dust: 0.2, mix: 0.75 });
      setAll(m, 'glitch', { chance: 0.3, intense: 0.55, dur: glitchDur['1/16'], intel: 0.2, mix: 1 });
    },
  },
  {
    name: 'Stutter Machine',
    desc: 'A synced random walk steps the gate mode: repeats, swaps and brakes.',
    category: 'Rhythm',
    bpm: 126,
    sources: ['off', 'beat', 'off'],
    build(m) {
      wire(m, 'host.from2L', 'pgate.in1L');
      wire(m, 'pgate.out1L', 'glitch.in1L');
      wire(m, 'glitch.out1L', 'mixer.ch2L');
      // "Modulate selectors for free rhythm": a synced random walk steps the Mode
      wire(m, 'drift.cvout:walk', 'pgate.cv:mode');
      setAll(m, 'pgate', { mode: mode.repeat, prob: 0.55, rate: gateRate['1/16'], patt: patt(13), swing: 0.15, mix: 1 });
      setAll(m, 'glitch', { chance: 0.2, intense: 0.4, mix: 1 });
      setAll(m, 'drift', { rate: step(1, 8), depth: 0.6, smooth: 0 });
      m.buttons.drift.sync = true;
    },
  },
  {
    name: 'Chrono Sequencer',
    desc: 'Chrono\'s Spray sample-and-hold walks the filter bands as a melody.',
    category: 'Rhythm',
    bpm: 112,
    sources: ['pad', 'off', 'off'],
    build(m) {
      // the manual's tip: Spray CV is a clock-synced sample & hold
      wire(m, 'host.from1L', 'chrono.in1L');
      wire(m, 'chrono.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'mixer.ch1L');
      wire(m, 'chrono.cvout:spray', 'prism.cv:bands');
      setAll(m, 'chrono', { grain: grain['1/8'], spray: 0.5, stretch: 0.2, reverse: 0.15, mix: 0.35 });
      setAll(m, 'prism', { bands: bandsHz(550), res: 0.66, morph: 0.32, mix: 0.85 });
      setAll(m, 'mixer', { fader1: 0.98 });
    },
  },
  {
    name: 'Sidechain Pump',
    desc: 'The gate rests the pad on every beat, like sidechain ducking.',
    category: 'Rhythm',
    bpm: 122,
    sources: ['pad', 'beat', 'off'],
    build(m) {
      // Skip on every beat rests the pad under the kick
      wire(m, 'host.from1L', 'pgate.in1L');
      wire(m, 'pgate.out1L', 'mixer.ch1L');
      wire(m, 'host.from2L', 'mixer.ch2L');
      setAll(m, 'pgate', { mode: mode.skip, prob: 1, rate: gateRate['1/16'], patt: patt(1), mix: 1 });
      setAll(m, 'mixer', { fader1: 0.9 });
    },
  },
  {
    name: 'Swap Shuffle',
    desc: 'Swung swaps: the gate\'s rejects get their own shimmer on channel 3.',
    category: 'Rhythm',
    bpm: 118,
    sources: ['off', 'beat', 'off'],
    build(m) {
      // the gate's rejects get their own effect on another channel
      wire(m, 'host.from2L', 'pgate.in1L');
      wire(m, 'pgate.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'mixer.ch2L');
      wire(m, 'pgate.out2L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'mixer.ch3L');
      setAll(m, 'pgate', { mode: mode.swap, prob: 0.6, rate: gateRate['1/16'], patt: patt(15), swing: 0.35, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(4), fdbk: 0.35, mix: 0.35 });
      setAll(m, 'ghost', { shimmer: 0.4, decay: 0.45, time: ghostTime(0.25), mix: 0.8 });
      setAll(m, 'mixer', { pan2: 0.35, pan3: 0.7, fader3: 0.78 });
    },
  },
  {
    name: 'Fifths Oracle',
    desc: 'Mutated glitches thrown up a fifth or down an octave, harmonised.',
    category: 'Rhythm',
    bpm: 116,
    sources: ['arp', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'glitch.in1L');
      wire(m, 'glitch.out1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'mixer.ch1L');
      setAll(m, 'glitch', { chance: 0.4, intense: 0.7, muta: 0.45, dur: glitchDur['1/8'], intel: 0.3, mix: 1 });
      setAll(m, 'echoforge', { rate: echo32(4), fdbk: 0.3, mix: 0.3 });
      m.buttons.glitch.tune = true;
    },
  },
  {
    name: 'Vinyl Brake',
    desc: 'The gate reverses bass steps with a decelerating vinyl brake.',
    category: 'Rhythm',
    bpm: 100,
    sources: ['off', 'beat', 'bass'],
    build(m) {
      wire(m, 'host.from3L', 'pgate.in1L');
      wire(m, 'pgate.out1L', 'tape.in1L');
      wire(m, 'tape.out1L', 'mixer.ch3L');
      wire(m, 'host.from2L', 'mixer.ch2L');
      setAll(m, 'pgate', { mode: mode.mirror, prob: 0.35, rate: gateRate['1/8'], patt: patt(7), mix: 1 });
      setAll(m, 'tape', { wear: 0.5, wow: 0.2, flutter: 0.1, mix: 1 });
    },
  },
  // -------------------------------------------------------- sound design
  {
    name: 'Fold Fever',
    desc: 'Bass through a wavefolder whose depth orbits, mono below, wide above.',
    category: 'Sound Design',
    bpm: 120,
    sources: ['off', 'off', 'bass'],
    build(m) {
      wire(m, 'host.from3L', 'overmind.in1L');
      wire(m, 'overmind.out1L', 'subverter.in1L');
      wire(m, 'subverter.out1L', 'mixer.ch3L');
      wire(m, 'orbit.cvout:x', 'overmind.cv:fold');
      setAll(m, 'overmind', { shape: 0.55, fold: 0.5, harm: 0.35, drive: 0.35, char: 0.3, bias: 0.6, mix: 0.8 });
      setAll(m, 'subverter', { width: 0.7, hp: 0.35, move: 0.25, mix: 1 });
      setAll(m, 'orbit', { rate: lfoHz(0.4), radius: 0.3 });
    },
  },
  {
    name: 'Cross-Mod',
    desc: 'Bass replaces Reactor FM\'s oscillator and frequency-modulates the keys.',
    category: 'Sound Design',
    bpm: 110,
    sources: ['keys', 'off', 'bass'],
    build(m) {
      // Reactor FM's second input: the bass replaces the oscillator as modulator
      wire(m, 'host.from1L', 'reactor.in1L');
      wire(m, 'host.from3L', 'reactor.in2L');
      wire(m, 'reactor.out1L', 'mixer.ch1L');
      wire(m, 'host.from3L', 'mixer.ch3L');
      setAll(m, 'reactor', { fm: 0.5, mod: 0.3, env: 0.7, am: 0.1, mix: 0.7 });
      setAll(m, 'mixer', { fader3: 0.6 });
    },
  },
  // ------------------------------------------------------------ feedback
  {
    name: 'Dub Siren',
    desc: 'A tape-and-echo loop whose delay time wanders, so repeats bend in pitch.',
    category: 'Feedback',
    bpm: 90,
    sources: ['arp', 'off', 'off'],
    build(m) {
      // a loop through the splitter, just past centre, with a wandering delay time
      wire(m, 'host.from1L', 'echoforge.in1L');
      wire(m, 'echoforge.out1L', 'splitter.aInL');
      wire(m, 'splitter.aOut1L', 'mixer.ch1L');
      wire(m, 'splitter.aOut2L', 'tape.in1L');
      wire(m, 'tape.out1L', 'echoforge.in2L');
      wire(m, 'orbit.cvout:x', 'echoforge.cv:rate');
      setAll(m, 'echoforge', { rate: echo32(12), fdbk: 0.65, diffuse: 0.55, spread: 0.7, density: 0.25, mix: 0.5 });
      setAll(m, 'tape', { wear: 0.4, wow: 0.3, memory: 0.2, mix: 1 });
      setAll(m, 'splitter', { gainA: 0.5 });
      setAll(m, 'orbit', { rate: lfoHz(0.09), radius: 0.12 });
      setAll(m, 'tamer', { focus: 0.6 });
    },
  },
  {
    name: 'Shimmer Loop',
    desc: 'Spectral Ghost and Prism Engine feed each other; Focus tames the ring.',
    category: 'Feedback',
    bpm: 88,
    sources: ['pad', 'off', 'off'],
    build(m) {
      wire(m, 'host.from1L', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'prism.in1L');
      wire(m, 'prism.out1L', 'mixer.ch1L');
      wire(m, 'prism.out2L', 'ghost.in2L');
      setAll(m, 'ghost', { shimmer: 0.5, decay: 0.5, blur: 0.5, time: ghostTime(0.5), mix: 0.6 });
      setAll(m, 'prism', { bands: bandsHz(900), morph: 0.4, res: 0.5, detune: detune.fourth, mix: 0.5 });
      setAll(m, 'tamer', { focus: 0.7 });
    },
  },
  {
    name: 'Howlround',
    desc: 'The Merger past centre opens the loop: it blooms into a sustained drone.',
    category: 'Feedback',
    bpm: 100,
    drone: true,
    sources: ['keys', 'off', 'off'],
    build(m) {
      // the merger past centre opens the loop throttle: it blooms and sustains
      wire(m, 'host.from1L', 'overmind.in1L');
      wire(m, 'overmind.out1L', 'merger.aIn1L');
      wire(m, 'merger.aOutL', 'ghost.in1L');
      wire(m, 'ghost.out1L', 'splitter.aInL');
      wire(m, 'splitter.aOut1L', 'mixer.ch1L');
      wire(m, 'splitter.aOut2L', 'merger.aIn2L');
      setAll(m, 'overmind', { shape: 0.3, fold: 0.3, drive: 0.2, mix: 0.6 });
      setAll(m, 'ghost', { decay: 0.4, blur: 0.6, shimmer: 0.2, time: ghostTime(0.3), mix: 0.6 });
      setAll(m, 'merger', { gainA: 0.55 });
      setAll(m, 'tamer', { focus: 0.75, thresh: 0.75 });
    },
  },
  {
    name: 'Init',
    desc: 'Input 1 straight to the mixer. A blank rack to patch from.',
    category: 'Starters',
    bpm: 120,
    sources: ['keys', 'off', 'off'],
    build(m) {
      st(m, { m: H, j: 'from1L' }, { m: 'mixer', j: 'ch1L' });
    },
  },
];

const FX_ORDER = ['Starters', 'Ambient', 'Lo-fi', 'Rhythm', 'Sound Design', 'Feedback'];
// keep the input patches in their old order (stable, so Warm Start stays first)
INPUT_FX.sort((a, b) => FX_ORDER.indexOf(a.category) - FX_ORDER.indexOf(b.category));

export const CATEGORIES = ['Seeds', 'Ecosystems', 'Machines', 'Drones', 'Input FX'];

export const PRESETS = [
  ...NO_INPUT,
  // their loops only bloom while the input feeds them
  ...INPUT_FX.map((p) => ({ ...p, category: 'Input FX', sources: p.sources, build: chain(conditions(0, 0.5, 0.4), p.build) })),
];

export function applyPreset(model, preset) {
  model.load({ name: preset.name, cables: [] });
  model.addTrunk();
  preset.build(model);
  model.name = preset.name;
  model.emit('load');
}
