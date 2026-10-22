import { existsSync } from "fs";
import { join } from "path";

import type { AppConfig } from "../types/config";
import { debugLog } from "../utils/debug-log";
import { getPluginsDir } from "./loader";
import { encodeBuiltinDisabledPluginIds } from "./ownership";
import { pluginDirectoryNames } from "./plugin-names";

const log = debugLog.createLogger("plugin-seed");

/**
 * Plugins that used to ship inside Gloomberb and now live in their own
 * repositories.
 *
 * Extracting one must not take a working feature away from someone who upgrades.
 * On first launch after the move, each of these is installed once, then recorded
 * so it is never reinstalled — including when the user removes it deliberately.
 */
export const EXTRACTED_PLUGINS = [
  // TV was a module inside Macro, so a user who turned Macro off was turning
  // it off with it. `previousOwnerIds` keeps that choice: the seeder does not
  // restore what someone disabled.
  { id: "tv", name: "TV", repo: "gloom-sh/gloom-tv", directory: "gloom-tv", previousOwnerIds: ["macro", "macro-tv"] },
  { id: "substack", name: "Substack", repo: "gloom-sh/gloom-substack", directory: "gloom-substack" },
  { id: "ibkr", name: "Interactive Brokers", repo: "gloom-sh/gloom-ibkr", directory: "gloom-ibkr" },
  { id: "ibkr-gateway", name: "IBKR Gateway", repo: "gloom-sh/gloom-ibkr-gateway", directory: "gloom-ibkr-gateway" },
  { id: "public", name: "Public", repo: "gloom-sh/gloom-public", directory: "gloom-public" },
  { id: "robinhood", name: "Robinhood", repo: "gloom-sh/gloom-robinhood", directory: "gloom-robinhood" },
  { id: "simplefin", name: "SimpleFIN", repo: "gloom-sh/gloom-simplefin", directory: "gloom-simplefin" },
  { id: "polls", name: "Polls", repo: "gloom-sh/gloom-polls", directory: "gloom-polls" },
  { id: "prediction-markets", name: "Prediction Markets", repo: "gloom-sh/gloom-prediction-markets", directory: "gloom-prediction-markets" },
  // Bring-your-own-key AI left under a new id, so the choice to switch the old
  // one off is recorded against `ai` rather than against this entry.
  { id: "byok-ai", name: "BYOK AI", repo: "gloom-sh/gloom-byok-ai", directory: "gloom-byok-ai", previousOwnerIds: ["ai"] },
] as const;

type ExtractedPlugin = (typeof EXTRACTED_PLUGINS)[number];

export interface SeedResult {
  installed: string[];
  failed: string[];
  /** Ids to record as seeded, whether or not this launch installed them. */
  seeded: string[];
}

/**
 * Checks both product names, because a plugin installed before its repository
 * was renamed sits in a directory under the old one. Missing that install would
 * clone a second copy, and the loader refuses the duplicate id.
 */
function isInstalled(directory: string, pluginsDir: string): boolean {
  return pluginDirectoryNames(directory).some((name) => existsSync(join(pluginsDir, name)));
}

/**
 * The plugins left to install, each neither recorded as seeded, installed
 * already, nor switched off before the move, and the ids to record as seeded
 * without installing them. After a launch's seed, `pending` is what it could
 * not install.
 */
