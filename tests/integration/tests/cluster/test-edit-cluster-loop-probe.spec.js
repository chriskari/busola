/// <reference types="cypress" />
//
// Dedicated diagnostic spec for the edit-cluster renderer OOM loop.
//
// This spec is INERT unless Cypress.env('LOOP_PROBE') is set (it is added to the
// specPattern permanently, but skips itself on normal runs). When armed it:
//   1. starts out-of-process CDP profiling (CPU + heap-allocation sampling +
//      Performance.getMetrics polling) via Cypress's built-in remote:debugger:protocol
//      channel — request/response is enough because Profiler.stop / HeapProfiler
//      getSamplingProfile / Performance.getMetrics all return their payload in the
//      command *response* (no event subscription, no extra npm dependency);
//   2. runs the edit-cluster rename flow in a tight AMPLIFIER loop to raise the per-job
//      hit rate (the loop reproduces ~1/25 naturally, never locally);
//   3. holds and polls (metrics + the in-page __loopProbe snapshot) so the loop has time
//      to ratchet RSS, checkpointing profiles periodically so a hard crash still leaves
//      usable data on disk.
//
// All artifacts land under cypress/loop-probe/ (carried out by the existing always()
// upload). See support/loop-probe.js and plugins/index.js.

import config from '../../config';

const PROBE_ON = !!Cypress.env('LOOP_PROBE');

// A/B arm selector (temporary scaffolding): when CYPRESS_DISABLE_CHART_ANIMATION=1 is set,
// force the overview's recharts radial charts to skip animation by planting a window flag
// before the app boots on every navigation. UI5RadialChart reads it. Running one loop-probe
// with the env and one without — on the SAME build — isolates the recharts animation loop as
// the RSS-ratchet driver with no confound. Removed once confirmed (the fix uses a prop).
if (Cypress.env('DISABLE_CHART_ANIMATION')) {
  Cypress.on('window:before:load', (win) => {
    win.__DISABLE_CHART_ANIMATION = true;
  });
}

const DESC = 'loop-probe amplifier description';
const TEMP_NAME = 'loop-probe-tmp';
const AMPLIFIER_ITERATIONS = Number(Cypress.env('LOOP_PROBE_ITERATIONS')) || 25;
const HOLD_SAMPLES = Number(Cypress.env('LOOP_PROBE_HOLD_SAMPLES')) || 180; // ~6 min @2s
const IDLE_SAMPLES = Number(Cypress.env('LOOP_PROBE_IDLE_SAMPLES')) || 60; // ~2 min @2s
const HOLD_INTERVAL_MS = 2000;
const HEAP_ABORT_MB = 3400; // near Chrome's ~3.8GB per-renderer cap
const CHECKPOINT_EVERY = 5; // dump a CPU/heap profile chunk every N amplifier iterations
// Amplifier iterations at which to pull a full heap snapshot. amp-1 is a near-baseline
// reference; the rest sample the ratchet as it climbs. Taking a snapshot forces a full GC
// first, so whatever detached DOM the snapshot reports is genuinely RETAINED (not transient
// garbage). The renderer can crash mid-amplifier (seen as early as ~iteration 3), so the
// early captures are insurance and the later ones are richer if it survives.
const AMP_SNAPSHOT_AT = [1, 4, 8, 12, 16, 20];

// Thin wrapper around Cypress's CDP channel. Resolves with the CDP result object.
const cdp = (command, params = {}) =>
  Cypress.automation('remote:debugger:protocol', { command, params });

// Swallow CDP errors (target may have crashed) so we always fall through to cleanup.
const cdpSafe = (command, params) =>
  cdp(command, params).catch((e) => ({ __cdpError: String(e) }));

let originalName;
let checkpoint = 0;

const dumpCpuCheckpoint = () =>
  cy.then(() =>
    cdpSafe('Profiler.stop').then((res) => {
      if (res?.profile)
        cy.task('probeWriteProfile', {
          name: `cpu-${String(checkpoint).padStart(3, '0')}.cpuprofile`,
          data: res.profile,
        });
      checkpoint++;
      return cdpSafe('Profiler.start');
    }),
  );

const dumpHeapCheckpoint = (final) =>
  cy.then(() =>
    cdpSafe(
      final ? 'HeapProfiler.stopSampling' : 'HeapProfiler.getSamplingProfile',
    ).then((res) => {
      if (res?.profile)
        cy.task('probeWriteProfile', {
          name: final
            ? 'heap-final.heapprofile'
            : `heap-${String(checkpoint).padStart(3, '0')}.heapprofile`,
          data: res.profile,
        });
    }),
  );

