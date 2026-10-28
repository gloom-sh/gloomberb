import { constants } from "fs";
import { access, lstat, readFile, readlink, rename, rm, symlink } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { HOMEBREW_PREFIXES, macCommandFolders } from "../../../../updater/command-names";
import { logFailure } from "../../../../utils/log-failure";
import { DESKTOP_APP_NAME, isDesktopAppIdentifier, LEGACY_DESKTOP_APP_NAME } from "../../shared/app-name";

/**
 * A Mac install from before the rename is `Gloomberb.app`, and its updater
 * puts each new build in that same bundle. So the new build, when it starts
 * from `Gloomberb.app`, renames its bundle to `Gloom.app` and opens again from
 * there, and the `gloom` and `gloomberb` links the install script made into
 * the old bundle follow it. Run from `Gloom.app`, it removes a
 * `Gloomberb.app` left beside it.
 *
 * Homebrew installs are left to Homebrew: its record names the bundle it
 * installed, and a bundle renamed under it makes `brew upgrade` fail. The cask
 * moves it to `Gloom.app` at the next `brew upgrade --cask gloomberb`.
 *
 * Nothing moves when a link into the old bundle sits in a folder this user
 * cannot write, since that command would stop working; the app runs under the
 * old name and tries again at the next start.
 */
const APP_BUNDLE = `${DESKTOP_APP_NAME}.app`;
const LEGACY_APP_BUNDLE = `${LEGACY_DESKTOP_APP_NAME}.app`;
/** The terminal commands an installer links into the bundle's Resources. */
const COMMAND_NAMES = ["gloom", "gloomberb"];

export interface MacAppNameOptions {
  /** The running app's executable, inside `<bundle>/Contents/MacOS`. */
  execPath: string;
  platform: string;
  homeDir: string;
  /** PATH as the app sees it. */
  pathEnv: string;
  /** Where Homebrew may keep its Caskroom; tests pass their own. */
  homebrewPrefixes?: readonly string[];
  /** Homebrew's command folders; tests pass their own. */
  homebrewBins?: readonly string[];
}

export type MacAppRename =
  /** Not a Mac bundle under the old name. */
  | { kind: "none" }
  | { kind: "skipped"; reason: "homebrew" | "read-only-location" | "name-taken" | "command-folder-not-writable" }
  | { kind: "failed" }
  /** Renamed: the app opens again from `bundle`. */
  | { kind: "renamed"; bundle: string; relinked: string[] };

interface BundleLink {
  /** The link, in a command folder. */
  path: string;
  /** What it points at, as written. */
  target: string;
  /** Where in the bundle it points, from the bundle's folder down. */
  inside: string;
}

function runningBundle(execPath: string): string | null {
  return /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    // Intentional ignore: a missing path, or one this user cannot see; either way there is nothing to move there.
    return false;
  }
}

/** The bundle identifier a build of this app writes in its version.json, or null for anything else. */
async function bundleIdentifier(bundle: string): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(join(bundle, "Contents", "Resources", "version.json"), "utf8")) as { identifier?: unknown };
    return typeof info.identifier === "string" ? info.identifier : null;
  } catch {
    // Intentional ignore: no readable version.json means the bundle is not one of ours.
    return null;
  }
}

async function managedByHomebrew(prefixes: readonly string[]): Promise<boolean> {
  const found = await Promise.all(prefixes.map((prefix) => exists(join(prefix, "Caskroom", "gloomberb"))));
  return found.includes(true);
}

/** The `gloom` and `gloomberb` links in the command folders that point into `bundle`. */
async function linksInto(bundle: string, folders: readonly string[]): Promise<BundleLink[]> {
  const found = await Promise.all(folders.flatMap((folder) => COMMAND_NAMES.map(async (name): Promise<BundleLink | null> => {
    const path = join(folder, name);
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      // Intentional ignore: not there, or not a link; either way it does not lead into the bundle.
      return null;
    }
    const absolute = resolve(folder, target);
    if (absolute !== bundle && !absolute.startsWith(`${bundle}/`)) return null;
    return { path, target, inside: absolute.slice(bundle.length) };
  })));
  return found.filter((link): link is BundleLink => link !== null);
}

async function writable(folder: string): Promise<boolean> {
  try {
    await access(folder, constants.W_OK);
    return true;
  } catch {
    // Intentional ignore: a folder this user cannot write keeps its link, so nothing is renamed.
    return false;
  }
}

