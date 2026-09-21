import { expect, test } from "bun:test";
import { startMainThreadStallMonitor } from "./main-thread-stall";
import { measurePerf } from "./perf-marks";

function createHarness() {
  let clock = 0;
  let tick: (() => void) | null = null;
  const reports: Array<{ blockedMs: number; context: Record<string, unknown> }> = [];
  const stop = startMainThreadStallMonitor({
    intervalMs: 250,
    thresholdMs: 400,
    now: () => clock,
    schedule: (callback) => { tick = callback; return 1; },
    cancel: () => { tick = null; },
    report: (blockedMs, context) => { reports.push({ blockedMs, context }); },
  });
  return {
    reports,
    stop,
    advance: (ms: number) => { clock += ms; },
    fire: () => tick?.(),
    get clock() { return clock; },
  };
}

test("a timer that comes back on time reports nothing", () => {
  const harness = createHarness();
  for (let index = 0; index < 4; index += 1) {
    harness.advance(256);
    harness.fire();
  }
  harness.stop();

  expect(harness.reports).toEqual([]);
});

test("a blocked loop is reported with the work that ran before it", () => {
  const harness = createHarness();
  harness.advance(250);
  harness.fire();

  measurePerf("cache.read", () => {});
  harness.advance(3_600);
  harness.fire();
  harness.stop();

  expect(harness.reports).toHaveLength(1);
  expect(harness.reports[0]?.blockedMs).toBe(3_350);
  expect(harness.reports[0]?.context.lastMeasured).toBe("cache.read");
});

test("stopping the monitor ends the reports", () => {
  const harness = createHarness();
  harness.stop();
  harness.advance(5_000);
  harness.fire();

  expect(harness.reports).toEqual([]);
});
