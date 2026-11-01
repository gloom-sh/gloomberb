import { afterEach, describe, expect, test } from "bun:test";
import type { CrashReportsPayload } from "../api-client";
import { flushCrashReports, installCrashReporter, resetCrashReporterForTests } from "./crash-reports";
import { forwardAttendedStalls } from "./stall-reports-dom";
import {
  formatStallReportDetails,
  installStallReporter,
  recordStall,
  resetStallReporterForTests,
  setStallAttentionProbe,
  type StallReport,
  type StallReporterHost,
  type StallReportState,
} from "./stall-reports";

const HOUR_MS = 60 * 60 * 1000;

/** A reporter whose disk is `stored` and whose clock is `clock.now`; reports land in `sent`, log lines in `log`. */
function fakeReporter(overrides: Partial<StallReporterHost> = {}) {
  const clock = { now: Date.parse("2026-10-27T14:43:00Z") };
  let stored: StallReportState = { sent: {}, pending: {} };
  const sent: StallReport[] = [];
  const log: string[] = [];
  installStallReporter({
    appVersion: "0.18.6",
    platform: "darwin",
    arch: "arm64",
    appendLog: (line) => { log.push(line); },
    load: () => JSON.parse(JSON.stringify(stored)),
    save: (state) => { stored = JSON.parse(JSON.stringify(state)); },
    now: () => clock.now,
    send: (report) => { sent.push(report); },
    ...overrides,
  });
  return { clock, sent, log };
}

afterEach(() => {
  resetStallReporterForTests();
  resetCrashReporterForTests();
});

describe("stall reports", () => {
  // Section names can embed a queue key or a symbol; only the fixed leading part may leave.
  test("a freeze sends its bucket, the section's fixed name and counts, and keeps the full section in the local log", async () => {
    const crashReports: CrashReportsPayload[] = [];
    installCrashReporter({
      surface: "desktop",
      homeDir: "/Users/alice",
      isEnabled: () => true,
      getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
      send: async (payload) => { crashReports.push(payload); },
    });
    const { log } = fakeReporter({ send: undefined });

    recordStall("window", {
      blockedMs: 2_340,
      lastMeasured: "chart.resolve:AAPL /Users/alice/x",
      lastMeasuredEndedMsAgo: 3_000,
      uptimeMs: 95_000,
      phase: "steady",
    });
    await flushCrashReports();

    expect(log).toEqual(["2026-10-27T14:43:00Z  window    froze  2.3 s  last measured: chart.resolve:AAPL /Users/alice/x, ended 3000 ms before  [phase=steady up=30s-2m gap=<1s]"]);
    const errors = crashReports.flatMap((payload) => payload.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "MainThreadStall",
      message: "2-5s after chart.resolve",
      plugin: "stall-monitor",
      pane: "process=window count=1 longest=2300ms phase=steady up=30s-2m gap=<1s day=1 platform=macos-arm64",
    });
    expect(JSON.stringify(crashReports)).not.toMatch(/AAPL|alice/);
  });

  test("one report per kind a day; the stalls in between are counted into the next one", () => {
    const { clock, sent, log } = fakeReporter();

    recordStall("window", { blockedMs: 1_200, lastMeasured: "layout.save" });
    clock.now += HOUR_MS;
    recordStall("window", { blockedMs: 1_900, lastMeasured: "layout.save" });
    recordStall("window", { blockedMs: 1_400, lastMeasured: "layout.save" });
    // Another kind has its own slot, and a short freeze is only logged.
    recordStall("app", { blockedMs: 1_100 });
    recordStall("window", { blockedMs: 600, lastMeasured: "layout.save" });
    clock.now += 24 * HOUR_MS;
    recordStall("window", { blockedMs: 1_000, lastMeasured: "layout.save" });

    expect(log).toHaveLength(6);
    expect(sent.map(({ process, bucket, section, count, longestMs }) => ({ process, bucket, section, count, longestMs }))).toEqual([
      { process: "window", bucket: "1-2s", section: "layout.save", count: 1, longestMs: 1_200 },
      { process: "app", bucket: "1-2s", section: "unmeasured", count: 1, longestMs: 1_100 },
      { process: "window", bucket: "1-2s", section: "layout.save", count: 3, longestMs: 1_900 },
    ]);
  });
});

