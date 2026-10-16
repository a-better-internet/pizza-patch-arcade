// Cable layer, following the "Best Practices for Browser-Based Patch UIs" brief:
//  * one <svg> that is a direct child of <body>, position:fixed, full viewport,
//    pointer-events:none, so clientX/Y map 1:1 onto SVG coordinates;
//  * gravity Bezier: control points hang below the jacks, slack grows with distance;
//  * every cable is a <g> with a 3px visual path and a 20px transparent hit path;
//  * ghost drag: the drag listeners live on window; on release the ghost is
//    removed first, then elementFromPoint() finds the target, then a new cable
//    is created (never "converted" from the ghost);
//  * Shift held = delete mode: cables become clickable and turn red on hover;
//  * colours come from a JS dictionary, never from computed styles;
//  * jack centres come from getBoundingClientRect().

import { PatchModel } from '../patch.js';
import { getJack } from '../spec.js';
import { cableAncestry } from '../graph.js';
import { svg } from './controls.js';

export const CABLE_COLORS = {
  route1: '#3ee07c',
  route2: '#47b8ff',
  route3: '#ff8f3a',
  mixed: '#efe6d2',
  none: '#9aa5b4',
  cv: '#ffd23f',
  ghost: '#ffffff',
  delete: '#ff3b3b',
};

