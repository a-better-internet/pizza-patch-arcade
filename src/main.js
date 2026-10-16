// Patch Arcade — application controller.

import { MODULES, MODULE_BY_ID, LFO_SYNC_DIVS, DRIFT_SYNC_DIVS, stepIndex, expMap, PGATE_RATES, NOTE_DIVS } from './spec.js';
import { PatchModel, ORIGIN_HAND } from './patch.js';
import { Rng } from './dsp/util.js';
import { PATTERNS } from './dsp/modules/pgate.js';
import { PRESETS, CATEGORIES, applyPreset } from './presets.js';
import { buildRack } from './ui/rack.js';
import { CableLayer } from './ui/cables.js';
import { RACK_W } from './ui/layouts.js';
import { AudioHost, HOST_SOURCES } from './audio/host.js';

const STORE_KEY = 'patch-arcade:v1';
const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------- persistence
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveStore(data) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* private mode or quota: run without persistence */
  }
}

const settings = {
  bpm: 120,
  volume: 0.8,
  shrill: 0.6,
  sources: ['keys', 'off', 'off'],
  trims: [0, 0, 0],
  zoom: 'fit',
  presetIndex: 0,
};

const model = new PatchModel();
const stored = loadStore();
let restored = false;
if (stored && stored.patch) {
  try {
    model.load(stored.patch);
    const st = stored.settings || {};
    const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const ids = HOST_SOURCES.map((x) => x.id);
    settings.bpm = num(st.bpm, 40, 240, 120);
    settings.volume = num(st.volume, 0, 1, 0.8);
    settings.shrill = num(st.shrill, 0, 1, 0.6);
    settings.trims = [0, 1, 2].map((i) => num(st.trims && st.trims[i], -24, 12, 0));
    settings.zoom = st.zoom === 'fit' ? 'fit' : num(st.zoom, 0.4, 1.6, 'fit');
    settings.presetIndex = Math.round(num(st.presetIndex, 0, PRESETS.length - 1, 0));
    // external sources need a fresh user gesture; fall back to a demo
    settings.sources = [0, 1, 2].map((i) => {
      const s = st.sources && st.sources[i];
      if (!ids.includes(s) || s === 'mic' || s === 'file') return i === 0 ? 'keys' : 'off';
      return s;
    });
    restored = true;
  } catch {
    restored = false;
  }
}
if (!restored) {
  applyPreset(model, PRESETS[0]);
  // phones: open at a playable size and scroll sideways rather than fitting a tiny rack
  if (document.documentElement.clientWidth < 760) settings.zoom = 0.55;
}

// ------------------------------------------------------------------ toasts
const toastBox = $('#toasts');
function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toastBox.appendChild(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 2800);
  setTimeout(() => t.remove(), kind === 'error' ? 6600 : 3400);
}

// ------------------------------------------------------------------- audio
const audio = new AudioHost({
  onTelemetry: (t) => {
    lastTelemetry = t;
  },
  onError: (m) => toast(m, 'error'),
  onState: (s) => updatePower(s),
});
let lastTelemetry = null;

function syncEngine() {
  if (!audio.node) return;
  audio.send({ type: 'patch', cables: model.cables });
  audio.send({ type: 'params', values: model.params });
  for (const m in model.buttons) for (const b in model.buttons[m]) audio.send({ type: 'button', m, b, v: model.buttons[m][b] });
  audio.send({ type: 'global', key: 'mix', value: model.globals.mix });
  audio.send({ type: 'global', key: 'bpm', value: settings.bpm });
  audio.send({ type: 'global', key: 'volume', value: settings.volume });
  audio.send({ type: 'global', key: 'shrill', value: settings.shrill });
  audio.send({ type: 'global', key: 'bypass', value: bypassed });
  settings.trims.forEach((db, h) => audio.send({ type: 'source', host: h, trimDb: db }));
}

async function applySource(h, kind, file) {
  settings.sources[h] = kind;
  persist();
  if (!audio.node) return;
  try {
    await audio.setSource(h, kind, file);
  } catch (e) {
    toast(e && e.message ? e.message : String(e), 'error');
    settings.sources[h] = 'off';
    hostSelects[h].value = 'off';
    await audio.setSource(h, 'off');
  }
}

