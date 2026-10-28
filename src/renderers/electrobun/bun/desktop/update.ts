import { open, readdir, rm } from "fs/promises";
import { basename, dirname, join } from "path";
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
import {
  classifyUpdateError,
  httpStatusFailureCode,
  type UpdateFailure,
  type UpdateFailureCode,
} from "../../../../updater/failure";
import {
  forgetStagedUpdate,
  noteUpdateApplying,
  noteUpdateStaged,
  reportUpdateFailure,
  type UpdateInstallKind,
} from "../../../../telemetry/update-failures";
import { logFailure } from "../../../../utils/log-failure";
import { compareSemver, isPrereleaseVersion } from "../../../../utils/semver";
import { VERSION } from "../../../../version";
import { DESKTOP_APP_NAME, LEGACY_DESKTOP_APP_NAME } from "../../shared/app-name";

type ElectrobunUpdater = typeof Electrobun.Updater;

/**
 * The part of Electrobun's updater this flow uses. Tests pass a fake, because
 * the real module cannot be loaded or exercised outside the packaged app.
 * `setUpdateSource` is this app's patch (patches/electrobun@*.patch).
 */
export type ElectrobunUpdaterApi = Pick<
  ElectrobunUpdater,
  | "checkForUpdate"
  | "downloadUpdate"
  | "applyUpdate"
  | "updateInfo"
  | "clearStatusHistory"
  | "getStatusHistory"
  | "onStatusChange"
  | "setUpdateSource"
> & Partial<Pick<ElectrobunUpdater, "appDataFolder">> & {
  localInfo: Pick<ElectrobunUpdater["localInfo"], "channel" | "baseUrl">;
};

/** The newest releases, newest first, as GitHub lists them. */
type ListReleases = () => Promise<GitHubReleaseListing[]>;

const NIGHTLY_RELEASE_WINDOW = 30;

/** A step that failed for a reason known where it was thrown. */
class DesktopUpdateError extends Error {
  constructor(message: string, readonly code: UpdateFailureCode) {
    super(message);
    this.name = "DesktopUpdateError";
  }
}

/** `<app>.previous` and `<app>.previous-<suffix>`: what an install moves the old app to. */
function isUpdateAside(entry: string, appName: string): boolean {
  if (!entry.startsWith(`${appName}.previous`)) return false;
  const rest = entry.slice(appName.length + ".previous".length);
  return rest === "" || /^-[0-9a-z]+(?:-\d+)?$/.test(rest);
}

/**
 * Removes the copies of the app an install moved aside and could not remove
 * then (the Electrobun patch's `replaceAppBundle`), from beside the app this
 * process runs from: starting from it means the install that left them worked.
 * macOS keeps the app in its bundle, Linux and Windows in a folder with
 * `bin/bun` inside. On Windows the copies are the ones the move into the
 * installer's folder set aside (installer-folder.ts).
 * Beside `Gloom.app` it also takes `Gloomberb.app.previous`: the copy the
 * update that brought the new name moved aside, under the old one.
 * Resolves to the paths it removed.
 */
export async function removeUpdateAsides(
  execPath: string = process.execPath,
  platform: string = process.platform,
): Promise<string[]> {
  const app = platform === "darwin"
    ? /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1]
    : (platform === "linux" || platform === "win32") && basename(dirname(execPath)).toLowerCase() === "bin" ? dirname(dirname(execPath)) : undefined;
  if (!app) return [];
  const folder = dirname(app);
  const names = platform === "darwin" && basename(app) === `${DESKTOP_APP_NAME}.app`
    ? [basename(app), `${LEGACY_DESKTOP_APP_NAME}.app`]
    : [basename(app)];
  const removed: string[] = [];
  for (const entry of await readdir(folder).catch(() => [] as string[])) {
    if (!names.some((name) => isUpdateAside(entry, name))) continue;
    const path = join(folder, entry);
    // One that still cannot be removed (another user's) is tried again at the next start.
    const done = await rm(path, { recursive: true, force: true }).then(() => true, logFailure("desktop-update", "Could not remove an old copy of the app", false));
    if (done) removed.push(path);
  }
  return removed;
}

const TAR_BLOCK = 512;

