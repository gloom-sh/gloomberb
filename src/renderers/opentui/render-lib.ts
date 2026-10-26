/**
 * Loads OpenTUI's native render library before the terminal starts, and
 * keeps the standalone binary starting when its temp folder cannot run it.
 *
 * A Bun-compiled binary carries the library inside itself. Bun's dlopen
 * writes it to a new file in the temp folder on every launch and loads that
 * file. When the folder is full or read-only the write fails and the load
 * fails on the path inside the binary ("/$bunfs/root/libopentui-*.so: cannot
 * open shared object file"); when it is mounted noexec the file is written
 * but cannot be mapped ("failed to map segment from shared object"). Either
 * way the library is copied once into the native cache folder and loaded
 * from there on every later launch. The copy is named after the embedded
 * file, whose name carries a hash of its contents, so an upgrade never loads
 * an older library.
 *
 * Bun never deletes the files it writes, so each launch would leave 8 MB in
 * the temp folder until it fills up. On Linux the one this launch mapped is
 * removed once it is loaded: the mapping keeps it usable until exit.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { getGloomberbDirs } from "../../data/config/home";

/** Where the render library sits inside a standalone binary. */
interface EmbeddedRenderLib {
  /** The library @opentui/core loads by default. */
  path: string;
  /** Linux: the musl library, which it loads instead when `OPENTUI_LIBC` is `musl`. */
  musl?: string;
}

let embeddedRenderLib: EmbeddedRenderLib | null = null;

/**
 * Where the standalone binary carries its render library. A package or a
 * checkout has none.
 * @knipignore Called by the module scripts/build.ts writes for the release binary.
 */
export function useEmbeddedRenderLib(lib: EmbeddedRenderLib): void {
  embeddedRenderLib = lib;
}

/** The embedded library @opentui/core picks, by the same rule it uses. */
function embeddedRenderLibPath(env: NodeJS.ProcessEnv): string | null {
  if (!embeddedRenderLib) return null;
  return env.OPENTUI_LIBC === "musl" && embeddedRenderLib.musl ? embeddedRenderLib.musl : embeddedRenderLib.path;
}

/**
 * The folder Bun writes embedded libraries to before loading them: a
 * non-empty `BUN_TMPDIR`, else `TMPDIR`, `TMP` or `TEMP`, else the platform's
 * (Bun 1.3, `RealFS.tmpdirPath`).
 */
function bunTempDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const dir = env.BUN_TMPDIR || env.TMPDIR || env.TMP || env.TEMP;
  if (dir) return dir.length > 1 && /[\\/]$/.test(dir) ? dir.slice(0, -1) : dir;
  if (platform === "darwin") return "/private/tmp";
  if (platform === "win32") return `${(env.SYSTEMROOT || env.WINDIR || "C:\\Windows").replace(/\\$/, "")}\\Temp`;
  return "/tmp";
}

/** How Bun names the copy it writes: `.<hex>-<HEX>.so` (`.dylib`, `.dll`). */
const BUN_EXTRACTED_NAME = /^\.[0-9a-f]+-[0-9A-F]+\.(?:so|dylib|dll)$/;

/**
 * The temp folder copies this process has mapped, read from
 * `/proc/self/maps`: `address perms offset dev inode path`, with
 * ` (deleted)` after a path that is gone.
 */
function mappedExtractedCopies(maps: string, tempDir: string): string[] {
  const copies = new Set<string>();
  for (const line of maps.split("\n")) {
    const path = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
    if (!path || path.endsWith(" (deleted)")) continue;
    if (dirname(path) === tempDir && BUN_EXTRACTED_NAME.test(basename(path))) copies.add(path);
  }
  return [...copies];
}

/**
 * Copies of the library Bun wrote to the temp folder during this launch and
 * could not load: a noexec folder holds a whole copy for every attempt, a
 * full one a cut-off copy. Matched by Bun's naming, a size up to the
 * library's and a write time after this process started.
 */
function failedExtractedCopies(tempDir: string, size: number, sinceMs: number): string[] {
  return listDir(tempDir).filter((name) => BUN_EXTRACTED_NAME.test(name)).map((name) => join(tempDir, name)).filter((path) => {
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size <= size && stat.mtimeMs >= sinceMs;
    } catch {
      // Intentional ignore: a copy that vanished needs no removal.
      return false;
    }
  });
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    // Intentional ignore: an unreadable folder holds nothing we could remove.
    return [];
  }
}

function removeFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Intentional ignore: a copy left behind only costs disk space.
    }
  }
}

