//
// Retainer analysis for a V8 .heapsnapshot captured by the edit-cluster OOM loop probe
// (plugins/heap-snapshot.js). The sampling `.heapprofile` only names allocation *sites*;
// this names the RETAINER — the live object + edge that holds the detached DOM subtrees
// alive across SPA navigation, which is the actual root cause of the native RSS ratchet.
//
// Usage:
//   node --max-old-space-size=8192 analyze-heapsnapshot.mjs <file.heapsnapshot> [--top=30]
//
// A real overview-crash snapshot is large (~150k+ DOM wrappers); give Node a big old-space.
// Gunzip the artifact first (the probe writes `<name>.heapsnapshot.gz`).
//
// What it reports:
//   1. Detached-DOM totals (count + self_size) via the `detachedness` node field (2 = detached),
//      with a fallback to native nodes whose name starts with "Detached ".
//   2. The dominant RETAINING EDGES that cross from a NON-detached (live / rooted) object into
//      the detached set — i.e. what is actually keeping the detached subtrees alive. Aggregated
//      by (retainer node type+name, edge name) and ranked by how much detached memory hangs off
//      each. Weak edges are excluded (they don't retain).
//   3. A few concrete shortest retainer paths from a GC root down to a large detached node, to
//      read the chain directly.

import fs from 'fs';

const file = process.argv[2];
const topArg = process.argv.find((a) => a.startsWith('--top='));
const TOP = topArg ? Number(topArg.split('=')[1]) : 30;
if (!file) {
  console.error(
    'usage: analyze-heapsnapshot.mjs <file.heapsnapshot> [--top=N]',
  );
  process.exit(1);
}

console.error(`[analyze] reading ${file} …`);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const { meta } = snap.snapshot;
const nodes = snap.nodes;
const edges = snap.edges;
const strings = snap.strings;

// --- field layout (read dynamically; layouts differ across Chrome versions) ---
const nf = meta.node_fields;
const NSTRIDE = nf.length;
const N_TYPE = nf.indexOf('type');
const N_NAME = nf.indexOf('name');
const N_ID = nf.indexOf('id');
const N_SELF = nf.indexOf('self_size');
const N_EDGES = nf.indexOf('edge_count');
const N_DETACHED = nf.indexOf('detachedness'); // -1 on very old snapshots
const NODE_TYPES = meta.node_types[0];

const ef = meta.edge_fields;
const ESTRIDE = ef.length;
const E_TYPE = ef.indexOf('type');
const E_NAME = ef.indexOf('name_or_index');
const E_TO = ef.indexOf('to_node');
const EDGE_TYPES = meta.edge_types[0];

const nodeCount = nodes.length / NSTRIDE;
console.error(
  `[analyze] ${nodeCount} nodes, ${edges.length / ESTRIDE} edges, ${strings.length} strings`,
);

const nodeName = (ni) => strings[nodes[ni * NSTRIDE + N_NAME]];
const nodeType = (ni) => NODE_TYPES[nodes[ni * NSTRIDE + N_TYPE]];
const nodeSelf = (ni) => nodes[ni * NSTRIDE + N_SELF];
const nodeId = (ni) => nodes[ni * NSTRIDE + N_ID];

// --- first-edge index per node (prefix sum of edge_count) ---
const firstEdge = new Uint32Array(nodeCount + 1);
for (let ni = 0; ni < nodeCount; ni++) {
  firstEdge[ni + 1] = firstEdge[ni] + nodes[ni * NSTRIDE + N_EDGES];
}
// edges[] is laid out per source node in node order; to_node is a BYTE offset into nodes[],
// so the target node index = to_node / NSTRIDE.
const edgeTo = (ei) => edges[ei * ESTRIDE + E_TO] / NSTRIDE;
const edgeTypeName = (ei) => EDGE_TYPES[edges[ei * ESTRIDE + E_TYPE]];
const edgeNameRaw = (ei) => edges[ei * ESTRIDE + E_NAME];
// element/hidden edges use a numeric index; the rest index into strings[]
const edgeLabel = (ei) => {
  const t = edgeTypeName(ei);
  const raw = edgeNameRaw(ei);
  if (t === 'element' || t === 'hidden') return `[${raw}]`;
  return strings[raw] ?? `#${raw}`;
};

