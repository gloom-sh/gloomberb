import type { UpdateChannel } from "../types/config";
import { reportUpdateFailure, type UpdateInstallKind } from "../telemetry/update-failures";
import { compareSemver, isPrereleaseVersion } from "../utils/semver";
import { PACKAGE_NAME } from "../version";
import {
  classifyUpdateError,
  httpStatusFailureCode,
  type UpdateFailure,
  type UpdateFailureCode,
  type UpdateFailurePhase,
} from "./failure";
import {
  GITHUB_LATEST_RELEASE_API_URL,
  GITHUB_RELEASES_API_URL,
  newestRelease,
  type GitHubReleaseAsset,
} from "./github-releases";

/**
 * How many of the newest releases the nightly channel looks through. Nightly
 * builds are only published for a new main, so any stable release outside this
 * window is older than the nightly builds inside it.
 */
const NIGHTLY_RELEASE_WINDOW = 30;

function getRuntimeProcess(): Pick<NodeJS.Process, "platform" | "arch" | "argv" | "execPath" | "getBuiltinModule"> | null {
  return (globalThis as { process?: NodeJS.Process }).process ?? null;
}

export interface ReleaseInfo {
  version: string;
  tagName: string;
  downloadUrl: string;
  publishedAt: string;
  updateAction: UpdateAction;
  compressed?: boolean;
  /** SHA-256 of the downloaded GitHub release asset. */
  checksum?: string;
  /**
   * The channel the release was found on, so a desktop download fetches from
   * the same release the check picked. Absent means stable.
   */
  channel?: UpdateChannel;
}

export interface UpdateProgress {
  /**
   * `ready`: the new version is downloaded and waiting. The terminal binary is
   * already swapped and runs on the next launch; the desktop app applies it
   * when `canRestart` is set and the user asks. Nothing restarts by itself.
   * `done` is for a finished action that has nothing left to wait for: an
   * install relaunching the app, or a download that found nothing to take,
   * which the app shows as a passing notice.
   */
  phase: "downloading" | "ready" | "replacing" | "done" | "error";
  percent?: number;
  error?: string;
  message?: string;
  /** With `ready`: this host can apply the update and relaunch on request. */
  canRestart?: boolean;
  /** With `error`: the step that failed and why, which the header says in a few words. */
  failure?: UpdateFailure;
}

export type UpdateAction =
  | { kind: "self" }
  | { kind: "desktop" }
  | { kind: "manual"; command: string }
  /**
   * A standalone binary this process cannot overwrite: a Nix store path, a
   * distro package under /usr/bin, anything installed by root. Whatever put it
   * there updates it; trying ourselves ended in "EROFS: read-only file system"
   * in the header (#684).
   */
  | { kind: "managed"; reason: string };

export type UpdateCheckResult =
  | { kind: "available"; release: ReleaseInfo }
  /** `notice`: why a newer-looking state is not an update, such as a nightly build waiting for a stable release. */
  | { kind: "current"; notice?: string }
  | { kind: "disabled" }
  | { kind: "error"; error: string; failure?: UpdateFailure };

/**
 * On the stable channel a nightly build is never replaced by an older stable
 * release: it stays until a stable release passes it.
 */
export function stableHoldNotice(currentVersion: string): string {
  return `Staying on v${currentVersion} until a newer stable release`;
}

export interface UpdateHost {
  checkForUpdateDetailed(currentVersion: string, channel: UpdateChannel): Promise<UpdateCheckResult>;
  /** Downloads and stages the update, ending in `ready` (or `error`). It never relaunches the app. */
  performUpdate(release: ReleaseInfo, onProgress: (p: UpdateProgress) => void): Promise<void>;
  /** Installs the staged update and relaunches the app. Only runs on an explicit request. */
  applyUpdate?(onProgress: (p: UpdateProgress) => void): Promise<void>;
}

let updateHost: UpdateHost | null = null;

