import { afterEach, describe, expect, test } from "bun:test";
import type { UpdateStatusEntry } from "electrobun/bun";
import type { UpdateFailureReport } from "../../../../api-client";
import {
  installUpdateFailureReporter,
  resetUpdateFailureReporterForTests,
  type UpdateReportState,
} from "../../../../telemetry/update-failures";
import type { UpdateProgress } from "../../../../updater";
import { createElectrobunDesktopUpdater, type ElectrobunUpdaterApi } from "./update";

type UpdateInfo = ReturnType<ElectrobunUpdaterApi["updateInfo"]>;

function status(entry: Pick<UpdateStatusEntry, "status"> & Partial<UpdateStatusEntry>): UpdateStatusEntry {
  return { message: entry.status, timestamp: 0, ...entry };
}

/**
 * Electrobun's updater, as far as the packaged app is concerned: the native
 * install and relaunch cannot run here, so `applyUpdate` only records the call
 * and plays the statuses the real one emits. Like the real one, every
 * `checkForUpdate()` replaces the info object, which drops `updateReady`.
 */
function createFakeUpdater(options: {
  applyStatuses?: UpdateStatusEntry[];
  /** Played during the download, before it finishes. */
  downloadStatuses?: UpdateStatusEntry[];
  downloadReady?: boolean;
  /** What the manifest says: the stable one unless a source is set. */
  manifestVersion?: string;
  /** A failed manifest fetch: the status Electrobun emits, and the error it returns. */
  checkFailure?: { status: UpdateStatusEntry | null; error: string };
  /** What the download throws partway, as Bun's fetch does when the connection drops. */
  downloadThrows?: Error;
} = {}) {
  const calls: string[] = [];
  /** Every `setUpdateSource`, in order; the last one is where Electrobun fetches from. */
  const sources: Array<{ channel: string; baseUrl: string } | null> = [];
  let callback: ((entry: UpdateStatusEntry) => void) | null = null;
  const history: UpdateStatusEntry[] = [];
  const manifest = () => ({
    version: options.manifestVersion ?? "0.18.0",
    hash: "new",
    updateAvailable: true,
    updateReady: false,
    error: "",
  }) as UpdateInfo;
  let info = manifest();
  const updater: ElectrobunUpdaterApi = {
    localInfo: {
      channel: async () => "stable",
      baseUrl: async () => "https://updates.example.test/stable/",
    },
    setUpdateSource: (source) => { sources.push(source); },
    checkForUpdate: async () => {
      calls.push("check");
      if (options.checkFailure) {
        if (options.checkFailure.status) history.push(options.checkFailure.status);
        return { version: "", hash: "", updateAvailable: false, updateReady: false, error: options.checkFailure.error };
      }
      info = manifest();
      return info;
    },
    downloadUpdate: async () => {
      calls.push("download");
      for (const entry of options.downloadStatuses ?? []) callback?.(entry);
      callback?.(status({ status: "download-progress", details: { progress: 40 } }));
      if (options.downloadThrows) throw options.downloadThrows;
      callback?.(status({ status: "download-complete" }));
      info.updateReady = options.downloadReady ?? true;
    },
    applyUpdate: async () => {
      calls.push("apply");
      for (const entry of options.applyStatuses ?? []) callback?.(entry);
    },
    updateInfo: () => info,
    clearStatusHistory: () => { history.length = 0; },
    getStatusHistory: () => [...history],
    onStatusChange: (next) => { callback = next; },
  };
  return { updater, calls, sources };
}

const RELAUNCH = [
  status({ status: "applying" }),
  status({ status: "replacing-app" }),
  status({ status: "launching-new-version" }),
  status({ status: "complete" }),
];

/** A release the stable check found, which carries no channel. */
const STABLE = {};

afterEach(() => {
  resetUpdateFailureReporterForTests();
});

/** What the desktop process would send to error tracking. */
function collectReports() {
  const reports: UpdateFailureReport[] = [];
  let state: UpdateReportState = { sent: {} };
  installUpdateFailureReporter({
    installKind: "desktop-applications",
    appVersion: "0.17.0",
    platform: "darwin",
    arch: "arm64",
    load: () => state,
    save: (next) => { state = next; },
    send: (report) => { reports.push(report); },
  });
  return { reports, state: () => state };
}

