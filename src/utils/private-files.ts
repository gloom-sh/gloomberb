import { chmodSync, closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, writeSync } from "fs";
import { chmod, lstat, mkdir, open } from "fs/promises";

/**
 * The profile keeps broker credentials (config.json), the Cloud session (the
 * database), a remote-control token and logs of what the user looked at. On
 * POSIX its folders are opened only by the user and its files read only by
 * them, whatever the umask. Windows keeps the profile under the user's own
 * folder, whose access list already does this, and has no such modes: there
 * every call here only creates and writes.
 */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function usesPosixModes(): boolean {
  return process.platform !== "win32";
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** Creates `path` and the folders above it as `mkdir -p` does, each one it creates open to the user alone. */
export function makePrivateDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

export async function makePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Leaves an existing folder open to the user alone; a missing one stays missing. */
export async function restrictDir(path: string): Promise<void> {
  if (!usesPosixModes()) return;
  try {
    await chmod(path, PRIVATE_DIR_MODE);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Leaves an existing file readable by the user alone; a missing one stays missing. */
export async function restrictFile(path: string): Promise<void> {
  if (!usesPosixModes()) return;
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function restrictFileSync(path: string): void {
  if (!usesPosixModes()) return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** The code of the error a private write throws when its path names a device, a pipe or anything else but a plain file. */
export const NOT_A_PLAIN_FILE = "ENOTPLAINFILE";

function notAPlainFile(path: string): Error {
  return Object.assign(new Error(`${path} is not a plain file.`), { code: NOT_A_PLAIN_FILE });
}

function isALink(path: string): Error {
  return Object.assign(new Error(`${path} is a link.`), { code: "ELOOP" });
}

/**
 * Opened to write without following a link (`O_NOFOLLOW`, which fails with
 * ELOOP) or waiting on a pipe no one reads (`O_NONBLOCK`). Windows has
 * neither flag; a link is refused there by looking first.
 */
function privateOpenFlags(append: boolean): number {
  return constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : 0)
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
}

function refuseWindowsLinkSync(path: string): void {
  if (usesPosixModes()) return;
  try {
    if (lstatSync(path).isSymbolicLink()) throw isALink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function refuseWindowsLink(path: string): Promise<void> {
  if (usesPosixModes()) return;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw isALink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Writes `contents` to a plain file only the user can read: created so, and
 * an existing file made so before anything is written to it, so the new
 * contents are never readable by anyone else. A link, a device or a pipe in
 * its place is refused, never written through. `append` adds to the end.
 */
export function writePrivateFileSync(path: string, contents: string | Uint8Array, options: { append?: boolean } = {}): void {
  refuseWindowsLinkSync(path);
  const fd = openSync(path, privateOpenFlags(options.append === true), PRIVATE_FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw notAPlainFile(path);
    if (usesPosixModes()) {
      try {
        fchmodSync(fd, PRIVATE_FILE_MODE);
      } catch {
        // Intentional ignore: a disk without POSIX modes (FAT, some network shares) cannot restrict the file; the write still goes through.
      }
    }
    if (!options.append) ftruncateSync(fd, 0);
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
  } finally {
    closeSync(fd);
  }
}

export async function writePrivateFile(path: string, contents: string | Uint8Array): Promise<void> {
  await refuseWindowsLink(path);
  const handle = await open(path, privateOpenFlags(false), PRIVATE_FILE_MODE);
  try {
    if (!(await handle.stat()).isFile()) throw notAPlainFile(path);
    if (usesPosixModes()) {
      await handle.chmod(PRIVATE_FILE_MODE).catch(() => {
        // Intentional ignore: a disk without POSIX modes (FAT, some network shares) cannot restrict the file; the write still goes through.
      });
    }
    await handle.truncate(0);
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