/**
 * The terminal binary a nightly build replaced in this run, kept beside it
 * until the restart so a switch back to stable can put it back
 * (`discardStagedUpdate`). Stable updates keep nothing, as before.
 */
let stagedSwap: { execPath: string; previousPath: string } | null = null;

export function setUpdateHost(host: UpdateHost | null): void {
  updateHost = host;
}

export function getAssetBaseNameForRuntime(
  runtimeProcess: Pick<NodeJS.Process, "platform" | "arch"> | null = getRuntimeProcess(),
): string {
  const os = runtimeProcess?.platform === "darwin"
    ? "darwin"
    : runtimeProcess?.platform === "win32"
      ? "windows"
      : "linux";
  // Always update to the architecture the current runtime actually is. macOS
  // only publishes arm64 today, so an x64 macOS runtime resolves no asset and
  // reports that instead of overwriting itself with an unrunnable binary.
  const arch = runtimeProcess?.arch === "arm64" ? "arm64" : "x64";
  const extension = os === "windows" ? ".exe" : "";
  return `gloomberb-${os}-${arch}${extension}`;
}

function getAssetBaseName(): string {
  return getAssetBaseNameForRuntime();
}

function parseAssetDigest(digest: string | undefined): string | undefined {
  return /^sha256:([a-f\d]{64})$/i.exec(digest ?? "")?.[1]?.toLowerCase();
}

function resolveReleaseAsset(
  assets: GitHubReleaseAsset[],
): { name: string; browser_download_url: string; compressed: boolean; checksum?: string } | null {
  const assetBaseName = getAssetBaseName();
  const gzAsset = assets.find((asset) => asset.name === `${assetBaseName}.gz`);
  if (gzAsset) {
    const { name, browser_download_url, digest } = gzAsset;
    return { name, browser_download_url, compressed: true, checksum: parseAssetDigest(digest) };
  }

  const rawAsset = assets.find((asset) => asset.name === assetBaseName);
  if (rawAsset) {
    const { name, browser_download_url, digest } = rawAsset;
    return { name, browser_download_url, compressed: false, checksum: parseAssetDigest(digest) };
  }

  return null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const runtimeExecutables = new Set([
  "bun",
  "bun.exe",
  "bunx",
  "bunx.exe",
  "node",
  "node.exe",
  "nodejs",
  "nodejs.exe",
  "npm",
  "npm.cmd",
  "npm.exe",
  "npx",
  "npx.cmd",
  "npx.exe",
  "pnpm",
  "pnpm.cmd",
  "pnpm.exe",
  "yarn",
  "yarn.cmd",
  "yarn.exe",
]);

function resolveEntrypointPath(argv = process.argv): string {
  return argv[1] ?? "";
}

function isSourceEntrypoint(entrypoint: string): boolean {
  const sourceEntrypointPattern = /\.(c|m)?jsx?$/;
  const tsEntrypointPattern = /\.(c|m)?tsx?$/;
  return sourceEntrypointPattern.test(entrypoint) || tsEntrypointPattern.test(entrypoint);
}

function isMacAppBundleExecutable(execPath: string): boolean {
  return normalizePath(execPath).includes(".app/contents/macos/");
}

function isBundledDesktopTuiRuntime(execPath: string, argv: string[]): boolean {
  const normalizedExecPath = normalizePath(execPath);
  const entrypoint = normalizePath(resolveEntrypointPath(argv));
  if (!entrypoint.endsWith("/resources/gloomberb-tui/tui-entry.js")) return false;
  return normalizedExecPath.endsWith("/contents/macos/bun")
    || normalizedExecPath.endsWith("/bin/bun")
    || normalizedExecPath.endsWith("/bin/bun.exe");
}

export function resolveSelfUpdateTargetPath(
  execPath = getRuntimeProcess()?.execPath ?? "",
  argv = getRuntimeProcess()?.argv ?? [],
): string | null {
  const resolvedExecPath = execPath;
  const normalizedExecPath = normalizePath(resolvedExecPath);
  if (isMacAppBundleExecutable(resolvedExecPath)) return null;

  const execBase = basename(normalizedExecPath);
  if (runtimeExecutables.has(execBase)) return null;
  if (normalizedExecPath.includes("/.bun/bin/")) return null;

  const entrypoint = normalizePath(resolveEntrypointPath(argv));
  if (isSourceEntrypoint(entrypoint)) return null;

  return resolvedExecPath;
}

/**
 * Why this process could not replace its own binary, or null when it can (or
 * when that cannot be told, as for a path that does not exist).
 *
 * `fs` is reached through a variable so the browser bundles, which share this
 * module, do not try to resolve it; they never get here because they have no
 * `process.execPath` to begin with.
 */
export function describeUnwritableInstall(execPath: string): string | null {
  if (!execPath || typeof require !== "function") return null;
  const normalized = normalizePath(execPath);
  const directory = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/"))) || "/";
  try {
    const fsModulePath = "fs";
    const fs = require(fsModulePath) as typeof import("fs");
    fs.accessSync(execPath, fs.constants.W_OK);
    fs.accessSync(directory, fs.constants.W_OK);
    return null;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "EROFS") return "the install is on a read-only file system";
    if (code === "EACCES" || code === "EPERM") return "the install directory is not writable";
    return null;
  }
}

