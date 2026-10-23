import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/**
 * The terminal command is `gloom`. `gloomberb`, its name before 0.19, keeps
 * working beside it, for scripts and habits.
 *
 * An install from before the rename has only `gloomberb`, and the ways it
 * updates (the standalone binary replacing itself, the desktop app replacing
 * its bundle) never add a command. So the new build adds `gloom` beside
 * `gloomberb` when it runs. A `gloom` that is already there, whatever it is,
 * is left alone, and a folder this user cannot write is skipped.
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

/** Homebrew's command folders on Apple Silicon and on Intel. */
const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Where a Mac keeps the desktop app's command: install.sh's folder, Homebrew's,
 * then the rest of PATH. A GUI app's PATH rarely has the first ones, so they
 * are named outright.
 */
function macCommandFolders(homeDir: string, pathEnv: string, homebrewBins: readonly string[]): string[] {
  return [...new Set([
    homeDir ? join(homeDir, ".local", "bin") : "",
    ...homebrewBins,
    ...pathEnv.split(":"),
  ].filter(Boolean))];
}

/**
 * Next to a `gloomberb` link into an app bundle, adds `gloom` linked to the
 * same bundle's `gloom`. The target is written the way Homebrew writes its
 * own links, so a later `brew upgrade` sees the link as its own.
 */
function linkMacCommand(folder: string): string | null {
  let target: string;
  try {
    target = readlinkSync(join(folder, LEGACY_COMMAND_NAME));
  } catch {
    // Intentional ignore: not there, or not a link; a standalone binary adds its own when it runs.
    return null;
  }
  const absolute = resolve(folder, target);
  if (!absolute.endsWith(`.app/Contents/Resources/${LEGACY_COMMAND_NAME}`)) return null;
  const bundleCommand = join(dirname(absolute), COMMAND_NAME);
  const path = join(folder, COMMAND_NAME);
  if (!existsSync(bundleCommand) || pathExists(path)) return null;
  return addSymlink(bundleCommand, path);
}

/**
 * Next to the desktop app's `gloomberb.cmd`, adds a `gloom.cmd` with the same
 * contents. The command finds the app from its own folder, so the copy runs
 * the same app.
 */
function copyWindowsCommand(folder: string): string | null {
  let shim: string;
  try {
    shim = readFileSync(join(folder, `${LEGACY_COMMAND_NAME}.cmd`), "utf8");
  } catch {
    // Intentional ignore: no gloomberb.cmd, so this PATH folder belongs to another program.
    return null;
  }
  if (!shim.includes(WINDOWS_SHIM_ENTRY)) return null;
  const path = join(folder, `${COMMAND_NAME}.cmd`);
  if (pathExists(path)) return null;
  try {
    writeFileSync(path, shim, { flag: "wx" });
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
  /** `%LOCALAPPDATA%`, where the Windows installer puts the app by default. */
  localAppData?: string;
  /** Homebrew's command folders; tests pass none. */
  homebrewBins?: readonly string[];
}

/**
 * For the desktop app, which updates by replacing its bundle: adds `gloom`
 * wherever an installer put the app's `gloomberb` command (install.sh and
 * Homebrew links on a Mac, the installer's PATH folder on Windows). Returns
 * the commands it added.
 */
export function linkDesktopCommands({
  platform,
  homeDir,
  pathEnv,
  localAppData,
  homebrewBins = HOMEBREW_BINS,
}: DesktopCommandOptions): string[] {
  if (platform === "darwin") {
    return macCommandFolders(homeDir, pathEnv, homebrewBins).flatMap((folder) => linkMacCommand(folder) ?? []);
  }
  if (platform === "win32") {
    const folders = new Set([
      localAppData ? join(localAppData, "Programs", "Gloomberb", "bin") : "",
      ...pathEnv.split(";"),
    ].filter(Boolean));
    return [...folders].flatMap((folder) => copyWindowsCommand(folder) ?? []);
  }
  return [];
}