// --- classify detached nodes ---
const isDetached = new Uint8Array(nodeCount);
let detachedCount = 0;
let detachedSelf = 0;
let usedField = false;
if (N_DETACHED !== -1) {
  for (let ni = 0; ni < nodeCount; ni++) {
    if (nodes[ni * NSTRIDE + N_DETACHED] === 2) {
      isDetached[ni] = 1;
      detachedCount++;
      detachedSelf += nodeSelf(ni);
    }
  }
  usedField = detachedCount > 0;
}
if (!usedField) {
  // fallback: native nodes named "Detached ..." (older snapshots without the field, or
  // the field unset). Chrome groups these under a synthetic "Detached DOM tree" too.
  for (let ni = 0; ni < nodeCount; ni++) {
    const nm = nodeName(ni);
    if (nodeType(ni) === 'native' && nm.startsWith('Detached')) {
      isDetached[ni] = 1;
      detachedCount++;
      detachedSelf += nodeSelf(ni);
    }
  }
}

console.log('\n=== detached-DOM totals ===');
console.log(
  `method: ${usedField ? 'detachedness field (==2)' : 'name starts with "Detached"'}`,
);
console.log(
  `detached nodes: ${detachedCount}  self_size: ${(detachedSelf / 1048576).toFixed(1)} MB`,
);

// breakdown of detached node names (which element kinds dominate)
const detByName = new Map();
for (let ni = 0; ni < nodeCount; ni++) {
  if (!isDetached[ni]) continue;
  const key = `${nodeType(ni)} ${nodeName(ni)}`;
  const e = detByName.get(key) || { count: 0, self: 0 };
  e.count++;
  e.self += nodeSelf(ni);
  detByName.set(key, e);
}
console.log('\ntop detached node kinds:');
[...detByName.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 15)
  .forEach(([k, v]) => console.log(`  ${String(v.count).padStart(7)}  ${k}`));

// --- dominant retaining edges: NON-detached -> detached (excluding weak) ---
// This is the boundary that keeps the detached island alive. Aggregate by the retaining
// object (type+name) and the edge label, weighted by the detached node's self_size.
const retAgg = new Map();
for (let src = 0; src < nodeCount; src++) {
  if (isDetached[src]) continue; // we want live/rooted retainers only
  const start = firstEdge[src];
  const end = firstEdge[src + 1];
  for (let ei = start; ei < end; ei++) {
    if (edgeTypeName(ei) === 'weak') continue; // weak refs don't retain
    const dst = edgeTo(ei);
    if (!isDetached[dst]) continue;
    const key = `${nodeType(src)} «${nodeName(src)}» --${edgeLabel(ei)}-->`;
    const e = retAgg.get(key) || { count: 0, self: 0, exSrc: src, exDst: dst };
    e.count++;
    e.self += nodeSelf(dst);
    retAgg.set(key, e);
  }
}
const topRetainers = [...retAgg.entries()]
  .sort((a, b) => b[1].self - a[1].self)
  .slice(0, TOP);
console.log(
  `\n=== dominant retaining edges (live object -> detached), top ${TOP} ===`,
);
console.log('(count = # detached targets, self = their summed self_size)');
topRetainers.forEach(([k, v]) =>
  console.log(
    `  ${String(v.count).padStart(6)}  ${(v.self / 1024).toFixed(0).padStart(8)} KB  ${k}`,
  ),
);

// --- shortest retainer paths from a GC root to a few large detached nodes ---
// BFS over reverse edges (retainers). Build reverse adjacency once.
console.error('[analyze] building reverse edges for path tracing …');
const revCount = new Uint32Array(nodeCount + 1);
for (let src = 0; src < nodeCount; src++) {
  const end = firstEdge[src + 1];
  for (let ei = firstEdge[src]; ei < end; ei++) {
    if (edgeTypeName(ei) === 'weak') continue;
    revCount[edgeTo(ei) + 1]++;
  }
}
for (let i = 0; i < nodeCount; i++) revCount[i + 1] += revCount[i];
const revFirst = revCount; // prefix-summed
const revSrc = new Uint32Array(revFirst[nodeCount]);
const revEdge = new Uint32Array(revFirst[nodeCount]);
const cursor = revFirst.slice();
for (let src = 0; src < nodeCount; src++) {
  const end = firstEdge[src + 1];
  for (let ei = firstEdge[src]; ei < end; ei++) {
    if (edgeTypeName(ei) === 'weak') continue;
    const dst = edgeTo(ei);
    const at = cursor[dst]++;
    revSrc[at] = src;
    revEdge[at] = ei;
  }
}

// roots = synthetic nodes with no incoming retainers (GC roots / (Detached DOM trees) etc.)
const isRoot = (ni) =>
  nodeType(ni) === 'synthetic' || revFirst[ni + 1] - revFirst[ni] === 0;

// pick a few largest detached nodes as path targets
const targets = [];
for (let ni = 0; ni < nodeCount; ni++) if (isDetached[ni]) targets.push(ni);
targets.sort((a, b) => nodeSelf(b) - nodeSelf(a));
const pathTargets = targets.slice(0, 5);