export function detectUpdateAction(
  execPath = getRuntimeProcess()?.execPath ?? "",
  argv = getRuntimeProcess()?.argv ?? [],
): UpdateAction | null {
  if (isMacAppBundleExecutable(execPath)) return null;
  if (isBundledDesktopTuiRuntime(execPath, argv)) return null;

  const normalizedExecPath = normalizePath(execPath);
  const execBase = basename(normalizedExecPath);
  const entrypoint = normalizePath(resolveEntrypointPath(argv));
  if (execBase === "gloomberb.exe") return null;

  if (resolveSelfUpdateTargetPath(execPath, argv)) {
    const reason = describeUnwritableInstall(execPath);
    return reason ? { kind: "managed", reason } : { kind: "self" };
  }

  if (!entrypoint || isSourceEntrypoint(entrypoint)) return null;

  if (
    execBase === "bun"
    || execBase === "bun.exe"
    || execBase === "bunx"
    || execBase === "bunx.exe"
    || normalizedExecPath.includes("/.bun/bin/")
    || entrypoint.includes("/.bun/install/")
    || entrypoint.includes("/install/global/")
  ) {
    return { kind: "manual", command: `bun install -g ${PACKAGE_NAME}@latest` };
  }

  if (
    execBase === "node"
    || execBase === "node.exe"
    || execBase === "nodejs"
    || execBase === "nodejs.exe"
    || execBase === "npm"
    || execBase === "npm.cmd"
    || execBase === "npm.exe"
    || execBase === "npx"
    || execBase === "npx.cmd"
    || execBase === "npx.exe"
    || execBase === "pnpm"
    || execBase === "pnpm.cmd"
    || execBase === "pnpm.exe"
    || execBase === "yarn"
    || execBase === "yarn.cmd"
    || execBase === "yarn.exe"
    || entrypoint.includes("/lib/node_modules/")
    || entrypoint.includes("/node_modules/")
  ) {
    return { kind: "manual", command: `npm install -g ${PACKAGE_NAME}@latest` };
  }

  return null;
}

export function canSelfUpdate(release: Pick<ReleaseInfo, "updateAction"> | null | undefined): boolean {
  return release?.updateAction.kind === "self" || release?.updateAction.kind === "desktop";
}

/**
 * Whether the install-update key has something to retry: a release this build
 * can install itself whose last attempt failed. A fresh one downloads on its
 * own, and a manual or managed one names its own command. (A downloaded
 * desktop update has its own use of the key: restarting into it.)
 */
