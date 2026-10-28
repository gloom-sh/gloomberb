import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UpdateStatusEntry } from "electrobun/bun";
import type { UpdateFailureReport } from "../../../../api-client";
import {
  installUpdateFailureReporter,
  resetUpdateFailureReporterForTests,
  type UpdateReportState,
} from "../../../../telemetry/update-failures";
import type { UpdateProgress } from "../../../../updater";
import { writeLegacyDesktopFiles } from "../../../../../scripts/write-legacy-desktop-files";
import { createElectrobunDesktopUpdater, firstTarPath, isWholeTar, removeUpdateAsides, type ElectrobunUpdaterApi } from "./update";

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
  // the app to Applications is what fixes it. From Applications, a move across
  // disks (the update is kept on another one) is its own reason: moving the app
  // again would not help.
  test.each([
    ["desktop-volume", "EROFS: read-only file system, rename", "wrong_location"],
    ["desktop-volume", "EXDEV: cross-device link not permitted, rename", "wrong_location"],
    ["desktop-applications", "EXDEV: cross-device link not permitted, rename", "cross_device"],
  ] as const)("an install from %s that fails with %s says %s", async (installKind, message, code) => {
    const { updater } = createFakeUpdater({
      applyStatuses: [status({ status: "error", details: { errorMessage: `Failed to replace app: ${message}` } })],
    });
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0", installKind });
    await desktop.download(STABLE, () => {});
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);

    expect(progress.at(-1)?.failure).toEqual({ phase: "apply", code });
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

// It deletes folders beside the installed app, so it must take only the
// copies an install moved aside, never the app or its neighbours.
describe("old copies of the app at the next start", () => {
  function folderWith(entries: string[]): string {
    const folder = mkdtempSync(join(tmpdir(), "gloom-update-asides-"));
    for (const entry of entries) mkdirSync(join(folder, entry, "Contents"), { recursive: true });
    return folder;
  }

  test.each([
    ["darwin", "Gloom.app", "Gloom.app/Contents/MacOS/bun"],
    ["darwin", "Gloomberb.app", "Gloomberb.app/Contents/MacOS/bun"],
    ["linux", "app", "app/bin/bun"],
    ["win32", "Gloom", "Gloom/bin/bun.exe"],
  ])("%s removes %s.previous and the uniquely named ones, and nothing else", async (platform, app, exec) => {
    const keep = [app, `${app}.previous.bak`, `${app}.previously`, `Other${app}.previous`, `${app}.previous-UPPER`];
    const folder = folderWith([...keep, `${app}.previous`, `${app}.previous-mgx1k2`, `${app}.previous-mgx1k2-1`]);
    try {
      const removed = await removeUpdateAsides(join(folder, exec), platform);
      expect(removed.map((path) => path.slice(folder.length + 1)).sort()).toEqual([`${app}.previous`, `${app}.previous-mgx1k2`, `${app}.previous-mgx1k2-1`]);
      expect(readdirSync(folder).sort()).toEqual([...keep].sort());
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("beside Gloom.app, also removes what the update that brought the new name moved aside", async () => {
    const folder = folderWith(["Gloom.app", "Gloomberb.app.previous", "Gloomberb.app.previous-mgx1k2", "Gloomberb.app"]);
    try {
      const removed = await removeUpdateAsides(join(folder, "Gloom.app/Contents/MacOS/bun"), "darwin");
      expect(removed.map((path) => path.slice(folder.length + 1)).sort()).toEqual(["Gloomberb.app.previous", "Gloomberb.app.previous-mgx1k2"]);
      // The old bundle itself is not an aside; removeLegacyMacApp decides about it.
      expect(readdirSync(folder).sort()).toEqual(["Gloom.app", "Gloomberb.app"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("leaves everything alone where it cannot tell the app's folder", async () => {
    const folder = folderWith(["bun.previous", "Gloomberb.previous"]);
    try {
      // A bundle path that is not the app's Contents/MacOS, and a runtime outside bin/.
      expect(await removeUpdateAsides(join(folder, "Gloomberb.app/bun"), "darwin")).toEqual([]);
      expect(await removeUpdateAsides(join(folder, "bun"), "linux")).toEqual([]);
      expect(await removeUpdateAsides(join(folder, "Gloomberb/bun.exe"), "win32")).toEqual([]);
      expect(existsSync(join(folder, "bun.previous"))).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

// An install from before the rename updates on Windows from the archive packed
// again with a Gloomberb folder. Electrobun keeps it unpacked as the running
// build's tar and would apply the next release's patch, made from the Gloom
// archive, to it: bspatch does not check what it patches, so the result would
// be a broken build. The download drops it first and fetches the full archive.
describe("update archives from before the rename", () => {
  /**
   * Writes `file` (a path under its top folder) and packs `entry` with the
   * system tar in `format`, as `<name>.tar`: the top folder packs it with
   * everything under it, the file's own path packs it alone.
   */
  function tar(folder: string, name: string, file: string, format = "ustar", entry = file.split("/")[0]!): string {
    const stage = mkdtempSync(join(folder, "stage-"));
    mkdirSync(join(stage, file, ".."), { recursive: true });
    writeFileSync(join(stage, file), "{}");
    const packed = Bun.spawnSync(["tar", `--format=${format}`, "-cf", join(folder, `${name}.tar`), entry], { cwd: stage });
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    rmSync(stage, { recursive: true });
    return join(folder, `${name}.tar`);
  }

  test.each(["ustar", "pax", "gnu"])("reads the first path of a %s tar", (format) => {
    const folder = mkdtempSync(join(tmpdir(), "gloom-update-tar-"));
    try {
      const short = tar(folder, "short", "Gloomberb/Resources/version.json", format);
      expect(firstTarPath(readFileSync(short))).toBe("Gloomberb/");
      // Over 100 characters: a pax or GNU header ahead of the entry names it.
      const long = `Gloomberb/${"deep/".repeat(30)}version.json`;
      if (format !== "ustar") expect(firstTarPath(readFileSync(tar(folder, "long", long, format, long)))).toBe(long);
      expect(firstTarPath(readFileSync(short).subarray(0, 100))).toBeNull();
      expect(firstTarPath(new Uint8Array(1024))).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a download first drops the unpacked archives that carry the old name", async () => {
    const root = mkdtempSync(join(tmpdir(), "gloom-update-legacy-"));
    try {
      const appData = join(root, "app-data");
      const extraction = join(appData, "self-extraction");
      const artifacts = join(root, "artifacts");
      mkdirSync(extraction, { recursive: true });
      mkdirSync(artifacts);
      // The release's Windows archive, and its copy for installs from before the rename, packed by the release script.
      const stage = mkdtempSync(join(root, "stage-"));
      mkdirSync(join(stage, "Gloom", "Resources"), { recursive: true });
      writeFileSync(join(stage, "Gloom", "Resources", "version.json"), "{}");
      Bun.spawnSync(["tar", "-cf", "out.tar", "Gloom"], { cwd: stage });
      writeFileSync(join(artifacts, "stable-win-x64-Gloom.tar.zst"), Bun.zstdCompressSync(readFileSync(join(stage, "out.tar"))));
      await writeLegacyDesktopFiles(artifacts, join(root, "work"));
      const unpack = (name: string, as: string) => writeFileSync(join(extraction, `${as}.tar`), Bun.zstdDecompressSync(readFileSync(join(artifacts, name))));
      unpack("stable-win-x64-Gloomberb.tar.zst", "from-the-old-name");
      unpack("stable-win-x64-Gloom.tar.zst", "from-the-new-name");
      tar(extraction, "mac-old", "Gloomberb.app/Contents/Resources/version.json");
      tar(extraction, "mac-new", "Gloom.app/Contents/Resources/version.json");
      tar(extraction, "other", "Gloomberbish/Resources/version.json");
      writeFileSync(join(extraction, "hash.patch"), "patch");

      const { updater, calls } = createFakeUpdater();
      const seenAtDownload: string[] = [];
      const download = updater.downloadUpdate;
      updater.appDataFolder = async () => appData;
      updater.downloadUpdate = async () => {
        seenAtDownload.push(...readdirSync(extraction).sort());
        await download();
      };
      const { progress, onProgress } = collect();
      await createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" }).download(STABLE, onProgress);

      expect(calls).toEqual(["check", "download"]);
      expect(progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
      expect(seenAtDownload).toEqual(["from-the-new-name.tar", "hash.patch", "mac-new.tar", "other.tar"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Electrobun takes `<hash>.tar` in its `self-extraction` folder as the update
// already downloaded, without reading it. A decompress that failed partway
// left part of one there, and every later download took it as done and every
// install failed to unpack it ("ReadError"), with no way out but deleting the
// folder by hand.
describe("a damaged update archive", () => {
  /** A release's archive as Electrobun unpacks it from the download, and the first half of it. */
  async function releaseTar(): Promise<{ whole: Uint8Array; cut: Uint8Array }> {
    const whole = await new Bun.Archive({
      "Gloom.app/Contents/Resources/version.json": "{}",
      "Gloom.app/Contents/MacOS/bun": new Uint8Array(64 * 1024).fill(7),
    }).bytes();
    return { whole, cut: whole.subarray(0, Math.floor(whole.length / 2)) };
  }

  /**
   * Electrobun's staging as 1.18.1 ships it, before this app's patch: a
   * download that finds `new.tar` takes it as done, a full download writes it
   * (`nextDownload`: whole, or the part a decompress that failed left), and the
   * install unpacks it for real.
   */
  async function stagingUpdater(root: string) {
    const fake = createFakeUpdater({ applyStatuses: RELAUNCH });
    const { updater, calls } = fake;
    const extraction = join(root, "self-extraction");
    const staged = join(extraction, "new.tar");
    const { whole, cut } = await releaseTar();
    const state = { fetches: 0, nextDownload: "whole" as "whole" | "cut" | "cut-silently" };
    mkdirSync(extraction, { recursive: true });
    const relaunch = updater.applyUpdate;
    updater.appDataFolder = async () => root;
    updater.downloadUpdate = async () => {
      calls.push("download");
      const info = updater.updateInfo();
      if (!existsSync(staged)) {
        state.fetches += 1;
        writeFileSync(staged, state.nextDownload === "whole" ? whole : cut);
        if (state.nextDownload === "cut") info.error = "zig-zstd failed with exit code 1";
        state.nextDownload = "whole";
      }
      info.updateReady = existsSync(staged);
    };
    updater.applyUpdate = async () => {
      await new Bun.Archive(readFileSync(staged)).extract(mkdtempSync(join(root, "unpacked-")));
      await relaunch();
    };
    return { updater, staged, state, cut };
  }

  async function withRoot(run: (root: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "gloom-update-damaged-"));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const INSTALLED = { phase: "done", message: "Update installed, restarting..." };

  test("one already there is fetched again rather than installed", () => withRoot(async (root) => {
    const { updater, staged, state, cut } = await stagingUpdater(root);
    writeFileSync(staged, cut);
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const { progress, onProgress } = collect();

    await desktop.download(STABLE, onProgress);
    await desktop.apply(onProgress);

    expect(state.fetches).toBe(1);
    expect(progress.filter((entry) => entry.phase === "error")).toEqual([]);
    expect(progress.at(-1)).toEqual(INSTALLED);
  }));

  test.each([
    ["with zig-zstd's error", "cut"],
    ["as if whole", "cut-silently"],
  ] as const)("one a download leaves %s is a damaged download, and the retry fetches it again", (_, nextDownload) => withRoot(async (root) => {
    const { reports } = collectReports();
    const { updater, state } = await stagingUpdater(root);
    state.nextDownload = nextDownload;
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    const first = collect();

    await desktop.download(STABLE, first.onProgress);
    expect(first.progress.at(-1)).toMatchObject({ phase: "error", failure: { phase: "verify", code: "corrupt" } });
    expect(reports).toMatchObject([{ phase: "verify", code: "corrupt", targetVersion: "0.18.0" }]);

    const retry = collect();
    await desktop.download(STABLE, retry.onProgress);
    await desktop.apply(retry.onProgress);
    expect(state.fetches).toBe(2);
    expect(retry.progress.at(-1)).toEqual(INSTALLED);
  }));

  test("one that does not unpack at the restart is named, removed, and fetched again", () => withRoot(async (root) => {
    const { updater, staged, state, cut } = await stagingUpdater(root);
    const desktop = createElectrobunDesktopUpdater(updater, { runningVersion: "0.17.0" });
    await desktop.download(STABLE, () => {});
    // Damaged on disk while it waited for the restart.
    writeFileSync(staged, cut);
    const restart = collect();

    await desktop.apply(restart.onProgress);
    expect(restart.progress.at(-1)).toEqual({
      phase: "error",
      error: "ReadError",
      failure: { phase: "apply", code: "corrupt" },
    });
    expect(existsSync(staged)).toBe(false);

    const retry = collect();
    await desktop.download(STABLE, retry.onProgress);
    await desktop.apply(retry.onProgress);
    expect(state.fetches).toBe(2);
    expect(retry.progress.at(-1)).toEqual(INSTALLED);
  }));

  // It decides which archives are deleted, so a whole one it rejected would
  // fail every update.
  test.each(["ustar", "pax", "gnu"])("reads a %s tar as whole, and no part of it short of its end", async (format) => {
    const folder = mkdtempSync(join(tmpdir(), "gloom-update-whole-tar-"));
    try {
      const stage = join(folder, "stage");
      const deep = join(stage, "Gloom", ..."deep/".repeat(30).split("/").filter(Boolean));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(stage, "Gloom", "version.json"), "{}");
      writeFileSync(join(deep, "bun"), crypto.getRandomValues(new Uint8Array(5000)));
      const path = join(folder, "whole.tar");
      const packed = Bun.spawnSync(["tar", `--format=${format}`, "-cf", path, "Gloom"], { cwd: stage });
      if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
      expect(await isWholeTar(path)).toBe(true);

      // Every cut before the last entry ends, down to nothing.
      const bytes = readFileSync(path);
      const contentEnd = bytes.findLastIndex((byte) => byte !== 0);
      const cutPath = join(folder, "cut.tar");
      for (let length = 0; length <= contentEnd; length += 251) {
        writeFileSync(cutPath, bytes.subarray(0, length));
        if (await isWholeTar(cutPath)) throw new Error(`${length} of ${bytes.length} bytes read as whole`);
      }
      writeFileSync(cutPath, crypto.getRandomValues(new Uint8Array(4096)));
      expect(await isWholeTar(cutPath)).toBe(false);
      expect(await isWholeTar(join(folder, "missing.tar"))).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