/**
 * The first path in a tar, read from its leading headers: a ustar name and
 * prefix, or the long name a pax (`x`) or GNU (`L`) header gives it. Null when
 * `bytes` ends before one.
 */
export function firstTarPath(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder();
  const field = (start: number, length: number) => {
    const raw = bytes.subarray(start, start + length);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
  };
  let longName: string | null = null;
  for (let header = 0; header + TAR_BLOCK <= bytes.length;) {
    if (bytes[header] === 0) return null;
    const type = String.fromCharCode(bytes[header + 156] ?? 0);
    const size = Number.parseInt(field(header + 124, 12).trim() || "0", 8);
    const data = header + TAR_BLOCK;
    if (type === "x" || type === "L" || type === "g" || type === "K") {
      if (!Number.isFinite(size) || data + size > bytes.length) return null;
      if (type === "L") longName = field(data, size);
      if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(bytes.subarray(data, data + size)))?.[1] ?? longName;
      header = data + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      continue;
    }
    if (longName) return longName;
    const name = field(header, 100);
    // POSIX ustar ("ustar\0") only: GNU tar keeps other fields where the prefix would be.
    const prefix = field(header + 257, 6) === "ustar" ? field(header + 345, 155) : "";
    return prefix ? `${prefix}/${name}` : name;
  }
  return null;
}

/**
 * An octal number field of a tar header, read as tar readers do: the digits
 * after any leading spaces, up to the first other character. The checksum is
 * what tells a header from noise.
 */
function tarOctal(header: Uint8Array, start: number, length: number): number {
  const digits = /^[\0 ]*([0-7]*)/.exec(new TextDecoder().decode(header.subarray(start, start + length)))?.[1];
  return digits ? Number.parseInt(digits, 8) : 0;
}

/** Whether a header's checksum matches it: its bytes summed with the checksum field as spaces. */
function tarHeaderChecksumMatches(header: Uint8Array): boolean {
  const stored = tarOctal(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

/**
 * Whether the file at `path` is a whole tar: every header from the first
 * matches its checksum, and the entries reach the end-of-archive block before
 * the file ends. A tar cut off partway (a decompress that failed, an app that
 * quit while writing it) or no tar at all is not. It reads the headers only,
 * so it says nothing about the files' contents.
 */
export async function isWholeTar(path: string): Promise<boolean> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return false;
  try {
    const { size } = await file.stat();
    const header = new Uint8Array(TAR_BLOCK);
    for (let offset = 0; offset + TAR_BLOCK <= size;) {
      const { bytesRead } = await file.read(header, 0, TAR_BLOCK, offset);
      if (bytesRead < TAR_BLOCK) return false;
      if (header.every((byte) => byte === 0)) return offset > 0;
      if (!tarHeaderChecksumMatches(header)) return false;
      // Octal: the base-256 sizes past 8 GB are not in an app's archive.
      const entrySize = tarOctal(header, 124, 12);
      offset += TAR_BLOCK + Math.ceil(entrySize / TAR_BLOCK) * TAR_BLOCK;
    }
    return false;
  } catch {
    return false;
  } finally {
    await file.close().catch(() => {});
  }
}

/** Whether `path` holds a file that is not a whole tar. A missing one is not damaged. */
async function isDamagedTar(path: string): Promise<boolean> {
  return await Bun.file(path).exists() && !(await isWholeTar(path));
}

/** Where Electrobun keeps the update with build hash `hash` once it is downloaded. */
function stagedArchivePath(extractionFolder: string, hash: string | undefined): string | null {
  return hash ? join(extractionFolder, `${hash}.tar`) : null;
}

async function removeStagedArchive(path: string): Promise<void> {
  await rm(path, { force: true }).catch(logFailure("desktop-update", "Could not remove a damaged update archive"));
}

/**
 * Removes the unpacked update archives in Electrobun's `self-extraction`
 * folder it must not build on. Electrobun takes `<hash>.tar` there as the
 * update already downloaded without reading it, and a damaged one (part of a
 * tar, from a decompress that failed) then failed to unpack at every install:
 * without it, the download fetches a fresh copy. Also removed are the ones
 * whose app carries its name from before the rename. The one that matters is
 * the Windows archive an install from then updated from: it is packed again
 * with the folder renamed (scripts/write-legacy-desktop-files.ts), so its
 * bytes are not those of the archive the next release's patch is made from,
 * and bspatch would turn it into a broken build. Without it the updater
 * downloads the full archive instead. Resolves to the paths it removed.
 */
async function removeUnusableUpdateArchives(folder: string): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(folder).catch(() => [] as string[])) {
    if (!entry.endsWith(".tar")) continue;
    const path = join(folder, entry);
    let reason: string;
    if (!(await isWholeTar(path))) {
      reason = "Could not remove a damaged update archive";
    } else {
      const head = await Bun.file(path).slice(0, 64 * 1024).bytes().catch(() => null);
      const top = head ? firstTarPath(head)?.replace(/^\.\//, "").split("/")[0] : undefined;
      if (top !== LEGACY_DESKTOP_APP_NAME && top !== `${LEGACY_DESKTOP_APP_NAME}.app`) continue;
      reason = "Could not remove an update archive from before the rename";
    }
    const done = await rm(path, { force: true }).then(() => true, logFailure("desktop-update", reason, false));
    if (done) removed.push(path);
  }
  return removed;
}