const sampleMetrics = (tag) =>
  cy.then(() =>
    cdpSafe('Performance.getMetrics').then((res) => {
      const metrics = res?.metrics;
      // Memory.getDOMCounters returns its payload in the command response (like
      // Performance.getMetrics), so it's a cheap, event-free live-DOM counter series
      // (documents/nodes/jsEventListeners) parallel to the LayoutObjects metric — the
      // two together confirm the growth is live attached DOM, not detached documents.
      return cdpSafe('Memory.getDOMCounters').then((dom) => {
        const domCounters = dom?.__cdpError
          ? undefined
          : {
              documents: dom?.documents,
              nodes: dom?.nodes,
              jsEventListeners: dom?.jsEventListeners,
            };
        cy.task('probeAppend', {
          file: 'cdp-metrics.jsonl',
          line: JSON.stringify({ ts: Date.now(), tag, metrics, domCounters }),
        });
        // return JSHeapUsedSize in MB for the live-hold abort check
        const used = Array.isArray(metrics)
          ? metrics.find((m) => m.name === 'JSHeapUsedSize')?.value
          : undefined;
        return used ? Math.round(used / 1048576) : null;
      });
    }),
  );

const snapshotInPage = (tag) =>
  cy.window({ log: false }).then((win) => {
    try {
      const snap = win.__loopProbe?.snapshot?.();
      if (snap)
        cy.task('probeAppend', {
          file: 'live-hold.jsonl',
          line: JSON.stringify({ tag, ...snap }),
        });
    } catch (e) {
      /* renderer may be pegged/crashed; ignore */
    }
  });

// Pull a full heap snapshot over the Node-side CDP WebSocket (plugins/heap-snapshot.js).
// This is the artifact that names the RETAINER holding the detached DOM (the sampling
// .heapprofile only shows allocation sites). taskTimeout is 10s globally, so override
// it — a snapshot of the AUT heap takes tens of seconds. Best-effort: the task never
// throws, and we log the {ok,...} outcome to live-hold.jsonl for correlation.
const heapSnapshot = (tag) =>
  cy
    .task(
      'probeHeapSnapshot',
      { name: `heap-${tag}.heapsnapshot` },
      { timeout: 180000 },
    )
    .then((res) =>
      cy.task('probeAppend', {
        file: 'live-hold.jsonl',
        line: JSON.stringify({
          tag: `heapsnapshot-${tag}`,
          ts: Date.now(),
          res,
        }),
      }),
    );

// Pull a native (Blink C++) memory-infra dump over the Node-side CDP WebSocket
// (plugins/memory-dump.js). The V8 heap snapshot names detached DOM but cannot weigh its
// native cost; this dump gives the per-allocator breakdown (malloc/partition_alloc/blink_gc
// /v8) that proves the RSS ratchet is Blink native memory. taskTimeout is 10s globally, so
// override it. Best-effort: the task never throws; the {ok,...} outcome is logged to
// live-hold.jsonl for correlation. Issued AFTER the heap snapshot on the same tick so the
// two CDP captures never overlap on one target.
const memoryDump = (tag) =>
  cy
    .task('probeMemoryDump', { name: `mem-${tag}` }, { timeout: 60000 })
    .then((res) =>
      cy.task('probeAppend', {
        file: 'live-hold.jsonl',
        line: JSON.stringify({ tag: `memdump-${tag}`, ts: Date.now(), res }),
      }),
    );

// One rename cycle mirroring tests/cluster/test-edit-cluster.spec.js.
const editCycle = (i) => {
  cy.visit(`${config.clusterAddress}/clusters`);
  cy.get('ui5-button[data-testid="edit"]', { timeout: 20000 }).click();
  cy.get('ui5-input[data-testid="cluster-description"]')
    .find('input')
    .click()
    .type(`${DESC} ${i}`);
  cy.get('ui5-input[data-testid="cluster-name"]')
    .first()
    .find('input')
    .type('{selectall}{backspace}')
    .type(`${TEMP_NAME}-${i}`);
  cy.contains('ui5-button', 'Update').click();
  cy.get('ui5-shellbar')
    .find('ui5-button#clusterSwitcherOpener')
    .should('be.visible');
  // rename back so the next iteration starts from a known name
  cy.visit(`${config.clusterAddress}/clusters`);
  cy.get('ui5-button[data-testid="edit"]', { timeout: 20000 }).click();
  cy.get('ui5-input[data-testid="cluster-name"]')
    .first()
    .find('input')
    .wait(300)
    .type('{selectall}{backspace}')
    .type(originalName);
  cy.contains('ui5-button', 'Update').click();
  cy.get('ui5-shellbar')
    .find('ui5-button#clusterSwitcherOpener')
    .should('be.visible');
};