export function getCenter(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

let gravityScale = 1;
export const setGravityScale = (s) => {
  gravityScale = s;
};

export function gravityPath(x1, y1, x2, y2) {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const slack = Math.min(200, distance * 0.4 + 20) * gravityScale;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${(y1 + slack).toFixed(1)} ${x2.toFixed(1)},${(y2 + slack).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

const jackKey = (m, j) => `${m}.${j}`;

export class CableLayer {
  constructor(model, ui, { onConnect, onDelete, onReject }) {
    this.model = model;
    this.ui = ui;
    this.onConnect = onConnect;
    this.onDelete = onDelete;
    this.onReject = onReject;
    this.groups = new Map();
    this.solo = null;
    this.pending = false;
    this.svg = svg('svg', { class: 'cable-layer', 'aria-hidden': 'true' });
    document.body.appendChild(this.svg);
    this.root = svg('g', { class: 'cables' }, this.svg);
    this.fx = svg('g', { class: 'fx' }, this.svg);
    this.ghost = null;
    this.drag = null;
    this.scale = 1;

    document.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('resize', () => this.schedule());
    window.addEventListener('scroll', () => this.schedule(), true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') document.body.classList.add('delete-mode');
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') document.body.classList.remove('delete-mode');
    });
    window.addEventListener('blur', () => document.body.classList.remove('delete-mode'));
    document.addEventListener('dblclick', (e) => {
      const j = e.target.closest && e.target.closest('.jack');
      if (!j) return;
      const gone = this.model.cables.filter((c) => (c.from.m === j.dataset.m && c.from.j === j.dataset.j) || (c.to.m === j.dataset.m && c.to.j === j.dataset.j));
      for (const c of gone) this.onDelete(c.id);
    });
  }

  // ---------------------------------------------------------------- render
  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  colorFor(c, anc) {
    if (getJack(c.from.m, c.from.j).type === 'cv') return CABLE_COLORS.cv;
    const hosts = anc.get(c.id);
    if (!hosts || hosts.size === 0) return CABLE_COLORS.none;
    if (hosts.size > 1) return CABLE_COLORS.mixed;
    return CABLE_COLORS[`route${[...hosts][0]}`];
  }

  // Reconcile SVG groups with the model.
  sync() {
    const anc = cableAncestry(this.model.cables, (c) => getJack(c.from.m, c.from.j).type === 'audio');
    const live = new Set();
    for (const c of this.model.cables) {
      live.add(c.id);
      let g = this.groups.get(c.id);
      if (!g) {
        const grp = svg('g', { class: 'cable', 'data-id': c.id }, this.root);
        const shadow = svg('path', { class: 'c-shadow' }, grp);
        const vis = svg('path', { class: 'c-vis' }, grp);
        const hit = svg('path', { class: 'c-hit' }, grp);
        const r = (5.2 * this.scale).toFixed(2);
        const a = svg('circle', { class: 'c-plug', r }, grp);
        const b = svg('circle', { class: 'c-plug', r }, grp);
        hit.addEventListener('click', (e) => {
          if (!document.body.classList.contains('delete-mode')) return;
          e.stopPropagation();
          this.onDelete(c.id);
        });
        g = { grp, shadow, vis, hit, a, b };
        this.groups.set(c.id, g);
        grp.classList.add('fresh');
        setTimeout(() => grp.classList.remove('fresh'), 400);
      }
      const col = this.colorFor(c, anc);
      g.vis.setAttribute('stroke', col);
      g.a.setAttribute('fill', col);
      g.b.setAttribute('fill', col);
      g.grp.classList.toggle('cv', col === CABLE_COLORS.cv);
      g.cable = c;
    }
    for (const [id, g] of this.groups) {
      if (!live.has(id)) {
        g.grp.remove();
        this.groups.delete(id);
      }
    }
    this.applySolo();
    this.schedule();
  }

  draw() {
    for (const [, g] of this.groups) {
      const c = g.cable;
      const ja = this.ui.jacks.get(jackKey(c.from.m, c.from.j));
      const jb = this.ui.jacks.get(jackKey(c.to.m, c.to.j));
      if (!ja || !jb) continue;
      const p = getCenter(ja), q = getCenter(jb);
      const d = gravityPath(p.x, p.y, q.x, q.y);
      g.shadow.setAttribute('d', d);
      g.vis.setAttribute('d', d);
      g.hit.setAttribute('d', d);
      g.a.setAttribute('cx', p.x);
      g.a.setAttribute('cy', p.y);
      g.b.setAttribute('cx', q.x);
      g.b.setAttribute('cy', q.y);
    }
    this.updateJackStates();
  }

  updateJackStates() {
    const used = new Set();
    for (const c of this.model.cables) {
      used.add(jackKey(c.from.m, c.from.j));
      used.add(jackKey(c.to.m, c.to.j));
    }
    for (const [k, el] of this.ui.jacks) el.classList.toggle('patched', used.has(k));
  }

  // Cables keep their proportions when the rack is zoomed.
  setScale(s) {
    this.scale = Math.max(0.35, Math.min(1.6, s));
    this.svg.style.setProperty('--cs', String(this.scale));
    setGravityScale(Math.max(0.3, Math.min(1.2, s)));
    for (const [, g] of this.groups) {
      g.a.setAttribute('r', (5.2 * this.scale).toFixed(2));
      g.b.setAttribute('r', (5.2 * this.scale).toFixed(2));
    }
    this.schedule();
  }

  setOpacity(v) {
    this.svg.style.setProperty('--cable-opacity', String(v));
  }

  setSolo(moduleId) {
    this.solo = this.solo === moduleId ? null : moduleId;
    this.applySolo();
    return this.solo;
  }

  applySolo() {
    for (const [, g] of this.groups) {
      const c = g.cable;
      const show = !this.solo || c.from.m === this.solo || c.to.m === this.solo;
      g.grp.classList.toggle('hidden', !show);
    }
  }

  // ---------------------------------------------------------- interaction
  onPointerDown(e) {
    const jackEl = e.target.closest && e.target.closest('.jack');
    if (!jackEl || e.button !== 0) return;
    e.preventDefault();
    const src = { m: jackEl.dataset.m, j: jackEl.dataset.j };
    const spec = getJack(src.m, src.j);
    if (!spec) return;
    const start = getCenter(jackEl);
    // MouseDown (Jack): create the ghost path, never interactive
    this.ghost = svg('path', { class: 'ghost', stroke: spec.type === 'cv' ? CABLE_COLORS.cv : CABLE_COLORS.ghost }, this.svg);
    this.ghost.style.pointerEvents = 'none';
    this.ghost.setAttribute('d', gravityPath(start.x, start.y, e.clientX, e.clientY));
    this.drag = { src, start, jackEl, pointerId: e.pointerId };
    document.body.classList.add('dragging');
    jackEl.classList.add('source');
    // Standard mode visuals: highlight valid targets, dim the rest
    for (const [, el] of this.ui.jacks) {
      if (el === jackEl) continue;
      const ok = !PatchModel.check(src, { m: el.dataset.m, j: el.dataset.j }).error;
      el.classList.toggle('valid', ok);
      el.classList.toggle('invalid', !ok);
    }
    const move = (ev) => {
      if (ev.pointerId !== this.drag.pointerId || !this.ghost) return;
      this.ghost.setAttribute('d', gravityPath(start.x, start.y, ev.clientX, ev.clientY));
    };
    const up = (ev) => {
      if (ev.pointerId !== this.drag.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // Step A: always remove the ghost first
      if (this.ghost) this.ghost.remove();
      this.ghost = null;
      document.body.classList.remove('dragging');
      jackEl.classList.remove('source');
      for (const [, el] of this.ui.jacks) el.classList.remove('valid', 'invalid');
      const drag = this.drag;
      this.drag = null;
      if (ev.type === 'pointercancel') return;
      // Step B: find the drop target
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest ? under.closest('.jack') : null;
      if (!target || target === jackEl) return;
      const dst = { m: target.dataset.m, j: target.dataset.j };
      const chk = PatchModel.check(drag.src, dst);
      if (chk.error) {
        if (this.onReject) this.onReject(chk.error, target);
        return;
      }
      // Step C: create a brand new permanent cable
      this.onConnect(drag.src, dst);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // Sparks thrown from both ends when a cable closes a feedback loop.
  sparks(cable) {
    const ends = [jackKey(cable.from.m, cable.from.j), jackKey(cable.to.m, cable.to.j)];
    for (const k of ends) {
      const el = this.ui.jacks.get(k);
      if (!el) continue;
      const { x, y } = getCenter(el);
      const parts = [];
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 60 + Math.random() * 140;
        parts.push({
          el: svg('circle', { r: 1.2 + Math.random() * 1.8, class: 'spark', cx: x, cy: y }, this.fx),
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80,
        });
      }
      const t0 = performance.now();
      const step = (t) => {
        const dt = (t - t0) / 1000;
        for (const p of parts) {
          p.el.setAttribute('cx', x + p.vx * dt);
          p.el.setAttribute('cy', y + p.vy * dt + 260 * dt * dt);
          p.el.setAttribute('opacity', String(Math.max(0, 1 - dt / 0.7)));
        }
        if (dt < 0.7) requestAnimationFrame(step);
        else for (const p of parts) p.el.remove();
      };
      requestAnimationFrame(step);
    }
  }
}