/**
 * Where the running app sits, for update failure reports and for what an
 * install that cannot replace it means. Electrobun replaces the macOS bundle
 * the app runs from; on Windows and Linux it always installs into its own
 * folder under the user's app data.
 */
export function detectDesktopInstallKind(
  execPath: string = process.execPath,
  platform: string = process.platform,
  homeDir: string = process.env.HOME ?? "",
): UpdateInstallKind {
  if (platform !== "darwin") return platform === "win32" || platform === "linux" ? "desktop-app-data" : "unknown";
  const bundle = /^(.*?\.app)\/Contents\//.exec(execPath)?.[1];
  if (!bundle) return "unknown";
  if (bundle.includes("/AppTranslocation/")) return "desktop-translocated";
  if (bundle.startsWith("/Volumes/")) return "desktop-volume";
  if (bundle.startsWith("/Applications/") || (homeDir && bundle.startsWith(`${homeDir}/Applications/`))) return "desktop-applications";
  return "desktop-elsewhere";
}

/**
 * On macOS a bundle that cannot be replaced where it runs (a disk image, the
 * read-only copy App Translocation runs, another volume) is fixed by moving
 * the app to Applications, which is what the header then says. Anywhere else
 * a move across disks keeps its own reason: from Applications, moving the app
 * again would not help.
 */
function installFailureCode(code: UpdateFailureCode, installKind: UpdateInstallKind): UpdateFailureCode {
  const movable = installKind === "desktop-translocated" || installKind === "desktop-volume";
  if (movable && (code === "permission_denied" || code === "read_only" || code === "wrong_location" || code === "cross_device")) return "wrong_location";
  return code;
}

/**
 * Why Electrobun's check failed. It returns one message for every failure, so
 * the status it emitted just before says whether the server answered (with
 * which status) or could not be reached.
 */
function checkFailureCode(error: string, history: UpdateStatusEntry[]): UpdateFailureCode {
  const last = history.at(-1);
  const status = last?.status === "error" ? /HTTP (\d{3})/.exec(last.message)?.[1] : undefined;
  if (status) return httpStatusFailureCode(Number(status));
  if (/Invalid update\.json/i.test(error)) return "bad_response";
  const code = classifyUpdateError(error);
  // "Failed to fetch update info" with no status before it: the request itself threw.
  return code === "unknown" ? "offline" : code;
}

/** Why a download that Electrobun returned from did not leave an update ready. */
function downloadFailureCode(error: string, lastErrorStatus: UpdateStatusEntry | null): UpdateFailure {
  if (/zstd/i.test(error)) return { phase: "verify", code: "corrupt" };
  if (lastErrorStatus?.message.startsWith("Failed to download:")) return { phase: "download", code: "http_error" };
  const code = classifyUpdateError(error);
  return { phase: "download", code: code === "unknown" ? "interrupted" : code };
}