let starting = false;
async function power() {
  if (starting) return;
  if (audio.running) {
    await audio.suspend();
    return;
  }
  starting = true;
  try {
    const fresh = !audio.node;
    await audio.start();
    if (fresh) {
      syncEngine();
      for (let h = 0; h < 3; h++) {
        const s = settings.sources[h];
        if (s !== 'mic' && s !== 'file') await audio.setSource(h, s);
        else hostSelects[h].value = 'off';
      }
      $('#sr').textContent = `${(audio.ctx.sampleRate / 1000).toFixed(1)} kHz`;
    }
  } catch (e) {
    toast(e && e.message ? e.message : String(e), 'error');
  } finally {
    starting = false;
  }
}

function updatePower(state) {
  const on = state === 'running';
  const btn = $('#power');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  $('#power-label').textContent = on ? 'Audio on' : state === 'suspended' ? 'Resume audio' : 'Start audio';
  document.body.classList.toggle('audio-on', on);
}

// ---------------------------------------------------------------- the rack
let bypassed = false;
const rackEl = $('#rack');
let ui = null;
let cables = null;

const handlers = {
  onParam: (m, p, v) => model.setParam(m, p, v),
  onButton: (m, b, v) => model.setButton(m, b, v),
  onMomentary: (m, b, v) => audio.send({ type: 'button', m, b, v }),
  onGlobal: (k, v) => model.setGlobal(k, v),
  onBypass: () => {
    bypassed = !bypassed;
    ui.bypass.classList.toggle('bypassed', bypassed);
    ui.bypass.setAttribute('aria-pressed', String(bypassed));
    ui.bypass.querySelector('.b-txt').textContent = bypassed ? 'Bypass' : 'On';
    audio.send({ type: 'global', key: 'bypass', value: bypassed });
  },
  onRoll: (h, die) => {
    const used = model.rollRoute(h, new Rng((Math.random() * 2 ** 31) | 0));
    die.classList.remove('rolling');
    void die.offsetWidth;
    die.classList.add('rolling');
    if (!used) toast(`Route ${h}: every effect is busy — clear a route or unpatch something first.`, 'warn');
    else {
      model.name = `Roll ${h}: ${used.map((id) => MODULE_BY_ID[id].name).join(' › ')}`;
      for (const c of model.cables) if (c.origin === 'dice' && c.route === h && c.loop) cables.sparks(c);
      if (settings.sources[h - 1] === 'off') {
        const pick = ['keys', 'beat', 'pad'][h - 1];
        hostSelects[h - 1].value = pick;
        applySource(h - 1, pick);
      }
      refreshLcd();
    }
  },
  onClearRoute: (h) => {
    const n = model.clearRoute(h);
    if (n) toast(`Route ${h} cleared.`);
  },
  onSolo: (m) => {
    const s = cables.setSolo(m);
    for (const spec of MODULES) {
      const b = ui.extras[`${spec.id}.solo`];
      if (b) b.classList.toggle('on', s === spec.id);
    }
  },
  onPreset: (dir) => {
    settings.presetIndex = (settings.presetIndex + dir + PRESETS.length) % PRESETS.length;
    loadPreset(PRESETS[settings.presetIndex]);
  },
  onPresetMenu: (anchor) => openPresetMenu(anchor),
  onLoadFile: () => $('#patch-file').click(),
  onSaveFile: async () => {
    const json = JSON.stringify(model.toJSON(), null, 2);
    const filename = `${(model.name || 'patch').replace(/[^\w\- ]+/g, '').trim() || 'patch'}.patcharcade.json`;
    // inside a claude.ai artifact, downloads go through the viewer's save prompt
    const dl = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try {
        await dl.save({ filename, data: json });
        toast('Patch saved.');
      } catch (e) {
        if (!e || e.code !== 'declined') toast('Saving files is not available here.', 'warn');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  },
};

function loadPreset(p) {
  applyPreset(model, p);
  setTempo(p.bpm || 120);
  p.sources.forEach((s, h) => {
    hostSelects[h].value = s;
    applySource(h, s);
  });
  toast(`Loaded “${p.name}” · ${p.bpm || 120} BPM`);
}

function refreshLcd() {
  ui.lcd.textContent = model.name || 'Untitled';
  const preset = PRESETS.find((p) => p.name === model.name);
  ui.lcd.title = preset ? `${preset.name}: ${preset.desc} (click for all patches)` : `${model.name || ''} (click for factory patches)`;
}

function setTempo(v) {
  const n = Math.max(40, Math.min(240, Math.round(+v || 120)));
  settings.bpm = n;
  $('#bpm').value = String(n);
  audio.send({ type: 'global', key: 'bpm', value: n });
  persist();
}

// ----------------------------------------------------------- preset browser
// A fixed overlay (not inside the scaled rack) so it reads at full size and
// sits above the cable layer.
let presetMenu = null;
function closePresetMenu(focusLcd) {
  if (!presetMenu) return;
  presetMenu.remove();
  presetMenu = null;
  ui.lcd.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', menuOutside, true);
  window.removeEventListener('resize', menuDismiss);
  window.removeEventListener('scroll', menuDismiss, true);
  if (focusLcd) ui.lcd.focus();
}
function menuOutside(e) {
  if (presetMenu && !presetMenu.contains(e.target) && e.target !== ui.lcd) closePresetMenu(false);
}
function menuDismiss(e) {
  if (e && e.type === 'scroll' && presetMenu && presetMenu.contains(e.target)) return;
  closePresetMenu(false);
}
function openPresetMenu(anchor) {
  if (presetMenu) {
    closePresetMenu(true);
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'preset-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Factory patches');
  const items = [];
  for (const cat of CATEGORIES) {
    const list = PRESETS.filter((p) => p.category === cat);
    if (!list.length) continue;
    const sec = document.createElement('section');
    sec.innerHTML = `<h3>${cat}</h3>`;
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pm-item';
      b.setAttribute('role', 'menuitem');
      if (p.name === model.name) b.setAttribute('aria-current', 'true');
      const name = document.createElement('b');
      name.textContent = p.name;
      const bpm = document.createElement('i');
      bpm.textContent = `${p.bpm} bpm`;
      const d = document.createElement('span');
      d.textContent = p.desc;
      b.append(name, bpm, d);
      b.addEventListener('click', () => {
        settings.presetIndex = PRESETS.indexOf(p);
        closePresetMenu(true);
        loadPreset(p);
      });
      sec.appendChild(b);
      items.push(b);
    }
    menu.appendChild(sec);
  }
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closePresetMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    }
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.maxHeight = `${Math.max(220, window.innerHeight - r.bottom - 20)}px`;
  presetMenu = menu;
  anchor.setAttribute('aria-expanded', 'true');
  (items.find((b) => b.getAttribute('aria-current')) || items[0]).focus();
  document.addEventListener('pointerdown', menuOutside, true);
  window.addEventListener('resize', menuDismiss);
  window.addEventListener('scroll', menuDismiss, true);
}

