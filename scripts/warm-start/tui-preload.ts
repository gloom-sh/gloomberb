import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { heapStats } from "bun:jsc";
import { dirname, join } from "path";
import { CliRenderer } from "@opentui/core";
import { installWarmStartNetwork, warmStartNetworkFromEnv } from "./network";
import { terminalPaneStates, type PaneShownState } from "./pane-states";

/**
 * Loaded with `bun --preload` before the terminal app: puts the benchmark's
 * network under `fetch` and, after every frame the renderer draws, writes
 * each pane whose state changed to `WARM_START_PROBE_OUT` as one JSON line,
 * `{ at, frame, panes }`, with `at` in ms since the epoch.
 */
const out = process.env.WARM_START_PROBE_OUT;
const network = warmStartNetworkFromEnv();
const counts = { kept: 0, fetched: 0, refused: 0, streamed: 0 };
const networkLog = process.env.WARM_START_NET_LOG;
if (network) installWarmStartNetwork({ ...network, log: (event, url) => {
  counts[event] += 1;
  if (out) appendFileSync(out, `${JSON.stringify({ at: Date.now(), network: counts })}\n`);
  if (networkLog) appendFileSync(networkLog, `${Date.now()} ${event} ${url}\n`);
} });

if (out) {
  writeFileSync(out, "");
  const home = dirname(out);
  const trigger = join(home, "collect-heap");
  const result = join(home, "heap-bytes");
  if (process.env.WARM_START_METRICS === "1") {
    setInterval(() => {
      if (!existsSync(trigger)) return;
      const snapshot = readFileSync(trigger, "utf8");
      unlinkSync(trigger);
      Bun.gc(true);
      const bytes = heapStats().heapSize;
      if (snapshot) writeFileSync(`${snapshot}.heapsnapshot`, new Uint8Array(Bun.generateHeapSnapshot("v8", "arraybuffer")));
      writeFileSync(result, String(bytes));
    }, 100).unref();
  }
  const last = new Map<string, PaneShownState>();
  let frame = 0;
  const proto = CliRenderer.prototype as unknown as { renderNative: (...args: unknown[]) => unknown };
  const renderNative = proto.renderNative;
  proto.renderNative = function (this: { root: Parameters<typeof terminalPaneStates>[0] }, ...args: unknown[]) {
    const status = renderNative.apply(this, args);
    if (status === undefined || status === "rendered") {
      frame += 1;
      const changed: Record<string, PaneShownState> = {};
      let any = false;
      for (const [id, state] of terminalPaneStates(this.root)) {
        if (last.get(id) === state) continue;
        last.set(id, state);
        changed[id] = state;
        any = true;
      }
      if (any) appendFileSync(out, `${JSON.stringify({ at: Date.now(), frame, panes: changed, network: counts })}\n`);
    }
    return status;
  };
  process.on("exit", () => {
    try { appendFileSync(out, `${JSON.stringify({ at: Date.now(), network: counts, exit: true })}\n`); } catch { /* Intentional ignore: the run reads what was written. */ }
  });
}
