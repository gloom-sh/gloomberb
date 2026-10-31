import { constants } from "fs";
import { lstat, mkdir, open } from "fs/promises";
import { homedir } from "os";
import { posix, win32 } from "path";

interface OutputPathContext {
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

/** `C:\Users\me\out.csv`, `C:/out.csv`, `\\server\share\out.csv`: a path only Windows reads. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * The absolute path `--output <path>` names, in any form a shell passes it:
 * relative to the folder the command runs in, absolute, or under the home
 * folder (`~/Desktop/rv.csv`, which a shell leaves as typed after
 * `--output=`). A Windows path is read as one on Windows; anywhere else it
 * is refused, since it would write a file named after the whole path.
 */
export function resolveOutputPath(raw: string, context: OutputPathContext = {}): string {
  const platform = context.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const typed = raw.trim();
  if (!typed) throw new Error("--output needs a file to write, such as --output report.csv.");
  if (platform !== "win32" && WINDOWS_PATH.test(typed)) {
    throw new Error(`${typed} is a Windows path. Write a path on this computer, such as --output ~/Desktop/report.csv.`);
  }
  const home = context.home ?? homedir();
  const homeRelative = /^~(?:$|[\\/])/.test(typed);
  const expanded = homeRelative ? paths.join(home, typed.slice(1)) : typed;
  return paths.resolve(context.cwd ?? process.cwd(), expanded);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function isFolder(path: string, paths: typeof posix): Error {
  return new Error(`Cannot write ${path}: it is a folder. Name a file in it, such as ${paths.join(path, "report.csv")}.`);
}

function isLink(path: string): Error {
  return new Error(`Cannot write ${path}: it is a link. Name the file it points to, or a new file.`);
}

function isNotAFile(path: string): Error {
  return new Error(`Cannot write ${path}: it is not a plain file. Name a new file, or a file to replace.`);
}

/**
 * Fails when `path` names a folder, a link or anything else that is not a
 * plain file (a device, a pipe): checked before a report loads, so it stops
 * at once, and again as the file is opened.
 */
export async function checkOutputPath(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const existing = await lstat(path).catch(() => {
    // Intentional ignore: a path that does not exist yet is the usual case, and writing reports any real failure.
    return null;
  });
  if (!existing) return;
  if (existing.isDirectory()) throw isFolder(path, platform === "win32" ? win32 : posix);
  if (existing.isSymbolicLink()) throw isLink(path);
  if (!existing.isFile()) throw isNotAFile(path);
}

/**
 * Creates the folder `path` goes in and the folders above it, failing with
 * that folder named when it cannot: `--output /nonexistent/x.png` cannot
 * create /nonexistent, which says more than the `mkdir` error behind it.
 */
export async function createOutputFolder(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const folder = (platform === "win32" ? win32 : posix).dirname(path);
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    const lead = `Cannot create the folder ${folder}`;
    if (code === "EACCES" || code === "EPERM") throw new Error(`${lead}: permission denied.`);
    if (code === "EROFS") throw new Error(`${lead}: the disk is read-only.`);
    if (code === "ENOTDIR" || code === "EEXIST") throw new Error(`${lead}: a file stands where one of its folders would be.`);
    throw new Error(`${lead}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Opens `path` to write, creating it readable by the user alone: never
 * through a link (`O_NOFOLLOW`), and without waiting on a pipe no one reads
 * (`O_NONBLOCK`). Windows has neither flag; `checkOutputPath` refuses a link there.
 */
const OUTPUT_OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const OUTPUT_FILE_MODE = 0o600;

/**
 * Writes a command's output to `path`, creating the folders it names as
 * `shot --output` does, and failing with what to do when it cannot. The file
 * is readable by the user alone, as one it replaces is made, and only a plain
 * file is written: a link or a device in its place is refused.
 */
export async function writeOutputFile(path: string, contents: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const paths = platform === "win32" ? win32 : posix;
  await createOutputFolder(path, platform);
  await checkOutputPath(path, platform);
  const fail = (error: unknown): never => {
    throw writeFailure(path, paths, error);
  };
  const file = await open(path, OUTPUT_OPEN_FLAGS, OUTPUT_FILE_MODE).catch(fail);
  try {
    // The path can change between the check and the open; what was opened is what counts.
    if (!(await file.stat()).isFile()) throw isNotAFile(path);
    await (async () => {
      if (platform !== "win32") await file.chmod(OUTPUT_FILE_MODE);
      await file.truncate(0);
      await file.writeFile(contents);
    })().catch(fail);
  } finally {
    await file.close();
  }
}

function writeFailure(path: string, paths: typeof posix, error: unknown): Error {
  const code = errorCode(error);
  if (code === "EISDIR") return isFolder(path, paths);
  // O_NOFOLLOW on a link: ELOOP on Linux and macOS, EMLINK on FreeBSD.
  if (code === "ELOOP" || code === "EMLINK") return isLink(path);
  // O_NONBLOCK on a pipe no one reads.
  if (code === "ENXIO") return isNotAFile(path);
  if (code === "EACCES" || code === "EPERM") return new Error(`Cannot write ${path}: permission denied.`);
  if (code === "ENOTDIR" || code === "EEXIST") return new Error(`Cannot write ${path}: a file stands where one of its folders would be.`);
  return new Error(`Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
}
