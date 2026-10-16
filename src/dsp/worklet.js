// AudioWorklet entry point. Runs the whole rack inside one processor so cables,
// feedback loops and safety stages are sample-accurate and glitch-free.

import { Engine } from './engine.js';
import { BLOCK } from '../spec.js';

class PatchArcadeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new Engine(sampleRate);
    this.inBufs = [0, 1, 2].map(() => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    this.inViews = [null, null, null];
    this.fifoIn = this.inBufs;
    this.fifoPos = 0;
    this.outL = new Float32Array(BLOCK);
    this.outR = new Float32Array(BLOCK);
    this.telemetryEvery = Math.max(1, Math.round(sampleRate / BLOCK / 30));
    this.blockCount = 0;
    this.errors = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  onMessage(msg) {
    const eng = this.engine;
    try {
      switch (msg.type) {
        case 'patch':
          eng.setPatch(msg.cables);
          break;
        case 'param':
          eng.setParam(msg.m, msg.p, msg.v);
          break;
        case 'params':
          for (const m in msg.values) for (const p in msg.values[m]) eng.setParam(m, p, msg.values[m][p]);
          break;
        case 'button':
          eng.setButton(msg.m, msg.b, msg.v);
          break;
        case 'global':
          eng.setGlobal(msg.key, msg.value);
          break;
        case 'source':
          eng.setSource(msg.host, msg.name, msg.trimDb);
          break;
        case 'panic':
          eng.panic();
          break;
        default:
          break;
      }
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  }

  runBlock(hasInput) {
    try {
      this.engine.processBlock(hasInput, this.outL, this.outR);
    } catch (err) {
      // never let an exception kill the audio thread: silence, reset, report
      this.outL.fill(0);
      this.outR.fill(0);
      if (this.errors++ < 5) this.port.postMessage({ type: 'error', message: String((err && err.stack) || err) });
      try {
        this.engine.panic();
      } catch {
        /* ignore */
      }
    }
    if (++this.blockCount >= this.telemetryEvery) {
      this.blockCount = 0;
      try {
        this.port.postMessage({ type: 'telemetry', t: this.engine.telemetry() });
      } catch {
        /* ignore */
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const L = out[0], R = out.length > 1 ? out[1] : null;
    const frames = L.length;
    const has = this.inViews;
    for (let h = 0; h < 3; h++) has[h] = inputs[h] && inputs[h].length ? this.inBufs[h] : null;
    if (frames % BLOCK === 0) {
      for (let off = 0; off < frames; off += BLOCK) {
        for (let h = 0; h < 3; h++) {
          const inp = inputs[h];
          if (!has[h]) continue;
          const a = inp[0], b = inp.length > 1 ? inp[1] : inp[0];
          const bl = this.inBufs[h][0], br = this.inBufs[h][1];
          for (let n = 0; n < BLOCK; n++) {
            bl[n] = a[off + n];
            br[n] = b[off + n];
          }
        }
        this.runBlock(has);
        for (let n = 0; n < BLOCK; n++) {
          L[off + n] = this.outL[n];
          if (R) R[off + n] = this.outR[n];
        }
      }
    } else {
      // unusual render quantum: FIFO with one block of latency
      for (let i = 0; i < frames; i++) {
        const pos = this.fifoPos;
        for (let h = 0; h < 3; h++) {
          if (!has[h]) continue;
          const inp = inputs[h];
          this.inBufs[h][0][pos] = inp[0][i];
          this.inBufs[h][1][pos] = (inp[1] || inp[0])[i];
        }
        L[i] = this.outL[pos];
        if (R) R[i] = this.outR[pos];
        if (++this.fifoPos >= BLOCK) {
          this.fifoPos = 0;
          this.runBlock(has);
        }
      }
    }
    return true;
  }
}

registerProcessor('patch-arcade', PatchArcadeProcessor);
