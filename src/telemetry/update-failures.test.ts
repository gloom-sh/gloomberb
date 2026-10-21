import { afterEach, describe, expect, test } from "bun:test";
import type { CrashReportsPayload, UpdateFailureReport } from "../api-client";
import { performUpdate } from "../updater";
import { flushCrashReports, installCrashReporter, resetCrashReporterForTests } from "./crash-reports";
import {
  installUpdateFailureReporter,
  noteUpdateApplying,
  noteUpdateStaged,
  reportUpdateFailure,
  resetUpdateFailureReporterForTests,
  reviewLastUpdateAttempt,
  type UpdateFailureReporterHost,
  type UpdateReportState,
} from "./update-failures";

const HOUR_MS = 60 * 60 * 1000;
const originalFetch = globalThis.fetch;

/** A reporter whose disk is `stored` and whose clock is `clock.now`; what it sends lands in `sent`. */
function fakeReporter(overrides: Partial<UpdateFailureReporterHost> = {}) {
  const clock = { now: Date.parse("2026-10-20T09:00:00Z") };
  let stored: UpdateReportState = { sent: {} };
  const sent: UpdateFailureReport[] = [];
  const host: UpdateFailureReporterHost = {
    installKind: "desktop-applications",
    appVersion: "0.17.5",
    platform: "darwin",
    arch: "arm64",
    load: () => JSON.parse(JSON.stringify(stored)),
    save: (state) => { stored = JSON.parse(JSON.stringify(state)); },
    now: () => clock.now,
    send: (report) => { sent.push(report); },
    ...overrides,
  };
  installUpdateFailureReporter(host);
  return { clock, sent, host, stored: () => stored };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUpdateFailureReporterForTests();
  resetCrashReporterForTests();
});

describe("update failure reports", () => {
  // The step's own error can carry the user's home folder, a signed download
  // URL and the system's wording; none of it may leave the machine.
  test("a failed download sends the step, a code and versions, and none of the error's text", async () => {
    const crashReports: CrashReportsPayload[] = [];
    installCrashReporter({
      surface: "terminal",
      homeDir: "/home/alice",
      isEnabled: () => true,
      getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
      send: async (payload) => { crashReports.push(payload); },
    });
    fakeReporter({ installKind: "terminal-binary", platform: "linux", arch: "x64", send: undefined });
    const execPath = process.execPath;
    const argv = process.argv;
    globalThis.fetch = (async () => {
      throw Object.assign(
        new Error("connect ECONNREFUSED https://objects.example.test/gloomberb-linux-x64.gz?X-Amz-Signature=SECRET while writing /home/alice/.local/bin/gloomberb"),
        { code: "ECONNREFUSED" },
      );
    }) as typeof fetch;
    const progress: unknown[] = [];
    try {
      Object.defineProperty(process, "execPath", { value: "/home/alice/.local/bin/gloomberb", configurable: true });
      Object.defineProperty(process, "argv", { value: ["/home/alice/.local/bin/gloomberb"], configurable: true });
      await performUpdate({
        version: "0.18.1",
        tagName: "v0.18.1",
        downloadUrl: "https://objects.example.test/gloomberb-linux-x64.gz?X-Amz-Signature=SECRET",
        publishedAt: "",
        updateAction: { kind: "self" },
        compressed: true,
        checksum: "ab".repeat(32),
      }, (entry) => { progress.push(entry); });
    } finally {
      Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
      Object.defineProperty(process, "argv", { value: argv, configurable: true });
    }
    await flushCrashReports({ timeoutMs: 500 });

    // The user still reads the whole error locally.
    expect(progress.at(-1)).toMatchObject({ phase: "error", error: expect.stringContaining("ECONNREFUSED"), failure: { phase: "download", code: "offline" } });
    expect(crashReports).toHaveLength(1);
    const [error] = crashReports[0]!.errors;
    expect(error).toEqual({
      kind: "plugin",
      type: "UpdateFailed",
      message: "download: offline",
      plugin: "updater",
      pane: "to=0.18.1 channel=stable platform=linux-x64 install=terminal-binary",
      update: {
        phase: "download",
        code: "offline",
        appVersion: "0.17.5",
        targetVersion: "0.18.1",
        channel: "stable",
        platform: "linux",
        arch: "x64",
        installKind: "terminal-binary",
      },
    });
    const body = JSON.stringify(crashReports[0]);
    for (const leak of ["alice", "SECRET", "example.test", "ECONNREFUSED", "/home", "http"]) expect(body).not.toContain(leak);
  });

  test("sends one report per step, code and app version a day, across launches", () => {
    const { clock, sent, host } = fakeReporter();
    const interrupted = { phase: "download", code: "interrupted" } as const;

    reportUpdateFailure(interrupted, { targetVersion: "0.18.1" });
    reportUpdateFailure(interrupted, { targetVersion: "0.18.2" });
    // The next launch reads what the last one saved.
    installUpdateFailureReporter({ ...host });
    clock.now += 23 * HOUR_MS;
    reportUpdateFailure(interrupted, { targetVersion: "0.18.2" });
    expect(sent).toHaveLength(1);

    // Another reason in the same step is news.
    reportUpdateFailure({ phase: "download", code: "disk_full" }, { targetVersion: "0.18.2" });
    expect(sent.map((report) => report.code)).toEqual(["interrupted", "disk_full"]);

    // A day after the first, it is sent again.
    clock.now += 2 * HOUR_MS;
    reportUpdateFailure(interrupted, { targetVersion: "0.18.2" });
    expect(sent.map((report) => report.code)).toEqual(["interrupted", "disk_full", "interrupted"]);

    // Another app version counts on its own.
    installUpdateFailureReporter({ ...host, appVersion: "0.18.0" });
    reportUpdateFailure(interrupted, { targetVersion: "0.18.2" });
    expect(sent.at(-1)).toMatchObject({ appVersion: "0.18.0", code: "interrupted" });
    expect(sent).toHaveLength(4);
  });

  test("drops anything that is not a version or a known value", () => {
    const { sent } = fakeReporter({ platform: "sunos", arch: "ppc64" });
    reportUpdateFailure({ phase: "check", code: "rate_limited" }, { targetVersion: "/Users/bob/Downloads", channel: "nightly" });
    expect(sent).toEqual([{
      phase: "check",
      code: "rate_limited",
      appVersion: "0.17.5",
      channel: "nightly",
      platform: "other",
      arch: "other",
      installKind: "desktop-applications",
    }]);
  });
});

