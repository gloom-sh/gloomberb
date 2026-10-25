import { expect, test } from "bun:test";
import type { LiveScanPayload, LiveScanWireDefinition } from "../../../api-client/live-scan";
import { LiveScanPoller, nextLiveScanPoll, type LiveScanFeedState } from "./live-feed";

const NOW = Date.UTC(2026, 9, 26, 18, 0, 0);
const definition = (percent: number): LiveScanWireDefinition => ({
  version: 1, universe: { kind: "all" }, conditions: [{ kind: "move", window: 5, direction: "up", percent }],
});
const payload = (extra: Partial<LiveScanPayload> = {}): LiveScanPayload => ({
  status: "live", access: "realtime", delayMinutes: 0, asOf: NOW, takenAt: NOW, refreshMs: 15_000,
  scanned: 10, matched: 0, matches: [], warmingWindows: [], warnings: [], ...extra,
});

/** A client whose answers the test hands out, and timers it runs by hand. */
function harness() {
  const requests: Array<{ definition: LiveScanWireDefinition; signal: AbortSignal; resolve: (payload: LiveScanPayload) => void; reject: (error: Error) => void }> = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const states: LiveScanFeedState[] = [];
  const poller = new LiveScanPoller(
    {
      getLiveScan: (definition, signal) => new Promise<LiveScanPayload>((resolve, reject) => {
        requests.push({ definition, signal: signal!, resolve, reject });
      }),
    },
    (state) => states.push(state),
    {
      set: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    () => NOW,
  );
  const fire = () => {
    const timer = timers.filter((entry) => !entry.cleared).at(-1)!;
    timer.cleared = true;
    timer.callback();
  };
  return { poller, requests, timers, states, fire, last: () => states.at(-1)! };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("asks again a second after the snapshot's next refresh, slowly at the close, soon while starting", () => {
  expect(nextLiveScanPoll(payload(), false, NOW + 2_000)).toBe(14_000);
  expect(nextLiveScanPoll(payload({ refreshMs: 60_000 }), false, NOW + 2_000)).toBe(59_000);
  // An answer that is already old by the time it lands waits a full interval.
  expect(nextLiveScanPoll(payload(), false, NOW + 40_000)).toBe(15_000);
  expect(nextLiveScanPoll(payload({ status: "closed" }), false, NOW)).toBe(300_000);
  expect(nextLiveScanPoll(payload({ status: "starting" }), false, NOW)).toBe(3_000);
  expect(nextLiveScanPoll(payload(), true, NOW)).toBe(30_000);
});

test("polls the scan on the snapshot's cadence and keeps the last matches through a failed refresh", async () => {
  const { poller, requests, timers, fire, last } = harness();
  poller.setScan(definition(2), "a");
  poller.setEnabled(true);
  expect(requests).toHaveLength(1);
  expect(last().loading).toBe(true);
  requests[0]!.resolve(payload({ matched: 1 }));
  await flush();
  expect(last()).toMatchObject({ loading: false, error: null, payload: { matched: 1 } });
  expect(timers.at(-1)!.ms).toBe(16_000);

  fire();
  expect(requests).toHaveLength(2);
  requests[1]!.reject(new Error("Gloom Cloud is unreachable"));
  await flush();
  expect(last()).toMatchObject({ error: "Gloom Cloud is unreachable", payload: { matched: 1 } });
  expect(timers.at(-1)!.ms).toBe(30_000);
});

test("a new scan drops the old answer, aborts its request and ignores it if it lands", async () => {
  const { poller, requests, last } = harness();
  poller.setScan(definition(2), "a");
  poller.setEnabled(true);
  poller.setScan(definition(5), "b");
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.definition).toEqual(definition(5));
  requests[0]!.resolve(payload({ matched: 99 }));
  await flush();
  expect(last().payload).toBeNull();
  requests[1]!.resolve(payload({ matched: 3 }));
  await flush();
  expect(last().payload?.matched).toBe(3);
});

test("stopping keeps what is on screen and asks nothing until started again", async () => {
  const { poller, requests, timers, last } = harness();
  poller.setScan(definition(2), "a");
  poller.setEnabled(true);
  requests[0]!.resolve(payload({ matched: 4 }));
  await flush();
  poller.setEnabled(false);
  expect(timers.every((timer) => timer.cleared)).toBe(true);
  expect(last().payload?.matched).toBe(4);
  poller.setEnabled(true);
  expect(requests).toHaveLength(2);
});
