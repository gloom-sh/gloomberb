import { basename, join, resolve } from "path";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "fs";
import {
  getPluginsDir,
  readPluginCommit,
  resolvePluginBrowserEntry,
  resolvePluginEntry,
} from "../../plugins/loader";
import { linkHostPackages } from "../../plugins/host-link";
import {
  installedPluginDirectories,
  loadRegistryListings,
  readPluginRemote,
  readPluginRemoteHeads,
  updatePlugin,
  validatePluginDirectoryName,
  type RegistryListing,
} from "../../plugins/installer";
import { isReservedBuiltinPluginId } from "../../plugins/ownership";
import { pluginFromModule, pluginSupportsTarget } from "../../plugins/plugin-export";
import { requiredGloomberb } from "../../utils/semver";
import { ALL_PLUGIN_TARGETS, type GloomPlugin, type PluginTarget } from "../../types/plugin";
import {
  cliStyles,
  renderStats,
  renderTable,
} from "../../utils/cli-output";
import type { CliCommandContext } from "../../types/plugin";
import { fail } from "../errors";
import { VERSION } from "../../version";

/**
 * The `plugins`, `update` and `plugin doctor` commands. Installing, updating
 * and linking themselves live in plugins/installer.ts, shared with the
 * marketplace and the desktop.
 */

const PLUGINS_DIR = getPluginsDir();

export async function updatePlugins(name?: string) {
  const dirs = name ? [validatePluginDirectoryName(name)] : installedPluginDirectories();

  if (dirs.length === 0) {
    console.log(cliStyles.muted("No plugins installed."));
    return;
  }

  const listings = await loadRegistryListings();
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
    const listing = remote ? listings.get(remote.toLowerCase()) : undefined;
    const required = requiredGloomberb(listing?.minGloomberb);
    if (required) {
      console.log(cliStyles.warning(`Skipping ${dir} (needs Gloomberb ${required}, this is ${VERSION})`));
      continue;
    }
    try {
      await updatePlugin(dir, { pin: listing?.pin ?? undefined });
    } catch (error) {
      console.error(cliStyles.danger(`Failed to update ${dir}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
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
    plugin = pluginFromModule(await import(`${entryFile}?doctor=${Date.now()}`));
    if (!plugin) {
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

  const rendersInBrowser = pluginSupportsTarget(plugin, "desktop") || pluginSupportsTarget(plugin, "web");
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

export interface InstalledPluginRow {
  name: string;
  version: string;
  commit: string;
  /** Set only with --check: "up to date", the commit waiting, or "" for a linked checkout. */
  update?: string;
  description: string;
  linked: boolean;
}

async function readInstalledPlugins(options: { check?: boolean }): Promise<InstalledPluginRow[]> {
  const entries = installedPluginDirectories();
  if (entries.length === 0) return [];

  // Off by default: this is a local listing, and asking every remote turns it
  // into a network call that can hang behind a credential prompt.
  const listings = options.check ? await loadRegistryListings() : new Map<string, RegistryListing>();
  const heads = options.check ? await readPluginRemoteHeads(entries) : {};

  return entries.map((name) => {
    const dir = join(PLUGINS_DIR, name);
    let version = "";
    let description = "";
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        version = pkg.version || "";
        description = pkg.description || "";
      } catch {
        description = "Unreadable package.json";
      }
    }
    const linked = lstatSync(dir).isSymbolicLink();
    const commit = readPluginCommit(dir);
    const row: InstalledPluginRow = {
      name,
      version,
      commit: linked ? "linked" : commit ? commit.slice(0, 7) : "",
      description,
      linked,
    };
    if (!options.check) return row;
    const remote = readPluginRemote(dir);
    // A registry-listed plugin moves between reviewed commits, so what its
    // branch holds today says nothing about whether an update is waiting.
    const reviewed = remote ? listings.get(remote.toLowerCase())?.pin?.commit : undefined;
    const target = reviewed ?? heads[name];
    const behind = !linked && !!target && !!commit && !commit.toLowerCase().startsWith(target.toLowerCase());
    return { ...row, update: linked ? "" : behind ? target!.slice(0, 7) : "up to date" };
  });
}

export async function listPlugins(ctx: CliCommandContext, options: { check?: boolean } = {}) {
  const plugins = await readInstalledPlugins(options);
  const columns = [
    { key: "name", header: "Plugin", shrink: false },
    { key: "version", header: "Version" },
    { key: "commit", header: "Commit" },
    ...(options.check ? [{ key: "update", header: "Update" }] : []),
    { key: "description", header: "Description" },
  ];
  ctx.printResult({ data: plugins, metadata: { directory: PLUGINS_DIR } }, {
    columns,
    text: (rows) => {
      if (rows.length === 0) {
        return cliStyles.muted("No plugins installed. Install one with gloomberb install <user/repo>.");
      }
      return [
        renderTable(
          columns.map(({ header, shrink }) => ({ header, shrink })),
          rows.map((row) => columns.map(({ key }) => {
            const value = String(row[key as keyof InstalledPluginRow] ?? "");
            return key === "update" && value && value !== "up to date" ? cliStyles.warning(value) : value;
          })),
        ),
        "",
        renderStats([["Directory", cliStyles.muted(PLUGINS_DIR)]]),
      ].join("\n");
    },
  });
}