async function listGitHubReleases(): Promise<GitHubReleaseListing[]> {
  const response = await fetch(`${GITHUB_RELEASES_API_URL}?per_page=${NIGHTLY_RELEASE_WINDOW}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new DesktopUpdateError(`GitHub returned ${response.status}`, httpStatusFailureCode(response.status));
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

/**
 * The progress an Electrobun status means. An `error` status is left to the
 * caller: during a download Electrobun emits some it recovers from (a patch
 * that does not apply falls back to the full download), so only the outcome
 * says whether the download failed.
 */
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
    default:
      return null;
  }
}

export function createElectrobunDesktopUpdater(
  updater: ElectrobunUpdaterApi,
  {
    installKind = detectDesktopInstallKind(),
    listReleases = listGitHubReleases,
    runningVersion = VERSION,
  }: {
    /** Where the app runs from, which an install that cannot replace it is blamed on. */
    installKind?: UpdateInstallKind;
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

  /** Electrobun's `self-extraction` folder, where the download leaves the update as `<hash>.tar`. */
  async function extractionFolder(): Promise<string | null> {
    const appData = await updater.appDataFolder?.().catch(() => null);
    return appData ? join(appData, "self-extraction") : null;
  }

  /** The error progress for a failed step, reported to error tracking on the way. */
  function failed(failure: UpdateFailure, error: string, release?: { version?: string; channel?: UpdateChannel } | null): UpdateProgress {
    reportUpdateFailure(failure, {
      targetVersion: release?.version,
      channel: release?.channel === "nightly" ? "nightly" : "stable",
    });
    return { phase: "error", error, failure };
  }

  /**
   * Forgets a downloaded update `updateChannel` does not allow: a nightly
   * build staged before the switch back to stable. Electrobun's own ready
   * flag goes at the stable check that follows (every check replaces it), so
   * a restart cannot install it, and its files go with the next download.
   */
  function dropStagedMisfit(updateChannel: UpdateChannel): void {
    if (readyRelease && !applyInProgress && !stagedUpdateFitsChannel(readyRelease, updateChannel)) {
      readyRelease = null;
      forgetStagedUpdate();
    }
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

  /** Electrobun's check, with the failure it ended in named. */
  async function checkElectrobun(): Promise<Awaited<ReturnType<ElectrobunUpdaterApi["checkForUpdate"]>> | { error: string; code: UpdateFailureCode }> {
    const info = await updater.checkForUpdate();
    if (!info.error) return info;
    return { error: info.error, code: checkFailureCode(info.error, updater.getStatusHistory()) };
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

    const info = await checkElectrobun();
    if ("code" in info) throw new DesktopUpdateError(info.error, info.code);
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

  /**
   * The check, without reporting: a download runs it first and reports what
   * went wrong itself.
   */
  async function checkQuietly(currentVersion: string, updateChannel: UpdateChannel): Promise<UpdateCheckResult> {
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
      const info = await checkElectrobun();
      if ("code" in info) {
        return { kind: "error", error: info.error, failure: { phase: "check", code: info.code } };
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
      const code = error instanceof DesktopUpdateError ? error.code : classifyUpdateError(error);
      return {
        kind: "error",
        error: error instanceof Error ? error.message : "Desktop update check failed",
        failure: { phase: "check", code },
      };
    }
  }

  async function check(currentVersion: string, updateChannel: UpdateChannel = "stable"): Promise<UpdateCheckResult> {
    const result = await checkQuietly(currentVersion, updateChannel);
    if (result.kind === "error" && result.failure) reportUpdateFailure(result.failure, { channel: updateChannel });
    return result;
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
    /** The last error Electrobun emitted on the way, which may or may not have ended the download. */
    let lastErrorStatus: UpdateStatusEntry | null = null;
    /** The release the download is for, once the check has found it. */
    let target: ReleaseInfo | null = null;
    updater.clearStatusHistory();
    updater.onStatusChange((entry) => {
      if (entry.status === "error") {
        lastErrorStatus = entry;
        return;
      }
      const progress = mapDesktopUpdateStatus(entry);
      if (progress) onProgress(progress);
    });

    try {
      onProgress({ phase: "downloading", percent: 0 });
      const result = await checkQuietly(runningVersion, updateChannel);
      if (result.kind === "error") {
        onProgress(failed(result.failure ?? { phase: "check", code: "unknown" }, result.error, { channel: updateChannel }));
        return;
      }
      if (result.kind !== "available") {
        onProgress({
          phase: "done",
          message: result.kind === "disabled" ? "Desktop updates are unavailable in this build" : "Already on the latest version",
        });
        return;
      }
      target = result.release;

      const extraction = await extractionFolder();
      if (extraction) await removeUnusableUpdateArchives(extraction);
      await updater.downloadUpdate();
      const updateInfo = updater.updateInfo();
      if (updateInfo?.error) {
        onProgress(failed(downloadFailureCode(updateInfo.error, lastErrorStatus), updateInfo.error, result.release));
        return;
      }
      if (!updateInfo?.updateReady) {
        onProgress(failed({ phase: "download", code: "interrupted" }, "Desktop update did not finish downloading.", result.release));
        return;
      }
      // However Electrobun came by it (a patch, the full download), an archive
      // that is not whole is never offered for a restart. It goes, so the retry
      // downloads it again.
      const staged = extraction ? stagedArchivePath(extraction, updateInfo.hash) : null;
      if (staged && await isDamagedTar(staged)) {
        await removeStagedArchive(staged);
        onProgress(failed({ phase: "verify", code: "corrupt" }, "The downloaded update is damaged.", result.release));
        return;
      }

      // Downloaded, not installed: applying relaunches the app, and that waits
      // for the user's explicit request (`apply`).
      readyRelease = result.release;
      noteUpdateStaged(result.release.version, updateChannel);
      onProgress({ phase: "ready", canRestart: true });
    } catch (error) {
      const code = classifyUpdateError(error);
      onProgress(failed(
        { phase: "download", code: code === "unknown" ? "interrupted" : code },
        error instanceof Error ? error.message : "Desktop update failed",
        { version: target?.version, channel: updateChannel },
      ));
    } finally {
      downloadInProgress = false;
      updater.onStatusChange(null);
    }
  }

  async function apply(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    if (applyInProgress || downloadInProgress) return;
    if (!readyRelease || !updater.updateInfo()?.updateReady) {
      const missing = readyRelease;
      readyRelease = null;
      onProgress(failed({ phase: "apply", code: "staged_missing" }, "The downloaded update is no longer available.", missing));
      return;
    }

    const target = readyRelease;
    const stagedHash = updater.updateInfo()?.hash;
    applyInProgress = true;
    let relaunching = false;
    let reportedError = false;
    /** The install failed on the archive itself: it does not unpack. */
    let damaged = false;
    const report = (progress: UpdateProgress) => {
      if (progress.phase === "error") reportedError = true;
      onProgress(progress);
    };
    const installFailed = (error: unknown, message: string) => {
      // Electrobun names the system error in its message ("Failed to replace app: EACCES: ...").
      const code = installFailureCode(classifyUpdateError(error), installKind);
      if (code === "corrupt") damaged = true;
      report(failed({ phase: relaunching ? "relaunch" : "apply", code }, message, target));
    };
    // Kept before Electrobun quits the app, so the next launch can tell whether it took.
    noteUpdateApplying(target.version, target.channel === "nightly" ? "nightly" : "stable");
    updater.onStatusChange((entry) => {
      if (entry.status === "error") {
        const message = entry.details?.errorMessage || entry.message;
        installFailed(message, message);
        return;
      }
      if (entry.status === "launching-new-version" || entry.status === "complete") relaunching = true;
      const progress = mapDesktopUpdateStatus(entry);
      if (progress) report(progress);
    });

    try {
      report({ phase: "replacing" });
      await updater.applyUpdate();
      // Electrobun returns without a status when it finds nothing to install:
      // the downloaded files are gone, or hold no app.
      if (!relaunching && !reportedError) {
        report(failed({ phase: "apply", code: "staged_missing" }, "Desktop update could not be installed.", target));
      }
    } catch (error) {
      installFailed(error, error instanceof Error ? error.message : "Desktop update failed");
    } finally {
      updater.onStatusChange(null);
    }

    // Past this point the app is quitting, so the guard stays up. A failed apply
    // drops the staged release: the retry starts from the download again. An
    // archive that does not unpack goes too, or that download would take it as
    // done once more and the install would fail on it again.
    if (!relaunching) {
      readyRelease = null;
      const extraction = damaged ? await extractionFolder() : null;
      const staged = extraction ? stagedArchivePath(extraction, stagedHash) : null;
      if (staged) await removeStagedArchive(staged);
      applyInProgress = false;
    }
  }

  return { check, download, apply };
}
