import { describe, expect, test } from "bun:test";
import type { UpdateStatusEntry } from "electrobun/bun";
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
  downloadReady?: boolean;
  /** What the manifest says: the stable one unless a source is set. */
  manifestVersion?: string;
} = {}) {
  const calls: string[] = [];
  /** Every `setUpdateSource`, in order; the last one is where Electrobun fetches from. */
  const sources: Array<{ channel: string; baseUrl: string } | null> = [];
  let callback: ((entry: UpdateStatusEntry) => void) | null = null;
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
      info = manifest();
      return info;
    },
    downloadUpdate: async () => {
      calls.push("download");
      callback?.(status({ status: "download-progress", details: { progress: 40 } }));
      callback?.(status({ status: "download-complete" }));
      info.updateReady = options.downloadReady ?? true;
    },
    applyUpdate: async () => {
      calls.push("apply");
      for (const entry of options.applyStatuses ?? []) callback?.(entry);
    },
    updateInfo: () => info,
    clearStatusHistory: () => {},
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

function collect() {
  const progress: UpdateProgress[] = [];
  return { progress, onProgress: (next: UpdateProgress) => { progress.push(next); } };
}

describe("desktop update flow", () => {
  test("a finished download stops at ready and never applies on its own", async () => {
    const { updater, calls } = createFakeUpdater({ applyStatuses: RELAUNCH });
    const desktop = createElectrobunDesktopUpdater(updater);
    const { progress, onProgress } = collect();

    await desktop.download("0.17.0", onProgress);

    expect(calls).toEqual(["check", "download"]);
    expect(progress).toEqual([
      { phase: "downloading", percent: 0 },
      { phase: "downloading", percent: 40 },
      { phase: "ready", canRestart: true },
    ]);
  });

  test("applies only on the explicit request, and a second request is harmless", async () => {
    const { updater, calls } = createFakeUpdater({ applyStatuses: RELAUNCH });
    const desktop = createElectrobunDesktopUpdater(updater);
    await desktop.download("0.17.0", () => {});
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
    const desktop = createElectrobunDesktopUpdater(updater);
    await desktop.download("0.17.0", () => {});
    calls.length = 0;

    const hourly = await desktop.check("0.17.0");
    const reopened = collect();
    await desktop.download("0.17.0", reopened.onProgress);
    await desktop.apply(() => {});

    expect(hourly).toMatchObject({ kind: "available", release: { version: "0.18.0", updateAction: { kind: "desktop" } } });
    expect(reopened.progress).toEqual([{ phase: "ready", canRestart: true }]);
    // No second download, and the apply still found its update.
    expect(calls).toEqual(["apply"]);
  });

  test("a download that did not finish reports an error instead of ready", async () => {
    const { updater, calls } = createFakeUpdater({ downloadReady: false });
    const desktop = createElectrobunDesktopUpdater(updater);
    const { progress, onProgress } = collect();

    await desktop.download("0.17.0", onProgress);
    await desktop.apply(onProgress);

    expect(progress.at(-2)).toEqual({ phase: "error", error: "Desktop update did not finish downloading." });
    expect(progress.at(-1)).toEqual({ phase: "error", error: "The downloaded update is no longer available." });
    expect(calls).not.toContain("apply");
  });

  test("an apply Electrobun silently gives up on is an error, and a retry downloads again", async () => {
    // A newer release replaced the downloaded one, so there is nothing to install.
    const { updater, calls } = createFakeUpdater({ applyStatuses: [status({ status: "applying" })] });
    const desktop = createElectrobunDesktopUpdater(updater);
    await desktop.download("0.17.0", () => {});
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);
    expect(progress).toEqual([
      { phase: "replacing" },
      { phase: "replacing" },
      { phase: "error", error: "Desktop update could not be installed." },
    ]);

    const retry = collect();
    await desktop.download("0.17.0", retry.onProgress);
    expect(retry.progress.at(-1)).toEqual({ phase: "ready", canRestart: true });
    expect(calls.filter((call) => call === "download")).toHaveLength(2);
  });

  test("an install error is reported once", async () => {
    const { updater } = createFakeUpdater({
      applyStatuses: [status({ status: "error", details: { errorMessage: "Failed to replace app: EACCES" } })],
    });
    const desktop = createElectrobunDesktopUpdater(updater);
    await desktop.download("0.17.0", () => {});
    const { progress, onProgress } = collect();

    await desktop.apply(onProgress);

    expect(progress.filter((entry) => entry.phase === "error")).toEqual([
      { phase: "error", error: "Failed to replace app: EACCES" },
    ]);
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

    // The download reads the same release, and a later stable check while it
    // waits for the restart leaves that source alone.
    await desktop.download("0.18.0", () => {}, "nightly");
    await desktop.check("0.18.0", "stable");
    expect(sources.at(-1)).toEqual(expect.objectContaining({ channel: "nightly" }));
    expect(calls).toEqual(["check", "check", "download"]);
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
      listReleases: async () => [listing("v0.18.1", "stable"), listing(NIGHTLY, "nightly")],
    });

    await expect(desktop.check(NIGHTLY.slice(1), "nightly")).resolves.toMatchObject({
      kind: "available",
      release: { version: "0.18.1" },
    });
    expect(sources.at(-1)).toEqual({
      channel: "stable",
      baseUrl: "https://github.com/gloom-sh/gloomberb/releases/download/v0.18.1",
    });
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
