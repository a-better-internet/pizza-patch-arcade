import { ModuleBase } from '../module.js';
import { SVF, Allpass, softLimit, dbToGain, gainToDb, smoothCoef, smoothstep, clamp, flush } from '../util.js';
import { TAMER_RECOVERY, NOTE_DIVS, stepIndex, tamerThreshDb } from '../../spec.js';

const BAND_HZ = [180, 400, 900, 1800, 3500, 7000];

// Master Feedback Tamer.
//  Focus: six band detectors watch for one band becoming genuinely dominant
//  for a sustained moment (a runaway resonance, not a bass note). The dominant
//  frequency is tracked by zero crossings and carved out with a moving notch;
//  the carved energy is smeared through all-passes and returned quietly.
//  Limiter: threshold / knee (Softness) / ratio (Clamp) / release (Recovery).
//  Runaway detector: slow energy climbing toward the threshold over seconds
//  eases the gain back and drives the Howl CV.
export class FeedbackTamer extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    const sr = this.sr;
    this.alias('out2L', 'out1L');
    this.alias('out2R', 'out1R');
    this.det = BAND_HZ.map((f) => {
      const s = new SVF(sr);
      s.set(Math.min(f, sr * 0.4), 1.4);
      return s;
    });
    this.energy = new Float64Array(BAND_HZ.length);
    this.eCoef = smoothCoef(0.25, sr);
    this.domTime = 0;
    this.domBand = -1;
    this.carve = 0;
    this.zc = 0;
    this.zn = 0;
    this.lastSign = 0;
    this.fEst = 1000;
    this.notch = [new SVF(sr), new SVF(sr)];
    const ms = (v) => (v / 1000) * sr;
    this.smear = [
      [13, 23, 37, 53].map((v) => new Allpass(ms(v))),
      [15, 27, 41, 59].map((v) => new Allpass(ms(v))),
    ];
    this.env = 0;
    this.att = smoothCoef(0.0008, sr);
    this.grDb = 0;
    this.slow = 0;
    this.slowCoef = smoothCoef(2, sr);
    this.run = 0;
    this.runUp = smoothCoef(1.5, sr);
    this.runDown = smoothCoef(3, sr);
    this.minGain = 1;
  }

  reset() {
    for (const d of this.det) d.reset();
    this.energy.fill(0);
    for (const n of this.notch) n.reset();
    for (const ch of this.smear) for (const a of ch) a.clear();
    this.carve = 0;
    this.env = 0;
    this.grDb = 0;
    this.slow = 0;
    this.run = 0;
  }

  readTelemetry() {
    const t = { grDb: -gainToDb(this.minGain), howl: this.run, carve: this.carve, freq: this.fEst };
    this.minGain = 1;
    return t;
  }

  process() {
    const p = this.p, sr = this.sr;
    const c = this.inConnected, I = this.in;
    const pick = (a, b) => (c[a] || !c[b] ? I[a] : I[b]);
    const a1L = pick('in1L', 'in1R'), a1R = pick('in1R', 'in1L');
    const a2L = pick('in2L', 'in2R'), a2R = pick('in2R', 'in2L');
    const thrDb = tamerThreshDb(p.thresh);
    const thr = dbToGain(thrDb);
    const knee = p.soft * 24;
    const slope = 0.33 + 0.67 * p.clamp;
    const beats = NOTE_DIVS[TAMER_RECOVERY[stepIndex(p.recovery, TAMER_RECOVERY.length)]];
    const rel = smoothCoef(Math.max(0.02, (beats * 60) / this.engine.bpm), sr);
    const focus = p.focus;
    // Focus also sets how dominant a band must be before it is carved (+12 .. +6 dB)
    const domThr = 16 - 12 * focus;

    // --- dominance analysis (per block)
    let maxE = 0, maxK = 0, sumE = 0;
    for (let k = 0; k < this.energy.length; k++) {
      sumE += this.energy[k];
      if (this.energy[k] > maxE) {
        maxE = this.energy[k];
        maxK = k;
      }
    }
    const others = (sumE - maxE) / (this.energy.length - 1) + 1e-9;
    const dom = maxE / others;
    if (focus > 0.001 && dom > domThr && maxE > 1e-4) {
      if (maxK !== this.domBand) {
        this.domBand = maxK;
        this.domTime = 0;
      }
      this.domTime += 64 / sr;
    } else {
      this.domTime = Math.max(0, this.domTime - (2 * 64) / sr);
    }
    const carveT = this.domTime > 0.3 ? focus * smoothstep(domThr, domThr * 3, dom) : 0;
    this.carve += (carveT - this.carve) * (carveT > this.carve ? 0.05 : 0.01);
    this.notch[0].set(this.fEst, 6);
    this.notch[1].set(this.fEst, 6);
    const kN = this.notch[0].k;

    const oL = this.cur.out1L, oR = this.cur.out1R;
    const dk = this.domBand >= 0 ? this.domBand : 0;
    for (let n = 0; n < 64; n++) {
      let l = a1L[n] + a2L[n];
      let r = a1R[n] + a2R[n];
      const mono = 0.5 * (l + r);
      for (let k = 0; k < this.det.length; k++) {
        const d = this.det[k];
        d.process(mono);
        const b = d.bp * d.k;
        this.energy[k] = flush(this.energy[k] + this.eCoef * (b * b - this.energy[k]));
        if (k === dk) {
          const s = b > 0 ? 1 : -1;
          if (s !== this.lastSign) {
            this.zc++;
            this.lastSign = s;
          }
        }
      }
      if (++this.zn >= 1024) {
        const f = (this.zc / 2) * (sr / this.zn);
        if (f > 40 && f < sr * 0.4) this.fEst += (f - this.fEst) * 0.3;
        this.zc = 0;
        this.zn = 0;
      }
      // dynamic notch + smear
      if (this.carve > 1e-4) {
        this.notch[0].process(l);
        this.notch[1].process(r);
        const cl = this.notch[0].bp * kN * this.carve;
        const cr = this.notch[1].bp * kN * this.carve;
        let sl = cl, sr2 = cr;
        for (let k = 0; k < 4; k++) {
          sl = this.smear[0][k].process(sl, 0.6);
          sr2 = this.smear[1][k].process(sr2, 0.6);
        }
        l = l - cl + 0.3 * focus * sl;
        r = r - cr + 0.3 * focus * sr2;
      }
      // runaway detector
      const pw = 0.5 * (l * l + r * r);
      this.slow = flush(this.slow + this.slowCoef * (pw - this.slow));
      const slowDb = 10 * Math.log10(this.slow + 1e-12) + 3;
      const runT = smoothstep(thrDb - 10, thrDb + 2, slowDb);
      this.run += (runT - this.run) * (runT > this.run ? this.runUp : this.runDown);
      // limiter / compressor
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.env = pk > this.env ? this.env + (pk - this.env) * this.att : this.env + (pk - this.env) * rel;
      const lvl = gainToDb(this.env);
      const over = lvl - thrDb;
      let gr;
      if (2 * over < -knee) gr = 0;
      else if (knee > 0 && 2 * Math.abs(over) <= knee) gr = (slope * (over + knee / 2) * (over + knee / 2)) / (2 * knee);
      else gr = slope * over;
      const g = dbToGain(-gr - 9 * this.run);
      if (g < this.minGain) this.minGain = g;
      l *= g;
      r *= g;
      if (p.clamp > 0.85) {
        // hard ceiling at the threshold when Clamp is near maximum
        const k = (p.clamp - 0.85) / 0.15;
        l = l + k * (softLimit(l, thr * 0.85, thr * 1.05) - l);
        r = r + k * (softLimit(r, thr * 0.85, thr * 1.05) - r);
      }
      oL[n] = l;
      oR[n] = r;
    }
    this.cur['cvout:howl'].fill(clamp(this.run, 0, 1));
  }

  led() {
    return [this.run, this.carve];
  }
}