describe("app stalls", () => {
  // The desktop app's own process: a SQLite statement that held it names
  // itself, says whether it waited on another program's lock, and the
  // report says whether anyone was looking, whether the thread was busy or
  // waiting, and how often it happened today.
  test("a stall after a SQLite statement names the statement, its tries and the lock, with the app's attention and CPU", () => {
    const { clock, sent, log } = fakeReporter();
    setStallAttentionProbe(() => ({ active: false, visible: true }));
    const event = {
      blockedMs: 2_100,
      lastMeasured: "sqlite.blocked",
      lastMeasuredEndedMsAgo: 400,
      sqlite: { operation: "touch cached resource", attempts: 3, lockWait: true },
      uptimeMs: 40 * 60_000,
      phase: "steady" as const,
    };

    recordStall("app", event);
    clock.now += HOUR_MS;
    recordStall("app", { blockedMs: 1_500, uptimeMs: 100 * 60_000, phase: "steady", threadCpu: 0.04, otherCpu: 1.27 });
    clock.now += HOUR_MS;
    recordStall("app", event);
    // A sub-second stall is logged without asking the windows.
    setStallAttentionProbe(() => { throw new Error("must not be read"); });
    recordStall("app", { blockedMs: 600 });

    expect(sent.map((report) => [report.section, formatStallReportDetails(report)])).toEqual([
      ["sqlite.blocked.touch-cached-resource", "process=app count=1 longest=2100ms phase=steady up=10-60m gap=in fg=0 vis=1 lock=1 try=3 day=1 platform=macos-arm64"],
      ["unmeasured", "process=app count=1 longest=1500ms phase=steady up=1-6h gap=none fg=0 vis=1 cpu=0 oth=130 day=2 platform=macos-arm64"],
    ]);
    expect(log[0]).toEndWith("last measured: sqlite.blocked, ended 400 ms before (touch cached resource, 3 tries, waited on a lock)  [phase=steady up=10-60m gap=in fg=0 vis=1]");
    expect(log[1]).toEndWith("nothing measured before it  [phase=steady up=1-6h gap=none fg=0 vis=1 cpu=0 oth=130]");
    expect(log[3]).toEndWith("nothing measured before it  [phase=unknown up=unknown gap=none]");
  });

  // Error tracking keeps 120 characters of the details line.
  test("the details line fits error tracking with every field at its longest", () => {
    const details = formatStallReportDetails({
      process: "app",
      bucket: "15s+",
      section: "sqlite.blocked.save-plugin-state",
      appVersion: "0.19.1",
      platform: "windows",
      arch: "arm64",
      count: 999,
      longestMs: 123_400,
      day: 500,
      phase: "startup",
      uptime: "30s-2m",
      gap: "10-60s",
      active: null,
      visible: null,
      attempts: 99,
      lockWait: true,
      cpuPercent: 100,
      otherCpuPercent: 990,
    });

    expect(details.length).toBeLessThanOrEqual(120);
    expect(details).toBe("process=app count=999 longest=123400ms phase=startup up=30s-2m gap=10-60s fg=? vis=? cpu=100 oth=990 lock=1 try=99");
  });
});

describe("window stalls", () => {
  /** A window the test moves in front of the user and away; its clock is `clock.now`. */
  function fakeWindow() {
    const clock = { now: 10_000 };
    const view = { visible: true, focused: false };
    const target = new EventTarget();
    const doc = Object.defineProperties(new EventTarget(), {
      visibilityState: { get: () => view.visible ? "visible" : "hidden" },
      hasFocus: { value: () => view.focused },
    });
    Object.assign(target, { document: doc });
    const set = (next: Partial<typeof view>) => {
      Object.assign(view, next);
      if (next.focused !== undefined) target.dispatchEvent(new Event(next.focused ? "focus" : "blur"));
      if (next.visible !== undefined) doc.dispatchEvent(new Event("visibilitychange"));
    };
    return { clock, set, target: target as unknown as Window };
  }

  // A window behind others has its timers slowed to about one a second, which reads as a freeze.
  test("only a window in front with focus since before the stall began forwards it", () => {
    const { clock, set, target } = fakeWindow();
    const forwarded: number[] = [];
    const { sink } = forwardAttendedStalls((event) => { forwarded.push(event.blockedMs); }, target, () => clock.now);

    sink({ blockedMs: 900 });
    set({ focused: true });
    clock.now += 500;
    // Its timer was slowed in the background and came back after the focus.
    sink({ blockedMs: 900 });
    clock.now += 5_000;
    sink({ blockedMs: 2_000 });
    set({ visible: false });
    set({ visible: true });
    clock.now += 1_000;
    sink({ blockedMs: 1_500 });

    expect(forwarded).toEqual([2_000]);
  });
});