export function canRetryUpdate(state: {
  updateAvailable: ReleaseInfo | null;
  updateProgress: UpdateProgress | null;
  updateCheckInProgress: boolean;
}): boolean {
  return !!state.updateAvailable
    && state.updateProgress?.phase === "error"
    && !state.updateCheckInProgress
    && canSelfUpdate(state.updateAvailable);
}

/** A downloaded update this host can install and relaunch into when the user asks. */
export function canRestartToApply(progress: UpdateProgress | null | undefined): boolean {
  return progress?.phase === "ready" && progress.canRestart === true;
}

interface LatestReleasePayload {
  tag_name: string;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

/**
 * The newest release of any kind, nightly builds included, that carries this
 * platform's binary. Null when the list has none.
 */
function pickNightlyChannelRelease(payload: unknown): LatestReleasePayload | null {
  if (!Array.isArray(payload)) return null;
  const releases = payload as Array<LatestReleasePayload & { draft?: boolean }>;
  return newestRelease(releases, (release) => Array.isArray(release.assets) && resolveReleaseAsset(release.assets) !== null);
}

/**
 * Asks GitHub for the release this install should run on `channel`. Stable
 * reads `releases/latest`, which never returns a prerelease. Nightly reads the
 * newest releases and takes the highest version, so a nightly build is
 * offered the stable release once it passes the nightly's version. Only the
 * self-updating binary follows nightly: npm, Bun and package-manager installs
 * update from stable releases whatever the setting says.
 */
export async function checkForUpdateDetailed(
  currentVersion: string,
  channel: UpdateChannel = "stable",
): Promise<UpdateCheckResult> {
  if (updateHost) {
    return updateHost.checkForUpdateDetailed(currentVersion, channel);
  }

  const updateAction = detectUpdateAction();
  if (!updateAction) {
    return { kind: "disabled" };
  }
  const nightly = channel === "nightly" && updateAction.kind === "self";
  const failed = (error: string, code: UpdateFailureCode, targetVersion?: string): UpdateCheckResult => {
    const failure: UpdateFailure = { phase: "check", code };
    reportUpdateFailure(failure, { targetVersion, channel: nightly ? "nightly" : "stable" });
    return { kind: "error", error, failure };
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(nightly ? `${GITHUB_RELEASES_API_URL}?per_page=${NIGHTLY_RELEASE_WINDOW}` : GITHUB_LATEST_RELEASE_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!res.ok) {
      return failed(`GitHub returned ${res.status}`, httpStatusFailureCode(res.status));
    }

    const payload = await res.json();
    let data = payload as LatestReleasePayload;
    if (nightly) {
      const picked = pickNightlyChannelRelease(payload);
      if (!picked) return { kind: "current" };
      data = picked;
    }

    const version = data.tag_name.replace(/^v/, "");
    // A tag that does not parse as a version is not an update.
    if ((compareSemver(version, currentVersion) ?? 0) <= 0) {
      // A nightly build on the stable channel waits for a newer stable release
      // rather than going back to an older one, and says so.
      return !nightly && isPrereleaseVersion(currentVersion)
        ? { kind: "current", notice: stableHoldNotice(currentVersion) }
        : { kind: "current" };
    }

    const asset = resolveReleaseAsset(data.assets);
    if (!asset) {
      return failed(`No compatible release asset found for ${getAssetBaseName()}`, "no_build", version);
    }
    if (!asset.checksum) {
      return failed(`Release asset ${asset.name} is missing a valid SHA-256 digest`, "no_build", version);
    }

    return {
      kind: "available",
      release: {
        version,
        tagName: data.tag_name,
        downloadUrl: asset.browser_download_url,
        publishedAt: data.published_at,
        updateAction,
        compressed: asset.compressed,
        ...(asset.checksum ? { checksum: asset.checksum } : {}),
        ...(nightly ? { channel } : {}),
      },
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return failed("Update check timed out", "timeout");
    }
    const code = classifyUpdateError(error);
    return failed(error instanceof Error ? error.message : "Update check failed", code === "unknown" && error instanceof SyntaxError ? "bad_response" : code);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function checkForUpdate(
  currentVersion: string,
): Promise<ReleaseInfo | null> {
  const result = await checkForUpdateDetailed(currentVersion);
  return result.kind === "available" ? result.release : null;
}

/**
 * Takes back a downloaded update the channel no longer allows: a nightly build
 * waiting for a restart when the channel goes back to stable. The terminal
 * binary, already swapped in, is swapped back for the one this run started
 * from. The desktop app drops its staged update itself at the stable check
 * the caller runs next. Resolves to why it could not, or null.
 */
export async function discardStagedUpdate(): Promise<string | null> {
  if (updateHost) return null;
  const swap = stagedSwap;
  if (!swap) return "the previous version was not kept";
  const discardedPath = `${swap.execPath}.discarded`;
  try {
    const { renameSync, unlinkSync } = getRuntimeProcess()!.getBuiltinModule("fs");
    try {
      unlinkSync(discardedPath);
    } catch { /* Intentional ignore: The discarded binary may not exist; a failed rename is reported by discardStagedUpdate. */ }
    renameSync(swap.execPath, discardedPath);
    try {
      renameSync(swap.previousPath, swap.execPath);
    } catch (error) {
      renameSync(discardedPath, swap.execPath);
      throw error;
    }
    stagedSwap = null;
    try {
      unlinkSync(discardedPath);
    } catch { /* Intentional ignore: The original binary is restored; removing the discarded download is best-effort cleanup. */ }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "the previous version could not be put back";
  }
}

/** Installs the downloaded update and relaunches. Callers gate it on `canRestartToApply`. */
export async function applyUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  if (!updateHost?.applyUpdate) {
    onProgress({ phase: "error", error: "Restarting to apply an update is unavailable in this runtime." });
    return;
  }
  await updateHost.applyUpdate(onProgress);
}

export async function performUpdate(
  release: ReleaseInfo,
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  if (updateHost) {
    await updateHost.performUpdate(release, onProgress);
    return;
  }

  if (!canSelfUpdate(release)) {
    const action = release.updateAction;
    onProgress({
      phase: "error",
      error: action.kind === "manual"
        ? `Run ${action.command}`
        : action.kind === "managed"
          ? `Update through the package manager that installed Gloom: ${action.reason}.`
          : "This update type is unavailable in the current runtime.",
    });
    return;
  }

  if (release.updateAction.kind === "desktop") {
    onProgress({
      phase: "error",
      error: "Desktop updates are unavailable outside the packaged desktop app.",
    });
    return;
  }

  const execPath = resolveSelfUpdateTargetPath();
  if (!execPath) {
    onProgress({
      phase: "error",
      error: "Self-update is unavailable when running from source or via Bun/Node. Relaunch the packaged gloom binary to update.",
    });
    return;
  }

  const checksum = /^[a-f\d]{64}$/i.exec(release.checksum ?? "")?.[0].toLowerCase();
  const fail = (failure: UpdateFailure, error: string) => {
    reportUpdateFailure(failure, { targetVersion: release.version, channel: release.channel });
    onProgress({ phase: "error", error, failure });
  };
  if (!checksum) {
    fail({ phase: "verify", code: "no_build" }, "Self-update requires a valid SHA-256 checksum.");
    return;
  }

  const updatePath = execPath + ".update";
  const oldPath = execPath + ".old";
  let unlinkUpdatePath: ((path: string) => void) | null = null;
  /** The step under way, which a thrown error is reported against. */
  let phase: UpdateFailurePhase = "download";

  try {
    // Not import(): Bun folds even a specifier held in a variable and bundles
    // browser polyfills for all three into the web and desktop view builds,
    // which never reach this path. Self-update only runs in the compiled
    // terminal binary, where the process is always there.
    const runtime = getRuntimeProcess()!;
    const { renameSync, unlinkSync, chmodSync } = runtime.getBuiltinModule("fs");
    unlinkUpdatePath = unlinkSync;
    const { gunzipSync } = runtime.getBuiltinModule("zlib");
    const { createHash } = runtime.getBuiltinModule("crypto");

    onProgress({ phase: "downloading", percent: 0 });

    const res = await fetch(release.downloadUrl);
    if (!res.ok || !res.body) {
      throw new UpdateStepError({ phase: "download", code: httpStatusFailureCode(res.status) }, `Download failed: ${res.status}`);
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The connection broke partway: whatever it says, the file is incomplete.
        const code = classifyUpdateError(error);
        throw new UpdateStepError(
          { phase: "download", code: code === "timeout" ? code : "interrupted" },
          error instanceof Error ? error.message : "Download interrupted",
        );
      }
      const { done, value } = chunk;
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0) {
        onProgress({
          phase: "downloading",
          percent: Math.round((received / contentLength) * 100),
        });
      }
    }
    if (contentLength > 0 && received < contentLength) {
      throw new UpdateStepError(
        { phase: "download", code: "interrupted" },
        `Download stopped at ${received} of ${contentLength} bytes`,
      );
    }

    phase = "verify";
    const downloaded = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      downloaded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const actual = createHash("sha256").update(downloaded).digest("hex");
    if (actual !== checksum) {
      throw new UpdateStepError({ phase: "verify", code: "corrupt" }, `Checksum mismatch: expected ${checksum}, got ${actual}`);
    }
    const nextBinary = release.compressed
      ? new Uint8Array(gunzipSync(downloaded))
      : downloaded;
    phase = "apply";
    await Bun.write(updatePath, nextBinary);
    chmodSync(updatePath, 0o755);

    // Swap binaries
    onProgress({ phase: "replacing" });
    stagedSwap = null;
    try {
      unlinkSync(oldPath);
    } catch { /* Intentional ignore: The old binary may not exist; a failed swap is reported through update progress. */ }
    renameSync(execPath, oldPath);
    try {
      renameSync(updatePath, execPath);
    } catch (error) {
      renameSync(oldPath, execPath);
      throw error;
    }
    if (isPrereleaseVersion(release.version)) {
      // A nightly build can be ruled out before the restart (the channel goes
      // back to stable), so the binary it replaced stays to put back. The
      // next update clears it away.
      stagedSwap = { execPath, previousPath: oldPath };
    } else {
      try {
        unlinkSync(oldPath);
      } catch { /* Intentional ignore: The new binary is installed; removing its backup is best-effort cleanup. */ }
    }

    // The new binary is in place; the running process keeps the old one until
    // the user restarts it, which this process never does for them.
    onProgress({ phase: "ready" });
  } catch (err: unknown) {
    // Clean up temp file on failure
    try {
      unlinkUpdatePath?.(updatePath);
    } catch { /* Intentional ignore: Remove a partial update download while the original failure is reported through update progress. */ }
    const failure = err instanceof UpdateStepError ? err.failure : { phase, code: classifyUpdateError(err) };
    fail(failure, err instanceof Error ? err.message : "Update failed");
  }
}

/** A failed step whose code is known where it is thrown. */
class UpdateStepError extends Error {
  constructor(readonly failure: UpdateFailure, message: string) {
    super(message);
    this.name = "UpdateStepError";
  }
}

/** How the running terminal app was installed, as update failure reports name it. */
export function terminalInstallKind(action: UpdateAction | null = detectUpdateAction()): UpdateInstallKind {
  if (!action) return "terminal-source";
  if (action.kind === "self") return "terminal-binary";
  if (action.kind === "managed") return "terminal-managed";
  if (action.kind === "manual") return "terminal-package-manager";
  return "unknown";
}
