// Patch Arcade module specification.
//
// This file is shared by the UI (main thread) and the DSP engine (AudioWorklet),
// so it must stay free of DOM and Web Audio references.
//
// Knob values are always normalised 0..1. Bipolar knobs rest at 0.5.
// Stepped knobs snap to `steps` positions (0..steps-1 mapped onto 0..1).

export const RACK_VERSION = 1;

// Engine block size. The rack processes in 64-sample batches, so a cable that
// closes a loop adds exactly one batch of delay (~1.3 ms at 48 kHz).
export const BLOCK = 64;

// A CV signal of +/-1 moves a knob by +/-CV_SCALE of its range.
export const CV_SCALE = 0.5;

// Master output ceiling (dBFS) enforced by the safety limiter.
export const OUTPUT_CEILING_DB = -1;

export const NOTE_DIVS = {
  // name: length in beats (quarter notes)
  '4 bar': 16, '2 bar': 8, '1 bar': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/8T': 1 / 3,
  '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125, '1/64': 0.0625,
};

const pct = (v) => `${Math.round(v * 100)}%`;
const bip = (v) => {
  const x = Math.round((v - 0.5) * 200);
  return x === 0 ? '0' : x > 0 ? `+${x}%` : `${x}%`;
};
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${f.toFixed(f < 10 ? 2 : 0)} Hz`);
const ms = (s) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);
const db = (d) => (d <= -60 ? '-inf dB' : `${d > 0 ? '+' : ''}${d.toFixed(1)} dB`);
export const expMap = (t, lo, hi) => lo * Math.pow(hi / lo, t);
export const stepIndex = (v, steps) => Math.max(0, Math.min(steps - 1, Math.round(v * (steps - 1))));
export const stepValue = (i, steps) => (steps <= 1 ? 0 : i / (steps - 1));

export const ECHO_RATE_STEPS = 32;
export const GRAIN_DIVS = ['1/64', '1/32', '1/16', '1/8', '1/4', '1/2'];
export const GLITCH_DURS = ['1/32', '1/16', '1/8', '1/4', '1/2'];
export const LFO_SYNC_DIVS = ['4 bar', '2 bar', '1 bar', '1/2', '1/4', '1/8', '1/16', '1/32'];
export const DRIFT_SYNC_DIVS = ['1 bar', '1/2', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const PGATE_RATES = ['1/4', '1/8', '1/16', '1/8T', '1/32'];
export const PGATE_MODES = ['Skip', 'Swap', 'Repeat', 'Mirror', 'Invert', 'Random'];
export const TAMER_RECOVERY = ['1/64', '1/32', '1/16', '1/8', '1/4', '1/2', '1 bar'];
export const DETUNE_INTERVALS = [0, 3, 4, 5, 7, 12];
export const DETUNE_NAMES = ['unison', 'min 3rd', 'maj 3rd', '4th', '5th', 'octave'];

// Fader law shared by UI and engine: 0.8 = unity, 1.0 ~ +5.8 dB.
export const faderGain = (v) => (v <= 0.001 ? 0 : Math.pow(v / 0.8, 3));
export const tamerThreshDb = (v) => -36 + 36 * v;
export const utilGainDb = (v) => (v - 0.5) * 24;

// Param helper. `roll` is the dice's bell-curve [mean, sigma, min, max].
const P = (id, label, def, extra = {}) => ({ id, label, def, size: 'small', bipolar: false, cv: true, ...extra });

const MIX = (def = 0.5, roll = [0.8, 0.15, 0.45, 1]) =>
  P('mix', 'Mix', def, { size: 'mix', fmt: pct, roll });

export const MODULES = [
  // ---------------------------------------------------------------- effects
  {
    id: 'echoforge', name: 'Echoforge', kind: 'effect', theme: 'echoforge',
    blurb: 'A tempo-synced delay that can smear into reverb.',
    params: [
      P('rate', 'Rate', stepValue(5, ECHO_RATE_STEPS), { size: 'big', steps: ECHO_RATE_STEPS, fmt: (v) => `${stepIndex(v, ECHO_RATE_STEPS) + 1}/32`, roll: [0.2, 0.12, 0.03, 0.5] }),
      P('density', 'Density', 0.3, { size: 'big', fmt: pct, roll: [0.4, 0.2, 0, 0.9] }),
      MIX(0.4),
      P('spread', 'Spread', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.18, 0.1, 0.9] }),
      P('fdbk', 'Fdbk', 0.45, { fmt: pct, roll: [0.45, 0.15, 0.1, 0.8] }),
      P('diffuse', 'Diffuse', 0.35, { fmt: pct, roll: [0.4, 0.2, 0, 1] }),
    ],
    buttons: [{ id: 'freeze', label: 'Freeze', toggle: true }],
    cvOuts: [],
    loopNote: 'repeats shorten into a shimmer',
  },
  {
    id: 'tape', name: 'Tape Phantom', kind: 'effect', theme: 'tape',
    blurb: 'Magnetic tape emulation.',
    params: [
      P('wear', 'Wear', 0.35, { size: 'big', fmt: pct, roll: [0.35, 0.18, 0, 0.85] }),
      P('wow', 'Wow', 0.25, { size: 'big', fmt: pct, roll: [0.3, 0.18, 0, 0.9] }),
      MIX(0.6),
      P('flutter', 'Flutter', 0.2, { fmt: pct, roll: [0.25, 0.15, 0, 0.8] }),
      P('drop', 'Drop', 0, { fmt: pct, roll: [0.15, 0.15, 0, 0.6] }),
      P('memory', 'Memry', 0.2, { fmt: pct, roll: [0.25, 0.18, 0, 0.75] }),
      P('age', 'Age', 0.3, { fmt: pct, roll: [0.4, 0.2, 0, 1] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'wowflut', label: 'Wow/Flut Out', unipolar: false }],
    loopNote: 'saturation builds each pass',
  },
  {
    id: 'chrono', name: 'Chrono Shredder', kind: 'effect', theme: 'chrono',
    blurb: 'A granular buffer scrambler.',
    params: [
      P('stretch', 'Stretch', 0.3, { size: 'big', fmt: pct, roll: [0.35, 0.2, 0, 0.9] }),
      P('reverse', 'Reverse', 0.2, { size: 'big', fmt: pct, roll: [0.3, 0.2, 0, 0.9] }),
      MIX(0.5),
      P('grain', 'Grain', stepValue(2, GRAIN_DIVS.length), { steps: GRAIN_DIVS.length, fmt: (v) => GRAIN_DIVS[stepIndex(v, GRAIN_DIVS.length)], roll: [0.45, 0.2, 0, 1] }),
      P('spray', 'Spray', 0.25, { fmt: pct, roll: [0.3, 0.2, 0, 0.9] }),
      P('fdbk', 'Fdbk', 0.15, { fmt: pct, roll: [0.2, 0.15, 0, 0.6] }),
      P('pitch', 'Pitch', 0.5, { bipolar: true, fmt: (v) => { const s = (v - 0.5) * 24; return `${s >= 0 ? '+' : ''}${s.toFixed(1)} st`; }, roll: [0.5, 0.12, 0, 1] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'spray', label: 'Spray Out', unipolar: false }],
    loopNote: 'more grains play backwards',
  },
  {
    id: 'prism', name: 'Prism Engine', kind: 'effect', theme: 'prism',
    blurb: 'A dual resonant multimode filter.',
    params: [
      P('bands', 'Bands', 0.45, { size: 'big', fmt: (v) => hz(expMap(v, 100, 8000)), roll: [0.45, 0.18, 0.1, 0.85] }),
      P('spread', 'Spread', 0.5, { size: 'big', bipolar: true, fmt: bip, roll: [0.5, 0.15, 0.15, 0.85] }),
      MIX(0.6),
      P('detune', 'D.Tune', 0, { fmt: (v) => DETUNE_NAMES[Math.min(5, Math.round(v * 5))], roll: [0.35, 0.3, 0, 1] }),
      P('sep', 'Sep.', 0.2, { fmt: pct, roll: [0.3, 0.2, 0, 0.9] }),
      P('res', 'Res.', 0.45, { fmt: pct, roll: [0.45, 0.15, 0.1, 0.75] }),
      P('morph', 'Morph', 0.25, { fmt: (v) => (v < 0.25 ? 'low-pass' : v < 0.75 ? 'band-pass' : 'high-pass'), roll: [0.35, 0.2, 0, 0.8] }),
    ],
    buttons: [],
    cvOuts: [],
    loopNote: 'bands drift apart',
  },
  {
    id: 'overmind', name: 'Overmind', kind: 'effect', theme: 'overmind',
    blurb: 'A wavefolder and distortion tour.',
    params: [
      P('shape', 'Shape', 0.25, { size: 'big', fmt: (v) => (v < 0.34 ? 'overdrive' : v < 0.67 ? 'wavefold' : 'wrap'), roll: [0.35, 0.2, 0, 0.9] }),
      P('fold', 'Fold', 0.3, { size: 'big', fmt: pct, roll: [0.35, 0.2, 0, 0.85] }),
      MIX(0.5, [0.6, 0.15, 0.3, 1]),
      P('harm', 'Harm.', 0.2, { fmt: pct, roll: [0.25, 0.18, 0, 0.8] }),
      P('char', 'Char.', 0.4, { fmt: (v) => (v < 0.5 ? `LP ${hz(expMap(v * 2, 900, 18000))}` : `decimate ${pct((v - 0.5) * 2)}`), roll: [0.4, 0.12, 0.1, 0.7] }),
      P('drive', 'Drive', 0.3, { fmt: (v) => db(v * 24), roll: [0.3, 0.15, 0, 0.75] }),
      P('bias', 'Bias', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.15, 0.1, 0.9] }),
    ],
    buttons: [],
    cvOuts: [],
    loopNote: 'the fold curve mutates',
  },
  {
    id: 'subverter', name: 'Subverter', kind: 'effect', theme: 'subverter',
    blurb: 'A stereo field manipulator and mastering tool.',
    params: [
      P('polarity', 'Polarity', 0, { size: 'big', fmt: (v) => `${Math.round(v * 180)}°`, roll: [0.25, 0.2, 0, 1] }),
      P('symmetry', 'Symmetry', 0, { size: 'big', fmt: pct, roll: [0.25, 0.2, 0, 0.8] }),
      MIX(1, [0.85, 0.12, 0.5, 1]),
      P('width', 'Width', 0.5, { fmt: (v) => `${Math.round(v * 200)}%`, roll: [0.6, 0.15, 0.2, 1] }),
      P('move', 'Move', 0, { fmt: pct, roll: [0.25, 0.2, 0, 0.9] }),
      P('drive', 'Drive', 0.1, { fmt: pct, roll: [0.2, 0.15, 0, 0.7] }),
      P('hp', 'HP', 0.2, { fmt: (v) => hz(expMap(v, 20, 600)), roll: [0.3, 0.15, 0, 0.8] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'mid', label: 'Mid', unipolar: true }, { id: 'side', label: 'Side', unipolar: true }],
    loopNote: 'the image breathes wider',
  },
  {
    id: 'bloom', name: 'Static Bloom', kind: 'effect', theme: 'bloom',
    blurb: 'A harmonic saturation and smearing engine.',
    params: [
      P('color', 'Color', 0.4, { size: 'big', fmt: (v) => hz(expMap(v, 55, 440)), roll: [0.45, 0.2, 0, 1] }),
      P('density', 'Density', 0.5, { size: 'big', fmt: pct, roll: [0.5, 0.2, 0.1, 1] }),
      MIX(0.4, [0.5, 0.15, 0.25, 0.9]),
      P('bloom', 'Bloom', 0.4, { fmt: (v) => ms(expMap(v, 0.15, 6)), roll: [0.4, 0.2, 0, 0.9] }),
      P('texture', 'Tex.', 0.4, { fmt: pct, roll: [0.4, 0.2, 0, 1] }),
      P('reverb', 'Reverb', 0.3, { fmt: pct, roll: [0.35, 0.2, 0, 0.9] }),
      P('harm', 'Harm.', 0.25, { fmt: pct, roll: [0.3, 0.18, 0, 0.85] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'bloom', label: 'Bloom Out', unipolar: true }],
    loopNote: 'the bloom thickens',
  },
  {
    id: 'dust', name: 'Dust Engine', kind: 'effect', theme: 'dust',
    blurb: 'Vinyl and tape noise.',
    params: [
      P('wear', 'Wear', 0.15, { size: 'big', fmt: pct, roll: [0.2, 0.12, 0, 0.5] }),
      P('dust', 'Dust', 0.25, { size: 'big', fmt: pct, roll: [0.3, 0.15, 0, 0.75] }),
      MIX(0.5),
      P('oxidize', 'Oxidize', 0, { fmt: pct, roll: [0.15, 0.15, 0, 0.7] }),
      P('warp', 'Warp', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.15, 0.15, 0.85] }),
      P('comp', 'Comp.', 0.2, { fmt: pct, roll: [0.3, 0.2, 0, 0.8] }),
      P('bit', 'Bit', 0, { fmt: (v) => `${(16 - v * 13).toFixed(1)} bit`, roll: [0.15, 0.15, 0, 0.7] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'crack', label: 'Crack Out', unipolar: true }],
    loopNote: 'bit depth crumbles cumulatively',
  },
  {
    id: 'ghost', name: 'Spectral Ghost', kind: 'effect', theme: 'ghost',
    blurb: 'A ghostly delay with a shimmer reverb tank.',
    params: [
      P('decay', 'Decay', 0.45, { size: 'big', fmt: pct, roll: [0.45, 0.15, 0.1, 0.8] }),
      P('blur', 'Blur', 0.3, { size: 'big', fmt: pct, roll: [0.4, 0.2, 0, 1] }),
      MIX(0.4, [0.5, 0.15, 0.25, 0.9]),
      P('pitch', 'Pitch', 0.2, { fmt: pct, roll: [0.25, 0.15, 0, 0.8] }),
      P('width', 'Width', 0.4, { fmt: pct, roll: [0.5, 0.2, 0, 1] }),
      P('shimmer', 'Shimr', 0.15, { fmt: pct, roll: [0.25, 0.2, 0, 0.8] }),
      P('time', 'Time', 0.4, { fmt: (v) => ms(expMap(v, 0.02, 0.9)), roll: [0.5, 0.2, 0, 1] }),
    ],
    buttons: [{ id: 'freeze', label: 'Freeze', toggle: true }, { id: 'recover', label: 'Recover', toggle: false }],
    cvOuts: [],
    loopNote: 'the ghost detunes further',
  },
  {
    id: 'glitch', name: 'Glitch Oracle', kind: 'effect', theme: 'glitch',
    blurb: 'A Euclidean rhythmic glitch sequencer.',
    params: [
      P('chance', 'Chance', 0.25, { size: 'big', fmt: (v) => `${Math.round(v * 32)}/32 steps`, roll: [0.25, 0.12, 0.05, 0.6] }),
      P('intense', 'Intense', 0.3, { size: 'big', fmt: pct, roll: [0.4, 0.2, 0, 1] }),
      MIX(1, [0.9, 0.1, 0.6, 1]),
      P('dur', 'Dur.', stepValue(1, GLITCH_DURS.length), { steps: GLITCH_DURS.length, fmt: (v) => GLITCH_DURS[stepIndex(v, GLITCH_DURS.length)], roll: [0.35, 0.2, 0, 1] }),
      P('intel', 'Int.', 0, { fmt: (v) => `seed ${Math.round(v * 99)}`, roll: [0.5, 0.3, 0, 1] }),
      P('muta', 'Muta.', 0.1, { fmt: pct, roll: [0.15, 0.12, 0, 0.6] }),
    ],
    buttons: [{ id: 'tune', label: 'Tune', toggle: true }],
    cvOuts: [{ id: 'gate', label: 'Gate Out', unipolar: true }],
    loopNote: 'glitches grow more likely',
  },
  // ------------------------------------------------------------- modulators
  {
    id: 'orbit', name: 'Orbit LFO', kind: 'mod', theme: 'orbit',
    blurb: 'A two-axis LFO tracing shapes rather than a single wave.',
    params: [
      P('rate', 'Rate', 0.45, { size: 'big', fmt: (v) => hz(expMap(v, 0.02, 20)), roll: [0.4, 0.15, 0.1, 0.75] }),
      P('radius', 'Radius', 0.35, { fmt: pct, roll: [0.35, 0.15, 0.1, 0.7] }),
      P('shape', 'Shape', 0, { fmt: (v) => (v < 0.22 ? 'sine' : v < 0.45 ? 'triangle' : v < 0.67 ? 'square' : 'stepped'), roll: [0.3, 0.25, 0, 1] }),
      P('gravity', 'Gravity', 0, { fmt: pct, roll: [0.3, 0.25, 0, 1] }),
      P('phase', 'Phase', 0, { fmt: (v) => `${Math.round(v * 90)}°`, roll: [0.3, 0.3, 0, 1] }),
      P('axis', 'Axis', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.1, 0.3, 0.7] }),
    ],
    buttons: [{ id: 'sync', label: 'Sync', toggle: true }],
    cvOuts: [{ id: 'x', label: 'X', unipolar: false }, { id: 'y', label: 'Y', unipolar: false }],
  },
  {
    id: 'reactor', name: 'Reactor FM', kind: 'effect', theme: 'reactor', modStyle: true,
    blurb: 'A phase modulator with its own oscillator.',
    in2Label: 'Mod',
    params: [
      MIX(0.5, [0.6, 0.15, 0.3, 1]),
      P('freq', 'Freq.', 0.35, { fmt: (v) => hz(expMap(v, 20, 4000)), roll: [0.35, 0.2, 0, 0.9] }),
      P('fm', 'FM', 0.3, { fmt: pct, roll: [0.3, 0.15, 0, 0.75] }),
      P('am', 'AM', 0, { fmt: pct, roll: [0.15, 0.15, 0, 0.7] }),
      P('mod', 'Mod', 0.2, { fmt: pct, roll: [0.25, 0.2, 0, 0.9] }),
      P('env', 'Env', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.2, 0, 1] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'env', label: 'CV Out', unipolar: true }],
  },
  {
    id: 'drift', name: 'Drift Field', kind: 'mod', theme: 'drift',
    blurb: 'A random walk generator.',
    params: [
      P('rate', 'Rate', 0.4, { size: 'big', fmt: (v) => ms(1 / expMap(v, 0.1, 20)), roll: [0.4, 0.15, 0.1, 0.8] }),
      P('depth', 'Depth', 0.35, { fmt: pct, roll: [0.35, 0.15, 0.1, 0.7] }),
      P('smooth', 'Smooth', 0.5, { fmt: pct, roll: [0.5, 0.25, 0, 1] }),
      P('bias', 'Bias', 0.5, { bipolar: true, fmt: bip, roll: [0.5, 0.1, 0.3, 0.7] }),
      P('chaos', 'Chaos', 0.1, { fmt: pct, roll: [0.2, 0.2, 0, 0.9] }),
    ],
    buttons: [{ id: 'sync', label: 'Sync', toggle: true }],
    cvOuts: [{ id: 'walk', label: 'CV Out', unipolar: false }],
  },
  {
    id: 'pgate', name: 'Probability Gate', kind: 'effect', theme: 'pgate', modStyle: true,
    blurb: 'A clocked routing gate — a traffic controller, not a distortion box.',
    out2Label: 'Rejects',
    params: [
      MIX(1, [0.9, 0.1, 0.6, 1]),
      P('prob', 'Prob.', 0.4, { fmt: pct, roll: [0.4, 0.15, 0.1, 0.8] }),
      P('mode', 'Mode', 0, { steps: PGATE_MODES.length, fmt: (v) => PGATE_MODES[stepIndex(v, PGATE_MODES.length)], roll: [0.5, 0.35, 0, 1] }),
      P('rate', 'Rate', stepValue(2, PGATE_RATES.length), { steps: PGATE_RATES.length, fmt: (v) => PGATE_RATES[stepIndex(v, PGATE_RATES.length)], roll: [0.5, 0.2, 0, 1] }),
      P('swing', 'Swg', 0, { fmt: pct, roll: [0.2, 0.2, 0, 0.7] }),
      P('patt', 'Patt.', 0, { steps: 100, fmt: (v) => `#${stepIndex(v, 100) + 1}`, roll: [0.5, 0.3, 0, 1] }),
    ],
    buttons: [],
    cvOuts: [{ id: 'gate', label: 'CV Out', unipolar: true }],
    loopNote: 'events fire more often',
  },
  // ---------------------------------------------------------------- utility
  {
    id: 'splitter', name: 'Stereo Splitter', kind: 'util', theme: 'splitter',
    blurb: 'Two circuits, each taking one stereo input to four stereo outputs.',
    params: [
      P('gainA', 'Gain', 0.5, { bipolar: true, cv: false, fmt: (v) => db(utilGainDb(v)) }),
      P('gainB', 'Gain', 0.5, { bipolar: true, cv: false, fmt: (v) => db(utilGainDb(v)) }),
    ],
    buttons: [], cvOuts: [],
  },
  {
    id: 'merger', name: 'Stereo Merger', kind: 'util', theme: 'merger',
    blurb: 'Two circuits, each summing four stereo inputs with a gentle soft-clip.',
    params: [
      P('gainA', 'Gain', 0.5, { bipolar: true, cv: false, fmt: (v) => db(utilGainDb(v)) }),
      P('gainB', 'Gain', 0.5, { bipolar: true, cv: false, fmt: (v) => db(utilGainDb(v)) }),
    ],
    buttons: [], cvOuts: [],
  },
  {
    id: 'mixer', name: '3-Channel Mixer', kind: 'util', theme: 'mixer',
    blurb: 'Three stereo channels with equal-power pan and cross-fades.',
    params: [
      P('fader1', 'Ch 1', 0.8, { cv: false, fmt: (v) => db(20 * Math.log10(Math.max(1e-6, faderGain(v)))) }),
      P('fader2', 'Ch 2', 0.8, { cv: false, fmt: (v) => db(20 * Math.log10(Math.max(1e-6, faderGain(v)))) }),
      P('fader3', 'Ch 3', 0.8, { cv: false, fmt: (v) => db(20 * Math.log10(Math.max(1e-6, faderGain(v)))) }),
      P('pan1', 'Pan', 0.5, { bipolar: true, fmt: bip }),
      P('pan2', 'Pan', 0.5, { bipolar: true, fmt: bip }),
      P('pan3', 'Pan', 0.5, { bipolar: true, fmt: bip }),
      P('xf12', 'XFade', 0.5, { bipolar: true, fmt: bip }),
      P('xf23', 'XFade', 0.5, { bipolar: true, fmt: bip }),
    ],
    buttons: [], cvOuts: [],
  },
  {
    id: 'tamer', name: 'Master Feedback Tamer', kind: 'util', theme: 'tamer', solo: true,
    blurb: 'Tames whatever is patched through it.',
    params: [
      P('thresh', 'Thresh.', 0.8, { cv: false, fmt: (v) => db(tamerThreshDb(v)) }),
      P('recovery', 'Recovery', stepValue(2, TAMER_RECOVERY.length), { cv: false, steps: TAMER_RECOVERY.length, fmt: (v) => TAMER_RECOVERY[stepIndex(v, TAMER_RECOVERY.length)] }),
      P('focus', 'Focus', 0.4, { cv: false, size: 'big', fmt: pct }),
      P('clamp', 'Clamp', 0.5, { cv: false, fmt: pct }),
      P('soft', 'Softness', 0.5, { cv: false, fmt: pct }),
    ],
    buttons: [],
    cvOuts: [{ id: 'howl', label: 'Howl Out', unipolar: true }],
  },
];

