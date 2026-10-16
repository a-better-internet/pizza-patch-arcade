import { ModuleBase } from '../module.js';
import { Oversampler, sat, dbToGain, HALF_PI } from '../util.js';
import { faderGain, utilGainDb } from '../../spec.js';

// Pick the buffer for one side of a stereo pair, copying the other side when
// only one jack of the pair is patched (mono normalisation).
function side(mod, l, r, wantLeft) {
  const c = mod.inConnected;
  if (wantLeft) return c[l] || !c[r] ? mod.in[l] : mod.in[r];
  return c[r] || !c[l] ? mod.in[r] : mod.in[l];
}

// Stereo Splitter: two circuits, each one stereo input -> four stereo outputs.
export class StereoSplitter extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    for (const c of ['a', 'b']) {
      for (let i = 2; i <= 4; i++) {
        this.alias(`${c}Out${i}L`, `${c}Out1L`);
        this.alias(`${c}Out${i}R`, `${c}Out1R`);
      }
    }
  }
  process() {
    for (const c of ['a', 'b']) {
      const id = c === 'a' ? 'gainA' : 'gainB';
      const g0 = dbToGain(utilGainDb(this.pPrev[id])), g1 = dbToGain(utilGainDb(this.p[id]));
      const L = side(this, `${c}InL`, `${c}InR`, true), R = side(this, `${c}InL`, `${c}InR`, false);
      const oL = this.cur[`${c}Out1L`], oR = this.cur[`${c}Out1R`];
      for (let n = 0; n < 64; n++) {
        const g = g0 + ((g1 - g0) * n) / 64;
        oL[n] = L[n] * g;
        oR[n] = R[n] * g;
      }
    }
  }
}

// Stereo Merger: two circuits, each four stereo inputs summed with a gentle,
// oversampled soft clip. Its gain knobs are the main loop throttle.
export class StereoMerger extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    this.os = [0, 1, 2, 3].map(() => new Oversampler(2));
  }
  reset() {
    for (const o of this.os) o.reset();
  }
  process() {
    let k = 0;
    for (const c of ['a', 'b']) {
      const id = c === 'a' ? 'gainA' : 'gainB';
      const g0 = dbToGain(utilGainDb(this.pPrev[id])), g1 = dbToGain(utilGainDb(this.p[id]));
      const ins = [];
      for (let i = 1; i <= 4; i++) {
        const l = `${c}In${i}L`, r = `${c}In${i}R`;
        if (this.inConnected[l] || this.inConnected[r]) ins.push([side(this, l, r, true), side(this, l, r, false)]);
      }
      const oL = this.cur[`${c}OutL`], oR = this.cur[`${c}OutR`];
      const osL = this.os[k++], osR = this.os[k++];
      for (let n = 0; n < 64; n++) {
        const g = g0 + ((g1 - g0) * n) / 64;
        let l = 0, r = 0;
        for (let j = 0; j < ins.length; j++) {
          l += ins[j][0][n];
          r += ins[j][1][n];
        }
        const ul = osL.upsample(l * g);
        ul[0] = 1.25 * sat(ul[0] / 1.25);
        ul[1] = 1.25 * sat(ul[1] / 1.25);
        oL[n] = osL.downsample(ul);
        const ur = osR.upsample(r * g);
        ur[0] = 1.25 * sat(ur[0] / 1.25);
        ur[1] = 1.25 * sat(ur[1] / 1.25);
        oR[n] = osR.downsample(ur);
      }
    }
  }
}

// 3-Channel Mixer with equal-power pans and cross-fades, metering true dBFS.
export class Mixer extends ModuleBase {
  constructor(engine, spec) {
    super(engine, spec);
    this.peaks = new Float64Array(4);
    this.g0 = new Float64Array(6);
    this.g1 = new Float64Array(6);
  }
  readMeters() {
    const out = Array.from(this.peaks);
    this.peaks.fill(0);
    return out;
  }
  gains() {
    const p = this.p;
    // flat-centre equal-power cross-fades: centre = both channels at unity
    const xf = (v) => [Math.min(1, Math.SQRT2 * Math.cos(v * HALF_PI)), Math.min(1, Math.SQRT2 * Math.sin(v * HALF_PI))];
    const [a12, b12] = xf(p.xf12);
    const [a23, b23] = xf(p.xf23);
    const ch = [faderGain(p.fader1) * a12, faderGain(p.fader2) * b12 * a23, faderGain(p.fader3) * b23];
    const out = this.g1;
    for (let i = 0; i < 3; i++) {
      const pan = p[`pan${i + 1}`];
      out[2 * i] = ch[i] * Math.min(1, Math.SQRT2 * Math.cos(pan * HALF_PI));
      out[2 * i + 1] = ch[i] * Math.min(1, Math.SQRT2 * Math.sin(pan * HALF_PI));
    }
    return out;
  }
  process() {
    const g1 = this.gains();
    const g0 = this.g0;
    const oL = this.cur.outL, oR = this.cur.outR;
    oL.fill(0);
    oR.fill(0);
    for (let c = 0; c < 3; c++) {
      const l = `ch${c + 1}L`, r = `ch${c + 1}R`;
      if (!this.inConnected[l] && !this.inConnected[r]) continue;
      const L = side(this, l, r, true), R = side(this, l, r, false);
      const a0 = g0[2 * c], a1 = g1[2 * c], b0 = g0[2 * c + 1], b1 = g1[2 * c + 1];
      let pk = this.peaks[c];
      for (let n = 0; n < 64; n++) {
        const t = n / 64;
        const sl = L[n] * (a0 + (a1 - a0) * t);
        const sr = R[n] * (b0 + (b1 - b0) * t);
        oL[n] += sl;
        oR[n] += sr;
        const a = Math.max(Math.abs(sl), Math.abs(sr));
        if (a > pk) pk = a;
      }
      this.peaks[c] = pk;
    }
    let pk = this.peaks[3];
    for (let n = 0; n < 64; n++) {
      const a = Math.max(Math.abs(oL[n]), Math.abs(oR[n]));
      if (a > pk) pk = a;
    }
    this.peaks[3] = pk;
    this.g1 = this.g0;
    this.g0 = g1;
  }
}