const bfsToRoot = (target) => {
  const prevNode = new Int32Array(nodeCount).fill(-1);
  const prevEdge = new Int32Array(nodeCount).fill(-1);
  const seen = new Uint8Array(nodeCount);
  const q = [target];
  seen[target] = 1;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur !== target && isRoot(cur)) {
      // reconstruct forward path root -> target
      const chain = [];
      let n = cur;
      while (n !== -1 && n !== target) {
        chain.push({ node: n, edge: prevEdge[n] });
        n = prevNode[n];
      }
      chain.push({ node: target, edge: -1 });
      return chain;
    }
    for (let r = revFirst[cur]; r < revFirst[cur + 1]; r++) {
      const s = revSrc[r];
      if (seen[s]) continue;
      seen[s] = 1;
      prevNode[s] = cur;
      prevEdge[s] = revEdge[r];
      q.push(s);
    }
  }
  return null;
};

const printChain = (chain) => {
  if (!chain) {
    console.log(
      '  (no path to a root found — likely retained only within detached set)',
    );
    return;
  }
  chain.forEach((step, i) => {
    const via = step.edge === -1 ? '' : `  --${edgeLabel(step.edge)}-->`;
    const flag = isDetached[step.node] ? ' [detached]' : '';
    console.log(
      `  ${'  '.repeat(i)}${nodeType(step.node)} «${nodeName(step.node)}»${flag}${via}`,
    );
  });
};

console.log(
  '\n=== shortest root->detached retainer paths (largest 5 detached) ===',
);
for (const t of pathTargets) {
  console.log(
    `\n• target: ${nodeType(t)} «${nodeName(t)}» id=${nodeId(t)} self=${nodeSelf(t)}B`,
  );
  printChain(bfsToRoot(t));
}

// --- trace the DOMINANT retaining edges up to a root ---------------------------
// The largest-self detached nodes are often browser-internal (cached detached documents),
// which is noise. The dominant retaining EDGES (aggregated above) are the real signal:
// trace the live SOURCE object of each up to a GC root to see what app structure holds it.
console.log(
  `\n=== root paths for the top ${Math.min(TOP, 10)} dominant retaining edges ===`,
);
for (const [k, v] of topRetainers.slice(0, 10)) {
  console.log(`\n• ${v.count}× ${k}`);
  console.log(
    `  retaining object: ${nodeType(v.exSrc)} «${nodeName(v.exSrc)}» id=${nodeId(v.exSrc)}`,
  );
  printChain(bfsToRoot(v.exSrc));
}

// --- Cypress-artifact test: how much detached DOM survives WITHOUT the harness? -----------
// The amplifier runs ~hundreds of commands in ONE it(); Cypress retains every command's
// jQuery `subject` (chained via prevObject) in cy.queue.CommandQueue until the test ends.
// That is a TEST-HARNESS retainer, absent in production. Forward-reachability from all GC
// roots while REFUSING to traverse the Cypress command-queue machinery tells us how many
// detached nodes an app-level (or browser-internal) retainer holds independently of Cypress.
const CYPRESS_NAMES = new Set([
  '$Cy',
  'CommandQueue',
  '$Command',
  '$Chainer',
  'jQuery.fn.init',
]);
const isCypress = (ni) => CYPRESS_NAMES.has(nodeName(ni));

const reachable = new Uint8Array(nodeCount);
const rq = [];
for (let ni = 0; ni < nodeCount; ni++) {
  if (nodeType(ni) === 'synthetic' && !isCypress(ni)) {
    reachable[ni] = 1;
    rq.push(ni);
  }
}
let rhead = 0;
while (rhead < rq.length) {
  const cur = rq[rhead++];
  const end = firstEdge[cur + 1];
  for (let ei = firstEdge[cur]; ei < end; ei++) {
    if (edgeTypeName(ei) === 'weak') continue;
    const dst = edgeTo(ei);
    if (reachable[dst] || isCypress(dst)) continue; // don't route through the harness
    reachable[dst] = 1;
    rq.push(dst);
  }
}
let survives = 0;
let survivesSelf = 0;
for (let ni = 0; ni < nodeCount; ni++) {
  if (isDetached[ni] && reachable[ni]) {
    survives++;
    survivesSelf += nodeSelf(ni);
  }
}
console.log('\n=== Cypress-artifact test ===');
console.log(
  'detached nodes still reachable from a root WITHOUT traversing Cypress cy.queue:',
);
console.log(
  `  ${survives} / ${detachedCount}  (${((100 * survives) / detachedCount).toFixed(1)}%)  self ${(survivesSelf / 1048576).toFixed(2)} MB`,
);
console.log(
  `  → ${detachedCount - survives} detached nodes are retained ONLY via the Cypress command queue (harness artifact).`,
);