function refreshControls() {
  for (const spec of MODULES) {
    for (const p of spec.params) {
      const k = ui.knobs[spec.id][p.id];
      if (k) k.set(model.params[spec.id][p.id]);
      const f = ui.faders[`${spec.id}.${p.id}`];
      if (f) f.set(model.params[spec.id][p.id]);
    }
    for (const b in ui.buttons[spec.id]) {
      const on = !!model.buttons[spec.id][b];
      ui.buttons[spec.id][b].classList.toggle('on', on);
      ui.buttons[spec.id][b].setAttribute('aria-pressed', String(on));
    }
  }
  for (const k in ui.globals) ui.globals[k].set(model.globals[k]);
  cables.setOpacity(cableOpacity(model.globals.cables));
  ui.globals.cables.el.style.opacity = String(0.35 + 0.65 * model.globals.cables);
  refreshLcd();
}

const cableOpacity = (v) => v;

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveStore({ patch: model.toJSON(), settings });
}
// never lose the last tweak to the debounce when the tab closes or reloads
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => document.hidden && flushSave());

model.on((type, d) => {
  switch (type) {
    case 'cables':
      audio.send({ type: 'patch', cables: model.cables });
      cables.sync();
      if (d && d.added) for (const c of d.added) if (c.loop) cables.sparks(c);
      break;
    case 'param':
      audio.send({ type: 'param', m: d.m, p: d.p, v: d.v });
      break;
    case 'params':
      // dice rolls change knobs and toggles (Sync, Tune, Freeze) together
      audio.send({ type: 'params', values: model.params });
      for (const m in model.buttons) for (const b in model.buttons[m]) audio.send({ type: 'button', m, b, v: model.buttons[m][b] });
      refreshControls();
      break;
    case 'button':
      audio.send({ type: 'button', m: d.m, b: d.b, v: d.v });
      if (ui.buttons[d.m] && ui.buttons[d.m][d.b]) {
        ui.buttons[d.m][d.b].classList.toggle('on', d.v);
        ui.buttons[d.m][d.b].setAttribute('aria-pressed', String(d.v));
      }
      break;
    case 'global':
      if (d.key === 'mix') audio.send({ type: 'global', key: 'mix', value: d.v });
      if (d.key === 'cables') {
        cables.setOpacity(cableOpacity(d.v));
        ui.globals.cables.el.style.opacity = String(0.35 + 0.65 * d.v);
      }
      break;
    case 'load':
      if (!ui) return;
      syncEngine();
      refreshControls();
      cables.sync();
      break;
    default:
      break;
  }
  persist();
});

