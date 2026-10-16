// Builds the rack DOM from the module spec and panel layouts.

import { MODULES, GLOBAL_PARAMS, HOST_ID, jacksFor, faderGain } from '../spec.js';
import { layoutFor, ROWS, RACK_W } from './layouts.js';
import { Knob, Fader, Meter, svg, tooltip } from './controls.js';

const el = (tag, cls, parent, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
};

const place = (node, x, y) => {
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  return node;
};

export function jackClass(j) {
  if (j.toHost) return 'jack audio tohost';
  if (j.type === 'audio') return 'jack audio';
  return j.dir === 'out' ? 'jack cvout' : 'jack cvin';
}

function makeJack(moduleId, j, parent, x, y) {
  const d = el('button', jackClass(j), parent);
  d.type = 'button';
  d.dataset.m = moduleId;
  d.dataset.j = j.id;
  d.setAttribute('aria-label', `${moduleId === HOST_ID ? '' : moduleId + ' '}${j.label}`);
  d.addEventListener('pointerenter', () => tooltip(j.label, d));
  d.addEventListener('pointerleave', () => tooltip(null));
  if (x !== undefined) place(d, x, y);
  return d;
}

export function buildRack(root, model, handlers) {
  const ui = { knobs: {}, jacks: new Map(), buttons: {}, panels: {}, faders: {}, meters: {}, extras: {}, globals: {} };
  root.innerHTML = '';
  root.style.width = `${RACK_W}px`;

  // ------------------------------------------------------------ top strip
  const strip = el('div', 'strip', root);
  const left = el('div', 'strip-left', strip);
  const bypass = el('button', 'bypass', left);
  bypass.type = 'button';
  bypass.innerHTML = '<span class="b-led"></span><span class="b-txt">On</span>';
  bypass.setAttribute('aria-pressed', 'false');
  bypass.title = 'Bypass the whole rack';
  bypass.addEventListener('click', () => handlers.onBypass());
  ui.bypass = bypass;

  const lcdWrap = el('div', 'patch-lcd', left);
  const prev = el('button', 'lcd-btn', lcdWrap, '◀');
  prev.type = 'button';
  prev.title = 'Previous factory patch';
  const lcd = el('button', 'lcd', lcdWrap);
  lcd.type = 'button';
  lcd.setAttribute('aria-haspopup', 'menu');
  lcd.setAttribute('aria-expanded', 'false');
  lcd.setAttribute('aria-label', 'Factory patches');
  lcd.addEventListener('click', () => handlers.onPresetMenu(lcd));
  const next = el('button', 'lcd-btn', lcdWrap, '▶');
  next.type = 'button';
  next.title = 'Next factory patch';
  prev.addEventListener('click', () => handlers.onPreset(-1));
  next.addEventListener('click', () => handlers.onPreset(1));
  ui.lcd = lcd;
  const files = el('div', 'lcd-files', left);
  const open = el('button', 'icon-btn', files);
  open.type = 'button';
  open.title = 'Load patch file (.json)';
  open.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v9H2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  open.addEventListener('click', () => handlers.onLoadFile());
  const save = el('button', 'icon-btn', files);
  save.type = 'button';
  save.title = 'Save patch file (.json)';
  save.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h11l3 3v11H3z M6 3v5h7V3 M6 17v-5h8v5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  save.addEventListener('click', () => handlers.onSaveFile());

  el('div', 'logo', strip, 'Patch Arcade');

  const io = el('div', 'strip-io', strip);
  const hostSpec = { id: HOST_ID, kind: 'host', params: [], buttons: [], cvOuts: [] };
  const hostJacks = Object.fromEntries(jacksFor(hostSpec).map((j) => [j.id, j]));
  const fh = el('div', 'from-host', io);
  el('div', 'io-title', fh, 'From Host');
  const fhRow = el('div', 'fh-row', fh);
  ui.dice = [];
  for (let h = 1; h <= 3; h++) {
    const blk = el('div', `fh fh${h}`, fhRow);
    const jr = el('div', 'fh-jacks', blk);
    for (const s of ['L', 'R']) {
      const j = makeJack(HOST_ID, hostJacks[`from${h}${s}`], jr);
      ui.jacks.set(`${HOST_ID}.from${h}${s}`, j);
    }
    const dr = el('div', 'fh-dice', blk);
    const die = el('button', `die die${h}`, dr);
    die.type = 'button';
    die.title = `Roll a random chain for route ${h}`;
    die.setAttribute('aria-label', `Roll dice for From Host ${h}`);
    die.innerHTML = dieFace(h);
    die.addEventListener('click', () => handlers.onRoll(h, die));
    const x = el('button', 'clear-x', dr, '✕');
    x.type = 'button';
    x.title = `Clear route ${h}`;
    x.setAttribute('aria-label', `Clear route ${h}`);
    x.addEventListener('click', () => handlers.onClearRoute(h));
    el('span', 'fh-num', blk, String(h));
    ui.dice.push(die);
  }
  const th = el('div', 'to-host', io);
  el('div', 'io-title', th, 'To Host');
  const thr = el('div', 'fh-jacks', th);
  for (const s of ['L', 'R']) ui.jacks.set(`${HOST_ID}.to${s}`, makeJack(HOST_ID, hostJacks[`to${s}`], thr));

  const gk = el('div', 'strip-knobs', strip);
  for (const g of GLOBAL_PARAMS) {
    const cell = el('div', `gknob g-${g.theme}`, gk);
    const k = new Knob({
      label: g.label, title: g.id === 'fdbkChance' ? 'Feedback chance' : g.id === 'cables' ? 'Cable visibility' : 'Global wet/dry',
      def: g.def, value: model.globals[g.id], size: 26, style: `cap-${g.theme}`, fmt: g.fmt,
      onChange: (v) => handlers.onGlobal(g.id, v),
    });
    cell.appendChild(k.el);
    el('span', 'g-label', cell, g.label);
    ui.globals[g.id] = k;
  }

  // ---------------------------------------------------------------- rows
  for (const row of ROWS) {
    const r = el('div', 'row', root);
    for (const id of row.mods) {
      const spec = MODULES.find((m) => m.id === id);
      r.appendChild(buildPanel(spec, model, handlers, ui));
    }
  }
  return ui;
}

