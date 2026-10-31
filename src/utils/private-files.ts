import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "fs";
import { chmod, mkdir, open } from "fs/promises";

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

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
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
    if (!isMissing(error)) throw error;
  }
}

/** Leaves an existing file readable by the user alone; a missing one stays missing. */
export async function restrictFile(path: string): Promise<void> {
  if (!usesPosixModes()) return;
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function restrictFileSync(path: string): void {
  if (!usesPosixModes()) return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Writes `contents` to a file only the user can read: created so, and an
 * existing file made so before anything is written to it, so the new
 * contents are never readable by anyone else. `append` adds to the end.
 */
export function writePrivateFileSync(path: string, contents: string, options: { append?: boolean } = {}): void {
  const fd = openSync(path, options.append ? "a" : "w", PRIVATE_FILE_MODE);
  try {
    if (usesPosixModes()) {
      try {
        fchmodSync(fd, PRIVATE_FILE_MODE);
      } catch {
        // Intentional ignore: a disk without POSIX modes (FAT, some network shares) cannot restrict the file; the write still goes through.
      }
    }
    const bytes = Buffer.from(contents, "utf-8");
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
  } finally {
    closeSync(fd);
  }
}

export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w", PRIVATE_FILE_MODE);
  try {
    if (usesPosixModes()) {
      await handle.chmod(PRIVATE_FILE_MODE).catch(() => {
        // Intentional ignore: a disk without POSIX modes (FAT, some network shares) cannot restrict the file; the write still goes through.
      });
    }
    await handle.writeFile(contents, "utf-8");
  } finally {
    await handle.close();
  }
}
