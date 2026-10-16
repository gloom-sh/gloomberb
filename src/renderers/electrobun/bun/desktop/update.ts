import type Electrobun from "electrobun/bun";
import type { UpdateStatusEntry } from "electrobun/bun";
import type { UpdateChannel } from "../../../../types/config";
import {
  stableHoldNotice,
  type ReleaseInfo,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../../../../updater";
import {
  GITHUB_RELEASES_API_URL,
  githubReleaseDownloadBaseUrl,
  isPrereleaseRelease,
  newestRelease,
  type GitHubReleaseListing,
} from "../../../../updater/github-releases";
import { stagedUpdateFitsChannel } from "../../../../updater/channel";
import { compareSemver, isPrereleaseVersion } from "../../../../utils/semver";
import { VERSION } from "../../../../version";

type ElectrobunUpdater = typeof Electrobun.Updater;

/**
 * The part of Electrobun's updater this flow uses. Tests pass a fake, because
 * the real module cannot be loaded or exercised outside the packaged app.
 * `setUpdateSource` is Gloomberb's patch (patches/electrobun@*.patch).
 */
export type ElectrobunUpdaterApi = Pick<
  ElectrobunUpdater,
  "checkForUpdate" | "downloadUpdate" | "applyUpdate" | "updateInfo" | "clearStatusHistory" | "onStatusChange" | "setUpdateSource"
> & {
  localInfo: Pick<ElectrobunUpdater["localInfo"], "channel" | "baseUrl">;
};

/** The newest releases, newest first, as GitHub lists them. */
type ListReleases = () => Promise<GitHubReleaseListing[]>;

const NIGHTLY_RELEASE_WINDOW = 30;

async function listGitHubReleases(): Promise<GitHubReleaseListing[]> {
  const response = await fetch(`${GITHUB_RELEASES_API_URL}?per_page=${NIGHTLY_RELEASE_WINDOW}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("GitHub returned an unexpected releases payload");
  return data as GitHubReleaseListing[];
}

export interface ElectrobunDesktopUpdater {
  /** `channel` defaults to stable, which reads the release version.json names exactly as before channels. */
  check(currentVersion: string, channel?: UpdateChannel): Promise<UpdateCheckResult>;
  /**
   * Downloads and stages `release`, the update a check offered, ending in
   * `ready`. It never relaunches the app. It checks again first, on the
   * release's channel and as the installed build, which is the question that
   * check answered: asked as the release's own version, the nightly check
   * finds nothing newer than it.
   */
  download(release: Pick<ReleaseInfo, "channel">, onProgress: (progress: UpdateProgress) => void): Promise<void>;
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

/**
 * The prefix of a release's desktop files. Both channels build with
 * Electrobun's `stable` environment; the nightly workflow renames its copies
 * `nightly-*`, so a stable and a nightly manifest can never be mistaken for
 * each other.
 */
function desktopFilesChannel(release: GitHubReleaseListing): "stable" | "nightly" {
  return isPrereleaseRelease(release) ? "nightly" : "stable";
}

function hasDesktopManifest(release: GitHubReleaseListing): boolean {
  const manifest = `${desktopReleasePlatformPrefix(desktopFilesChannel(release))}-update.json`;
  return release.assets?.some((asset) => asset.name === manifest) === true;
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

export function createElectrobunDesktopUpdater(
  updater: ElectrobunUpdaterApi,
  {
    listReleases = listGitHubReleases,
    runningVersion = VERSION,
  }: {
    listReleases?: ListReleases;
    /** The version of the installed app, which a download checks as. */
    runningVersion?: string;
  } = {},
): ElectrobunDesktopUpdater {
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

  /**
   * Forgets a downloaded update `updateChannel` does not allow: a nightly
   * build staged before the switch back to stable. Electrobun's own ready
   * flag goes at the stable check that follows (every check replaces it), so
   * a restart cannot install it, and its files go with the next download.
   */
  function dropStagedMisfit(updateChannel: UpdateChannel): void {
    if (readyRelease && !applyInProgress && !stagedUpdateFitsChannel(readyRelease, updateChannel)) readyRelease = null;
  }

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

  /**
   * Nightly: the highest version among the newest releases that has this
   * platform's desktop manifest, nightly or stable, fetched from that release's
   * own files. Electrobun only compares build hashes, so the version check
   * here is what keeps it from going backwards.
   */
  async function checkNightly(currentVersion: string): Promise<UpdateCheckResult> {
    const target = newestRelease(await listReleases(), hasDesktopManifest);
    if (!target?.tag_name || (compareSemver(target.tag_name, currentVersion) ?? 0) <= 0) {
      return { kind: "current" };
    }
    const filesChannel = desktopFilesChannel(target);
    const baseUrl = githubReleaseDownloadBaseUrl(target.tag_name);
    updater.setUpdateSource({ channel: filesChannel, baseUrl });

    const info = await updater.checkForUpdate();
    if (info.error) return { kind: "error", error: info.error };
    // The same build as the one installed.
    if (!info.updateAvailable) return { kind: "current" };

    return {
      kind: "available",
      release: {
        version: target.tag_name.replace(/^v/, ""),
        tagName: target.tag_name,
        downloadUrl: `${baseUrl}/${desktopReleasePlatformPrefix(filesChannel)}-update.json`,
        publishedAt: target.published_at ?? "",
        updateAction: { kind: "desktop" },
        channel: "nightly",
      },
    };
  }

  async function check(currentVersion: string, updateChannel: UpdateChannel = "stable"): Promise<UpdateCheckResult> {
    dropStagedMisfit(updateChannel);
    // A downloaded update the channel still allows stays the answer until the
    // user restarts into it, and asking Electrobun again would discard its
    // ready flag. Its source stays put too: applying reads it again.
    if (readyRelease) return { kind: "available", release: readyRelease };
    try {
      const [channel, baseUrl] = await Promise.all([
        updater.localInfo.channel(),
        updater.localInfo.baseUrl(),
      ]);
      if (channel === "dev" || !baseUrl) {
        return { kind: "disabled" };
      }

      if (updateChannel === "nightly") return await checkNightly(currentVersion);

      // Stable is the release version.json names, as it always was.
      updater.setUpdateSource(null);
      const info = await updater.checkForUpdate();
      if (info.error) {
        return { kind: "error", error: info.error };
      }
      if (!info.updateAvailable) {
        return { kind: "current" };
      }
      // A nightly build back on stable keeps running until a stable release
      // passes it, rather than installing an older one.
      if (isPrereleaseVersion(currentVersion) && (compareSemver(info.version, currentVersion) ?? -1) <= 0) {
        return { kind: "current", notice: stableHoldNotice(currentVersion) };
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
    release: Pick<ReleaseInfo, "channel">,
    onProgress: (progress: UpdateProgress) => void,
  ): Promise<void> {
    // The download comes from the release the check found, on its channel.
    const updateChannel: UpdateChannel = release.channel === "nightly" ? "nightly" : "stable";
    if (downloadInProgress) {
      onProgress({
        phase: "error",
        error: "A desktop update is already in progress.",
      });
      return;
    }

    // Already downloaded, for instance after the window reloaded: say so
    // instead of fetching again.
    dropStagedMisfit(updateChannel);
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
      const result = await check(runningVersion, updateChannel);
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
