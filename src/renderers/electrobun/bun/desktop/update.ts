import type Electrobun from "electrobun/bun";
import type { UpdateStatusEntry } from "electrobun/bun";
import type {
  ReleaseInfo,
  UpdateCheckResult,
  UpdateProgress,
} from "../../../../updater";

type ElectrobunUpdater = typeof Electrobun.Updater;

/**
 * The part of Electrobun's updater this flow uses. Tests pass a fake, because
 * the real module cannot be loaded or exercised outside the packaged app.
 */
export type ElectrobunUpdaterApi = Pick<
  ElectrobunUpdater,
  "checkForUpdate" | "downloadUpdate" | "applyUpdate" | "updateInfo" | "clearStatusHistory" | "onStatusChange"
> & {
  localInfo: Pick<ElectrobunUpdater["localInfo"], "channel" | "baseUrl">;
};

export interface ElectrobunDesktopUpdater {
  check(currentVersion: string): Promise<UpdateCheckResult>;
  /** Downloads and stages the update, ending in `ready`. It never relaunches the app. */
  download(currentVersion: string, onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /**
   * Installs the staged update, which quits the app and relaunches it. Only the
   * user's Restart gets here. A repeat request while one is running, or after it
   * succeeded and the app is quitting, does nothing.
   */
  apply(onProgress: (progress: UpdateProgress) => void): Promise<void>;
}

function desktopReleasePlatformPrefix(channel: string): string {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${channel}-${os}-${arch}`;
}

function mapDesktopUpdateStatus(entry: UpdateStatusEntry): UpdateProgress | null {
  const progress = entry.details?.progress;
  switch (entry.status) {
    case "downloading":
    case "download-starting":
    case "checking-local-tar":
    case "local-tar-found":
    case "local-tar-missing":
    case "fetching-patch":
    case "patch-found":
    case "patch-not-found":
    case "downloading-patch":
    case "downloading-full-bundle":
    case "download-progress":
      return {
        phase: "downloading",
        percent: typeof progress === "number" ? progress : undefined,
      };
    case "applying-patch":
    case "patch-applied":
    case "extracting-version":
    case "patch-chain-complete":
    case "decompressing":
    case "applying":
    case "extracting":
    case "replacing-app":
    case "launching-new-version":
      return { phase: "replacing" };
    // `download-complete` is left out: the download flow reports `ready` itself,
    // once `updateInfo().updateReady` confirms it.
    case "complete":
      return { phase: "done", message: "Update installed, restarting..." };
    case "error":
      return {
        phase: "error",
        error: entry.details?.errorMessage || entry.message,
      };
    default:
      return null;
  }
}

export function createElectrobunDesktopUpdater(updater: ElectrobunUpdaterApi): ElectrobunDesktopUpdater {
  let downloadInProgress = false;
  /**
   * The release whose download finished and waits for the user's Restart. Kept
   * here rather than read back from Electrobun: its updater replaces the object
   * that carries `updateReady` on every update check, so one hourly check would
   * make a later `applyUpdate()` do nothing.
   */
  let readyRelease: ReleaseInfo | null = null;
  /** An apply is under way, or finished and the app is quitting. */
  let applyInProgress = false;

  async function releaseInfo(updateInfo: { version?: string; hash?: string }, currentVersion: string): Promise<ReleaseInfo> {
    const [channel, baseUrl] = await Promise.all([
      updater.localInfo.channel(),
      updater.localInfo.baseUrl(),
    ]);
    const version = updateInfo.version || currentVersion;
    return {
      version,
      tagName: `v${version}`,
      downloadUrl: `${baseUrl.replace(/\/+$/, "")}/${desktopReleasePlatformPrefix(channel)}-update.json`,
      publishedAt: "",
      updateAction: { kind: "desktop" },
    };
  }

  async function check(currentVersion: string): Promise<UpdateCheckResult> {
    // A downloaded update stays the answer until the user restarts into it, and
    // asking Electrobun again would discard its ready flag.
    if (readyRelease) return { kind: "available", release: readyRelease };
    try {
      const [channel, baseUrl] = await Promise.all([
        updater.localInfo.channel(),
        updater.localInfo.baseUrl(),
      ]);
      if (channel === "dev" || !baseUrl) {
        return { kind: "disabled" };
      }

      const info = await updater.checkForUpdate();
      if (info.error) {
        return { kind: "error", error: info.error };
      }
      if (!info.updateAvailable) {
        return { kind: "current" };
      }

      return {
        kind: "available",
        release: await releaseInfo(info, currentVersion),
      };
    } catch (error) {
      return {
        kind: "error",
        error: error instanceof Error ? error.message : "Desktop update check failed",
      };
    }
  }

  async function download(
    currentVersion: string,
    onProgress: (progress: UpdateProgress) => void,
  ): Promise<void> {
    if (downloadInProgress) {
      onProgress({
        phase: "error",
        error: "A desktop update is already in progress.",
      });
      return;
    }

    // Already downloaded, for instance after the window reloaded: say so
    // instead of fetching again.
    if (readyRelease) {
      onProgress({ phase: "ready", canRestart: true });
      return;
    }

    downloadInProgress = true;
    updater.clearStatusHistory();
    updater.onStatusChange((entry) => {
      const progress = mapDesktopUpdateStatus(entry);
      if (progress) onProgress(progress);
    });

    try {
      onProgress({ phase: "downloading", percent: 0 });
      const result = await check(currentVersion);
      if (result.kind === "error") {
        onProgress({ phase: "error", error: result.error });
        return;
      }
      if (result.kind !== "available") {
        onProgress({
          phase: "done",
          message: result.kind === "disabled" ? "Desktop updates are unavailable in this build" : "Already on the latest version",
        });
        return;
      }

      await updater.downloadUpdate();
      const updateInfo = updater.updateInfo();
      if (updateInfo?.error) {
        onProgress({ phase: "error", error: updateInfo.error });
        return;
      }
      if (!updateInfo?.updateReady) {
        onProgress({ phase: "error", error: "Desktop update did not finish downloading." });
        return;
      }

      // Downloaded, not installed: applying relaunches the app, and that waits
      // for the user's explicit request (`apply`).
      readyRelease = result.release;
      onProgress({ phase: "ready", canRestart: true });
    } catch (error) {
      onProgress({
        phase: "error",
        error: error instanceof Error ? error.message : "Desktop update failed",
      });
    } finally {
      downloadInProgress = false;
      updater.onStatusChange(null);
    }
  }

  async function apply(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    if (applyInProgress || downloadInProgress) return;
    if (!readyRelease || !updater.updateInfo()?.updateReady) {
      readyRelease = null;
      onProgress({ phase: "error", error: "The downloaded update is no longer available." });
      return;
    }

    applyInProgress = true;
    let relaunching = false;
    let reportedError = false;
    const report = (progress: UpdateProgress) => {
      if (progress.phase === "error") reportedError = true;
      onProgress(progress);
    };
    updater.onStatusChange((entry) => {
      if (entry.status === "launching-new-version" || entry.status === "complete") relaunching = true;
      const progress = mapDesktopUpdateStatus(entry);
      if (progress) report(progress);
    });

    try {
      report({ phase: "replacing" });
      await updater.applyUpdate();
      // Electrobun returns without a status when it cannot install, for example
      // when a newer release replaced the one that was downloaded.
      if (!relaunching && !reportedError) {
        report({ phase: "error", error: "Desktop update could not be installed." });
      }
    } catch (error) {
      report({
        phase: "error",
        error: error instanceof Error ? error.message : "Desktop update failed",
      });
    } finally {
      updater.onStatusChange(null);
    }

    // Past this point the app is quitting, so the guard stays up. A failed apply
    // drops the staged release: the retry starts from the download again.
    if (!relaunching) {
      readyRelease = null;
      applyInProgress = false;
    }
  }

  return { check, download, apply };
}