/** Points `link` at the same file inside `bundle`, written the same way (absolute or relative). Resolves to whether it did. */
async function relink(link: BundleLink, bundle: string): Promise<boolean> {
  const folder = dirname(link.path);
  const absolute = `${bundle}${link.inside}`;
  const target = isAbsolute(link.target) ? absolute : relative(folder, absolute);
  // Made beside it and moved over it, so the command is never missing.
  const temporary = `${link.path}.${process.pid}-relink`;
  try {
    await rm(temporary, { force: true });
    await symlink(target, temporary);
    await rename(temporary, link.path);
    return true;
  } catch (error) {
    await rm(temporary, { force: true }).catch(logFailure("desktop-app-name", "Could not remove a half-made command link"));
    logFailure("desktop-app-name", "Could not point a command at the renamed app")(error);
    return false;
  }
}

/**
 * The name the copy moved out of the way takes: `Gloom.app.previous`, the
 * name the updater's own copies take, so one that cannot be removed now goes
 * with theirs at the next start (update.ts, `removeUpdateAsides`).
 */
async function asidePath(bundle: string): Promise<string> {
  const previous = `${bundle}.previous`;
  if (!(await exists(previous))) return previous;
  for (let attempt = 0; ; attempt += 1) {
    const unique = `${previous}-${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
    if (!(await exists(unique))) return unique;
  }
}

/** The links into `bundle`, unless one of them sits in a folder this user cannot write. */
async function movableLinks(bundle: string, options: MacAppNameOptions): Promise<BundleLink[] | null> {
  const links = await linksInto(bundle, macCommandFolders(options.homeDir, options.pathEnv, options.homebrewBins));
  const folders = [...new Set(links.map((link) => dirname(link.path)))];
  const allWritable = await Promise.all(folders.map(writable));
  return allWritable.every(Boolean) ? links : null;
}

/**
 * Renames the running app from `Gloomberb.app` to `Gloom.app` and points the
 * command links that led into it at the new bundle. The caller relaunches from
 * `bundle` when it says `renamed`. A `Gloom.app` of this app already there
 * gives way to the running one, which is the build its updater just installed.
 */
export async function renameLegacyMacApp(options: MacAppNameOptions): Promise<MacAppRename> {
  if (options.platform !== "darwin") return { kind: "none" };
  const bundle = runningBundle(options.execPath);
  if (!bundle || basename(bundle) !== LEGACY_APP_BUNDLE) return { kind: "none" };
  // A disk image, or the read-only copy App Translocation runs.
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return { kind: "skipped", reason: "read-only-location" };
  if (await managedByHomebrew(options.homebrewPrefixes ?? HOMEBREW_PREFIXES)) return { kind: "skipped", reason: "homebrew" };

  const renamed = join(dirname(bundle), APP_BUNDLE);
  const occupied = await exists(renamed);
  if (occupied && !isDesktopAppIdentifier(await bundleIdentifier(renamed))) return { kind: "skipped", reason: "name-taken" };
  const links = await movableLinks(bundle, options);
  if (!links) return { kind: "skipped", reason: "command-folder-not-writable" };

  const aside = occupied ? await asidePath(renamed) : null;
  try {
    if (aside) await rename(renamed, aside);
    try {
      await rename(bundle, renamed);
    } catch (error) {
      if (aside) await rename(aside, renamed);
      throw error;
    }
  } catch (error) {
    logFailure("desktop-app-name", "Could not rename the app to its new name")(error);
    return { kind: "failed" };
  }
  if (aside) await rm(aside, { recursive: true, force: true }).catch(logFailure("desktop-app-name", "Could not remove the copy of the app the rename replaced"));

  const relinked: string[] = [];
  for (const link of links) {
    if (await relink(link, renamed)) relinked.push(link.path);
  }
  return { kind: "renamed", bundle: renamed, relinked };
}

/**
 * Run from `Gloom.app`: removes a `Gloomberb.app` of this app beside it (an
 * install from before the rename, next to one made from a new download) after
 * pointing its command links at the running bundle. Left alone under
 * Homebrew, or when a link into it cannot be moved. Resolves to the removed
 * bundle, or null.
 */
export async function removeLegacyMacApp(options: MacAppNameOptions): Promise<string | null> {
  if (options.platform !== "darwin") return null;
  const bundle = runningBundle(options.execPath);
  if (!bundle || basename(bundle) !== APP_BUNDLE) return null;
  const legacy = join(dirname(bundle), LEGACY_APP_BUNDLE);
  if (!(await exists(legacy)) || !isDesktopAppIdentifier(await bundleIdentifier(legacy))) return null;
  if (await managedByHomebrew(options.homebrewPrefixes ?? HOMEBREW_PREFIXES)) return null;
  const links = await movableLinks(legacy, options);
  if (!links) return null;
  for (const link of links) {
    // A command still leading into the old bundle keeps it: removing it would break that command.
    if (!(await relink(link, bundle))) return null;
  }
  const removed = await rm(legacy, { recursive: true, force: true }).then(() => true, logFailure("desktop-app-name", "Could not remove the app's old copy", false));
  return removed ? legacy : null;
}
