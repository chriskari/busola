//
// Node-side CDP native-memory (memory-infra) capture for the edit-cluster OOM loop probe.
//
// WHY THIS EXISTS: a V8 .heapsnapshot NAMES which DOM objects are detached but cannot
// WEIGH their native (Blink C++) cost — it represents them as small `native` stubs. The
// edit-cluster ratchet lives in Blink native allocators (attached layout tree: LayoutObject
// / PhysicalBoxFragment / ComputedStyle, plus partition_alloc / malloc), so we need an
// allocator-level breakdown the heapsnapshot cannot give. CDP's Tracing domain with the
// `disabled-by-default-memory-infra` category + Tracing.requestMemoryDump produces exactly
// that: per-allocator resident/effective sizes (malloc, partition_alloc, blink_gc, v8) and
// process_totals.resident_set_bytes.
//
// WHY NODE-SIDE (same reason as heap-snapshot.js): the memory dump is delivered as a stream
// of `Tracing.dataCollected` *events*, terminated by a `Tracing.tracingComplete` *event* —
// not a command response. Cypress's in-spec remote:debugger:protocol automation is
// request/response only and cannot subscribe to CDP events, so the trace has to be pulled
// from the plugins (Node) process over an independent CDP WebSocket. Node 24's built-in
// global `WebSocket` means no extra npm dependency. Port discovery + target selection are
// shared with heap-snapshot.js (imported below), and Chrome allows multiple CDP clients per
// target so this runs alongside Cypress's own connection.
//
// The result is gzipped JSONL (.memtrace.jsonl.gz), ONE trace event per line: a detailed
// dump emits many dataCollected events and buffering them into a single string would hit
// Node's ~512MB max-string-length ceiling (the same trap heap-snapshot.js streams around).
// Read it back line-by-line (see loop-probe/analyze.mjs).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readDevToolsPort, pickPageTarget } = require('./heap-snapshot');

// Capture one native memory-infra dump to <outDir>/<name>.memtrace.jsonl.gz. Never throws —
// resolves with an {ok, ...} result object the caller logs, so a capture failure never fails
// the run. `port` (from Cypress's --remote-debugging-port arg) is preferred; `userDataDir`
// is a fallback that reads the DevToolsActivePort file.
async function captureMemoryDump({
  port: portArg,
  userDataDir,
  name,
  outDir,
  timeoutMs = 60000,
}) {
  const port = portArg || readDevToolsPort(userDataDir);
  if (!port) return { ok: false, reason: 'no CDP port', portArg, userDataDir };

  let targetInfo;
  try {
    targetInfo = await pickPageTarget(port);
  } catch (e) {
    return { ok: false, reason: `json/list failed: ${e}`, port };
  }
  const target = targetInfo.chosen;
  if (!target) {
    return { ok: false, reason: 'no page target', port, all: targetInfo.all };
  }

  return await new Promise((resolve) => {
    let ws;
    let done = false;
    let events = 0;
    let dumpGuid = null;
    // CDP command ids: 1=Tracing.start, 2=Tracing.requestMemoryDump, 3=Tracing.end.
    const START_ID = 1;
    const DUMP_ID = 2;
    const END_ID = 3;

    // Stream each trace event as one gzipped JSONL line. Created lazily on the first
    // dataCollected so a trace that errors before any data leaves no empty file.
    let gzip = null;
    let fileStream = null;
    const outPath = path.join(outDir, `${name}.memtrace.jsonl.gz`);

    const ensureStreams = () => {
      if (gzip) return;
      fs.mkdirSync(outDir, { recursive: true });
      fileStream = fs.createWriteStream(outPath);
      gzip = zlib.createGzip();
      gzip.pipe(fileStream);
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
      resolve({ target: target.url, port, ...result });
    };

    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', events }),
      timeoutMs,
    );

    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch (e) {
      return finish({ ok: false, reason: `ws construct: ${e}` });
    }

    ws.addEventListener('open', () => {
      // ReportEvents => dumps arrive as Tracing.dataCollected events over this socket.
      // The category name is exact: a typo yields an empty-but-successful trace.
      ws.send(
        JSON.stringify({
          id: START_ID,
          method: 'Tracing.start',
          params: {
            transferMode: 'ReportEvents',
            traceConfig: {
              includedCategories: ['disabled-by-default-memory-infra'],
              memoryDumpConfig: {},
            },
          },
        }),
      );
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }

      // Accumulate the streamed trace events (each dataCollected carries an array).
      if (msg.method === 'Tracing.dataCollected') {
        const value = msg.params?.value;
        if (Array.isArray(value)) {
          try {
            ensureStreams();
            for (const e of value) {
              gzip.write(JSON.stringify(e) + '\n');
              events++;
            }
          } catch (e) {
            return finish({ ok: false, reason: `write: ${e}`, events });
          }
        }
        return;
      }

      // The trace terminates on the tracingComplete EVENT (not a command response) —
      // this is the key difference from heap-snapshot's id-based terminator.
      if (msg.method === 'Tracing.tracingComplete') {
        if (!gzip) {
          return finish({ ok: false, reason: 'no trace events', dumpGuid });
        }
        fileStream.on('finish', () => {
          let gzBytes = 0;
          try {
            gzBytes = fs.statSync(outPath).size;
          } catch {
            /* ignore */
          }
          finish({ ok: true, events, gzBytes, dumpGuid });
        });
        fileStream.on('error', (e) =>
          finish({ ok: false, reason: `write: ${e}`, events }),
        );
        gzip.end();
        return;
      }

      // Command responses.
      if (msg.id === START_ID) {
        if (msg.error) {
          return finish({
            ok: false,
            reason: `Tracing.start: ${msg.error.message}`,
          });
        }
        // deterministic:true forces a GC before the dump, so reported native memory is
        // retained, not transient — parity with the heap snapshots' pre-snapshot GC.
        ws.send(
          JSON.stringify({
            id: DUMP_ID,
            method: 'Tracing.requestMemoryDump',
            params: { deterministic: true, levelOfDetail: 'detailed' },
          }),
        );
      } else if (msg.id === DUMP_ID) {
        if (msg.error) {
          return finish({
            ok: false,
            reason: `requestMemoryDump: ${msg.error.message}`,
          });
        }
        dumpGuid = msg.result?.dumpGuid || null;
        if (msg.result && msg.result.success === false) {
          // still end the trace so we don't hang; report the failed dump
          ws.send(JSON.stringify({ id: END_ID, method: 'Tracing.end' }));
          return;
        }
        ws.send(JSON.stringify({ id: END_ID, method: 'Tracing.end' }));
      } else if (msg.id === END_ID && msg.error) {
        return finish({
          ok: false,
          reason: `Tracing.end: ${msg.error.message}`,
          events,
        });
      }
    });

    ws.addEventListener('error', () =>
      finish({ ok: false, reason: 'ws error', events }),
    );
  });
}

module.exports = { captureMemoryDump };
