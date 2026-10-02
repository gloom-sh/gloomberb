import { basename, join, resolve } from "path";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "fs";
import { execFile as execFileCallback, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { findAbsorbedPlugin, type AbsorbedPlugin } from "./absorbed";
import type { PluginPin } from "./builtin/plugin-marketplace/store";
import { bunCommand } from "./dependencies";
import { linkHostPackages, missingPeerPlugins } from "./host-link";
import {
  findAbsorbedCheckout,
  getPluginsDir,
  isDirectoryOrLink,
  isPluginDirectory,
  readPluginCommit,
  resolvePluginEntry,
} from "./loader";
import { pluginDirectoryNames } from "./plugin-names";
import { pluginFromModule } from "./plugin-export";
import type { GloomPlugin } from "../types/plugin";
import { cliStyles } from "../utils/cli-output";
import { compareSemver, requiredGloomberb } from "../utils/semver";
import { VERSION } from "../version";
import { fail } from "../cli/errors";

/**
 * Installs, updates, links and removes plugins in the plugins folder. The
 * `install`, `update`, `remove` and `plugin link` commands, the marketplace
 * pane and the desktop's Bun side all come through here, so a plugin lands
 * the same way whichever of them asked. It runs git and bun, so it only loads
 * in a Bun process.
 */

const PLUGINS_DIR = getPluginsDir();

const execFile = promisify(execFileCallback);

function ensurePluginsDir() {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function validatePluginDirectoryName(name: string): string {
  if (!GITHUB_SEGMENT_PATTERN.test(name)) {
    throw new Error(`Invalid plugin name: ${name}.`);
  }
  return name;
}

export interface ParsedGitHubRef {
  url: string;
  name: string;
  /** `owner/repo`, the registry's spelling. */
  repo: string;
}

export function parseGitHubRef(rawRef: string): ParsedGitHubRef {
  const ref = rawRef.startsWith("github:") ? rawRef.slice("github:".length) : rawRef;
  let segments: string[];
  if (ref.startsWith("https://")) {
    const parsed = new URL(ref);
    if (parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`Invalid plugin reference: ${rawRef}. Use user/repo or a GitHub URL.`);
    }
    segments = parsed.pathname.split("/").filter(Boolean);
  } else if (!ref.includes("://")) {
    segments = ref.split("/");
  } else {
    segments = [];
  }
  const [owner, rawRepo] = segments;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (segments.length === 2 && owner && GITHUB_SEGMENT_PATTERN.test(owner) && repo) {
    const name = validatePluginDirectoryName(repo);
    return { url: `https://github.com/${owner}/${name}.git`, name, repo: `${owner}/${name}` };
  }
  throw new Error(`Invalid plugin reference: ${ref}. Use user/repo or a GitHub URL.`);
}

export interface PluginInstallOptions {
  /**
   * Suppress child-process output and progress logging. The marketplace pane
   * installs while the terminal UI owns the screen, and git and bun writing to
   * stdout corrupts the rendered frame.
   */
  quiet?: boolean;
  pin?: PluginPin;
}

export interface PluginDirectoryInfo {
  directory: string;
  path: string;
  commit: string | null;
  plugin: Pick<GloomPlugin, "id" | "name" | "version"> | null;
}

class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(stderr.trim() ? `${message}: ${stderr.trim().split("\n").pop()}` : message);
    this.name = "GitError";
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without blocking the event loop: a fetch or `bun install`
 * takes seconds, and the terminal UI and the desktop's Bun process keep
 * serving the app while a plugin updates in the background. Rejects only
 * when the command cannot be started at all.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  output: { stdout: "pipe" | "inherit"; stderr: "pipe" | "inherit" },
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", output.stdout, output.stderr] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf-8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function git(args: string[], cwd: string, quiet: boolean, failure: string): Promise<string> {
  // Quiet means the app owns the screen, or there is no terminal at all: a
  // repository that wants credentials fails instead of prompting on it.
  const env = quiet ? { ...process.env, GIT_TERMINAL_PROMPT: "0" } : undefined;
  const result = await run("git", args, cwd, { stdout: "pipe", stderr: quiet ? "pipe" : "inherit" }, env)
    .catch((): RunResult => ({ code: null, stdout: "", stderr: "" }));
  if (result.code !== 0) throw new GitError(failure, result.stderr);
  return result.stdout.trim();
}