export const MODULE_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m]));

// The global strip ("host") is modelled as a pseudo-module.
export const HOST_ID = 'host';

export const GLOBAL_PARAMS = [
  // the conditions a sound must satisfy to exist (see src/dsp/ecology.js)
  { id: 'life', label: 'Life', def: 0.6, fmt: (v) => (v < 0.02 ? 'off: loops need input' : `${pct(v)} · held near ${(-40 + 26 * v).toFixed(0)} dBFS`), theme: 'red', title: 'Life (how strongly loops sustain themselves)' },
  { id: 'breath', label: 'Breath', def: 0.5, fmt: (v) => `${(34 * (1 - 0.75 * v)).toFixed(0)} s cycle · ${(3 + 21 * v).toFixed(0)} dB deep`, theme: 'cyan', title: 'Breath (how loops swell and recede)' },
  { id: 'unrest', label: 'Unrest', def: 0.4, fmt: (v) => (v < 0.01 ? 'off' : `carves a held tone after ${expMap(1 - v, 1.5, 25).toFixed(1)} s`), theme: 'violet', title: 'Unrest (how soon a settled tone is carved away)' },
  { id: 'fdbkChance', label: 'Fdbk', def: 0.3, fmt: pct, theme: 'amber' },
  { id: 'cables', label: 'Cables', def: 1, fmt: pct, theme: 'green' },
  { id: 'mix', label: 'Mix', def: 1, fmt: pct, theme: 'blue' },
];