/** Puts the embedded library in the cache folder unless an intact copy is there, and returns its path. */
function cachedCopy(embeddedPath: string, size: number, cacheDir: string): string {
  const name = basename(embeddedPath);
  const target = join(cacheDir, name);
  try {
    if (statSync(target).size === size) return target;
  } catch {
    // Intentional ignore: no copy yet, written below.
  }
  mkdirSync(cacheDir, { recursive: true });
  const partial = join(cacheDir, `.${name}.${process.pid}.partial`);
  try {
    writeFileSync(partial, readFileSync(embeddedPath), { mode: 0o755 });
    renameSync(partial, target);
  } catch (error) {
    removeFiles([partial]);
    throw error;
  }
  // The copy an earlier version left, now unused. Another launch's partial
  // copy (dot-named) is still being written and stays.
  removeFiles(listDir(cacheDir).filter((entry) => entry !== name && entry.startsWith("libopentui")).map((entry) => join(cacheDir, entry)));
  return target;
}

/**
 * A failed load the folder the library was in explains: it never left the
 * binary because the temp folder took no file (`$bunfs`, `~BUN` on Windows),
 * or the folder does not let code run from it (glibc: "failed to map
 * segment", musl: "Operation not permitted"). A missing symbol or dependency
 * fails wherever the file sits.
 */
function isFolderFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\$bunfs|~BUN|failed to map segment|operation not permitted|permission denied/i.test(message);
}

/** Neither the temp folder nor the cache folder can hold and run the library. */
export class RenderLibUnavailableError extends Error {
  constructor(tempDir: string, cacheDir: string) {
    super(
      `Gloom can't load its render library: neither the temp folder ${tempDir} nor ${cacheDir} can hold and run it. `
      + "Start it with TMPDIR set to a writable folder that allows running programs: TMPDIR=/path/to/folder gloom",
    );
    this.name = "RenderLibUnavailableError";
  }
}

export interface RenderLibLoadOptions {
  /** Points @opentui/core at a library file (undefined: the one it picks) and loads it, throwing what loading threw. */
  load(path?: string): void;
  /** The library inside a standalone binary; null for a package or a checkout. */
  embeddedPath: string | null;
  tempDir: string;
  cacheDir: string;
  /** `/proc/self/maps`, or null where there is none. */
  readMaps(): string | null;
  /** When this process started, in epoch milliseconds. */
  startedAtMs: number;
}

/**
 * Loads the library from the temp folder, and from the cache folder when
 * the temp folder cannot hold or run it. Anything this cannot help with is
 * left as it was: the terminal then fails on it where it always did.
 * Throws {@link RenderLibUnavailableError} when both folders fail.
 */
export function loadRenderLibWith(options: RenderLibLoadOptions): void {
  const { load, embeddedPath, tempDir, cacheDir } = options;
  let tempError: unknown;
  try {
    load();
    if (embeddedPath) removeFiles(mappedExtractedCopies(options.readMaps() ?? "", realPath(tempDir)));
    return;
  } catch (error) {
    if (!embeddedPath) return;
    tempError = error;
  }

  let size: number;
  try {
    size = statSync(embeddedPath).size;
  } catch {
    // Intentional ignore: without the embedded file there is nothing to copy, so the original failure stands.
    return;
  }
  // The margin allows for file systems with coarse times.
  removeFiles(failedExtractedCopies(tempDir, size, options.startedAtMs - 2_000));

  let cachePath: string;
  try {
    cachePath = cachedCopy(embeddedPath, size, cacheDir);
  } catch {
    // The cache folder cannot hold it either. Only the temp folder's fault is reported as such.
    if (isFolderFailure(tempError)) throw new RenderLibUnavailableError(tempDir, cacheDir);
    return;
  }
  try {
    load(cachePath);
  } catch (cacheError) {
    if (isFolderFailure(tempError) && isFolderFailure(cacheError)) throw new RenderLibUnavailableError(tempDir, cacheDir);
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Intentional ignore: a temp folder that does not resolve holds nothing mapped.
    return path;
  }
}

function readProcessMaps(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/self/maps", "utf8");
  } catch {
    // Intentional ignore: without /proc the copy stays, as it always did.
    return null;
  }
}

/** Loads the render library for this process; see {@link loadRenderLibWith}. */
export async function loadRenderLib(): Promise<void> {
  const { resolveRenderLib, setRenderLibPath } = await import("@opentui/core");
  loadRenderLibWith({
    load(path) {
      if (path) setRenderLibPath(path);
      resolveRenderLib();
    },
    embeddedPath: embeddedRenderLibPath(process.env),
    tempDir: bunTempDir(process.env, process.platform),
    cacheDir: getGloomberbDirs().nativeCache,
    readMaps: readProcessMaps,
    startedAtMs: performance.timeOrigin,
  });
}
