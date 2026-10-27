import { afterEach, describe, expect, test } from "bun:test";
import type { CrashReportsPayload } from "../api-client";
import { flushCrashReports, installCrashReporter, resetCrashReporterForTests } from "./crash-reports";
import {
  installStallReporter,
  recordStall,
  resetStallReporterForTests,
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

    recordStall("window", { blockedMs: 2_340, lastMeasured: "chart.resolve:AAPL /Users/alice/x", lastMeasuredEndedMsAgo: 12 });
    await flushCrashReports();

    expect(log).toEqual(["2026-10-27T14:43:00Z  window    froze  2.3 s  last measured: chart.resolve:AAPL /Users/alice/x, ended 12 ms before"]);
    const errors = crashReports.flatMap((payload) => payload.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "MainThreadStall",
      message: "2-5s after chart.resolve",
      plugin: "stall-monitor",
      pane: "process=window count=1 longest=2300ms platform=macos-arm64",
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
