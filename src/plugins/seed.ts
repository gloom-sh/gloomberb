import { existsSync } from "fs";
import { join } from "path";

import type { AppConfig } from "../types/config";
import { debugLog } from "../utils/debug-log";
import { getPluginsDir } from "./loader";
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
  { id: "tv", repo: "gloom-sh/gloom-tv", directory: "gloom-tv", previousOwnerIds: ["macro", "macro-tv"] },
  { id: "substack", repo: "gloom-sh/gloom-substack", directory: "gloom-substack" },
  { id: "ibkr", repo: "gloom-sh/gloomberb-ibkr", directory: "gloomberb-ibkr" },
  { id: "ibkr-gateway", repo: "gloom-sh/gloomberb-ibkr-gateway", directory: "gloomberb-ibkr-gateway" },
  { id: "public", repo: "gloom-sh/gloom-public", directory: "gloom-public" },
  { id: "robinhood", repo: "gloom-sh/gloom-robinhood", directory: "gloom-robinhood" },
  { id: "simplefin", repo: "gloom-sh/gloom-simplefin", directory: "gloom-simplefin" },
  // Each of these was a module inside Market Overview or Macro, so a user who
  // turned that plugin off was turning these off with it. `previousOwnerIds`
  // keeps that choice: the seeder does not restore what someone disabled.
  { id: "polls", repo: "gloom-sh/gloom-polls", directory: "gloom-polls" },
  { id: "fear-greed", repo: "gloom-sh/gloom-fear-greed", directory: "gloom-fear-greed", previousOwnerIds: ["market-overview"] },
  { id: "market-halts", repo: "gloom-sh/gloom-market-halts", directory: "gloom-market-halts", previousOwnerIds: ["market-overview"] },
  { id: "market-heatmap", repo: "gloom-sh/gloom-market-heatmap", directory: "gloom-market-heatmap", previousOwnerIds: ["market-overview"] },
  { id: "ipo-calendar", repo: "gloom-sh/gloom-ipo-calendar", directory: "gloom-ipo-calendar", previousOwnerIds: ["macro"] },
  { id: "prediction-markets", repo: "gloom-sh/gloom-prediction-markets", directory: "gloom-prediction-markets" },
] as const;

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
 * Installs any extracted plugin the user has not seen yet.
 *
 * Best effort by design: a failure is logged and retried on the next launch
 * rather than recorded, because the common cause is being offline at startup and
 * marking it seeded would silently drop the plugin forever.
 */
export async function seedExtractedPlugins(
  config: AppConfig,
  installPlugin: (ref: string) => Promise<void>,
  pluginsDir: string = getPluginsDir(),
): Promise<SeedResult> {
  const alreadySeeded = new Set(config.seededPlugins ?? []);
  const disabled = new Set(config.disabledPlugins ?? []);

  const result: SeedResult = { installed: [], failed: [], seeded: [...alreadySeeded] };

  for (const entry of EXTRACTED_PLUGINS) {
    if (alreadySeeded.has(entry.id)) continue;

    // Present already: either installed by hand or seeded before this record
    // existed. Mark it so we stop looking.
    if (isInstalled(entry.directory, pluginsDir)) {
      result.seeded.push(entry.id);
      continue;
    }

    // Turned off before the move: restoring it would override that choice.
    if (disabled.has(entry.id) || ("previousOwnerIds" in entry && entry.previousOwnerIds.some((id) => disabled.has(id)))) {
      result.seeded.push(entry.id);
      continue;
    }

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