function classifyExtractedPlugins(config: AppConfig, pluginsDir: string): { pending: ExtractedPlugin[]; settled: string[] } {
  const alreadySeeded = new Set(config.seededPlugins ?? []);
  // A previous owner that is now a group of built-ins counts as off only while
  // all of them are, which is when its id is saved.
  const disabled = new Set([
    ...config.disabledPlugins ?? [],
    ...encodeBuiltinDisabledPluginIds(config.disabledPlugins ?? []),
  ]);
  const pending: ExtractedPlugin[] = [];
  const settled: string[] = [];
  for (const entry of EXTRACTED_PLUGINS) {
    if (alreadySeeded.has(entry.id)) continue;
    // Present already (installed by hand, or seeded before this record
    // existed), or turned off before the move, which restoring it would
    // override: recorded so we stop looking.
    if (isInstalled(entry.directory, pluginsDir)
      || disabled.has(entry.id) || ("previousOwnerIds" in entry && entry.previousOwnerIds.some((id) => disabled.has(id)))) {
      settled.push(entry.id);
      continue;
    }
    pending.push(entry);
  }
  return { pending, settled };
}

/**
 * Installs any extracted plugin the user has not seen yet.
 *
 * Best effort by design: a failure is logged and retried on the next launch
 * rather than recorded, because the common cause is being offline at startup and
 * marking it seeded would silently drop the plugin forever.
 */
export async function seedExtractedPlugins(
  config: AppConfig,
  installPlugin: (ref: string) => Promise<unknown>,
  pluginsDir: string = getPluginsDir(),
): Promise<SeedResult> {
  const { pending, settled } = classifyExtractedPlugins(config, pluginsDir);
  const result: SeedResult = { installed: [], failed: [], seeded: [...config.seededPlugins ?? [], ...settled] };

  for (const entry of pending) {
    try {
      log.info(`Restoring ${entry.id} from ${entry.repo}`);
      await installPlugin(entry.repo);
      result.installed.push(entry.id);
      result.seeded.push(entry.id);
    } catch (error) {
      log.error(`Could not restore ${entry.id}: ${error}`);
      result.failed.push(entry.id);
    }
  }

  return result;
}

/** `TV, Polls and Substack`. */
function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Where to get git: Git for Windows on Windows, with its download page when there is room for it. */
export function gitInstallAdvice(platform: string = process.platform, link = false): string {
  if (platform !== "win32") return "install git";
  return link ? "install Git for Windows (https://git-scm.com/download/win)" : "install Git for Windows";
}

function capitalize(text: string): string {
  return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

/**
 * The one notice a launch shows when its seed left official plugins
 * uninstalled: the cause when it is a missing git, which is the usual one on
 * Windows, and otherwise that it tries again at the next launch.
 */
export function pluginSeedNotice(failedIds: readonly string[], gitMissing: boolean, platform: string = process.platform): string | null {
  const names = EXTRACTED_PLUGINS.filter((entry) => failedIds.includes(entry.id)).map((entry) => entry.name);
  if (names.length === 0) return null;
  const what = names.length <= 2 ? nameList(names) : `${names.length} official plugins`;
  const one = names.length === 1;
  return gitMissing
    ? `${what} ${one ? "needs" : "need"} Git and ${one ? "is" : "are"} not installed. ${capitalize(gitInstallAdvice(platform))}, then restart Gloom.`
    : `${what} could not be installed. Gloom tries again at the next launch.`;
}

/**
 * `doctor`'s check of the official plugins the seed has not installed: which,
 * and what to do. A failure when git is missing, since no launch can install
 * them then; a warning otherwise, since the next launch tries again. Null when
 * none is missing.
 */
export function officialPluginsCheck(
  config: AppConfig,
  { gitMissing, pluginsDir = getPluginsDir(), platform = process.platform }: { gitMissing: () => boolean; pluginsDir?: string; platform?: string },
): { check: string; status: "error" | "warn"; detail: string } | null {
  const { pending } = classifyExtractedPlugins(config, pluginsDir);
  if (pending.length === 0) return null;
  const names = nameList(pending.map((entry) => entry.name));
  return gitMissing()
    ? { check: "official plugins", status: "error", detail: `Not installed: ${names}. They need Git: ${gitInstallAdvice(platform, true)}, then restart Gloom.` }
    : { check: "official plugins", status: "warn", detail: `Not installed yet: ${names}. Gloom installs them at the next launch.` };
}
