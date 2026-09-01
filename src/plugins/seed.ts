import { existsSync } from "fs";
import { join } from "path";

import type { AppConfig } from "../types/config";
import { debugLog } from "../utils/debug-log";
import { getPluginsDir } from "./loader";

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
  { id: "substack", repo: "gloom-sh/gloomberb-substack", directory: "gloomberb-substack" },
  { id: "ibkr", repo: "gloom-sh/gloomberb-ibkr", directory: "gloomberb-ibkr" },
  { id: "ibkr-gateway", repo: "gloom-sh/gloomberb-ibkr-gateway", directory: "gloomberb-ibkr-gateway" },
] as const;

export interface SeedResult {
  installed: string[];
  failed: string[];
  /** Ids to record as seeded, whether or not this launch installed them. */
  seeded: string[];
}

function isInstalled(directory: string, pluginsDir: string): boolean {
  return existsSync(join(pluginsDir, directory));
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
    if (disabled.has(entry.id)) {
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
