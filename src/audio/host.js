// Web Audio host: creates the AudioContext and the rack's AudioWorkletNode and
// feeds the three From Host inputs. The instrument needs no input at all: by
// default each From Host carries only the one-sample impulse sent by Strike.
// Demo instruments, a microphone/line input or a file are optional extras for
// using the rack as an effect.

export const HOST_SOURCES = [
  { id: 'impulse', label: 'Impulse only' },
  { id: 'off', label: 'Off' },
  { id: 'keys', label: 'Keys', group: 'Demo input' },
  { id: 'pad', label: 'Pad', group: 'Demo input' },
  { id: 'beat', label: 'Beat', group: 'Demo input' },
  { id: 'bass', label: 'Bass', group: 'Demo input' },
  { id: 'arp', label: 'Arp', group: 'Demo input' },
  { id: 'mic', label: 'Mic / Line in', group: 'External input' },
  { id: 'file', label: 'Audio file…', group: 'External input' },
];

// Where to load the engine from. The single-file build embeds the worklet
// source; Chrome refuses Blob URLs on file:// pages, so a data: URL follows.
function workletURLs() {
  const src = globalThis.__PA_WORKLET_SOURCE__;
  const extra = Array.isArray(globalThis.__PA_WORKLET_URLS__) ? globalThis.__PA_WORKLET_URLS__ : [];
  if (typeof src === 'string') {
    const urls = [...extra];
    try {
      urls.push(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch {
      /* ignore */
    }
    urls.push(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
    return urls;
  }
  return [new URL('../dsp/worklet.js', import.meta.url).href];
}

async function loadWorklet(ctx) {
  let last = null;
  for (const url of workletURLs()) {
    try {
      await ctx.audioWorklet.addModule(url);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Could not load the audio engine (${last && last.message}). Try serving the page over http://localhost.`);
}

export class AudioHost {
  constructor({ onTelemetry, onError, onState }) {
    this.onTelemetry = onTelemetry;
    this.onError = onError;
    this.onState = onState;
    this.ctx = null;
    this.node = null;
    this.inBus = [];
    this.ext = [null, null, null];
    this.tokens = [0, 0, 0];
  }

  get running() {
    return !!(this.ctx && this.ctx.state === 'running' && this.node);
  }

  async start() {
    if (this.node) {
      await this.ctx.resume();
      this.onState(this.ctx.state);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser does not support Web Audio.');
    const ctx = new AC({ latencyHint: 'interactive' });
    if (!ctx.audioWorklet) {
      ctx.close();
      throw new Error('AudioWorklet is unavailable. Open the page over https:// or http://localhost.');
    }
    await loadWorklet(ctx);
    const node = new AudioWorkletNode(ctx, 'patch-arcade', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'telemetry') this.onTelemetry(d.t);
      else if (d.type === 'error') this.onError(`Audio engine: ${d.message}`);
    };
    node.onprocessorerror = () => {
      this.onError('The audio engine stopped unexpectedly. Press the power button to restart it.');
      this.teardown();
    };
    for (let h = 0; h < 3; h++) {
      const g = ctx.createGain();
      g.connect(node, 0, h);
      this.inBus[h] = g;
    }
    node.connect(ctx.destination);
    ctx.onstatechange = () => this.onState(ctx.state);
    this.ctx = ctx;
    this.node = node;
    await ctx.resume();
    this.onState(ctx.state);
  }

  async suspend() {
    if (this.ctx) await this.ctx.suspend();
  }

  teardown() {
    for (let h = 0; h < 3; h++) this.stopExternal(h);
    try {
      if (this.node) this.node.disconnect();
      if (this.ctx) this.ctx.close();
    } catch {
      /* ignore */
    }
    this.node = null;
    this.ctx = null;
    this.onState('closed');
  }

  send(msg) {
    if (this.node) this.node.port.postMessage(msg);
  }

  // Disconnect an external source. `delayMs` lets the engine's 15 ms source
  // fade finish first, so switching away from a mic or file never clicks.
  stopExternal(h, delayMs = 0) {
    const x = this.ext[h];
    if (!x) return;
    this.ext[h] = null;
    const kill = () => {
      try {
        if (x.node) x.node.disconnect();
        if (x.buffer) x.node.stop();
        if (x.stream) x.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
    };
    if (delayMs > 0) setTimeout(kill, delayMs);
    else kill();
  }

  // kind: 'impulse' | demo name | 'off' | 'mic' | 'file' (with `file`). A newer call for
  // the same input supersedes an older one still waiting on a permission
  // prompt or a file decode.
  async setSource(h, kind, file) {
    if (!this.ctx) return;
    const token = ++this.tokens[h];
    const stale = () => token !== this.tokens[h] || !this.ctx;
    if (kind === 'mic' || kind === 'file') {
      let x;
      if (kind === 'mic') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Microphone input is not available in this browser.');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (stale()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        x = { node: this.ctx.createMediaStreamSource(stream), stream };
      } else {
        if (!file) throw new Error('No file chosen.');
        const buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
        if (stale()) return;
        const node = this.ctx.createBufferSource();
        node.buffer = buffer;
        node.loop = true;
        node.start();
        x = { node, buffer };
      }
      // swap: the engine crossfades its input while the old source drains
      this.stopExternal(h, 60);
      x.node.connect(this.inBus[h]);
      this.ext[h] = x;
      this.send({ type: 'source', host: h, name: 'input' });
      return;
    }
    this.send({ type: 'source', host: h, name: kind });
    this.stopExternal(h, 60);
  }
}
