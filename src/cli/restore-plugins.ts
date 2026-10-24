import { saveConfig } from "../data/config/store";
import { loadCliConfigIfAvailable } from "./context";
import { getPluginsDir } from "../plugins/loader";
import { pluginSeedFailure, pluginSeedNotice, samePluginSeedFailure, seedExtractedPlugins } from "../plugins/extracted-plugins";
import { setPluginSeedNotice } from "../plugins/seed-notice";
import { debugLog } from "../utils/debug-log";
import type { AppConfig } from "../types/config";
import { settleWithin } from "../utils/async-deadline";

const log = debugLog.createLogger("plugin-seed");

/**
 * How long a launch waits for the plugin registry before it starts without
 * the plugins left to install. A connection that hangs would otherwise hold
 * the screen blank: the registry is read first, and git would hang the same
 * way after it. They are retried at the next launch.
 */
const REGISTRY_WAIT_MS = 8_000;

/**
 * Reinstalls plugins that moved out of this repository into their own.
 *
 * Runs before the plugin catalog is read so a restored plugin is available in
 * the same session, and never blocks or prints: an offline launch should
 * start normally and try again next time. What it could not install becomes
 * one notice the app shows once it is up (`setPluginSeedNotice`), saying why
 * when git is missing, and `doctor` names the plugins.
 *
 * Returns what it recorded (the seeded ids, and what failed) so a caller that
 * already holds the config in memory can adopt it. The desktop loads its
 * config before restoring, and without this it would keep an object one
 * launch stale and overwrite the record on the next save.
 */
export async function restoreExtractedPlugins(): Promise<Pick<AppConfig, "seededPlugins" | "pluginSeedFailure"> | null> {
  try {
    const config = await loadCliConfigIfAvailable();
    // No data directory yet means a first run: there is nothing to restore.
    if (!config) return null;
    // Through the registry like `gloom install`: the reviewed commit, and
    // nothing on a Gloomberb too old for it. That failure is retried at the
    // next launch, by when this Gloomberb has usually updated itself. The
    // registry is read once, and only when something is left to install.
    // Quiet: the terminal app is about to own the screen, and git's or bun's
    // output would be left behind in the scrollback.
    const { gitInstalled, installListedPlugin, loadRegistryListings } = await import("../plugins/installer");
    let listings: Promise<Awaited<ReturnType<typeof loadRegistryListings>> | null> | undefined;
    let gitMissing: boolean | undefined;
    const result = await seedExtractedPlugins(config, async (repo) => {
      // Without git every clone fails the same way: no registry read, no attempt.
      gitMissing ??= !gitInstalled();
      if (gitMissing) throw new Error("git is not installed");
      listings ??= settleWithin(loadRegistryListings(), REGISTRY_WAIT_MS);
      const known = await listings;
      // No answer at all: the network hangs, and a clone would too. Nothing is tried until the next launch.
      if (!known) throw new Error("the plugin registry did not answer");
      return installListedPlugin(repo, { quiet: true }, known);
    });
    // Recorded, so doctor knows a launch tried, and a failure the next launch
    // retries is not announced again while it lasts.
    const failure = pluginSeedFailure(result.failed, gitMissing === true);
    setPluginSeedNotice(pluginSeedNotice(failure, config.pluginSeedFailure));

    const seeded = [...new Set(result.seeded)].sort();
    const existing = [...new Set(config.seededPlugins ?? [])].sort();
    const record = { seededPlugins: seeded, pluginSeedFailure: failure };
    if (seeded.join() === existing.join() && samePluginSeedFailure(failure, config.pluginSeedFailure)) return record;

    await saveConfig({ ...config, ...record });
    if (result.installed.length > 0) {
      log.info(`Restored ${result.installed.join(", ")} into ${getPluginsDir()}`);
    }
    return record;
  } catch (error) {
    log.error(`Plugin restore skipped: ${error}`);
    return null;
  }
}