function isOnBranch(dir: string): boolean {
  try {
    execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pinMatches(commit: string | null, expected: string | undefined): boolean {
  if (!expected || !commit) return true;
  return commit.toLowerCase().startsWith(expected.toLowerCase());
}

/**
 * Fetches the pinned commit without checking it out. With a ref, the commit
 * is what the ref names and the pinned commit (when known) only verifies it;
 * with a commit alone, that commit is fetched directly.
 */
async function fetchPin(targetDir: string, pin: PluginPin, quiet: boolean): Promise<string> {
  const wanted = pin.ref ?? pin.commit;
  if (!wanted) throw new Error("The registry pin names no ref or commit.");
  if (pin.commit && !COMMIT_PATTERN.test(pin.commit)) throw new Error(`Invalid commit in registry pin: ${pin.commit}`);
  await git(["fetch", "--depth", "1", "origin", wanted], targetDir, quiet, `Could not fetch ${wanted}`);
  const commit = await git(["rev-parse", "FETCH_HEAD^{commit}"], targetDir, quiet, `Could not read ${wanted}`);
  if (!pinMatches(commit, pin.commit)) {
    throw new Error(`${pin.ref ?? "The pinned ref"} now points at ${commit.slice(0, 7)}, the registry reviewed ${pin.commit!.slice(0, 7)}.`);
  }
  return commit;
}

/** Leaves HEAD detached at one exact commit, which is the state `update` expects to find. */
async function checkoutCommit(targetDir: string, commit: string, quiet: boolean): Promise<void> {
  await git(["checkout", "--detach", "--force", commit], targetDir, quiet, `Could not check out ${commit.slice(0, 7)}`);
}

function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitOutput(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8").trim();
  } catch {
    return null;
  }
}

function versionAt(dir: string, commit: string): string | null {
  const text = gitOutput(["show", `${commit}:package.json`], dir);
  if (!text) return null;
  try {
    const version = JSON.parse(text).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Why checking out `candidate` would move the checkout at `installed`
 * backwards, or null when it would not. The registry pins a tag, which can
 * be older than a checkout that was installed from the default branch.
 * Installs are shallow, so history answers only when both commits are in
 * it; otherwise the versions the two commits declare decide, then, when
 * those match, their commit dates.
 */
export function describeOlderCommit(dir: string, installed: string, candidate: string, label = candidate.slice(0, 7)): string | null {
  if (installed === candidate || gitSucceeds(["merge-base", "--is-ancestor", installed, candidate], dir)) return null;
  const installedVersion = versionAt(dir, installed);
  const byVersion = compareSemver(versionAt(dir, candidate), installedVersion);
  const older = () => `the registry's ${label} is older than the installed ${byVersion ? installedVersion : installed.slice(0, 7)}`;
  if (gitSucceeds(["merge-base", "--is-ancestor", candidate, installed], dir)) return older();
  if (byVersion !== null && byVersion !== 0) return byVersion < 0 ? older() : null;
  const candidateTime = Number(gitOutput(["show", "-s", "--format=%ct", candidate], dir));
  const installedTime = Number(gitOutput(["show", "-s", "--format=%ct", installed], dir));
  return candidateTime > 0 && installedTime > 0 && candidateTime < installedTime ? older() : null;
}

/** Brings `targetDir` to the pinned commit. */
async function checkoutPin(targetDir: string, pin: PluginPin, quiet: boolean): Promise<void> {
  if (!pin.ref && !pin.commit) return;
  await checkoutCommit(targetDir, await fetchPin(targetDir, pin, quiet), quiet);
}

async function installDependencies(targetDir: string, quiet: boolean): Promise<void> {
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return;
  if (!quiet) console.log(cliStyles.muted("Installing plugin dependencies..."));
  // --production: plugin repos depend on `gloomberb` as a devDependency so
  // their own CI can typecheck against the real API. At runtime the host is
  // symlinked in instead, and pulling a second full copy here would both
  // waste a lot of disk and risk a duplicate React.
  const output = quiet ? "pipe" : "inherit";
  const bun = bunCommand();
  const result = bun
    ? await run(bun.command, ["install", "--production"], targetDir, { stdout: output, stderr: output }, bun.env).catch(() => null)
    : null;
  if (result?.code !== 0 && !quiet) console.error(cliStyles.warning("Warning: failed to install plugin dependencies."));

  // After `bun install`, which prunes links it does not know about.
  const link = linkHostPackages(targetDir);
  if (link.error && !quiet) {
    console.error(cliStyles.warning(`Warning: could not link the Gloomberb runtime (${link.error}).`));
    console.error(cliStyles.muted("The plugin's \"gloomberb/*\" imports will not resolve."));
  }
}

async function readPluginExport(targetDir: string): Promise<Pick<GloomPlugin, "id" | "name" | "version"> | null> {
  const entryFile = await resolvePluginEntry(targetDir);
  if (!entryFile) return null;
  // Fresh so an update is validated against the new code, not the module Bun
  // cached when the previous version loaded.
  const plugin = pluginFromModule(await import(`${entryFile}?validate=${Date.now()}`));
  if (!plugin) return null;
  return { id: plugin.id, name: plugin.name, version: plugin.version || "0.0.0" };
}

/**
 * Refuses a plugin that is built into Gloomberb now (see absorbed.ts): the
 * loader would skip it, so installing or updating it only fetches code that
 * never runs.
 */
function refuseAbsorbed(absorbed: AbsorbedPlugin | null): void {
  if (absorbed) fail(`${absorbed.name} is built into Gloomberb now.`);
}

function describe(targetDir: string, directory: string, plugin: PluginDirectoryInfo["plugin"]): PluginDirectoryInfo {
  return { directory, path: targetDir, commit: readPluginCommit(targetDir), plugin };
}

export async function installPlugin(ref: string, options: PluginInstallOptions = {}): Promise<PluginDirectoryInfo> {
  const quiet = options.quiet === true;
  const say = (message: string) => {
    if (!quiet) console.log(message);
  };
  const { url, name } = parseGitHubRef(ref);
  refuseAbsorbed(findAbsorbedPlugin({ directory: name }));
  ensurePluginsDir();
  const targetDir = join(PLUGINS_DIR, name);

  if (existsSync(targetDir)) {
    fail(`Plugin "${name}" already exists.`, `Use "gloomberb update ${name}" to refresh it.`);
  }

  say(cliStyles.accent(`Installing ${name}`));
  say(cliStyles.muted(url));

  const pin = options.pin ?? {};
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (pin.ref) cloneArgs.push("--branch", pin.ref);
    cloneArgs.push(url, targetDir);
    await git(cloneArgs, PLUGINS_DIR, quiet, `Failed to clone ${url}`);
    if (pin.ref) {
      const commit = readPluginCommit(targetDir);
      if (!pinMatches(commit, pin.commit)) {
        throw new Error(`${pin.ref} now points at ${commit?.slice(0, 7) ?? "?"}, the registry reviewed ${pin.commit!.slice(0, 7)}.`);
      }
    } else if (pin.commit) {
      await checkoutPin(targetDir, pin, quiet);
    }
    // A fork under another name says what it is in its gloom.json.
    refuseAbsorbed(findAbsorbedCheckout(targetDir));
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    fail(error instanceof Error ? error.message : String(error));
  }

  if (pin.ref || pin.commit) say(cliStyles.muted(`Pinned to ${pin.ref ?? pin.commit}`));

  await installDependencies(targetDir, quiet);

  try {
    const plugin = await readPluginExport(targetDir);
    if (plugin) {
      say(cliStyles.success(`Installed ${plugin.name} v${plugin.version}`));
      return describe(targetDir, name, plugin);
    }
    say(cliStyles.warning("Installed files, but no valid GloomPlugin export was found."));
  } catch (err) {
    say(cliStyles.warning(`Plugin validation failed: ${err}`));
  }
  return describe(targetDir, name, null);
}

export async function removePlugin(name: string, options: PluginInstallOptions = {}): Promise<void> {
  const targetDir = join(PLUGINS_DIR, validatePluginDirectoryName(name));
  if (!existsSync(targetDir) && !lstatSync(targetDir, { throwIfNoEntry: false })) {
    fail(`Plugin "${name}" was not found.`, PLUGINS_DIR);
  }
  // A linked plugin is a symlink to the developer's checkout; removing the
  // link must not delete their working copy.
  if (lstatSync(targetDir).isSymbolicLink()) rmSync(targetDir, { force: true });
  else rmSync(targetDir, { recursive: true, force: true });
  if (!options.quiet) console.log(cliStyles.success(`Removed plugin "${name}".`));
}

export interface PluginUpdateResult extends PluginDirectoryInfo {
  before: string | null;
  changed: boolean;
  /** Why the checkout was left where it was: the registry's commit is older. */
  kept?: string;
}

/** `owner/repo` from the checkout's origin remote, or null for anything that is not a GitHub clone. */
export function readPluginRemote(pluginDir: string): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: pluginDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf-8").trim();
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

/** The sha from `git ls-remote origin HEAD`; null when the answer is not one. */
export function parseRemoteHead(output: string): string | null {
  const sha = output.trim().split(/\s+/)[0] ?? "";
  return COMMIT_PATTERN.test(sha) ? sha : null;
}

/** A slow remote is a missing answer, not a hung pane. */
const REMOTE_HEAD_TIMEOUT_MS = 8_000;

/**
 * Where the remote's default branch is now.
 *
 * This is the only way to answer "is there an update" for a plugin the
 * registry does not list: there is no reviewed commit to compare against, and
 * `update` lands exactly here. Network, so it never runs on a startup path,
 * and a private repository without credentials must fail rather than sit on a
 * credential prompt, hence `GIT_TERMINAL_PROMPT=0`.
 */
export async function readPluginRemoteHead(name: string): Promise<string | null> {
  const dir = join(PLUGINS_DIR, validatePluginDirectoryName(name));
  if (!existsSync(join(dir, ".git"))) return null;
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  try {
    const { stdout } = await execFile("git", ["ls-remote", "origin", "HEAD"], {
      cwd: dir,
      timeout: REMOTE_HEAD_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return parseRemoteHead(stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Remote heads for the given plugin folders, or every installed clone. Folders
 * that are linked, not git, or unreachable are simply absent from the result.
 */
export async function readPluginRemoteHeads(names?: readonly string[]): Promise<Record<string, string>> {
  const dirs = names?.length ? [...names] : installedPluginDirectories();
  const heads: Record<string, string> = {};
  await Promise.all(dirs.map(async (dir) => {
    try {
      const head = await readPluginRemoteHead(dir);
      if (head) heads[dir] = head;
    } catch {
      // An invalid folder name is not worth failing the whole check over.
    }
  }));
  return heads;
}

/**
 * Whether the checkout has edits to tracked files, which `update` would
 * discard: it checks commits out with --force. Untracked files, such as a
 * lockfile `bun install` wrote, survive a checkout and do not count. When git
 * cannot answer, the checkout counts as changed.
 */
export async function hasLocalChanges(dir: string): Promise<boolean> {
  const result = await run("git", ["status", "--porcelain", "--untracked-files=no"], dir, { stdout: "pipe", stderr: "pipe" })
    .catch(() => null);
  return result?.code !== 0 || result.stdout.trim().length > 0;
}

export async function updatePlugin(name: string, options: PluginInstallOptions = {}): Promise<PluginUpdateResult> {
  const quiet = options.quiet === true;
  const targetDir = join(PLUGINS_DIR, validatePluginDirectoryName(name));
  if (!existsSync(targetDir)) fail(`Plugin "${name}" was not found.`, PLUGINS_DIR);
  refuseAbsorbed(findAbsorbedCheckout(targetDir));
  if (lstatSync(targetDir).isSymbolicLink()) {
    fail(`"${name}" is linked to a local checkout; pull it there instead.`);
  }
  if (!existsSync(join(targetDir, ".git"))) fail(`"${name}" is not a git checkout and cannot be updated.`);

  const before = readPluginCommit(targetDir);
  if (!quiet) console.log(cliStyles.accent(`Updating ${name}...`));

  const pin = options.pin;
  if (pin?.ref || pin?.commit) {
    const commit = await fetchPin(targetDir, pin, quiet);
    // Updates only move forward: a checkout installed from the default
    // branch can be ahead of the tag the registry reviewed.
    const kept = before ? describeOlderCommit(targetDir, before, commit, pin.ref ?? commit.slice(0, 7)) : null;
    if (kept) {
      if (!quiet) console.log(cliStyles.muted(`Kept ${name}: ${kept}.`));
      return { ...describe(targetDir, name, null), before, changed: false, kept };
    }
    await checkoutCommit(targetDir, commit, quiet);
  } else {
    // Not in the registry, so there is nothing reviewed to land on: follow the
    // remote's default branch, whether the checkout is on a branch or detached
    // from an earlier pin.
    if (isOnBranch(targetDir)) {
      await git(["pull", "--ff-only"], targetDir, quiet, `Failed to update ${name}`);
    } else {
      await git(["fetch", "--depth", "1", "origin", "HEAD"], targetDir, quiet, `Failed to fetch ${name}`);
      await git(["checkout", "--detach", "--force", "FETCH_HEAD"], targetDir, quiet, `Failed to update ${name}`);
    }
  }

  await installDependencies(targetDir, quiet);
  const after = readPluginCommit(targetDir);
  let plugin: PluginDirectoryInfo["plugin"] = null;
  try {
    plugin = await readPluginExport(targetDir);
  } catch (error) {
    if (!quiet) console.log(cliStyles.warning(`Plugin validation failed: ${error}`));
  }
  const changed = before !== after;
  if (!quiet) {
    console.log(changed
      ? cliStyles.success(`Updated ${plugin?.name ?? name} to ${plugin?.version ?? after?.slice(0, 7) ?? "?"}`)
      : cliStyles.muted(`${plugin?.name ?? name} is already up to date.`));
  }
  return { ...describe(targetDir, name, plugin), before, changed };
}

export interface RegistryListing {
  /** The reviewed commit to land on; null when the registry follows the remote. */
  pin: PluginPin | null;
  /** Oldest Gloomberb the listed code runs on. */
  minGloomberb?: string;
}

/**
 * Looks each installed plugin up in the registry so an update lands on the
 * reviewed commit, and is not taken at all on a Gloomberb too old to run it.
 * The registry is best effort: offline, everything falls back to following
 * the remote.
 */
export async function loadRegistryListings(): Promise<Map<string, RegistryListing>> {
  const listings = new Map<string, RegistryListing>();
  try {
    const { loadRegistry } = await import("./builtin/plugin-marketplace/feed");
    const feed = await loadRegistry();
    for (const plugin of feed.plugins) {
      if (!plugin.repo) continue;
      listings.set(plugin.repo.toLowerCase(), {
        pin: plugin.ref || plugin.commit
          ? { ...(plugin.ref ? { ref: plugin.ref } : {}), ...(plugin.commit ? { commit: plugin.commit } : {}) }
          : null,
        ...(plugin.minGloomberb ? { minGloomberb: plugin.minGloomberb } : {}),
      });
    }
  } catch {
    // Offline or the feed is down: update from the remote instead.
  }
  return listings;
}

/**
 * Installs a plugin the way the marketplace does: a listed one at the commit
 * the registry reviewed, and not at all on a Gloomberb too old to run it.
 * An unlisted repository follows its default branch. A caller installing
 * several passes `listings` so the registry is read once.
 */
export async function installListedPlugin(
  ref: string,
  options: Omit<PluginInstallOptions, "pin"> = {},
  listings?: ReadonlyMap<string, RegistryListing>,
): Promise<PluginDirectoryInfo> {
  const repo = parseGitHubRef(ref).repo.toLowerCase();
  const listing = (listings ?? await loadRegistryListings()).get(repo);
  const required = requiredGloomberb(listing?.minGloomberb);
  if (required) fail(`${ref} needs Gloomberb ${required}, this is ${VERSION}.`, "Update Gloomberb first.");
  const installed = await installPlugin(ref, { ...options, ...(listing?.pin ? { pin: listing.pin } : {}) });
  // A plugin that imports a sibling plugin (IBKR Gateway imports Interactive
  // Brokers) brings it along, from the same registry.
  const known = listings ?? await loadRegistryListings();
  for (const peer of missingPeerPlugins(installed.path)) {
    const repo = [...known.keys()].find((candidate) => pluginDirectoryNames(peer).includes(candidate.split("/")[1] ?? ""));
    if (repo) await installListedPlugin(repo, options, known);
  }
  return installed;
}

/** Folder names of every installed plugin, clones and links alike. */
export function installedPluginDirectories(): string[] {
  ensurePluginsDir();
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => isPluginDirectory(entry.name) && isDirectoryOrLink(entry, join(PLUGINS_DIR, entry.name)))
    .map((entry) => entry.name);
}

/**
 * Makes a local checkout an installed plugin without cloning it. The link is
 * what the loader sees, so edits are live on the next reload or restart.
 */
export async function linkPlugin(sourcePath: string, options: PluginInstallOptions = {}): Promise<PluginDirectoryInfo> {
  const source = resolve(sourcePath);
  if (!existsSync(source)) fail(`No such directory: ${source}`);
  const entry = await resolvePluginEntry(source);
  if (!entry) fail(`${source} has no plugin entry (index.ts or package.json "main").`);
  refuseAbsorbed(findAbsorbedCheckout(source));
  ensurePluginsDir();
  const name = validatePluginDirectoryName(basename(source));
  const targetDir = join(PLUGINS_DIR, name);
  const existing = lstatSync(targetDir, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    fail(`Plugin "${name}" is already installed.`, `Remove it first with "gloomberb remove ${name}".`);
  }
  if (existing) rmSync(targetDir, { force: true });
  symlinkSync(source, targetDir, "dir");
  linkHostPackages(source);
  const plugin = await readPluginExport(source).catch(() => null);
  if (!options.quiet) {
    console.log(cliStyles.success(`Linked ${plugin?.name ?? name} from ${source}`));
    console.log(cliStyles.muted(`Check it with "gloomberb plugin doctor ${name}".`));
  }
  return describe(source, name, plugin);
}
