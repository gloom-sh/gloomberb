import { lstatSync, symlinkSync } from "fs";
import { lstat, readFile, readlink, stat, symlink, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

/**
 * The terminal command is `gloom`. `gloomberb`, its name before 0.18.4, keeps
 * working beside it, for scripts and habits.
 *
 * An install from before the rename has only `gloomberb`, and the ways it
 * updates (the standalone binary replacing itself, the desktop app replacing
 * its bundle) never add a command. So the new build adds `gloom` beside
 * `gloomberb` when it runs. A `gloom` that is already there, whatever it is,
 * is left alone, and a folder this user cannot write is skipped.
 *
 * The desktop app looks through PATH, which can hold a slow or unreachable
 * network folder, so its half only reads and writes asynchronously and runs
 * once the app is up.
 */
const COMMAND_NAME = "gloom";
const LEGACY_COMMAND_NAME = "gloomberb";

/** The file the desktop app's Windows command runs, which tells its `gloomberb.cmd` from another program's. */
const WINDOWS_SHIM_ENTRY = "gloomberb-tui\\tui-entry.js";

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // Intentional ignore: a missing path, or one this user cannot see; either way nothing is added there.
    return false;
  }
}

function addSymlink(target: string, path: string): string | null {
  try {
    symlinkSync(target, path);
    return path;
  } catch {
    // Intentional ignore: a read-only or root-owned folder keeps the command it has.
    return null;
  }
}

/**
 * For the standalone binary, which updates by replacing itself: links the
 * other name to it in its own folder, `gloom` beside a `gloomberb` installed
 * before the rename (or `gloomberb` beside a `gloom`). Returns the link it
 * added, or null. A binary under any other name is left as it is.
 */
export function linkStandaloneCommand(execPath: string): string | null {
  const name = basename(execPath);
  const other = name === COMMAND_NAME ? LEGACY_COMMAND_NAME : name === LEGACY_COMMAND_NAME ? COMMAND_NAME : null;
  if (!other) return null;
  const path = join(dirname(execPath), other);
  if (pathExists(path)) return null;
  // Relative, as install.sh links it, so the pair still works if the folder moves.
  return addSymlink(name, path);
}

/** Homebrew's prefixes on Apple Silicon and on Intel. */
export const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"];

/** Homebrew's command folders on Apple Silicon and on Intel. */
const HOMEBREW_BINS = HOMEBREW_PREFIXES.map((prefix) => join(prefix, "bin"));

/**
 * Where a Mac keeps the desktop app's command: install.sh's folder, `~/bin`,
 * Homebrew's, then the rest of PATH. A GUI app's PATH rarely has the first
 * ones, so they are named outright.
 */
export function macCommandFolders(homeDir: string, pathEnv: string, homebrewBins: readonly string[] = HOMEBREW_BINS): string[] {
  return [...new Set([
    homeDir ? join(homeDir, ".local", "bin") : "",
    homeDir ? join(homeDir, "bin") : "",
    ...homebrewBins,
    ...pathEnv.split(":"),
  ].filter(Boolean))];
}

async function pathExistsAsync(path: string, followLinks = false): Promise<boolean> {
  try {
    await (followLinks ? stat(path) : lstat(path));
    return true;
  } catch {
    // Intentional ignore: a missing path, or one this user cannot see; either way nothing is added there.
    return false;
  }
}

/**
 * Next to a `gloomberb` link into an app bundle, adds `gloom` linked to the
 * same bundle's `gloom`. The target is written the way Homebrew writes its
 * own links, so a later `brew upgrade` sees the link as its own.
 */
async function linkMacCommand(folder: string): Promise<string | null> {
  let target: string;
  try {
    target = await readlink(join(folder, LEGACY_COMMAND_NAME));
  } catch {
    // Intentional ignore: not there, or not a link; a standalone binary adds its own when it runs.
    return null;
  }
  const absolute = resolve(folder, target);
  if (!absolute.endsWith(`.app/Contents/Resources/${LEGACY_COMMAND_NAME}`)) return null;
  const bundleCommand = join(dirname(absolute), COMMAND_NAME);
  const path = join(folder, COMMAND_NAME);
  if (!(await pathExistsAsync(bundleCommand, true)) || await pathExistsAsync(path)) return null;
  try {
    await symlink(bundleCommand, path);
    return path;
  } catch {
    // Intentional ignore: a read-only or root-owned folder keeps the command it has.
    return null;
  }
}

/**
 * Next to the desktop app's `gloomberb.cmd`, adds a `gloom.cmd` with the same
 * contents. The command finds the app from its own folder, so the copy runs
 * the same app.
 */
async function copyWindowsCommand(folder: string): Promise<string | null> {
  let shim: string;
  try {
    shim = await readFile(join(folder, `${LEGACY_COMMAND_NAME}.cmd`), "utf8");
  } catch {
    // Intentional ignore: no gloomberb.cmd, so this PATH folder belongs to another program.
    return null;
  }
  if (!shim.includes(WINDOWS_SHIM_ENTRY)) return null;
  const path = join(folder, `${COMMAND_NAME}.cmd`);
  if (await pathExistsAsync(path)) return null;
  try {
    await writeFile(path, shim, { flag: "wx" });
    return path;
  } catch {
    // Intentional ignore: a folder this user cannot write keeps the command it has.
    return null;
  }
}

interface DesktopCommandOptions {
  platform: string;
  homeDir: string;
  /** PATH as the app sees it. */
  pathEnv: string;
  /** `%LOCALAPPDATA%`, where the Windows installer puts the app by default (`Programs\Gloom`, `Programs\Gloomberb` before the rename). */
  localAppData?: string;
  /** Homebrew's command folders; tests pass none. */
  homebrewBins?: readonly string[];
}

/**
 * For the desktop app, which updates by replacing its bundle: adds `gloom`
 * wherever an installer put the app's `gloomberb` command (install.sh and
 * Homebrew links on a Mac, the installer's PATH folder on Windows). Resolves
 * to the commands it added. Folders are looked at side by side, so a slow one
 * holds up only itself.
 */
export async function linkDesktopCommands({
  platform,
  homeDir,
  pathEnv,
  localAppData,
  homebrewBins = HOMEBREW_BINS,
}: DesktopCommandOptions): Promise<string[]> {
  let added: Array<string | null> = [];
  if (platform === "darwin") {
    added = await Promise.all(macCommandFolders(homeDir, pathEnv, homebrewBins).map(linkMacCommand));
  } else if (platform === "win32") {
    const folders = new Set([
      localAppData ? join(localAppData, "Programs", "Gloom", "bin") : "",
      localAppData ? join(localAppData, "Programs", "Gloomberb", "bin") : "",
      ...pathEnv.split(";"),
    ].filter(Boolean));
    added = await Promise.all([...folders].map(copyWindowsCommand));
  }
  return added.filter((path): path is string => path !== null);
}
