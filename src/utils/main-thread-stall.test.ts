import { expect, test } from "bun:test";
import {
  markStartupComplete,
  resetStartupCompleteForTests,
  setStallSink,
  startMainThreadStallMonitor,
  type StallEvent,
} from "./main-thread-stall";
import { measurePerf, recordPerfSample } from "./perf-marks";

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

// The monitor logs each stall as a sample of its own, and reporting one
// reads the windows through measured calls. Were either the step the next
// stall names, every stall after the first would read "after runtime.stall"
// or the window read, and hide what really ran before it.
test("stalls keep naming the work before them, with a SQLite statement's facts and the startup phase", () => {
  const events: StallEvent[] = [];
  const disposeSink = setStallSink((event) => {
    events.push(event);
    measurePerf("native.window.is-minimized", () => {});
  });
  let clock = 0;
  let tick: (() => void) | null = null;
  const stop = startMainThreadStallMonitor({
    now: () => clock,
    schedule: (callback) => { tick = callback; return 1; },
    cancel: () => { tick = null; },
  });
  try {
    recordPerfSample("sqlite.blocked", 900, { operation: "touch cached resource", attempts: 2, lockWait: true });
    clock += 1_250;
    tick!();
    markStartupComplete();
    clock += 1_250;
    tick!();
  } finally {
    stop();
    disposeSink();
    resetStartupCompleteForTests();
  }

  expect(events.map(({ lastMeasured, sqlite, phase, uptimeMs }) => ({ lastMeasured, sqlite, phase, uptimeMs }))).toEqual([
    { lastMeasured: "sqlite.blocked", sqlite: { operation: "touch cached resource", attempts: 2, lockWait: true }, phase: "startup", uptimeMs: 1_250 },
    { lastMeasured: "sqlite.blocked", sqlite: { operation: "touch cached resource", attempts: 2, lockWait: true }, phase: "steady", uptimeMs: 2_500 },
  ]);
});

// Windows keeps the timers' clock running while the computer sleeps, so a
// closed lid read as a freeze of minutes. Only the awake part of a late
// timer is a stall, and the platform's clocks say whether the thread was
// busy or waiting through it.
test("the time the computer slept is taken out, and a stall says how busy the thread and the others were", () => {
  let clock = 0;
  const clocks = { awakeMs: 0, threadCpuMs: 0, processCpuMs: 0 };
  let tick: (() => void) | null = null;
  const reports: Array<{ blockedMs: number; context: Record<string, unknown> }> = [];
  const stop = startMainThreadStallMonitor({
    now: () => clock,
    clocks: () => ({ ...clocks }),
    schedule: (callback) => { tick = callback; return 1; },
    cancel: () => { tick = null; },
    report: (blockedMs, context) => { reports.push({ blockedMs, context }); },
  });
  try {
    // Asleep for 40 minutes, awake for the timer's quarter second.
    clock += 2_400_250;
    clocks.awakeMs += 250;
    tick!();
    // Asleep 10 minutes, then 1.5 s of waiting on the disk with a little help elsewhere.
    clock += 601_750;
    clocks.awakeMs += 1_750;
    clocks.threadCpuMs += 75;
    clocks.processCpuMs += 75 + 350;
    tick!();
    // 2 s of script.
    clock += 2_250;
    clocks.awakeMs += 2_250;
    clocks.threadCpuMs += 1_980;
    clocks.processCpuMs += 1_980 + 225;
    tick!();
  } finally {
    stop();
  }

  expect(reports.map(({ blockedMs, context }) => ({ blockedMs, threadCpu: context.threadCpu, otherCpu: context.otherCpu }))).toEqual([
    { blockedMs: 1_500, threadCpu: 0.05, otherCpu: 0.2 },
    { blockedMs: 2_000, threadCpu: 0.99, otherCpu: 0.1 },
  ]);
});
