// Panel geometry (rack units = CSS px at 100% zoom). Every control is placed by
// its centre point. Jacks: [jackId, x, y]. Knobs: [paramId, x, y, size].

export const RACK_W = 1340;
export const EFFECT_W = 262;
export const EFFECT_H = 272;
export const LOW_W = 328;
export const LOW_H = 196;

// Rows of the rack, matching the hardware layout.
export const ROWS = [
  { h: EFFECT_H, mods: ['echoforge', 'tape', 'chrono', 'prism', 'overmind'] },
  { h: EFFECT_H, mods: ['subverter', 'bloom', 'dust', 'ghost', 'glitch'] },
  { h: LOW_H, mods: ['orbit', 'reactor', 'splitter', 'merger'] },
  { h: LOW_H, mods: ['drift', 'pgate', 'mixer', 'tamer'] },
];

const BIG = 50, MIXK = 42, SMALL = 28;

// Standard effect panel: params in spec order fill slots A B M C D E F.
const EFFECT_SLOTS = [
  [88, 70, BIG], [174, 70, BIG], [131, 148, MIXK], [70, 150, SMALL], [192, 150, SMALL], [86, 210, SMALL], [176, 210, SMALL],
];

export function effectLayout(spec) {
  const knobs = spec.params.map((p, i) => {
    const [x, y, size] = EFFECT_SLOTS[i];
    return { param: p.id, x, y, size };
  });
  const jacks = [
    ['in1L', 22, 58], ['in1R', 22, 86], ['in2L', 22, 206], ['in2R', 22, 234],
    ['out1L', 240, 58], ['out1R', 240, 86], ['out2L', 240, 206], ['out2R', 240, 234],
  ];
  // CV input under every knob
  for (const k of knobs) {
    const dy = k.size === BIG ? 42 : k.size === MIXK ? 38 : 28;
    jacks.push([`cv:${k.param}`, k.x, k.y + dy]);
  }
  // bottom-centre: buttons and CV outputs
  const extras = [...spec.buttons.map((b) => ({ kind: 'button', id: b.id, label: b.label })), ...spec.cvOuts.map((c) => ({ kind: 'cvout', id: c.id, label: c.label }))];
  const n = extras.length;
  const items = extras.map((e, i) => ({ ...e, x: n === 1 ? 131 : 112 + (38 * i) / Math.max(1, n - 1), y: 242 }));
  const buttons = items.filter((e) => e.kind === 'button').map((e) => ({ id: e.id, label: e.label, x: e.x, y: e.y }));
  for (const e of items.filter((e) => e.kind === 'cvout')) jacks.push([`cvout:${e.id}`, e.x, e.y]);
  return {
    w: EFFECT_W, h: EFFECT_H, knobs, jacks, buttons,
    solo: { x: 44, y: 234 },
    labels: [
      { text: 'Ins', x: 22, y: 38, cls: 'io' }, { text: 'Outs', x: 240, y: 38, cls: 'io' },
      { text: 'L', x: 38, y: 58, cls: 'lr' }, { text: 'R', x: 38, y: 86, cls: 'lr' },
      { text: 'L', x: 224, y: 58, cls: 'lr' }, { text: 'R', x: 224, y: 86, cls: 'lr' },
      { text: 'L', x: 38, y: 206, cls: 'lr' }, { text: 'R', x: 38, y: 234, cls: 'lr' },
      { text: 'L', x: 224, y: 206, cls: 'lr' }, { text: 'R', x: 224, y: 234, cls: 'lr' },
      ...(spec.cvOuts.length ? [{ text: spec.cvOuts.length > 1 ? 'Mid · Side' : spec.cvOuts[0].label, x: spec.buttons.length ? 150 : 131, y: 261, cls: 'cvlabel' }] : []),
    ],
  };
}

const row1 = 56, row2 = 126;