describe("the last update attempt, seen at the next launch", () => {
  function relaunchAs(reporter: ReturnType<typeof fakeReporter>, version: string, afterMs: number) {
    reporter.clock.now += afterMs;
    installUpdateFailureReporter({ ...reporter.host, appVersion: version });
    reviewLastUpdateAttempt();
  }

  test("an install that came back on the old version never took", () => {
    const reporter = fakeReporter();
    noteUpdateStaged("0.18.1", "stable");
    noteUpdateApplying("0.18.1", "stable");
    relaunchAs(reporter, "0.17.5", HOUR_MS);
    expect(reporter.sent).toMatchObject([{ phase: "apply", code: "not_applied", appVersion: "0.17.5", targetVersion: "0.18.1" }]);
    expect(reporter.stored().applying).toBeUndefined();
  });

  test("a download left waiting when the app quit is the stuck case", () => {
    const reporter = fakeReporter();
    noteUpdateStaged("0.18.1", "stable");
    relaunchAs(reporter, "0.17.5", 8 * HOUR_MS);
    expect(reporter.sent).toMatchObject([{ phase: "apply", code: "not_restarted", targetVersion: "0.18.1" }]);
    expect(reporter.stored().staged).toBeUndefined();
  });

  test("the new version reopening itself is the update working; reopened by hand later, the relaunch failed", () => {
    const reporter = fakeReporter();
    noteUpdateApplying("0.18.1", "stable");
    relaunchAs(reporter, "0.18.1", 5_000);
    expect(reporter.sent).toEqual([]);

    noteUpdateApplying("0.18.2", "stable");
    relaunchAs(reporter, "0.18.2", 3 * HOUR_MS);
    expect(reporter.sent).toMatchObject([{ phase: "relaunch", code: "relaunch_missed", appVersion: "0.18.2" }]);
  });

  test("an install that failed in its own run is reported then, not again at the next launch", () => {
    const reporter = fakeReporter();
    noteUpdateApplying("0.18.1", "stable");
    reportUpdateFailure({ phase: "apply", code: "permission_denied" }, { targetVersion: "0.18.1" });
    relaunchAs(reporter, "0.17.5", HOUR_MS);
    expect(reporter.sent.map((report) => report.code)).toEqual(["permission_denied"]);
  });
});
