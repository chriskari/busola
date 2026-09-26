#!/usr/bin/env node
//
// Correlate the loop-probe artifacts into a single timeline so one captured run is
// enough to name the edit-cluster OOM loop. Run against a downloaded artifact dir:
//
//   node analyze.mjs <loop-probe-dir>
//
// Inputs (any subset that exists):
//   chrome-mem.csv      OS per-process RSS/CPU (the crash signature)
//   cdp-metrics.jsonl   CDP Performance.getMetrics samples (JSHeapUsedSize, Nodes, ...)
//   inpage.jsonl        beaconed in-page snapshots (commit rate, scheduler stacks, ...)
//   live-hold.jsonl     spec-side snapshots taken during the hold
//   cpu-*.cpuprofile    open in Chrome DevTools > Performance, or speedscope.app
//   heap-*.heapprofile  open in Chrome DevTools > Memory > Load profile
//
// This script prints a summary; the .cpuprofile / .heapprofile files are the
// definitive per-function / per-allocation-stack evidence — open them in a UI.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2] || '.';
const read = (f) => {
  const p = path.join(dir, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const readJsonl = (f) =>
  (read(f) || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ---- OS memory: peak renderer RSS + whether CPU was pegged --------------------
const mem = read('chrome-mem.csv');
if (mem) {
  const rows = mem
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split(','))
    .map((r) => ({
      ts: Number(r[1]),
      pid: r[2],
      ptype: r[3],
      vsz: Number(r[4]),
      rss: Number(r[5]),
      cpu: Number(r[6]),
    }));

  // Per-pid accounting so we can find the hottest process even if the ps-based
  // --type=renderer label is missing (the RSS ratchet is the ground truth, not
  // the label). GPU/browser processes stay flat, so max-peak-RSS picks the AUT
  // renderer regardless of how it was tagged.
  const byPid = new Map();
  for (const r of rows) {
    let a = byPid.get(r.pid);
    if (!a) {
      a = { pid: r.pid, ptype: r.ptype, peakRss: 0, pegged: 0, samples: 0 };
      byPid.set(r.pid, a);
    }
    a.samples++;
    if (r.rss > a.peakRss) {
      a.peakRss = r.rss;
      a.peakCpu = r.cpu;
      a.peakTs = r.ts;
    }
    if (r.cpu > 100) a.pegged++;
  }
  const procs = [...byPid.values()];
  const labeledRenderers = procs.filter((p) => p.ptype === 'renderer');
  // hottest process overall (fallback when labeling failed)
  const hot = procs.sort((a, b) => b.peakRss - a.peakRss)[0] || {
    peakRss: 0,
    pegged: 0,
  };
  // prefer a labeled renderer if one actually exists, else the hottest process
  const subject =
    labeledRenderers.sort((a, b) => b.peakRss - a.peakRss)[0] || hot;

  console.log('== OS memory sampler ==');
  console.log(
    `  chrome processes seen: ${procs.length} (labeled renderer: ${labeledRenderers.length})`,
  );
  console.log(
    `  hottest process: pid ${subject.pid} type=${subject.ptype} ` +
      `peak RSS ${subject.peakRss} MB (cpu ${subject.peakCpu} at peak), ` +
      `pegged(cpu>100%) samples: ${subject.pegged}`,
  );
  const runaway = subject.peakRss > 2000 && subject.pegged > 5;
  console.log(
    `  => signature: ${
      runaway
        ? 'RUNAWAY LOOP (climbing RSS + pegged CPU)'
        : 'inconclusive / did not reproduce'
    }\n`,
  );
}

// ---- CDP metrics: heap / DOM / listener growth --------------------------------
const cdp = readJsonl('cdp-metrics.jsonl');
if (cdp.length) {
  const val = (m, name) =>
    Array.isArray(m.metrics)
      ? m.metrics.find((x) => x.name === name)?.value
      : undefined;
  const first = cdp[0];
  const last = cdp[cdp.length - 1];
  console.log('== CDP Performance.getMetrics ==');
  for (const name of [
    'JSHeapUsedSize',
    'Nodes',
    'JSEventListeners',
    'LayoutCount',
    'LayoutObjects',
  ]) {
    const a = val(first, name);
    const b = val(last, name);
    if (a != null && b != null) {
      const fmt =
        name === 'JSHeapUsedSize'
          ? (v) => `${Math.round(v / 1048576)}MB`
          : (v) => v;
      console.log(`  ${name}: ${fmt(a)} -> ${fmt(b)}`);
    }
  }
  // Memory.getDOMCounters live-node series (folded into cdp-metrics as `domCounters`).
  // Tracking against LayoutObjects reconfirms LIVE attached-tree growth (LayoutObjects
  // exist only for attached/rendered nodes) rather than detached-document retention.
  const domFirst = cdp.find((m) => m.domCounters?.nodes != null)?.domCounters;
  const domLast = [...cdp]
    .reverse()
    .find((m) => m.domCounters?.nodes != null)?.domCounters;
  if (domFirst && domLast) {
    console.log(
      `  domCounters.nodes: ${domFirst.nodes} -> ${domLast.nodes} ` +
        `(documents ${domFirst.documents} -> ${domLast.documents}, ` +
        `listeners ${domFirst.jsEventListeners} -> ${domLast.jsEventListeners})`,
    );
    const layoutLast = val(last, 'LayoutObjects');
    if (
      domLast.documents != null &&
      domLast.documents <= 20 &&
      layoutLast > domLast.nodes
    )
      console.log(
        `  => LIVE attached-DOM growth: documents flat (${domLast.documents}) while ` +
          `nodes + LayoutObjects climb together`,
      );
  }
  console.log('');
}

// ---- native memory-infra dumps: which ALLOCATOR holds the RSS --------------------
// The V8 heap snapshot names detached DOM but cannot weigh its native (Blink C++) cost.
// The memory-infra dumps (plugins/memory-dump.js) give the per-allocator breakdown so we
// can show the ratchet lives in Blink native allocators (attached layout tree +
// partition_alloc/malloc), not the V8 heap. Each dump trace event is one process; we pick
// the process with the largest resident_set_bytes (the AUT renderer), matching the
// chrome-mem.csv heuristic.
const memFiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.memtrace.jsonl.gz'))
  .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => a.mtime - b.mtime) // capture order
  .map((x) => x.f);

if (memFiles.length) {
  // memory-infra encodes sizes as hex strings (no 0x prefix), e.g. "9c40000".
  const hex = (v) => (v == null ? 0 : parseInt(String(v), 16) || 0);
  const MB = (bytes) => Math.round(bytes / 1048576);
  const ALLOCATORS = ['malloc', 'partition_alloc', 'blink_gc', 'v8'];

  const parseDump = (file) => {
    let text;
    try {
      text = zlib
        .gunzipSync(fs.readFileSync(path.join(dir, file)))
        .toString('utf8');
    } catch (e) {
      return { file, error: String(e) };
    }
    // Each memory-dump trace event carries args.dumps for ONE process; keep the hottest.
    let best = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const dumps = e.args?.dumps;
      if (!dumps?.process_totals) continue;
      const rss = hex(dumps.process_totals.resident_set_bytes);
      if (!best || rss > best.rss) best = { rss, dumps, pid: e.pid };
    }
    if (!best) return { file, error: 'no memory-dump events' };
    const row = { file, rssMB: MB(best.rss), pid: best.pid };
    for (const a of ALLOCATORS) {
      const attrs = best.dumps.allocators?.[a]?.attrs;
      row[a] = MB(hex(attrs?.size?.value ?? attrs?.effective_size?.value));
    }
    return row;
  };

  const rows = memFiles.map(parseDump).filter((r) => !r.error);
  console.log('== native memory-infra (hottest process, MB per allocator) ==');
  if (!rows.length) {
    console.log('  (no parseable dumps)');
  } else {
    const tag = (f) => f.replace(/^mem-|\.memtrace\.jsonl\.gz$/g, '');
    console.log(
      `  ${'tag'.padEnd(12)} ${'rss'.padStart(6)} ${ALLOCATORS.map((a) => a.padStart(9)).join(' ')}`,
    );
    for (const r of rows) {
      console.log(
        `  ${tag(r.file).padEnd(12)} ${String(r.rssMB).padStart(6)} ` +
          ALLOCATORS.map((a) => String(r[a]).padStart(9)).join(' '),
      );
    }
    if (rows.length >= 2) {
      const a = rows[0];
      const b = rows[rows.length - 1];
      const d = (k) => b[k] - a[k];
      const blinkNative = d('malloc') + d('partition_alloc') + d('blink_gc');
      console.log(
        `  delta ${tag(a.file)}->${tag(b.file)}: rss +${d('rssMB')}MB  ` +
          ALLOCATORS.map((k) => `${k} +${d(k)}`).join('  '),
      );
      if (blinkNative > d('v8') && blinkNative > 100)
        console.log(
          `  => NATIVE RATCHET: Blink native (malloc+partition_alloc+blink_gc) +${blinkNative}MB ` +
            `dominates v8 +${d('v8')}MB`,
        );
    }
  }
  console.log('');
}