function dieFace(n) {
  const pips = { 1: [[10, 10]], 2: [[6, 6], [14, 14]], 3: [[5, 5], [10, 10], [15, 15]] }[n];
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.5" y="1.5" width="17" height="17" rx="4"/>${pips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.9"/>`).join('')}</svg>`;
}

function buildPanel(spec, model, handlers, ui) {
  const lay = layoutFor(spec);
  const p = el('section', `module theme-${spec.theme} kind-${spec.kind}${spec.modStyle ? ' modstyle' : ''}`);
  p.style.width = `${lay.w}px`;
  p.style.height = `${lay.h}px`;
  p.dataset.m = spec.id;
  p.setAttribute('aria-label', spec.name);
  ui.panels[spec.id] = p;
  el('div', 'm-deco', p);
  const title = el('h2', 'm-title', p, spec.name);
  title.title = spec.blurb;
  ui.knobs[spec.id] = {};

  const jackSpecs = Object.fromEntries(jacksFor(spec).map((j) => [j.id, j]));
  for (const k of lay.knobs) {
    const ps = spec.params.find((x) => x.id === k.param);
    const style = ps.size === 'mix' ? 'silver' : k.size >= 44 ? 'dark big' : 'dark';
    const knob = new Knob({
      label: ps.label, title: `${spec.name} ${ps.label}`, def: ps.def, value: model.params[spec.id][ps.id],
      bipolar: ps.bipolar, steps: ps.steps, size: k.size, style: style.split(' ')[0], fmt: ps.fmt,
      onChange: (v) => handlers.onParam(spec.id, ps.id, v),
    });
    place(knob.el, k.x, k.y);
    knob.el.classList.add('ctl');
    p.appendChild(knob.el);
    const lbl = el('span', 'k-label', p, ps.label);
    place(lbl, k.x, k.y - k.size / 2 - 10);
    ui.knobs[spec.id][ps.id] = knob;
  }
  for (const [jid, x, y] of lay.jacks) {
    const js = jackSpecs[jid];
    if (!js) continue;
    ui.jacks.set(`${spec.id}.${jid}`, makeJack(spec.id, js, p, x, y));
  }
  ui.buttons[spec.id] = {};
  for (const b of lay.buttons || []) {
    const bs = spec.buttons.find((x) => x.id === b.id);
    const btn = el('button', `m-btn${bs.toggle ? ' toggle' : ' momentary'}`, p);
    btn.type = 'button';
    btn.setAttribute('aria-label', `${spec.name} ${bs.label}`);
    if (bs.toggle) btn.setAttribute('aria-pressed', String(!!model.buttons[spec.id][b.id]));
    btn.classList.toggle('on', !!(bs.toggle && model.buttons[spec.id][b.id]));
    place(btn, b.x, b.y);
    const bl = el('span', 'b-label', p, bs.label);
    place(bl, b.x, b.y + 15);
    btn.addEventListener('pointerenter', () => tooltip(bs.label, btn));
    btn.addEventListener('pointerleave', () => tooltip(null));
    if (bs.toggle) btn.addEventListener('click', () => handlers.onButton(spec.id, b.id, !model.buttons[spec.id][b.id]));
    else {
      btn.addEventListener('pointerdown', () => {
        btn.classList.add('on');
        handlers.onMomentary(spec.id, b.id, true);
      });
      const up = () => {
        btn.classList.remove('on');
        handlers.onMomentary(spec.id, b.id, false);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', () => btn.classList.contains('on') && up());
    }
    ui.buttons[spec.id][b.id] = btn;
  }
  for (const l of lay.labels || []) place(el('span', `p-label ${l.cls || ''}`, p, l.text), l.x, l.y);
  if (lay.solo) {
    const s = el('button', 'solo', p);
    s.type = 'button';
    s.title = 'Solo: show only this module\'s cables';
    s.setAttribute('aria-label', `Solo ${spec.name} cables`);
    place(s, lay.solo.x, lay.solo.y);
    s.addEventListener('click', () => handlers.onSolo(spec.id));
    ui.extras[`${spec.id}.solo`] = s;
  }
  if (lay.display) {
    const d = el('div', 'm-lcd', p, '—');
    d.style.width = `${lay.display.w}px`;
    place(d, lay.display.x, lay.display.y);
    ui.extras[`${spec.id}.display`] = d;
  }
  if (lay.divider) {
    const d = el('div', 'divider', p);
    d.style.top = `${lay.divider}px`;
  }
  if (lay.tag) {
    const t = el('div', 'side-tag', p, lay.tag);
    t.setAttribute('aria-hidden', 'true');
  }
  if (lay.faders) {
    for (const f of lay.faders) {
      const ps = spec.params.find((x) => x.id === f.param);
      const fd = new Fader({
        label: `${ps.label} level`, def: ps.def, value: model.params[spec.id][ps.id], h: f.h, fmt: ps.fmt,
        onChange: (v) => handlers.onParam(spec.id, ps.id, v),
      });
      place(fd.el, f.x - 6, f.y);
      fd.el.classList.add('ctl');
      p.appendChild(fd.el);
      ui.faders[`${spec.id}.${ps.id}`] = fd;
      const m = new Meter(f.h, 12);
      place(m.el, f.x + 12, f.y);
      m.el.classList.add('ctl');
      p.appendChild(m.el);
      ui.meters[`mixer.${f.meter}`] = m;
    }
  }
  if (lay.outMeter) {
    const m = new Meter(lay.outMeter.h, 12);
    place(m.el, lay.outMeter.x, lay.outMeter.y + lay.outMeter.h / 2);
    m.el.classList.add('ctl');
    p.appendChild(m.el);
    ui.meters['mixer.3'] = m;
  }
  if (lay.steps) {
    const st = el('div', 'steps', p);
    st.style.width = `${lay.steps.w}px`;
    place(st, lay.steps.x + lay.steps.w / 2, lay.steps.y);
    for (let i = 0; i < 16; i++) el('i', '', st);
    ui.extras[`${spec.id}.steps`] = st;
  }
  if (lay.grMeter) {
    const g = el('div', 'gr', p);
    g.style.width = `${lay.grMeter.w}px`;
    place(g, lay.grMeter.x, lay.grMeter.y);
    g.innerHTML = '<span class="gr-fill"></span><span class="gr-txt">GR</span>';
    ui.extras[`${spec.id}.gr`] = g;
    const howl = el('span', 'howl-led', p);
    place(howl, lay.grMeter.x + lay.grMeter.w / 2 + 10, lay.grMeter.y);
    ui.extras[`${spec.id}.howl`] = howl;
  }
  if (lay.scope) {
    const S = lay.scope.size;
    const s = svg('svg', { viewBox: `-1.2 -1.2 2.4 2.4`, width: S, height: S, class: 'scope ctl' }, p);
    place(s, lay.scope.x, lay.scope.y);
    svg('circle', { cx: 0, cy: 0, r: 1, class: 'scope-ring' }, s);
    ui.extras[`${spec.id}.trail`] = svg('polyline', { points: '', class: 'scope-trail' }, s);
    ui.extras[`${spec.id}.dot`] = svg('circle', { cx: 0, cy: 0, r: 0.13, class: 'scope-dot' }, s);
  }
  if (lay.trace) {
    const { w, h } = lay.trace;
    const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'trace' }, p);
    s.style.left = `${lay.trace.x}px`;
    s.style.top = `${lay.trace.y}px`;
    ui.extras[`${spec.id}.trace`] = svg('polyline', { points: '', class: 'trace-line' }, s);
  }
  if (spec.id === 'mixer') {
    // keep fader-law consistent with the engine
    ui.faderGain = faderGain;
  }
  const loopTag = el('span', 'loop-tag', p, 'LOOP');
  loopTag.setAttribute('aria-hidden', 'true');
  return p;
}
