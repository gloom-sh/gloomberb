import { saveConfig } from "../data/config/store";
import { loadCliConfigIfAvailable } from "./context";
import { seedExtractedPlugins } from "../plugins/seed";
import { debugLog } from "../utils/debug-log";

const log = debugLog.createLogger("plugin-seed");

/**
 * Reinstalls plugins that moved out of this repository into their own.
 *
 * Runs before the plugin catalog is read so a restored plugin is available in
 * the same session, and stays quiet on failure: an offline launch should start
 * normally and try again next time, not block on a network request.
 *
 * Returns the seeded ids so a caller that already holds the config in memory
 * can adopt them. The desktop loads its config before restoring, and without
 * this it would keep an object whose `seededPlugins` is one launch stale and
 * overwrite the record on the next save.
 */
export async function restoreExtractedPlugins(): Promise<string[] | null> {
  try {
    const config = await loadCliConfigIfAvailable();
    // No data directory yet means a first run: there is nothing to restore.
    if (!config) return null;
    const { installPlugin } = await import("./commands/plugins");
    const result = await seedExtractedPlugins(config, installPlugin);

    const seeded = [...new Set(result.seeded)].sort();
    const existing = [...new Set(config.seededPlugins ?? [])].sort();
    if (seeded.join() === existing.join()) return seeded;

    await saveConfig({ ...config, seededPlugins: seeded });
    if (result.installed.length > 0) {
      log.info(`Restored ${result.installed.join(", ")} into ~/.gloomberb/plugins`);
    }
    return seeded;
  } catch (error) {
    log.error(`Plugin restore skipped: ${error}`);
    return null;
  }
}
