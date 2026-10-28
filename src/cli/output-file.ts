import { mkdir, stat, writeFile } from "fs/promises";
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

/** Fails when `path` names a folder: checked before a report loads, so it stops at once. */
export async function checkOutputPath(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if ((await stat(path).catch(() => null))?.isDirectory()) throw isFolder(path, platform === "win32" ? win32 : posix);
}

/**
 * Writes a command's output to `path`, creating the folders it names as
 * `shot --output` does, and failing with what to do when it cannot.
 */
export async function writeOutputFile(path: string, contents: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const paths = platform === "win32" ? win32 : posix;
  try {
    await mkdir(paths.dirname(path), { recursive: true });
    await writeFile(path, contents);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EISDIR") throw isFolder(path, paths);
    if (code === "EACCES" || code === "EPERM") throw new Error(`Cannot write ${path}: permission denied.`);
    if (code === "ENOTDIR" || code === "EEXIST") throw new Error(`Cannot write ${path}: a file stands where one of its folders would be.`);
    throw new Error(`Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