function collect() {
  const progress: UpdateProgress[] = [];
  return { progress, onProgress: (next: UpdateProgress) => { progress.push(next); } };
}

describe("desktop update flow", () => {
  test("a finished download stops at ready and never applies on its own", async () => {
    const { updater, calls } = createFakeUpdater({ applyStatuses: RELAUNCH });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const { progress, onProgress } = collect();

    await desktop.download(STABLE, onProgress);

    expect(calls).toEqual(["check", "download"]);
    expect(progress).toEqual([
      { phase: "downloading", percent: 0 },
      { phase: "downloading", percent: 40 },
      { phase: "ready", canRestart: true },
    ]);
  });

  test("applies only on the explicit request, and a second request is harmless", async () => {
    const { updater, calls } = createFakeUpdater({ applyStatuses: RELAUNCH });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    await desktop.download(STABLE, () => {});
    const { progress, onProgress } = collect();

    await Promise.all([desktop.apply(onProgress), desktop.apply(onProgress)]);
    await desktop.apply(onProgress);

    expect(calls.filter((call) => call === "apply")).toHaveLength(1);
    expect(progress).toEqual([
      { phase: "replacing" },
      { phase: "replacing" },
      { phase: "replacing" },
      { phase: "replacing" },
      { phase: "done", message: "Update installed, restarting..." },
    ]);
  });

  test("an update check while one is ready neither asks Electrobun nor drops the ready state", async () => {
    const { updater, calls } = createFakeUpdater({ applyStatuses: RELAUNCH });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    await desktop.download(STABLE, () => {});
    calls.length = 0;

    const hourly = await desktop.check("0.17.0");
    const reopened = collect();
    await desktop.download(STABLE, reopened.onProgress);
    await desktop.apply(() => {});

    expect(hourly).toMatchObject({ kind: "available", release: { version: "0.18.0", updateAction: { kind: "desktop" } } });
    expect(reopened.progress).toEqual([{ phase: "ready", canRestart: true }]);
    // No second download, and the apply still found its update.
    expect(calls).toEqual(["apply"]);
  });

  test("a download that did not finish reports an error instead of ready", async () => {
    const { updater, calls } = createFakeUpdater({ downloadReady: false });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const { progress, onProgress } = collect();

    await desktop.download(STABLE, onProgress);
    await desktop.apply(onProgress);

    expect(progress.at(-2)).toEqual({
      phase: "error",
      error: "Desktop update did not finish downloading.",
      failure: { phase: "download", code: "interrupted" },
    });
    expect(progress.at(-1)).toEqual({
      phase: "error",
      error: "The downloaded update is no longer available.",
      failure: { phase: "apply", code: "staged_missing" },
    });
    expect(calls).not.toContain("apply");
  });

  test("a download cut off partway is interrupted, reported with the version it was for", async () => {
    const { reports } = collectReports();
    const { updater } = createFakeUpdater({ downloadThrows: new Error("The socket connection was closed unexpectedly.") });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const { progress, onProgress } = collect();

    await desktop.download(STABLE, onProgress);

    expect(progress.at(-1)).toMatchObject({ phase: "error", failure: { phase: "download", code: "interrupted" } });
    expect(reports).toMatchObject([{ phase: "download", code: "interrupted", targetVersion: "0.18.0", channel: "stable" }]);
  });

  test("an apply Electrobun silently gives up on is an error, and a retry downloads again", async () => {
    // The downloaded files are gone, so there is nothing to install.
    const { updater, calls } = createFakeUpdater({ applyStatuses: [status({ status: "applying" })] });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    await desktop.download(STABLE, () => {});
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);
    expect(progress).toEqual([
      { phase: "replacing" },
      { phase: "replacing" },
      { phase: "error", error: "Desktop update could not be installed.", failure: { phase: "apply", code: "staged_missing" } },
    ]);

    const retry = collect();
    await desktop.download(STABLE, retry.onProgress);
    expect(retry.progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
    expect(calls.filter((call) => call === "download")).toHaveLength(2);
  });

  test("an install error is reported once", async () => {
    const { reports, state } = collectReports();
    const { updater } = createFakeUpdater({
      applyStatuses: [status({ status: "error", details: { errorMessage: "Failed to replace app: EACCES" } })],
    });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    await desktop.download(STABLE, () => {});
    // Waiting for the user's Restart, which the next launch would read as never restarted.
    expect(state().staged).toMatchObject({ to: "0.18.0" });
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);

    expect(progress.filter((entry) => entry.phase === "error")).toEqual([
      { phase: "error", error: "Failed to replace app: EACCES", failure: { phase: "apply", code: "permission_denied" } },
    ]);
    expect(reports).toMatchObject([{ phase: "apply", code: "permission_denied", targetVersion: "0.18.0", channel: "stable" }]);
    // Reported here, so the next launch has nothing left to say about it.
    expect(state().applying).toBeUndefined();
    expect(state().staged).toBeUndefined();
  });

  // App Translocation runs a quarantined app from a read-only copy, and a disk
  // image is read-only: Electrobun cannot replace the bundle there, and moving
  // the app to Applications is what fixes it.
  test("an install that cannot replace an app run from a disk image says to move it", async () => {
    const { updater } = createFakeUpdater({
      applyStatuses: [status({ status: "error", details: { errorMessage: "Failed to replace app: EROFS: read-only file system, rename" } })],
    });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0", installKind: "desktop-volume" });
    await desktop.download(STABLE, () => {});
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);

    expect(progress.at(-1)?.failure).toEqual({ phase: "apply", code: "wrong_location" });
  });

  // Electrobun emits an error status when a patch does not apply, then falls
  // back to the full download. That status must not end the flow as failed
  // while the download carries on to ready.
  test("an error Electrobun recovers from during a download does not fail it", async () => {
    const { updater } = createFakeUpdater({
      downloadStatuses: [status({ status: "error", message: "Cyclical update detected, falling back to full download" })],
    });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const { progress, onProgress } = collect();

    await desktop.download(STABLE, onProgress);

    expect(progress.some((entry) => entry.phase === "error")).toBe(false);
    expect(progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
  });

  // Electrobun's check returns one message for every failure; the status it
  // emitted before says whether the server answered.
  test.each([
    [status({ status: "error", message: "Failed to fetch update info (HTTP 404)" }), "not_found"],
    [status({ status: "error", message: "Failed to fetch update info (HTTP 403)" }), "rate_limited"],
    [null, "offline"],
  ] as const)("a failed check is named by the status before it (%#)", async (before, code) => {
    const { updater } = createFakeUpdater({
      checkFailure: { status: before, error: "Failed to fetch update info from https://updates.example.test/stable-update.json?x1" },
    });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });

    await expect(desktop.check("0.17.0")).resolves.toMatchObject({ kind: "error", failure: { phase: "check", code } });
  });
});

