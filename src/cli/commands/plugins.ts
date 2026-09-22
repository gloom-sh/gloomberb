import { basename, join, resolve } from "path";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "fs";
import { execFile as execFileCallback, execFileSync } from "child_process";
import { promisify } from "util";
import {
  getPluginsDir,
  isDirectoryOrLink,
  isPluginDirectory,
  readPluginCommit,
  resolvePluginBrowserEntry,
  resolvePluginEntry,
} from "../../plugins/loader";
import { linkHostPackages } from "../../plugins/host-link";
import { isReservedBuiltinPluginId } from "../../plugins/ownership";
import { ALL_PLUGIN_TARGETS, type GloomPlugin, type PluginTarget } from "../../types/plugin";
import {
  cliStyles,
  renderSection,
  renderStat,
  renderTable,
} from "../../utils/cli-output";
import { fail } from "../errors";

const PLUGINS_DIR = getPluginsDir();

const execFile = promisify(execFileCallback);

function ensurePluginsDir() {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function validatePluginDirectoryName(name: string): string {
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

/**
 * What the registry reviewed. An install or update lands on exactly this, so
 * what the catalog describes is what runs, rather than whatever the default
 * branch holds at the moment the clone happens.
 */
export interface PluginPin {
  /** A tag or branch name. */
  ref?: string;
  /** Full or abbreviated commit hash. Verified after checkout when `ref` is also given. */
  commit?: string;
}

export interface PluginCommandOptions {
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

function git(args: string[], cwd: string, quiet: boolean, failure: string): string {
  try {
    const output = execFileSync("git", args, { cwd, stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"] });
    return output.toString("utf-8").trim();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && error.stderr
      ? String(error.stderr)
      : "";
    throw new GitError(failure, stderr);
  }
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
 * Brings `targetDir` to the pinned commit. With a ref, the checkout is what the
 * ref names and the commit (when known) only verifies it; with a commit alone,
 * that commit is fetched directly. Either way HEAD ends detached at one exact
 * commit, which is the state `update` expects to find.
 */
function checkoutPin(targetDir: string, pin: PluginPin, quiet: boolean): void {
  const wanted = pin.ref ?? pin.commit;
  if (!wanted) return;
  if (pin.commit && !COMMIT_PATTERN.test(pin.commit)) throw new Error(`Invalid commit in registry pin: ${pin.commit}`);
  git(["fetch", "--depth", "1", "origin", wanted], targetDir, quiet, `Could not fetch ${wanted}`);
  git(["checkout", "--detach", "--force", "FETCH_HEAD"], targetDir, quiet, `Could not check out ${wanted}`);
  const commit = readPluginCommit(targetDir);
  if (!pinMatches(commit, pin.commit)) {
    throw new Error(`${pin.ref ?? "The pinned ref"} now points at ${commit?.slice(0, 7) ?? "?"}, the registry reviewed ${pin.commit!.slice(0, 7)}.`);
  }
}

async function installDependencies(targetDir: string, quiet: boolean): Promise<void> {
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return;
  if (!quiet) console.log(cliStyles.muted("Installing plugin dependencies..."));
  try {
    // --production: plugin repos depend on `gloomberb` as a devDependency so
    // their own CI can typecheck against the real API. At runtime the host is
    // symlinked in instead, and pulling a second full copy here would both
    // waste a lot of disk and risk a duplicate React.
    execFileSync("bun", ["install", "--production"], { cwd: targetDir, stdio: quiet ? "pipe" : "inherit" });
  } catch {
    if (!quiet) console.error(cliStyles.warning("Warning: failed to install plugin dependencies."));
  }

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
  const mod = await import(`${entryFile}?validate=${Date.now()}`);
  const plugin = mod.default ?? mod.plugin;
  if (!plugin?.id || !plugin?.name) return null;
  return { id: plugin.id, name: plugin.name, version: plugin.version || "0.0.0" };
}

function describe(targetDir: string, directory: string, plugin: PluginDirectoryInfo["plugin"]): PluginDirectoryInfo {
  return { directory, path: targetDir, commit: readPluginCommit(targetDir), plugin };
}

export async function installPlugin(ref: string, options: PluginCommandOptions = {}): Promise<PluginDirectoryInfo> {
  const quiet = options.quiet === true;
  const say = (message: string) => {
    if (!quiet) console.log(message);
  };
  ensurePluginsDir();
  const { url, name } = parseGitHubRef(ref);
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
    git(cloneArgs, PLUGINS_DIR, quiet, `Failed to clone ${url}`);
    if (pin.ref) {
      const commit = readPluginCommit(targetDir);
      if (!pinMatches(commit, pin.commit)) {
        throw new Error(`${pin.ref} now points at ${commit?.slice(0, 7) ?? "?"}, the registry reviewed ${pin.commit!.slice(0, 7)}.`);
      }
    } else if (pin.commit) {
      checkoutPin(targetDir, pin, quiet);
    }
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

export async function removePlugin(name: string, options: PluginCommandOptions = {}): Promise<void> {
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

export async function updatePlugin(name: string, options: PluginCommandOptions = {}): Promise<PluginUpdateResult> {
  const quiet = options.quiet === true;
  const targetDir = join(PLUGINS_DIR, validatePluginDirectoryName(name));
  if (!existsSync(targetDir)) fail(`Plugin "${name}" was not found.`, PLUGINS_DIR);
  if (lstatSync(targetDir).isSymbolicLink()) {
    fail(`"${name}" is linked to a local checkout; pull it there instead.`);
  }
  if (!existsSync(join(targetDir, ".git"))) fail(`"${name}" is not a git checkout and cannot be updated.`);

  const before = readPluginCommit(targetDir);
  if (!quiet) console.log(cliStyles.accent(`Updating ${name}...`));

  const pin = options.pin;
  if (pin?.ref || pin?.commit) {
    checkoutPin(targetDir, pin, quiet);
  } else {
    // Not in the registry, so there is nothing reviewed to land on: follow the
    // remote's default branch, whether the checkout is on a branch or detached
    // from an earlier pin.
    if (isOnBranch(targetDir)) {
      git(["pull", "--ff-only"], targetDir, quiet, `Failed to update ${name}`);
    } else {
      git(["fetch", "--depth", "1", "origin", "HEAD"], targetDir, quiet, `Failed to fetch ${name}`);
      git(["checkout", "--detach", "--force", "FETCH_HEAD"], targetDir, quiet, `Failed to update ${name}`);
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

/**
 * Looks each installed plugin up in the registry so an update lands on the
 * reviewed commit. The registry is best effort: offline, everything falls
 * back to following the remote.
 */
async function loadRegistryPins(): Promise<Map<string, PluginPin>> {
  const pins = new Map<string, PluginPin>();
  try {
    const { loadRegistry } = await import("../../plugins/builtin/plugin-marketplace/feed");
    const feed = await loadRegistry();
    for (const plugin of feed.plugins) {
      if (!plugin.repo || (!plugin.ref && !plugin.commit)) continue;
      pins.set(plugin.repo.toLowerCase(), { ...(plugin.ref ? { ref: plugin.ref } : {}), ...(plugin.commit ? { commit: plugin.commit } : {}) });
    }
  } catch {
    // Offline or the feed is down: update from the remote instead.
  }
  return pins;
}

/** The registry's pin for a repository, so a CLI install lands where the catalog says. */
export async function resolveRegistryPin(repo: string): Promise<PluginPin | null> {
  return (await loadRegistryPins()).get(repo.toLowerCase()) ?? null;
}

function installedPluginDirectories(): string[] {
  ensurePluginsDir();
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => isPluginDirectory(entry.name) && isDirectoryOrLink(entry, join(PLUGINS_DIR, entry.name)))
    .map((entry) => entry.name);
}

export async function updatePlugins(name?: string) {
  const dirs = name ? [validatePluginDirectoryName(name)] : installedPluginDirectories();

  if (dirs.length === 0) {
    console.log(cliStyles.muted("No plugins installed."));
    return;
  }

  const pins = await loadRegistryPins();
  for (const dir of dirs) {
    const targetDir = join(PLUGINS_DIR, dir);
    if (lstatSync(targetDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      console.log(cliStyles.muted(`Skipping ${dir} (linked to a local checkout)`));
      continue;
    }
    if (!existsSync(join(targetDir, ".git"))) {
      console.log(cliStyles.warning(`Skipping ${dir} (not a git repo)`));
      continue;
    }
    const remote = readPluginRemote(targetDir);
    const pin = remote ? pins.get(remote.toLowerCase()) : undefined;
    try {
      await updatePlugin(dir, { pin });
    } catch (error) {
      console.error(cliStyles.danger(`Failed to update ${dir}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

/**
 * Makes a local checkout an installed plugin without cloning it. The link is
 * what the loader sees, so edits are live on the next reload or restart.
 */
export async function linkPlugin(sourcePath: string, options: PluginCommandOptions = {}): Promise<PluginDirectoryInfo> {
  ensurePluginsDir();
  const source = resolve(sourcePath);
  if (!existsSync(source)) fail(`No such directory: ${source}`);
  const entry = await resolvePluginEntry(source);
  if (!entry) fail(`${source} has no plugin entry (index.ts or package.json "main").`);
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

export type PluginCheckStatus = "ok" | "warn" | "fail";

export interface PluginCheck {
  id: string;
  status: PluginCheckStatus;
  message: string;
}

export interface PluginDoctorReport {
  directory: string;
  path: string;
  id: string | null;
  name: string | null;
  version: string | null;
  linked: boolean;
  commit: string | null;
  checks: PluginCheck[];
  /** Worst status across the checks. */
  status: PluginCheckStatus;
}

const HOST_LITERAL_PATTERN = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

const IGNORED_HOST_PATTERN = /(^|\.)(example\.(com|org|net)|localhost|github\.com|gloom\.sh)$/i;

function collectSourceFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out, depth + 1);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function hostCovered(host: string, declared: readonly string[]): boolean {
  return declared.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Everything that makes a plugin show up as `failed` or as a broken pane
 * later, checked before the author publishes: the entry resolves, the module
 * evaluates, the export is a plugin, the id is free, the targets are real, the
 * hosts it reaches are declared, and the browser build the desktop and web app
 * need actually compiles.
 */
export async function doctorPlugin(nameOrPath: string): Promise<PluginDoctorReport> {
  const candidate = nameOrPath.includes("/") || nameOrPath.startsWith(".") ? resolve(nameOrPath) : join(PLUGINS_DIR, nameOrPath);
  if (!existsSync(candidate)) fail(`Plugin "${nameOrPath}" was not found.`, PLUGINS_DIR);
  const directory = basename(candidate);
  const linked = lstatSync(candidate).isSymbolicLink();
  const checks: PluginCheck[] = [];
  const report: PluginDoctorReport = {
    directory,
    path: candidate,
    id: null,
    name: null,
    version: null,
    linked,
    commit: readPluginCommit(candidate),
    checks,
    status: "ok",
  };
  const add = (id: string, status: PluginCheckStatus, message: string) => {
    checks.push({ id, status, message });
    if (status === "fail" || (status === "warn" && report.status === "ok")) report.status = status;
  };

  const entryFile = await resolvePluginEntry(candidate);
  if (!entryFile) {
    add("entry", "fail", "No entry file: add index.ts or a package.json \"main\".");
    return report;
  }
  add("entry", "ok", basename(entryFile));

  const link = linkHostPackages(candidate);
  if (link.error) add("host-link", "fail", `gloomberb runtime is not linked: ${link.error}`);
  else if (link.provider === "process") add("host-link", "ok", "served by the host process");
  else add("host-link", "ok", `linked ${link.linked.join(", ")}`);

  let plugin: GloomPlugin | null = null;
  try {
    const mod = await import(`${entryFile}?doctor=${Date.now()}`);
    plugin = mod.default ?? mod.plugin ?? null;
    if (!plugin?.id || !plugin?.name) {
      add("export", "fail", "Module evaluated, but the default export is not a GloomPlugin (id and name are required).");
      return report;
    }
    report.id = plugin.id;
    report.name = plugin.name;
    report.version = plugin.version ?? null;
    add("export", "ok", `${plugin.name} v${plugin.version ?? "0.0.0"}`);
  } catch (error) {
    add("export", "fail", `Import failed: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }

  if (!plugin.version) add("version", "warn", "No version; the marketplace cannot tell when an update is available.");
  if (isReservedBuiltinPluginId(plugin.id)) add("id", "fail", `"${plugin.id}" is reserved by a built-in module.`);
  else add("id", "ok", plugin.id);

  const badTargets = (plugin.targets ?? []).filter((target) => !ALL_PLUGIN_TARGETS.includes(target as PluginTarget));
  if (badTargets.length > 0) add("targets", "fail", `Unknown targets: ${badTargets.join(", ")}`);
  else add("targets", "ok", plugin.targets?.length ? plugin.targets.join(", ") : "all renderers");

  if (plugin.configSchema) {
    const missingKeys = plugin.configSchema.filter((field) => !field.key || !field.label);
    if (missingKeys.length > 0) add("config-schema", "fail", "Every configSchema field needs a key and a label.");
    else add("config-schema", "ok", `${plugin.configSchema.length} setting${plugin.configSchema.length === 1 ? "" : "s"}`);
  }

  const declaredHosts = plugin.hosts ?? [];
  const seenHosts = new Set<string>();
  for (const file of collectSourceFiles(candidate)) {
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(HOST_LITERAL_PATTERN)) {
      const host = match[1]!.toLowerCase();
      if (IGNORED_HOST_PATTERN.test(host)) continue;
      seenHosts.add(host);
    }
  }
  const undeclared = [...seenHosts].filter((host) => !hostCovered(host, declaredHosts)).sort();
  if (undeclared.length > 0) {
    // A regex over source: a link the plugin only opens in the browser shows
    // up too, so this is a prompt to check, not a verdict.
    add("hosts", "warn", `In source but not in hosts: ${undeclared.join(", ")}. Anything fetched from there works on desktop and fails on the web.`);
  } else {
    add("hosts", "ok", declaredHosts.length ? declaredHosts.join(", ") : "no third-party hosts found");
  }

  const rendersInBrowser = !plugin.targets || plugin.targets.includes("desktop") || plugin.targets.includes("web");
  if (rendersInBrowser) {
    const browserEntry = await resolvePluginBrowserEntry(candidate);
    try {
      const { bundleExternalPlugin } = await import("../../plugins/bundle");
      const { getPluginCacheDir } = await import("../../plugins/loader");
      const outDir = join(getPluginCacheDir(), "doctor", directory);
      const result = await bundleExternalPlugin(candidate, outDir, { define: { "process.env.NODE_ENV": "\"production\"" } });
      const size = Math.round(Bun.file(result.outputPath).size / 1024);
      add("browser-build", "ok", `${basename(browserEntry ?? entryFile)} compiles for the desktop view (${size}KB)`);
      rmSync(outDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add("browser-build", "fail", `Desktop build failed: ${message.split("\n")[0]}. Ship an index.browser.ts without node:* imports, or set targets to ["cli", "tui"].`);
    }
  } else {
    add("browser-build", "ok", "skipped, terminal only");
  }

  return report;
}

export async function doctorPlugins(nameOrPath?: string): Promise<PluginDoctorReport[]> {
  if (nameOrPath) return [await doctorPlugin(nameOrPath)];
  const reports: PluginDoctorReport[] = [];
  for (const dir of installedPluginDirectories()) reports.push(await doctorPlugin(dir));
  return reports;
}

export async function listPlugins(options: { check?: boolean } = {}) {
  const entries = installedPluginDirectories();

  if (entries.length === 0) {
    console.log(cliStyles.muted("No plugins installed."));
    console.log(cliStyles.muted("Install one with: gloomberb install <github-user/repo>"));
    return;
  }

  // Off by default: this is a local listing, and asking every remote turns it
  // into a network call that can hang behind a credential prompt.
  const pins = options.check ? await loadRegistryPins() : new Map<string, PluginPin>();
  const heads = options.check ? await readPluginRemoteHeads(entries) : {};

  const rows = entries.map((name) => {
    const dir = join(PLUGINS_DIR, name);
    let version = "—";
    let description = "—";
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        version = pkg.version || "—";
        description = pkg.description || "—";
      } catch {
        description = "Unreadable package.json";
      }
    }
    const linked = lstatSync(dir).isSymbolicLink();
    const commit = readPluginCommit(dir);
    const row = [name, version, linked ? "linked" : commit ? commit.slice(0, 7) : "—", description];
    if (!options.check) return row;
    const remote = readPluginRemote(dir);
    // A registry-listed plugin moves between reviewed commits, so what its
    // branch holds today says nothing about whether an update is waiting.
    const reviewed = remote ? pins.get(remote.toLowerCase())?.commit : undefined;
    const target = reviewed ?? heads[name];
    const behind = !linked && !!target && !!commit && !commit.toLowerCase().startsWith(target.toLowerCase());
    row.splice(3, 0, linked ? "—" : behind ? target!.slice(0, 7) : "up to date");
    return row;
  });

  console.log(renderSection("Installed Plugins"));
  console.log(renderTable(
    [
      { header: "Plugin" },
      { header: "Version" },
      { header: "Commit" },
      ...(options.check ? [{ header: "Update" }] : []),
      { header: "Description" },
    ],
    rows,
  ));
  console.log("");
  console.log(renderStat("Directory", PLUGINS_DIR));
}