// Audio processors the dice may chain, with weights.
export const DICE_EFFECTS = [
  ['echoforge', 1], ['tape', 1], ['chrono', 1], ['prism', 1], ['overmind', 1],
  ['subverter', 0.6], ['bloom', 1], ['dust', 0.7], ['ghost', 1], ['glitch', 0.9],
  ['reactor', 0.5], ['pgate', 0.5],
];
export const DICE_MODULATORS = ['orbit', 'drift'];

// --------------------------------------------------------------------- jacks
// Every jack is mono. Stereo pairs are L/R jacks that auto-follow when patched.
// type: 'audio' | 'cv'.   dir: 'in' | 'out'
function J(id, dir, type, label, extra = {}) {
  return { id, dir, type, label, ...extra };
}

export function jacksFor(spec) {
  const out = [];
  if (spec.id === HOST_ID) {
    for (let h = 1; h <= 3; h++) {
      out.push(J(`from${h}L`, 'out', 'audio', `From Host ${h} L`, { pair: `from${h}R`, host: h }));
      out.push(J(`from${h}R`, 'out', 'audio', `From Host ${h} R`, { host: h }));
    }
    out.push(J('toL', 'in', 'audio', 'To Host L', { pair: 'toR', multi: true, toHost: true }));
    out.push(J('toR', 'in', 'audio', 'To Host R', { multi: true, toHost: true }));
    return out;
  }
  if (spec.kind === 'effect') {
    const in2 = spec.in2Label || 'In 2';
    const out2 = spec.out2Label || 'Out 2';
    out.push(J('in1L', 'in', 'audio', 'In 1 L', { pair: 'in1R' }), J('in1R', 'in', 'audio', 'In 1 R'));
    out.push(J('in2L', 'in', 'audio', `${in2} L`, { pair: 'in2R' }), J('in2R', 'in', 'audio', `${in2} R`));
    out.push(J('out1L', 'out', 'audio', 'Out 1 L', { pair: 'out1R' }), J('out1R', 'out', 'audio', 'Out 1 R'));
    out.push(J('out2L', 'out', 'audio', `${out2} L`, { pair: 'out2R' }), J('out2R', 'out', 'audio', `${out2} R`));
  }
  if (spec.id === 'splitter') {
    for (const c of ['a', 'b']) {
      out.push(J(`${c}InL`, 'in', 'audio', `${c.toUpperCase()} In L`, { pair: `${c}InR` }), J(`${c}InR`, 'in', 'audio', `${c.toUpperCase()} In R`));
      for (let i = 1; i <= 4; i++) {
        out.push(J(`${c}Out${i}L`, 'out', 'audio', `${c.toUpperCase()} Out ${i} L`, { pair: `${c}Out${i}R` }));
        out.push(J(`${c}Out${i}R`, 'out', 'audio', `${c.toUpperCase()} Out ${i} R`));
      }
    }
  }
  if (spec.id === 'merger') {
    for (const c of ['a', 'b']) {
      for (let i = 1; i <= 4; i++) {
        out.push(J(`${c}In${i}L`, 'in', 'audio', `${c.toUpperCase()} In ${i} L`, { pair: `${c}In${i}R` }));
        out.push(J(`${c}In${i}R`, 'in', 'audio', `${c.toUpperCase()} In ${i} R`));
      }
      out.push(J(`${c}OutL`, 'out', 'audio', `${c.toUpperCase()} Out L`, { pair: `${c}OutR` }), J(`${c}OutR`, 'out', 'audio', `${c.toUpperCase()} Out R`));
    }
  }
  if (spec.id === 'mixer') {
    for (let i = 1; i <= 3; i++) {
      out.push(J(`ch${i}L`, 'in', 'audio', `Ch ${i} L`, { pair: `ch${i}R` }), J(`ch${i}R`, 'in', 'audio', `Ch ${i} R`));
    }
    out.push(J('outL', 'out', 'audio', 'Out L', { pair: 'outR' }), J('outR', 'out', 'audio', 'Out R'));
  }
  if (spec.id === 'tamer') {
    out.push(J('in1L', 'in', 'audio', 'In 1 L', { pair: 'in1R' }), J('in1R', 'in', 'audio', 'In 1 R'));
    out.push(J('in2L', 'in', 'audio', 'In 2 L', { pair: 'in2R' }), J('in2R', 'in', 'audio', 'In 2 R'));
    out.push(J('out1L', 'out', 'audio', 'Out 1 L', { pair: 'out1R' }), J('out1R', 'out', 'audio', 'Out 1 R'));
    out.push(J('out2L', 'out', 'audio', 'Out 2 L', { pair: 'out2R' }), J('out2R', 'out', 'audio', 'Out 2 R'));
  }
  for (const p of spec.params || []) {
    if (p.cv) out.push(J(`cv:${p.id}`, 'in', 'cv', `${p.label} CV`, { param: p.id, multi: true }));
  }
  for (const c of spec.cvOuts || []) out.push(J(`cvout:${c.id}`, 'out', 'cv', c.label));
  return out;
}

export const HOST_SPEC = { id: HOST_ID, name: 'Host', kind: 'host', params: [], buttons: [], cvOuts: [] };

const JACK_CACHE = new Map();
export function jackMap(moduleId) {
  if (!JACK_CACHE.has(moduleId)) {
    const spec = moduleId === HOST_ID ? HOST_SPEC : MODULE_BY_ID[moduleId];
    if (!spec) return null;
    JACK_CACHE.set(moduleId, Object.fromEntries(jacksFor(spec).map((j) => [j.id, j])));
  }
  return JACK_CACHE.get(moduleId);
}

export function getJack(moduleId, jackId) {
  const m = jackMap(moduleId);
  return m ? m[jackId] || null : null;
}

export function defaultParams() {
  const out = {};
  for (const m of MODULES) {
    out[m.id] = {};
    for (const p of m.params) out[m.id][p.id] = p.def;
  }
  return out;
}

export function defaultButtons() {
  const out = {};
  for (const m of MODULES) {
    out[m.id] = {};
    for (const b of m.buttons) if (b.toggle) out[m.id][b.id] = false;
  }
  return out;
}