describe("desktop update channels", () => {
  const platform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const NIGHTLY = "v0.18.1-nightly.20261016.5.g0000fff";
  function listing(tag: string, filesChannel: "stable" | "nightly", prerelease = filesChannel === "nightly") {
    return {
      tag_name: tag,
      prerelease,
      published_at: "2026-10-16T03:00:00Z",
      assets: [{ name: `${filesChannel}-${platform}-update.json`, browser_download_url: `https://example.test/${tag}` }],
    };
  }

  test("nightly downloads the newest build from that release's own nightly files", async () => {
    const { updater, calls, sources } = createFakeUpdater();
    const desktop = createElectrobunDesktopUpdater(updater, {
      runningVersion: "0.18.0",
      listReleases: async () => [
        // A stable-named manifest on a nightly build is never mistaken for one.
        listing("v0.18.2-nightly.20261017.6.gaaaaaaa", "stable", true),
        listing(NIGHTLY, "nightly"),
        listing("v0.18.0", "stable"),
      ],
    });

    const result = await desktop.check("0.18.0", "nightly");
    expect(result).toMatchObject({
      kind: "available",
      release: { version: NIGHTLY.slice(1), tagName: NIGHTLY, channel: "nightly", updateAction: { kind: "desktop" } },
    });
    expect(sources.at(-1)).toEqual({
      channel: "nightly",
      baseUrl: `https://github.com/gloom-sh/gloomberb/releases/download/${NIGHTLY}`,
    });

    // The download asks again as the installed build, so it takes the build the
    // check offered rather than finding nothing newer than that build itself.
    // A nightly check while it waits for the restart leaves that source alone.
    const { progress, onProgress } = collect();
    await desktop.download(result.kind === "available" ? result.release : {}, onProgress);
    expect(progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
    await expect(desktop.check("0.18.0", "nightly")).resolves.toMatchObject({ release: { tagName: NIGHTLY } });
    expect(sources.at(-1)).toEqual(expect.objectContaining({ channel: "nightly" }));
    expect(calls).toEqual(["check", "check", "download"]);
  });

  test("back on stable, a downloaded nightly build is dropped, so a restart cannot install it", async () => {
    const { updater, calls, sources } = createFakeUpdater({ applyStatuses: RELAUNCH, manifestVersion: "0.18.0" });
    const desktop = createElectrobunDesktopUpdater(updater, {
      runningVersion: "0.17.0",
      listReleases: async () => [listing(NIGHTLY, "nightly")],
    });
    const { progress, onProgress } = collect();
    await desktop.download({ channel: "nightly" }, onProgress);
    expect(progress.at(-1)).toEqual({ phase: "ready", canRestart: true });

    // The stable check answers from version.json's source again (which also
    // clears Electrobun's ready flag) instead of the staged nightly build.
    const result = await desktop.check("0.17.0", "stable");
    expect(result).toMatchObject({ kind: "available", release: { version: "0.18.0", tagName: "v0.18.0" } });
    expect(result.kind === "available" && result.release.channel).toBeFalsy();
    expect(sources.at(-1)).toBeNull();
    await desktop.apply(onProgress);
    expect(progress.at(-1)).toMatchObject({ phase: "error", error: "The downloaded update is no longer available." });
    expect(calls).not.toContain("apply");
  });

  test("a downloaded stable release stays through a switch to nightly", async () => {
    const { updater } = createFakeUpdater({ manifestVersion: "0.18.0" });
    const desktop = createElectrobunDesktopUpdater(updater, {
      runningVersion: "0.17.0",
      listReleases: async () => { throw new Error("a staged update needs no new list"); },
    });
    await desktop.download(STABLE, () => {});
    await expect(desktop.check("0.17.0", "nightly")).resolves.toMatchObject({ kind: "available", release: { version: "0.18.0" } });
  });

  test("nightly with nothing newer than the installed build does not ask Electrobun", async () => {
    const { updater, calls } = createFakeUpdater();
    const desktop = createElectrobunDesktopUpdater(updater, {
      listReleases: async () => [listing(NIGHTLY, "nightly"), listing("v0.18.0", "stable")],
    });

    await expect(desktop.check(NIGHTLY.slice(1), "nightly")).resolves.toEqual({ kind: "current" });
    expect(calls).toEqual([]);
  });

  test("a nightly build is offered the stable release that passes it, from the stable files", async () => {
    const { updater, sources } = createFakeUpdater({ manifestVersion: "0.18.1" });
    const desktop = createElectrobunDesktopUpdater(updater, {
      runningVersion: NIGHTLY.slice(1),
      listReleases: async () => [listing("v0.18.1", "stable"), listing(NIGHTLY, "nightly")],
    });

    const result = await desktop.check(NIGHTLY.slice(1), "nightly");
    expect(result).toMatchObject({ kind: "available", release: { version: "0.18.1" } });
    expect(sources.at(-1)).toEqual({
      channel: "stable",
      baseUrl: "https://github.com/gloom-sh/gloomberb/releases/download/v0.18.1",
    });
    const { progress, onProgress } = collect();
    await desktop.download(result.kind === "available" ? result.release : {}, onProgress);
    expect(progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
  });

  test("stable reads version.json's own source and never goes back from a nightly build", async () => {
    const { updater, sources } = createFakeUpdater({ manifestVersion: "0.18.0" });
    const desktop = createElectrobunDesktopUpdater(updater, {
      listReleases: async () => { throw new Error("stable never lists releases"); },
    });

    // Electrobun sees a different build hash, but the stable release is older.
    await expect(desktop.check(NIGHTLY.slice(1), "stable")).resolves.toEqual({
      kind: "current",
      notice: `Staying on ${NIGHTLY} until a newer stable release`,
    });
    expect(sources).toEqual([null]);
    // A stable install takes the same manifest as before channels existed.
    await expect(desktop.check("0.17.0", "stable")).resolves.toMatchObject({ kind: "available", release: { version: "0.18.0" } });
  });
});
