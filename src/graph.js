// Patch graph analysis shared by the UI and the DSP engine.
//
// A cable is { id, from: { m, j }, to: { m, j } } where m is a module id and j a
// jack id. The host strip is split into two graph nodes: HOST_IN (the From Host
// outputs) and HOST_OUT (the To Host inputs), so a chain that starts and ends
// at the host is not mistaken for a feedback loop.

import { HOST_ID } from './spec.js';

export const HOST_IN = 'host:in';
export const HOST_OUT = 'host:out';

export function nodeOf(end, isSource) {
  if (end.m === HOST_ID) return isSource ? HOST_IN : HOST_OUT;
  return end.m;
}

export function adjacency(cables) {
  const adj = new Map();
  for (const c of cables) {
    const a = nodeOf(c.from, true);
    const b = nodeOf(c.to, false);
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  return adj;
}

// Processing order: depth-first from the host input so natural signal flow runs
// forwards; any edge that points backwards in this order is a feedback edge and
// reads the previous block. Host nodes are excluded (the engine handles them).
export function processOrder(moduleIds, cables) {
  const adj = adjacency(cables);
  const visited = new Set();
  const post = [];
  const visit = (root) => {
    // iterative DFS to stay safe on large graphs
    const stack = [[root, adj.has(root) ? [...adj.get(root)] : [], 0]];
    visited.add(root);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [node, kids] = top;
      if (top[2] < kids.length) {
        const k = kids[top[2]++];
        if (!visited.has(k)) {
          visited.add(k);
          stack.push([k, adj.has(k) ? [...adj.get(k)] : [], 0]);
        }
      } else {
        post.push(node);
        stack.pop();
      }
    }
  };
  visit(HOST_IN);
  for (const id of moduleIds) if (!visited.has(id)) visit(id);
  const order = post.reverse().filter((n) => n !== HOST_IN && n !== HOST_OUT);
  return order;
}

// Modules that sit inside a feedback loop (audio or CV): members of a strongly
// connected component with more than one node, or with a self-edge.
export function loopModules(cables) {
  const adj = adjacency(cables);
  const nodes = new Set();
  for (const [a, bs] of adj) {
    nodes.add(a);
    for (const b of bs) nodes.add(b);
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = new Set();

  const strong = (v0) => {
    // iterative Tarjan
    const work = [[v0, 0]];
    idx.set(v0, index);
    low.set(v0, index);
    index++;
    stack.push(v0);
    onStack.add(v0);
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      const kids = adj.has(v) ? [...adj.get(v)] : [];
      if (frame[1] < kids.length) {
        const w = kids[frame[1]++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          const selfLoop = comp.length === 1 && adj.has(v) && adj.get(v).has(v);
          if (comp.length > 1 || selfLoop) for (const n of comp) result.add(n);
        }
      }
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  result.delete(HOST_IN);
  result.delete(HOST_OUT);
  return result;
}

// Would adding a cable from module a to module b close a loop?
export function closesLoop(cables, fromM, toM) {
  if (fromM === HOST_ID || toM === HOST_ID) return false;
  if (fromM === toM) return true;
  const adj = adjacency(cables);
  const seen = new Set([toM]);
  const q = [toM];
  while (q.length) {
    const v = q.shift();
    if (v === fromM) return true;
    for (const w of adj.get(v) || []) {
      if (!seen.has(w)) {
        seen.add(w);
        q.push(w);
      }
    }
  }
  return false;
}

// Modules whose output can reach the host output (directly or through CV).
// Anything else is idle and the engine skips it to save CPU.
export function neededModules(cables) {
  const rev = new Map();
  for (const c of cables) {
    const a = nodeOf(c.from, true);
    const b = nodeOf(c.to, false);
    if (!rev.has(b)) rev.set(b, new Set());
    rev.get(b).add(a);
  }
  const seen = new Set([HOST_OUT]);
  const q = [HOST_OUT];
  while (q.length) {
    const v = q.shift();
    for (const w of rev.get(v) || []) {
      if (!seen.has(w)) {
        seen.add(w);
        q.push(w);
      }
    }
  }
  seen.delete(HOST_OUT);
  seen.delete(HOST_IN);
  return seen;
}

// Splitter and merger jacks are two independent circuits ('a' / 'b');
// every other module mixes all its inputs together.
function circuitNode(m, j) {
  if (m === 'splitter' || m === 'merger') return `${m}|${j[0]}`;
  if (m === HOST_ID) return j.startsWith('from') ? `host|${j[4]}` : 'host|out';
  return m;
}

// Which From Host routes (1..3) feed each cable, following audio cables only.
// Returns Map(cableId -> Set of host numbers).
export function cableAncestry(cables, isAudio) {
  const hostsAt = new Map(); // node -> Set
  const out = new Map();
  const audio = cables.filter((c) => isAudio(c));
  for (let h = 1; h <= 3; h++) hostsAt.set(`host|${h}`, new Set([h]));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const c of audio) {
      const src = hostsAt.get(circuitNode(c.from.m, c.from.j));
      if (!src || !src.size) continue;
      const dstKey = circuitNode(c.to.m, c.to.j);
      if (!hostsAt.has(dstKey)) hostsAt.set(dstKey, new Set());
      const dst = hostsAt.get(dstKey);
      for (const h of src) {
        if (!dst.has(h)) {
          dst.add(h);
          changed = true;
        }
      }
    }
  }
  for (const c of cables) {
    out.set(c.id, new Set(hostsAt.get(circuitNode(c.from.m, c.from.j)) || []));
  }
  return out;
}