// ---------------------------------------------------------------- host bar
const hostSelects = [];
const hostMeters = [];
function buildHostBar() {
  const box = $('#host-inputs');
  for (let h = 0; h < 3; h++) {
    const wrap = document.createElement('div');
    wrap.className = `hin hin${h + 1}`;
    wrap.innerHTML = `<label class="hin-label" for="src${h}">In ${h + 1}</label>`;
    const sel = document.createElement('select');
    sel.id = `src${h}`;
    for (const s of HOST_SOURCES) {
      // published artifacts cannot open the microphone
      if (s.id === 'mic' && globalThis.__PA_ARTIFACT__) continue;
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      sel.appendChild(o);
    }
    sel.value = settings.sources[h] === 'mic' || settings.sources[h] === 'file' ? 'off' : settings.sources[h];
    sel.addEventListener('change', () => {
      if (sel.value === 'file') {
        pendingFileHost = h;
        $('#audio-file').click();
        return;
      }
      if (sel.value === 'mic') toast('Use headphones with a microphone to avoid acoustic feedback.', 'warn');
      applySource(h, sel.value);
    });
    wrap.appendChild(sel);
    const trim = document.createElement('input');
    trim.type = 'range';
    trim.min = '-24';
    trim.max = '12';
    trim.step = '0.5';
    trim.value = String(settings.trims[h]);
    trim.className = 'trim';
    trim.title = 'Input trim';
    trim.setAttribute('aria-label', `Input ${h + 1} trim (dB)`);
    trim.addEventListener('input', () => {
      settings.trims[h] = +trim.value;
      audio.send({ type: 'source', host: h, trimDb: +trim.value });
      trim.title = `Input trim ${(+trim.value).toFixed(1)} dB`;
      persist();
    });
    trim.addEventListener('dblclick', () => {
      trim.value = '0';
      trim.dispatchEvent(new Event('input'));
    });
    wrap.appendChild(trim);
    const m = document.createElement('div');
    m.className = 'hmeter';
    m.innerHTML = '<i></i>';
    wrap.appendChild(m);
    box.appendChild(wrap);
    hostSelects.push(sel);
    hostMeters.push(m.firstChild);
  }
}
let pendingFileHost = -1;