(PROBE_ON ? context : context.skip)('edit-cluster loop probe', () => {
  before(() => {
    cy.loginAndSelectCluster();
    cy.visit(`${config.clusterAddress}/clusters`);
    cy.get('ui5-table-cell')
      .find('ui5-link[design="Emphasized"]')
      .should('be.visible')
      .then((el) => (originalName = el.text()));
  });

  after(() => {
    // final profile dump — runs even after an assertion failure (best-effort if the
    // browser is still alive; periodic checkpoints cover a hard crash)
    dumpHeapCheckpoint(true);
    cy.then(() =>
      cdpSafe('Profiler.stop').then((res) => {
        if (res?.profile)
          cy.task('probeWriteProfile', {
            name: 'cpu-final.cpuprofile',
            data: res.profile,
          });
      }),
    );
  });

  it('arms CDP profiling', () => {
    cy.then(() => cdpSafe('Profiler.enable'));
    cy.then(() => cdpSafe('Profiler.setSamplingInterval', { interval: 500 }));
    cy.then(() => cdpSafe('Profiler.start'));
    cy.then(() => cdpSafe('HeapProfiler.enable'));
    cy.then(() =>
      cdpSafe('HeapProfiler.startSampling', { samplingInterval: 32768 }),
    );
    cy.then(() => cdpSafe('Performance.enable'));
    sampleMetrics('armed');
  });

  it('idle-holds on a freshly opened edit-cluster (single-page fidelity)', () => {
    // Open the edit-cluster form ONCE and then sit idle — no navigation, no typing.
    // This reproduces the ORIGINAL signature (page loads, left alone, RSS ratchets)
    // on a single window, and captures DOM attribution + a Cypress-uncontaminated
    // CPU profile before the amplifier introduces any command/actionability churn.
    cy.visit(`${config.clusterAddress}/clusters`);
    cy.get('ui5-button[data-testid="edit"]', { timeout: 20000 }).click();
    cy.get('ui5-input[data-testid="cluster-name"]', { timeout: 20000 })
      .find('input')
      .should('be.visible');
    // fresh CPU profile so this idle window's loop is isolated from arm/amplifier
    dumpCpuCheckpoint();

    const idleStep = (n) => {
      if (n <= 0) return;
      cy.wait(HOLD_INTERVAL_MS);
      snapshotInPage(`idle-${IDLE_SAMPLES - n}`);
      sampleMetrics(`idle-${IDLE_SAMPLES - n}`).then((usedMB) => {
        if (n % 15 === 0) {
          dumpCpuCheckpoint();
          dumpHeapCheckpoint(false);
        }
        if (usedMB && usedMB >= HEAP_ABORT_MB) {
          cy.task('probeAppend', {
            file: 'live-hold.jsonl',
            line: JSON.stringify({
              tag: 'idle-heap-abort',
              usedMB,
              ts: Date.now(),
            }),
          });
          dumpCpuCheckpoint();
          dumpHeapCheckpoint(false);
          return;
        }
        idleStep(n - 1);
      });
    };
    cy.then(() => idleStep(IDLE_SAMPLES));
  });

  // Each amplifier iteration is its OWN test so Cypress releases the command queue between
  // iterations (numTestsKeptInMemory:0). This strips the harness confound from the captured
  // heap snapshots: a single giant it() would accumulate hundreds of cy command `subject`s,
  // and those jQuery subjects pin every navigated-away page's detached DOM — a snapshot then
  // shows Cypress's CommandQueue as the (nearest-root) retainer, masking the genuine one.
  // With per-iteration tests, only the current cycle's few subjects exist at snapshot time,
  // so the real retainer (the app/UI5 structure that survives across tests via the persistent
  // AUT window) is the shortest path in the graph, not Cypress.
  for (let i = 0; i < AMPLIFIER_ITERATIONS; i++) {
    it(`amplifies the edit-cluster rename flow #${i}`, () => {
      editCycle(i);
      sampleMetrics(`amp-${i}`);
      snapshotInPage(`amp-${i}`);
      if (AMP_SNAPSHOT_AT.includes(i)) {
        heapSnapshot(`amp-${i}`);
        memoryDump(`amp-${i}`);
      }
      if (i > 0 && i % CHECKPOINT_EVERY === 0) {
        dumpCpuCheckpoint();
        dumpHeapCheckpoint(false);
      }
    });
  }

  it('holds and observes while the loop ratchets', () => {
    // Bonus retainer snapshots if the amplifier survived all iterations without crashing.
    // The authoritative captures are the in-amplifier ones above (this test often never
    // runs — the renderer usually crashes during the amplifier).
    heapSnapshot('holdstart');
    memoryDump('holdstart');

    const holdStep = (n) => {
      if (n <= 0) return;
      cy.wait(HOLD_INTERVAL_MS);
      snapshotInPage(`hold-${HOLD_SAMPLES - n}`);
      sampleMetrics(`hold-${HOLD_SAMPLES - n}`).then((usedMB) => {
        // checkpoint every ~30s of holding
        if (n % 15 === 0) {
          dumpCpuCheckpoint();
          dumpHeapCheckpoint(false);
        }
        // a second retainer snapshot mid-hold, once more DOM has ratcheted
        if (HOLD_SAMPLES - n === 40) {
          heapSnapshot('hold-mid');
          memoryDump('hold-mid');
        }
        if (usedMB && usedMB >= HEAP_ABORT_MB) {
          cy.task('probeAppend', {
            file: 'live-hold.jsonl',
            line: JSON.stringify({ tag: 'heap-abort', usedMB, ts: Date.now() }),
          });
          dumpCpuCheckpoint();
          dumpHeapCheckpoint(false);
          heapSnapshot('heap-abort');
          memoryDump('heap-abort');
          return; // stop holding; we've captured the ratchet near the cap
        }
        holdStep(n - 1);
      });
    };
    cy.then(() => holdStep(HOLD_SAMPLES));
  });
});
