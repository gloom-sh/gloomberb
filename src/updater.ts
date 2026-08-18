import { GITHUB_LATEST_RELEASE_API_URL } from "./updater/github-releases";

function getRuntimeProcess(): Pick<NodeJS.Process, "platform" | "arch" | "argv" | "execPath"> | null {
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
}

export interface UpdateProgress {
  phase: "downloading" | "replacing" | "done" | "error";
  percent?: number;
  error?: string;
  message?: string;
}

export type UpdateAction =
  | { kind: "self" }
  | { kind: "desktop" }
  | { kind: "manual"; command: string };

export type UpdateCheckResult =
  | { kind: "available"; release: ReleaseInfo }
  | { kind: "current" }
  | { kind: "disabled" }
  | { kind: "error"; error: string };

export interface UpdateHost {
  checkForUpdateDetailed(currentVersion: string): Promise<UpdateCheckResult>;
  performUpdate(release: ReleaseInfo, onProgress: (p: UpdateProgress) => void): Promise<void>;
}

let updateHost: UpdateHost | null = null;

export function setUpdateHost(host: UpdateHost | null): void {
  updateHost = host;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getAssetBaseNameForRuntime(
  runtimeProcess: Pick<NodeJS.Process, "platform" | "arch"> | null = getRuntimeProcess(),
): string {
  const os = runtimeProcess?.platform === "darwin"
    ? "darwin"
    : runtimeProcess?.platform === "win32"
      ? "windows"
      : "linux";
  // macOS x64 uses arm64 binary (runs via Rosetta 2)
  const arch = os === "darwin" || runtimeProcess?.arch === "arm64" ? "arm64" : "x64";
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
  assets: { name: string; browser_download_url: string; digest?: string }[],
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
    return { kind: "self" };
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
    return { kind: "manual", command: "bun install -g gloomberb@latest" };
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
    return { kind: "manual", command: "npm install -g gloomberb@latest" };
  }

  return null;
}

export function canSelfUpdate(release: Pick<ReleaseInfo, "updateAction"> | null | undefined): boolean {
  return release?.updateAction.kind === "self" || release?.updateAction.kind === "desktop";
}

export async function checkForUpdateDetailed(
  currentVersion: string,
): Promise<UpdateCheckResult> {
  if (updateHost) {
    return updateHost.checkForUpdateDetailed(currentVersion);
  }

  const updateAction = detectUpdateAction();
  if (!updateAction) {
    return { kind: "disabled" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(GITHUB_LATEST_RELEASE_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!res.ok) {
      return { kind: "error", error: `GitHub returned ${res.status}` };
    }

    const data = (await res.json()) as {
      tag_name: string;
      published_at: string;
      assets: { name: string; browser_download_url: string; digest?: string }[];
    };

    const version = data.tag_name.replace(/^v/, "");
    if (compareSemver(version, currentVersion) <= 0) {
      return { kind: "current" };
    }

    const asset = resolveReleaseAsset(data.assets);
    if (!asset) {
      return {
        kind: "error",
        error: `No compatible release asset found for ${getAssetBaseName()}`,
      };
    }
    if (!asset.checksum) {
      return {
        kind: "error",
        error: `Release asset ${asset.name} is missing a valid SHA-256 digest`,
      };
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
      },
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "error", error: "Update check timed out" };
    }
    return {
      kind: "error",
      error: error instanceof Error ? error.message : "Update check failed",
    };
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

export async function performUpdate(
  release: ReleaseInfo,
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  if (updateHost) {
    await updateHost.performUpdate(release, onProgress);
    return;
  }

  if (!canSelfUpdate(release)) {
    onProgress({
      phase: "error",
      error: release.updateAction.kind === "manual"
        ? `Run ${release.updateAction.command}`
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
      error: "Self-update is unavailable when running from source or via Bun/Node. Relaunch the packaged gloomberb binary to update.",
    });
    return;
  }

  const checksum = /^[a-f\d]{64}$/i.exec(release.checksum ?? "")?.[0].toLowerCase();
  if (!checksum) {
    onProgress({ phase: "error", error: "Self-update requires a valid SHA-256 checksum." });
    return;
  }

  const updatePath = execPath + ".update";
  const oldPath = execPath + ".old";
  let unlinkUpdatePath: ((path: string) => void) | null = null;

  try {
    const fsModulePath = "fs";
    const zlibModulePath = "zlib";
    const cryptoModulePath = "crypto";
    const {
      renameSync,
      unlinkSync,
      chmodSync,
    } = await import(fsModulePath) as typeof import("fs");
    unlinkUpdatePath = unlinkSync;
    const { gunzipSync } = await import(zlibModulePath) as typeof import("zlib");
    const { createHash } = await import(cryptoModulePath) as typeof import("crypto");

    onProgress({ phase: "downloading", percent: 0 });

    const res = await fetch(release.downloadUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status}`);
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
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

    const downloaded = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      downloaded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const actual = createHash("sha256").update(downloaded).digest("hex");
    if (actual !== checksum) {
      throw new Error(`Checksum mismatch: expected ${checksum}, got ${actual}`);
    }
    const nextBinary = release.compressed
      ? new Uint8Array(gunzipSync(downloaded))
      : downloaded;
    await Bun.write(updatePath, nextBinary);
    chmodSync(updatePath, 0o755);

    // Swap binaries
    onProgress({ phase: "replacing" });
    try {
      unlinkSync(oldPath);
    } catch {}
    renameSync(execPath, oldPath);
    try {
      renameSync(updatePath, execPath);
    } catch (error) {
      renameSync(oldPath, execPath);
      throw error;
    }
    try {
      unlinkSync(oldPath);
    } catch {}

    onProgress({ phase: "done" });
  } catch (err: unknown) {
    // Clean up temp file on failure
    try {
      unlinkUpdatePath?.(updatePath);
    } catch {}
    onProgress({
      phase: "error",
      error: err instanceof Error ? err.message : "Update failed",
    });
  }
}
