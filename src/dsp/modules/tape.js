import { Effect } from '../module.js';
import { DelayLine, SVF, OnePole, Oversampler, sat, expMap, smoothCoef, TAU, clamp, flush } from '../util.js';

// Tape Phantom: tape emulation. Saturation is 2x oversampled and RMS gain
// compensated; the playback head is followed by a tape-style high roll-off, so
// heavy Wear gets warmer rather than harsher.
export class TapePhantom extends Effect {
  constructor(engine, spec) {
    const os = new Oversampler(2).latency;
    // dry is delayed by the playback head + oversampler so partial mixes don't comb
    super(engine, spec, { latency: os + Math.round(0.006 * engine.sr) });
    const sr = this.sr;
    this.tape = [new DelayLine(sr * 0.6), new DelayLine(sr * 0.6)];
    this.os = [new Oversampler(2), new Oversampler(2)];
    this.tone = [new SVF(sr), new SVF(sr)];
    this.memLp = [new OnePole(sr, 2200), new OnePole(sr, 2200)];
    this.memHp = [new OnePole(sr, 110), new OnePole(sr, 110)];
    this.wowPh = 0;
    this.flPh = 0;
    this.wander = [0, 0, 0, 0];
    this.wanderT = [0, 0, 0, 0];
    this.dz = 0; // dropout envelope
    this.dzState = 0;
    this.dzTimer = 0;
    this.dzDepth = 0;
    this.rmsIn = 1e-4;
    this.rmsOut = 1e-4;
    this.makeup = 1;
    this.rc = smoothCoef(0.3, sr);
    this.mc = smoothCoef(0.4, sr);
    this.hs = new Float64Array(2);
    this.cvOut = 0;
  }

  reset() {
    for (const t of this.tape) t.clear();
    for (const o of this.os) o.reset();
    for (const f of this.tone) f.reset();
    for (const f of this.memLp) f.reset();
    for (const f of this.memHp) f.reset();
    this.dz = 0;
    this.dzState = 0;
    this.makeup = 1;
  }

  processWet(inL, inR, wetL, wetR) {
    const sr = this.sr, p = this.p, rng = this.rng;
    const B = 64;
    const dt = B / sr;
    // Age: random-walk the wow/flutter rate and depth
    const ageRate = 0.05 + p.age * 1.2;
    for (let k = 0; k < 4; k++) {
      if ((this.wanderT[k] -= dt * ageRate) <= 0) {
        this.wanderT[k] = 0.5 + rng.next();
        this.wanderTarget = this.wanderTarget || [0, 0, 0, 0];
        this.wanderTarget[k] = rng.bi() * (0.2 + 0.8 * p.age);
      }
      const tgt = this.wanderTarget ? this.wanderTarget[k] : 0;
      this.wander[k] += (tgt - this.wander[k]) * Math.min(1, dt * 2 * ageRate);
    }
    const wowHz = 1.2 * (1 + 0.35 * this.wander[0]);
    const flHz = 7 * (1 + 0.25 * this.wander[1]);
    const wowD = p.wow * p.wow * 0.0028 * sr * (1 + 0.4 * this.wander[2]);
    const flD = p.flutter * p.flutter * 0.00028 * sr * (1 + 0.4 * this.wander[3]);

    // Dropout events
    const drop = p.drop;
    if (this.dzState === 0 && drop > 0.001 && rng.next() < drop * drop * 3 * dt) {
      this.dzState = 1;
      this.dzDepth = (0.4 + 0.6 * rng.next()) * Math.min(1, 0.3 + drop);
      this.dzTimer = 0.04 + rng.next() * 0.28;
    }
    let dzTarget = 0;
    if (this.dzState === 1) {
      dzTarget = this.dzDepth;
      if ((this.dzTimer -= dt) <= 0) this.dzState = 0;
    }

    const drive = 1 + 9 * p.wear * p.wear * (1 + 1.5 * this.loop);
    const cutBase = expMap(1 - 0.65 * p.wear, 4500, 15000);
    const mem = 0.82 * p.memory;
    const memD = 0.32 * sr;
    const head = Math.round(0.006 * sr);
    const ins = [inL, inR], outs = [wetL, wetR];
    const dzCoefAtt = 1 - Math.exp(-1 / (0.03 * sr));
    const dzCoefRel = 1 - Math.exp(-1 / (0.15 * sr));
    let wowPh = this.wowPh, flPh = this.flPh, dz = this.dz;
    let cvAcc = 0;
    for (let i = 0; i < B; i++) {
      wowPh += wowHz / sr;
      if (wowPh >= 1) wowPh -= 1;
      flPh += flHz / sr;
      if (flPh >= 1) flPh -= 1;
      dz += (dzTarget - dz) * (dzTarget > dz ? dzCoefAtt : dzCoefRel);
      const wv = Math.sin(TAU * wowPh), fv = Math.sin(TAU * flPh);
      const mod = wowD * (1 + wv) + flD * (1 + fv) + dz * 0.0015 * sr;
      cvAcc += 0.8 * (wv * p.wow + 0.5 * fv * p.flutter);
      const cut = cutBase * (1 - 0.82 * dz);
      if ((i & 7) === 0) {
        this.tone[0].set(cut, 0.6);
        this.tone[1].set(cut, 0.6);
      }
      for (let c = 0; c < 2; c++) {
        const tape = this.tape[c];
        const playback = tape.tapHermite(head + mod);
        const memory = tape.tapHermite(memD + mod);
        let fbs = this.memLp[c].process(memory);
        fbs = fbs - this.memHp[c].process(fbs);
        tape.write(ins[c][i] + sat(mem * fbs));
        // saturation, 2x oversampled
        const up = this.os[c].upsample(playback * drive);
        up[0] = sat(up[0]);
        up[1] = sat(up[1]);
        this.hs[c] = this.os[c].downsample(up) / drive;
        // energy tracking for gain compensation (use playback as reference)
        this.rmsIn = flush(this.rmsIn + this.rc * 0.5 * (playback * playback - this.rmsIn));
        this.rmsOut = flush(this.rmsOut + this.rc * 0.5 * (this.hs[c] * this.hs[c] - this.rmsOut));
      }
      if (this.rmsIn > 1e-7) {
        const want = clamp(Math.sqrt(this.rmsIn / (this.rmsOut + 1e-12)), 0.8, 2);
        this.makeup += (want - this.makeup) * this.mc;
      }
      const g = this.makeup * (1 - 0.72 * dz);
      outs[0][i] = this.tone[0].process(this.hs[0]) * g;
      outs[1][i] = this.tone[1].process(this.hs[1]) * g;
    }
    this.wowPh = wowPh;
    this.flPh = flPh;
    this.dz = dz;
    this.cur['cvout:wowflut'].fill(clamp(cvAcc / B, -1, 1));
  }
}