function bindHostBar() {
  $('#power').addEventListener('click', power);
  const bpm = $('#bpm');
  bpm.value = String(settings.bpm);
  const setBpm = setTempo;
  bpm.addEventListener('change', () => setBpm(bpm.value));
  $('#bpm-down').addEventListener('click', () => setBpm(settings.bpm - 1));
  $('#bpm-up').addEventListener('click', () => setBpm(settings.bpm + 1));
  let taps = [];
  $('#tap').addEventListener('click', () => {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 2500);
    taps.push(now);
    if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / iv);
    }
  });
  const vol = $('#volume');
  vol.value = String(settings.volume);
  vol.addEventListener('input', () => {
    settings.volume = +vol.value;
    audio.send({ type: 'global', key: 'volume', value: settings.volume });
    persist();
  });
  const sh = $('#shrill');
  sh.value = String(settings.shrill);
  sh.addEventListener('input', () => {
    settings.shrill = +sh.value;
    audio.send({ type: 'global', key: 'shrill', value: settings.shrill });
    persist();
  });
  $('#panic').addEventListener('click', () => {
    audio.send({ type: 'panic' });
    toast('All module buffers cleared.');
  });
  const cut = $('#cut');
  cut.addEventListener('click', () => {
    const on = !document.body.classList.contains('cut-mode');
    document.body.classList.toggle('cut-mode', on);
    document.body.classList.toggle('delete-mode', on);
    cut.classList.toggle('on', on);
    cut.setAttribute('aria-pressed', String(on));
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && document.body.classList.contains('cut-mode')) document.body.classList.add('delete-mode');
  });
  $('#zoom-out').addEventListener('click', () => setZoom(currentScale() - 0.1));
  $('#zoom-in').addEventListener('click', () => setZoom(currentScale() + 0.1));
  $('#zoom-fit').addEventListener('click', () => setZoom('fit'));
  $('#help').addEventListener('click', () => $('#help-dialog').showModal());
  $('#help-close').addEventListener('click', () => $('#help-dialog').close());
  $('#patch-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      model.load(JSON.parse(await f.text()));
      toast(`Loaded “${model.name}”`);
    } catch (err) {
      toast(`Could not load patch: ${err.message}`, 'error');
    }
  });
  // closing the file picker without choosing fires `cancel`, not `change`
  $('#audio-file').addEventListener('cancel', () => {
    const h = pendingFileHost;
    pendingFileHost = -1;
    if (h >= 0) hostSelects[h].value = settings.sources[h];
  });
  $('#audio-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    const h = pendingFileHost;
    pendingFileHost = -1;
    if (h < 0) return;
    if (!f) {
      hostSelects[h].value = settings.sources[h];
      return;
    }
    if (!audio.node) {
      toast('Start audio first, then choose the file again.', 'warn');
      hostSelects[h].value = 'off';
      return;
    }
    applySource(h, 'file', f).then(() => toast(`In ${h + 1}: looping ${f.name}`));
  });
}

