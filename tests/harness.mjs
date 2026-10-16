// Offline rendering + analysis helpers for the DSP test suite.
import { Engine } from '../src/dsp/engine.js';
import { BLOCK } from '../src/spec.js';
import { Rng } from '../src/dsp/util.js';

export const SR = 48000;

export function makeEngine(sr = SR) {
  return new Engine(sr);
}

// Push a PatchModel's state into an engine.
export function applyModel(engine, model) {
  engine.setPatch(model.cables);
  for (const m in model.params) for (const p in model.params[m]) engine.setParam(m, p, model.params[m][p]);
  for (const m in model.buttons) for (const b in model.buttons[m]) engine.setButton(m, b, model.buttons[m][b]);
  engine.setGlobal('mix', model.globals.mix);
}

// Test signal generators (stereo, block-wise).
export const signals = {
  silence: () => () => 0,
  noise: (amp = 0.5, seed = 3) => {
    const r = new Rng(seed);
    return () => amp * r.bi();
  },
  sine: (hz, amp = 0.5) => {
    let ph = 0;
    return () => {
      ph += hz / SR;
      if (ph >= 1) ph -= 1;
      return amp * Math.sin(2 * Math.PI * ph);
    };
  },
  square: (hz, amp = 0.9) => {
    let ph = 0;
    return () => {
      ph += hz / SR;
      if (ph >= 1) ph -= 1;
      return ph < 0.5 ? amp : -amp;
    };
  },
  // a plucky test tone: decaying sine bursts every 250 ms
  bursts: (hz = 440, amp = 0.6) => {
    let n = 0;
    return () => {
      const t = (n++ % (SR / 4)) / SR;
      return amp * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 12);
    };
  },
};

// Render `seconds` of audio. `input` is either null (use the engine's own
// host sources) or a generator function feeding host input 1 (as 'input').
export function render(engine, seconds, { input = null, onBlock = null, skip = 0 } = {}) {
  const blocks = Math.ceil((seconds * engine.sr) / BLOCK);
  const L = new Float32Array(blocks * BLOCK);
  const R = new Float32Array(blocks * BLOCK);
  const outL = new Float32Array(BLOCK), outR = new Float32Array(BLOCK);
  const inBufs = [[new Float32Array(BLOCK), new Float32Array(BLOCK)], null, null];
  for (let b = 0; b < blocks; b++) {
    let ins = null;
    if (input) {
      for (let n = 0; n < BLOCK; n++) {
        const v = input();
        inBufs[0][0][n] = v;
        inBufs[0][1][n] = v;
      }
      ins = inBufs;
    }
    engine.processBlock(ins, outL, outR);
    L.set(outL, b * BLOCK);
    R.set(outR, b * BLOCK);
    if (onBlock) onBlock(b);
  }
  if (skip > 0) {
    const s = Math.floor(skip * engine.sr);
    return { L: L.subarray(s), R: R.subarray(s) };
  }
  return { L, R };
}

export function peak(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (!(a < Infinity)) return Infinity;
    if (a > m) m = a;
  }
  return m;
}

export function rmsDb(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return 10 * Math.log10(s / Math.max(1, buf.length) + 1e-30);
}

export function countNonFinite(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) n++;
  return n;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Welch power spectrum (Hann, 4096 points, 50% overlap). Returns bin powers.
export function spectrum(buf, size = 4096) {
  const pow = new Float64Array(size / 2);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const re = new Float64Array(size), im = new Float64Array(size);
  let frames = 0;
  for (let off = 0; off + size <= buf.length; off += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = buf[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  for (let k = 0; k < size / 2; k++) pow[k] /= Math.max(1, frames);
  return pow;
}

// Energy above `hz` relative to total energy, in dB.
export function bandRatioDb(buf, loHz, hiHz = SR / 2, sr = SR) {
  const pow = spectrum(buf);
  const binHz = sr / (pow.length * 2);
  let band = 0, total = 0;
  for (let k = 1; k < pow.length; k++) {
    total += pow[k];
    const f = k * binHz;
    if (f >= loHz && f < hiHz) band += pow[k];
  }
  return 10 * Math.log10((band + 1e-30) / (total + 1e-30));
}

// Absolute energy (dBFS, relative to a full-scale sine) between two frequencies.
export function bandLevelDb(buf, loHz, hiHz = SR / 2, sr = SR) {
  const pow = spectrum(buf);
  const size = pow.length * 2;
  const binHz = sr / size;
  let band = 0;
  for (let k = 1; k < pow.length; k++) {
    const f = k * binHz;
    if (f >= loHz && f < hiHz) band += pow[k];
  }
  // Hann window power gain = 0.375 * size; a full-scale sine has power size^2/16 * 0.5 ...
  // normalise so a unit-amplitude sine reads 0 dB
  const ref = (size * size) / 16;
  return 10 * Math.log10(band / ref + 1e-30);
}