export const LAYOUTS = {
  orbit: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'rate', x: 56, y: 76, size: 54 },
      { param: 'radius', x: 130, y: row1, size: SMALL }, { param: 'shape', x: 186, y: row1, size: SMALL }, { param: 'gravity', x: 242, y: row1, size: SMALL },
      { param: 'phase', x: 158, y: row2, size: SMALL }, { param: 'axis', x: 214, y: row2, size: SMALL },
    ],
    jacks: [
      ['cv:rate', 56, 124], ['cv:radius', 130, row1 + 30], ['cv:shape', 186, row1 + 30], ['cv:gravity', 242, row1 + 30],
      ['cv:phase', 158, row2 + 30], ['cv:axis', 214, row2 + 30], ['cvout:x', 288, 118], ['cvout:y', 288, 152],
    ],
    buttons: [{ id: 'sync', label: 'Sync', x: 22, y: 172 }],
    display: { x: 74, y: 172, w: 74, kind: 'rate' },
    labels: [{ text: 'CV Outs', x: 288, y: 94, cls: 'cvlabel' }, { text: 'X', x: 305, y: 118, cls: 'lr' }, { text: 'Y', x: 305, y: 152, cls: 'lr' }],
    scope: { x: 290, y: 50, size: 40 },
  },
  drift: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'rate', x: 56, y: 76, size: 54 },
      { param: 'depth', x: 130, y: row1, size: SMALL }, { param: 'smooth', x: 186, y: row1, size: SMALL }, { param: 'bias', x: 242, y: row1, size: SMALL },
      { param: 'chaos', x: 186, y: row2, size: SMALL },
    ],
    jacks: [
      ['cv:rate', 56, 124], ['cv:depth', 130, row1 + 30], ['cv:smooth', 186, row1 + 30], ['cv:bias', 242, row1 + 30],
      ['cv:chaos', 186, row2 + 30], ['cvout:walk', 288, 162],
    ],
    buttons: [{ id: 'sync', label: 'Sync', x: 22, y: 172 }],
    display: { x: 74, y: 172, w: 74, kind: 'period' },
    labels: [{ text: 'CV Out', x: 288, y: 140, cls: 'cvlabel' }],
    trace: { x: 226, y: 98, w: 84, h: 24 },
  },
  reactor: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'mix', x: 80, y: row1, size: SMALL }, { param: 'freq', x: 134, y: row1, size: SMALL }, { param: 'fm', x: 188, y: row1, size: SMALL }, { param: 'am', x: 242, y: row1, size: SMALL },
      { param: 'mod', x: 120, y: row2, size: SMALL }, { param: 'env', x: 174, y: row2, size: SMALL },
    ],
    jacks: [
      ['in1L', 22, 54], ['in1R', 22, 82], ['in2L', 22, 130], ['in2R', 22, 158],
      ['out1L', 306, 54], ['out1R', 306, 82], ['out2L', 306, 130], ['out2R', 306, 158],
      ['cv:mix', 80, row1 + 30], ['cv:freq', 134, row1 + 30], ['cv:fm', 188, row1 + 30], ['cv:am', 242, row1 + 30],
      ['cv:mod', 120, row2 + 30], ['cv:env', 174, row2 + 30], ['cvout:env', 246, 150],
    ],
    buttons: [],
    solo: { x: 44, y: 158 },
    labels: [
      { text: 'Audio', x: 22, y: 36, cls: 'io' }, { text: 'Mod', x: 22, y: 112, cls: 'io' },
      { text: 'Audio', x: 306, y: 36, cls: 'io' }, { text: 'Out 2', x: 306, y: 112, cls: 'io' },
      { text: 'CV Out', x: 246, y: 126, cls: 'cvlabel' },
    ],
  },
  pgate: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'mix', x: 80, y: row1, size: SMALL }, { param: 'prob', x: 134, y: row1, size: SMALL }, { param: 'mode', x: 188, y: row1, size: SMALL }, { param: 'rate', x: 242, y: row1, size: SMALL },
      { param: 'swing', x: 80, y: row2, size: SMALL }, { param: 'patt', x: 134, y: row2, size: SMALL },
    ],
    jacks: [
      ['in1L', 22, 54], ['in1R', 22, 82], ['in2L', 22, 130], ['in2R', 22, 158],
      ['out1L', 306, 54], ['out1R', 306, 82], ['out2L', 306, 130], ['out2R', 306, 158],
      ['cv:mix', 80, row1 + 30], ['cv:prob', 134, row1 + 30], ['cv:mode', 188, row1 + 30], ['cv:rate', 242, row1 + 30],
      ['cv:swing', 80, row2 + 30], ['cv:patt', 134, row2 + 30], ['cvout:gate', 252, 158],
    ],
    buttons: [],
    solo: { x: 44, y: 158 },
    steps: { x: 172, y: 108, w: 116 },
    labels: [
      { text: 'Ins', x: 22, y: 36, cls: 'io' }, { text: 'Outs', x: 306, y: 36, cls: 'io' }, { text: 'Rejects', x: 306, y: 112, cls: 'io' },
      { text: 'CV Out', x: 252, y: 138, cls: 'cvlabel' },
    ],
  },
  splitter: (() => {
    const jacks = [];
    const labels = [];
    const knobs = [];
    [['a', 62, 'gainA'], ['b', 146, 'gainB']].forEach(([c, y, gain]) => {
      jacks.push([`${c}InL`, 24, y - 14], [`${c}InR`, 24, y + 14]);
      knobs.push({ param: gain, x: 70, y, size: SMALL });
      for (let i = 1; i <= 4; i++) jacks.push([`${c}Out${i}L`, 104 + i * 44, y - 14], [`${c}Out${i}R`, 104 + i * 44, y + 14]);
      labels.push({ text: 'In', x: 24, y: y - 34, cls: 'io' }, { text: 'Outs', x: 214, y: y - 34, cls: 'io' });
    });
    return { w: LOW_W, h: LOW_H, knobs, jacks, buttons: [], labels, divider: 104 };
  })(),
  merger: (() => {
    const jacks = [];
    const labels = [];
    const knobs = [];
    [['a', 62, 'gainA'], ['b', 146, 'gainB']].forEach(([c, y, gain]) => {
      for (let i = 1; i <= 4; i++) jacks.push([`${c}In${i}L`, -20 + i * 44, y - 14], [`${c}In${i}R`, -20 + i * 44, y + 14]);
      knobs.push({ param: gain, x: 214, y, size: SMALL });
      jacks.push([`${c}OutL`, 262, y - 14], [`${c}OutR`, 262, y + 14]);
      labels.push({ text: 'Ins', x: 90, y: y - 34, cls: 'io' }, { text: 'Out', x: 262, y: y - 34, cls: 'io' });
    });
    return { w: LOW_W, h: LOW_H, knobs, jacks, buttons: [], labels, divider: 104, tag: 'FINISH THEM' };
  })(),
  mixer: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'pan1', x: 46, y: 46, size: 24 }, { param: 'pan2', x: 136, y: 46, size: 24 }, { param: 'pan3', x: 226, y: 46, size: 24 },
      { param: 'xf12', x: 91, y: 104, size: 24 }, { param: 'xf23', x: 181, y: 104, size: 24 },
    ],
    faders: [
      { param: 'fader1', x: 46, y: 116, h: 52, meter: 0 },
      { param: 'fader2', x: 136, y: 116, h: 52, meter: 1 },
      { param: 'fader3', x: 226, y: 116, h: 52, meter: 2 },
    ],
    jacks: [
      ['cv:pan1', 46, 70], ['cv:pan2', 136, 70], ['cv:pan3', 226, 70], ['cv:xf12', 91, 128], ['cv:xf23', 181, 128],
      ['ch1L', 34, 166], ['ch1R', 58, 166], ['ch2L', 124, 166], ['ch2R', 148, 166], ['ch3L', 214, 166], ['ch3R', 238, 166],
      ['outL', 298, 54], ['outR', 298, 82],
    ],
    buttons: [],
    outMeter: { x: 298, y: 100, h: 66 },
    labels: [
      { text: 'Out', x: 298, y: 34, cls: 'io' },
      { text: 'Ch 1', x: 46, y: 185, cls: 'io' }, { text: 'Ch 2', x: 136, y: 185, cls: 'io' }, { text: 'Ch 3', x: 226, y: 185, cls: 'io' },
    ],
  },
  tamer: {
    w: LOW_W, h: LOW_H,
    knobs: [
      { param: 'thresh', x: 100, y: 58, size: SMALL }, { param: 'recovery', x: 228, y: 58, size: SMALL },
      { param: 'focus', x: 164, y: 104, size: 58 },
      { param: 'clamp', x: 100, y: 150, size: SMALL }, { param: 'soft', x: 228, y: 150, size: SMALL },
    ],
    jacks: [
      ['in1L', 26, 54], ['in1R', 26, 82], ['in2L', 26, 130], ['in2R', 26, 158],
      ['out1L', 302, 54], ['out1R', 302, 82], ['out2L', 302, 130], ['out2R', 302, 158],
      ['cvout:howl', 164, 166],
    ],
    buttons: [],
    solo: { x: 48, y: 158 },
    grMeter: { x: 164, y: 34, w: 70 },
    labels: [{ text: 'Howl Out', x: 164, y: 186, cls: 'cvlabel' }],
  },
};

export function layoutFor(spec) {
  if (LAYOUTS[spec.id]) return LAYOUTS[spec.id];
  return effectLayout(spec);
}
