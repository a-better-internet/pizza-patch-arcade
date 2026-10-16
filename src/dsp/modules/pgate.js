import { Effect } from '../module.js';
import { RecordBuffer, clamp } from '../util.js';
import { PGATE_RATES, PGATE_MODES, NOTE_DIVS, stepIndex } from '../../spec.js';
import { euclid } from './glitch.js';

// One hundred 16-step dance rhythms: classics first, then Euclidean variants.
const CLASSICS = [
  'x...x...x...x...', '..x...x...x...x.', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxxxxx',
  'x..x..x...x..x..', 'x..x..x...x.x...', 'x..x...x..x.x...', '....x.......x...',
  'x.....x...x.....', 'x...x...x..xx...', 'x..x..x.x..x..x.', '.xx..xx..xx..xx.',
  'x.xx.xx.x.xx.xx.', 'xx.xx.xx.xx.xx.x', 'x...x.x...x.x.x.', '..x...xx..x...x.',
  'x..x..x..x..x.x.', 'x.x..x.x..x.x...', '...x...x...x...x', 'x...x..xx...x...',
  'x.x.x...x.x.x...', 'xx..xx..xx..xx..', '.x.x.x.x.x.x.x.x', 'x..xx..xx..xx..x',
  'x.......x.x.....', 'x..x.x..x..x.x..', '.x..x..x.x..x..x', 'xxx.xxx.xxx.xxx.',
];
export const PATTERNS = (() => {
  const out = CLASSICS.map((s) => [...s].map((c) => (c === 'x' ? 1 : 0)));
  const seen = new Set(CLASSICS);
  const ks = [3, 5, 7, 9, 11, 13, 4, 6, 10, 12];
  for (let rot = 0; rot < 16 && out.length < 100; rot++) {
    for (const k of ks) {
      if (out.length >= 100) break;
      const p = euclid(k, 16, rot);
      const key = p.map((v) => (v ? 'x' : '.')).join('');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
})();

const M_SKIP = 0, M_SWAP = 1, M_REPEAT = 2, M_MIRROR = 3, M_INVERT = 4, M_RANDOM = 5;

// Probability Gate: a clocked router. Each event crossfades (2-8 ms) between
// the live path and the processed step, and whatever the pattern removes from
// the main output is sent to the second output.
export class ProbabilityGate extends Effect {
  constructor(engine, spec) {
    super(engine, spec, { separateOut2: true });
    const sr = this.sr;
    this.buf = [new RecordBuffer(sr * 4.2), new RecordBuffer(sr * 4.2)];
    this.voices = [{ g: 0, target: 0 }, { g: 0, target: 0 }, { g: 0, target: 0 }];
    this.lastEff = null;
    this.next = 0;
    this.jitter = 0;
    this.fast = 1 / (0.002 * sr);
    this.mid = 1 / (0.003 * sr);
    this.slow = 1 / (0.008 * sr);
    this.rep = Math.round(0.002 * sr);
    this.gateOn = false;
  }

  reset() {
    for (const b of this.buf) b.clear();
    for (const v of this.voices) {
      v.g = 0;
      v.target = 0;
    }
    this.lastEff = null;
  }

  processWet(inL, inR, wetL, wetR) {
    const p = this.p, sr = this.sr, rng = this.rng, eng = this.engine;
    const stepBeats = NOTE_DIVS[PGATE_RATES[stepIndex(p.rate, PGATE_RATES.length)]];
    const stepLen = Math.max(128, Math.round((stepBeats * 60 * sr) / eng.bpm));
    const pat = PATTERNS[stepIndex(p.patt, PATTERNS.length)];
    const prob = clamp(p.prob + this.loop * 0.3, 0, 1);
    const swing = p.swing * 0.33;
    const modeSel = stepIndex(p.mode, PGATE_MODES.length);
    const bps = eng.bpm / 60 / sr;
    const o2L = this.cur.out2L, o2R = this.cur.out2R;
    const bl = this.buf[0], br = this.buf[1];
    let beat = eng.beat;
    for (let i = 0; i < 64; i++, beat += bps) {
      const raw = beat / stepBeats;
      let idx = Math.floor(raw);
      const frac = raw - idx;
      // swing with a little human micro-jitter on the off-steps
      if (idx & 1 && frac < swing + this.jitter) idx -= 1;
      if (idx !== this.lastEff) {
        const first = this.lastEff === null;
        this.lastEff = idx;
        if (idx & 1) this.jitter = 0;
        else this.jitter = swing > 0 ? rng.bi() * 0.02 * p.swing : 0;
        for (const v of this.voices) v.target = 0;
        if (!first && pat[((idx % 16) + 16) % 16] && prob > 0 && rng.next() < prob) {
          const v = this.voices.reduce((a, b) => (a.g < b.g ? a : b));
          v.mode = modeSel === M_RANDOM ? rng.int(5) : modeSel;
          v.cap = bl.pos;
          v.t = 0;
          v.acc = 0;
          v.len = stepLen;
          v.target = 1;
          v.rate = v.mode === M_SKIP ? this.fast : v.mode === M_SWAP ? this.slow : this.mid;
        }
      }
      bl.write(inL[i]);
      br.write(inR[i]);
      const xl = inL[i], xr = inR[i];
      let G = 0, pl = 0, pr = 0;
      this.gateOn = false;
      for (const v of this.voices) {
        if (v.g <= 0 && v.target === 0) continue;
        v.g = clamp(v.g + (v.target > v.g ? v.rate : -v.rate), 0, 1);
        if (v.target) this.gateOn = true;
        const g = v.g;
        G += g;
        const t = v.t++;
        switch (v.mode) {
          case M_REPEAT: {
            // the previous step again at double speed: an octave up, twice
            const S = v.len;
            const u = (2 * t) % S;
            const e = Math.min(1, u / this.rep, (S - u) / this.rep);
            const pos = v.cap - S + u;
            pl += bl.readHermite(pos) * e * g;
            pr += br.readHermite(pos) * e * g;
            break;
          }
          case M_MIRROR: {
            // reverse with a decelerating vinyl brake
            const k = Math.max(0.25, 1 - 0.7 * (t / v.len));
            v.acc += k;
            const pos = v.cap - 2 - v.acc;
            pl += bl.readHermite(pos) * g;
            pr += br.readHermite(pos) * g;
            break;
          }
          case M_INVERT:
            pl += xl * g;
            pr -= xr * g;
            break;
          default:
            // Skip / Swap: the step leaves the main path
            break;
        }
      }
      if (G > 1) {
        pl /= G;
        pr /= G;
        G = 1;
      }
      wetL[i] = xl * (1 - G) + pl;
      wetR[i] = xr * (1 - G) + pr;
      // second output: whatever the pattern removed or replaced
      o2L[i] = xl * G;
      o2R[i] = xr * G;
    }
    this.cur['cvout:gate'].fill(this.gateOn ? 1 : 0);
  }

  led() {
    return this.gateOn ? 1 : 0;
  }
}