// --------------------------------------------------------------- zoom/fit
let scale = 1;
function currentScale() {
  return scale;
}
function setZoom(z) {
  settings.zoom = z;
  const main = $('main');
  const cs = window.getComputedStyle(main);
  const avail = Math.max(300, main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  scale = z === 'fit' ? Math.min(1.25, avail / RACK_W) : Math.max(0.4, Math.min(1.6, z));
  const wrap = $('#rack-wrap');
  rackEl.style.transform = `scale(${scale})`;
  wrap.style.width = `${RACK_W * scale}px`;
  wrap.style.height = `${rackEl.offsetHeight * scale}px`;
  $('#zoom-fit').textContent = `${Math.round(scale * 100)}%`;
  persist();
  if (cables) cables.setScale(scale);
}

// --------------------------------------------------------------- telemetry
const dbfs = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const orbitTrail = [];
const driftTrail = [];
let lastFaults = 0;

function renderTelemetry() {
  requestAnimationFrame(renderTelemetry);
  const t = lastTelemetry;
  if (!t || !ui) return;
  lastTelemetry = null;
  const active = new Set(t.active);
  for (const spec of MODULES) {
    const vals = t.values[spec.id];
    spec.params.forEach((p, i) => {
      const k = ui.knobs[spec.id][p.id];
      if (k) k.setDisplay(active.has(spec.id) && vals ? vals[i] : k.value);
    });
    const loop = t.loops[spec.id] || 0;
    const panel = ui.panels[spec.id];
    panel.style.setProperty('--loop', loop.toFixed(3));
    panel.classList.toggle('looping', loop > 0.01);
    panel.classList.toggle('idle', !active.has(spec.id));
  }
  // mixer meters
  for (let i = 0; i < 4; i++) {
    const m = ui.meters[`mixer.${i}`];
    if (m) m.set(t.mixer[i]);
  }
  // tamer
  const gr = ui.extras['tamer.gr'];
  if (gr) {
    const g = Math.min(1, t.tamer.grDb / 24);
    gr.firstChild.style.transform = `scaleX(${g.toFixed(3)})`;
    gr.lastChild.textContent = t.tamer.grDb > 0.5 ? `-${t.tamer.grDb.toFixed(1)} dB` : 'GR';
    ui.extras['tamer.howl'].style.setProperty('--howl', t.tamer.howl.toFixed(3));
  }
  // probability gate pattern display
  const steps = ui.extras['pgate.steps'];
  if (steps) {
    const pv = model.params.pgate;
    const pat = PATTERNS[stepIndex(pv.patt, PATTERNS.length)];
    const beats = NOTE_DIVS[PGATE_RATES[stepIndex(pv.rate, PGATE_RATES.length)]];
    const cur = Math.floor(t.beat / beats) % 16;
    const kids = steps.children;
    for (let i = 0; i < 16; i++) {
      kids[i].classList.toggle('hit', !!pat[i]);
      kids[i].classList.toggle('now', i === cur && active.has('pgate'));
    }
    steps.classList.toggle('firing', !!t.leds.pgate);
  }
  const gl = ui.panels.glitch;
  gl.classList.toggle('glitching', !!t.leds.glitch);
  // orbit LFO
  const o = t.leds.orbit;
  if (o) {
    const [x, y, hz] = o;
    orbitTrail.push([x, -y]);
    if (orbitTrail.length > 40) orbitTrail.shift();
    ui.extras['orbit.dot'].setAttribute('cx', x.toFixed(3));
    ui.extras['orbit.dot'].setAttribute('cy', (-y).toFixed(3));
    ui.extras['orbit.trail'].setAttribute('points', orbitTrail.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' '));
    const sync = model.buttons.orbit.sync;
    ui.extras['orbit.display'].textContent = sync ? LFO_SYNC_DIVS[stepIndex(model.params.orbit.rate, LFO_SYNC_DIVS.length)] : `${hz < 10 ? hz.toFixed(2) : hz.toFixed(1)} Hz`;
  }
  const d = t.leds.drift;
  if (d) {
    const [v, period] = d;
    driftTrail.push(v);
    if (driftTrail.length > 60) driftTrail.shift();
    const w = 84, h = 24;
    ui.extras['drift.trace'].setAttribute('points', driftTrail.map((val, i) => `${((i / 59) * w).toFixed(1)},${(h / 2 - val * (h / 2 - 2)).toFixed(1)}`).join(' '));
    const sync = model.buttons.drift.sync;
    ui.extras['drift.display'].textContent = sync ? DRIFT_SYNC_DIVS[stepIndex(model.params.drift.rate, DRIFT_SYNC_DIVS.length)] : `${Math.round(period * 1000)} ms`;
  }
  // host bar
  t.hosts.forEach((pk, h) => {
    const db = dbfs(pk);
    hostMeters[h].style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60)).toFixed(3)})`;
    hostMeters[h].className = db > -10 ? 'red' : db > -25 ? 'amber' : '';
  });
  const pk = Math.max(t.master.peakL, t.master.peakR);
  const odb = dbfs(pk);
  $('#out-fill').style.transform = `scaleX(${Math.max(0, Math.min(1, (odb + 60) / 60)).toFixed(3)})`;
  $('#out-db').textContent = pk > 1e-5 ? `${odb.toFixed(1)}` : '-∞';
  $('#ind-limit').classList.toggle('on', t.master.limGrDb > 0.3);
  $('#ind-guard').classList.toggle('on', t.master.hiGrDb > 1);
  $('#ind-level').classList.toggle('on', t.master.levGrDb > 0.5);
  if (t.faults > lastFaults) {
    toast('A module produced invalid audio and was reset automatically.', 'warn');
    lastFaults = t.faults;
  }
}

// --------------------------------------------------------------- startup
function init() {
  buildHostBar();
  ui = buildRack(rackEl, model, handlers);
  cables = new CableLayer(model, ui, {
    onConnect: (a, b) => {
      model.connect(a, b, { origin: ORIGIN_HAND });
      model.name = model.name.startsWith('*') ? model.name : `*${model.name}`;
      refreshLcd();
    },
    onDelete: (id) => model.removeCable(id),
    onReject: (why, target) => {
      target.classList.add('nope');
      setTimeout(() => target.classList.remove('nope'), 400);
      toast(`Can't patch ${why}.`, 'warn');
    },
  });
  bindHostBar();
  refreshControls();
  cables.sync();
  setZoom(settings.zoom);
  window.addEventListener('resize', () => settings.zoom === 'fit' && setZoom('fit'));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => cables.schedule());
  new ResizeObserver(() => cables.schedule()).observe(rackEl);
  requestAnimationFrame(renderTelemetry);
  // resume audio if the browser suspended it (tab switch, iOS interruption)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audio.ctx && audio.ctx.state !== 'running' && document.body.classList.contains('audio-on')) audio.ctx.resume();
  });
  document.body.classList.add('ready');
}

init();

// expose for debugging and automated tests
window.patchArcade = { model, audio, settings, get ui() { return ui; }, expMap };