// ---- in-page: render loop + who schedules the work ----------------------------
const snaps = [...readJsonl('inpage.jsonl'), ...readJsonl('live-hold.jsonl')];
if (snaps.length) {
  const latest = snaps[snaps.length - 1];
  console.log('== in-page probe (latest snapshot) ==');
  console.log(`  url: ${latest.url}`);
  console.log(`  total React commits: ${latest.commits}`);
  console.log(`  max commits/sec: ${latest.maxCommitsPerSec}`);
  console.log(`  scheduler counts: ${JSON.stringify(latest.sched)}`);
  console.log(`  fetches: ${latest.fetches}  xhrs: ${latest.xhrs}`);
  const list = (label, arr) => {
    if (!arr?.length) return;
    console.log(`  top ${label}:`);
    for (const { k, v } of arr.slice(0, 10)) console.log(`    ${v}  ${k}`);
  };
  list('scheduler call-sites (who loops)', latest.topStacks);
  list('re-rendering components', latest.topComponents);
  list('fetch/xhr urls', latest.topUrls);
  list('console error/warn signatures', latest.console);
  console.log('');
}

// ---- DOM-growth attribution: which window ballooned, and where -----------------
// Counters reset per window, so group by windowId and pick the window whose DOM
// grew largest — that is the crash window. Its top container + tag name the leak.
if (snaps.length) {
  const byWin = new Map();
  for (const s of snaps) {
    const id = s.windowId || 'unknown';
    const total = s.domGrowth?.total || 0;
    const cur = byWin.get(id);
    if (!cur || total > cur.peakTotal) {
      byWin.set(id, { id, peakTotal: total, url: s.url, snap: s });
    }
  }
  const wins = [...byWin.values()].sort((a, b) => b.peakTotal - a.peakTotal);
  if (wins.length && wins[0].peakTotal) {
    console.log('== DOM-growth attribution (per-window peak node count) ==');
    for (const w of wins.slice(0, 6)) {
      console.log(`  window ${w.id}: peak ${w.peakTotal} nodes  ${w.url}`);
    }
    const top = wins[0].snap.domGrowth;
    console.log(
      `\n  >> crash-suspect window ${wins[0].id} (${wins[0].peakTotal} nodes) <<`,
    );
    if (top?.topTags?.length) {
      console.log('  proliferating tags:');
      for (const { k, v } of top.topTags.slice(0, 12))
        console.log(`    ${String(v).padStart(6)}  ${k}`);
    }
    if (top?.topContainers?.length) {
      console.log('  largest containers (childElementCount  selector):');
      for (const c of top.topContainers)
        console.log(`    ${String(c.childElementCount).padStart(6)}  ${c.sel}`);
    }
    console.log('');
  }
}

// ---- profile files present? ---------------------------------------------------
const profiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.cpuprofile') || f.endsWith('.heapprofile'));
console.log('== profile checkpoints on disk ==');
if (profiles.length) {
  for (const f of profiles) console.log(`  ${f}`);
  console.log(
    '\n  Open .cpuprofile in Chrome DevTools (Performance > load) or https://speedscope.app',
  );
  console.log(
    '  to see the dominant function; .heapprofile in DevTools > Memory.',
  );
} else {
  console.log('  (none — the loop likely did not reproduce in this run)');
}
