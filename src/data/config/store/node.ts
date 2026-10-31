import { logFailure } from "../../../utils/log-failure";
import { existsSync, readdirSync, type Dirent } from "fs";
import { readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { expandUserHome, getGloomberbDirs } from "../home";
import type { AppConfig } from "../../../types/config";
import { createDefaultConfig } from "../../../types/config";
import { debugLog } from "../../../utils/debug-log";
import { findAbsorbedCheckout, isDirectoryOrLink, isPluginDirectory } from "../../../plugins/loader";
import { EXTRACTED_PLUGINS } from "../../../plugins/extracted-plugins";
import { makePrivateDir, writePrivateFile } from "../../../utils/private-files";
import { tightenProfilePermissions } from "../../profile-permissions";
import type { ConfigMigrationHost } from "./migrations";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "./normalize";

const configLog = debugLog.createLogger("config");
const IN_MEMORY_DATA_DIR = ":memory:";

/**
 * The config.json for a data directory: the file inside it, except that the
 * default data directory of the XDG layout keeps its config in the config
 * directory. A data directory chosen in config.json still carries its own
 * file, as everywhere else, and the global one only points at it.
 */
function configFileFor(dataDir: string): string {
  const dirs = getGloomberbDirs();
  if (dirs.kind === "xdg" && resolve(dataDir) === resolve(dirs.data)) return dirs.configFile;
  return join(dataDir, "config.json");
}

const expandHomePath = expandUserHome;

/**
 * The data directory the global config records, or null on a first run.
 *
 * Under `GLOOMBERB_HOME` or the XDG layout, a recorded directory that no
 * longer exists gives way to the default data directory: a config.json
 * carried along in a moved folder still names the old `~/.gloomberb`, and
 * honouring that would recreate the old folder, which is the one thing the
 * move was meant to avoid.
 */
export async function getDataDir(): Promise<string | null> {
  try {
    const dirs = getGloomberbDirs();
    const raw = await readFile(dirs.configFile, "utf-8");
    const config = JSON.parse(raw) as { dataDir?: string };
    const recorded = config.dataDir || null;
    if (recorded && dirs.kind !== "home" && !existsSync(recorded)) return dirs.data;
    return recorded;
  } catch (error) {
    // An absent optional file or directory is expected.
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") logFailure("data.config.store.node", "Reading the configured data directory failed")(error);
    return null;
  }
}

/**
 * Whether the plugins folder holds a copy of a plugin that is built in now,
 * under its own folder name or another whose gloom.json claims the id. Only a
 * one-time migration asks, so no ordinary load reads the folder. The folder is
 * resolved per call, so a test can point it away from the real plugins.
 */
function hasAbsorbedPluginCheckout(pluginId: string): boolean {
  const pluginsDir = getGloomberbDirs().plugins;
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    // An absent optional file or directory is expected.
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") logFailure("data.config.store.node", "Reading installed plugins for migration failed")(error);
    return false;
  }
  return entries.some((entry) => {
    const pluginDir = join(pluginsDir, entry.name);
    return isPluginDirectory(entry.name)
      && isDirectoryOrLink(entry, pluginDir)
      && findAbsorbedCheckout(pluginDir)?.id === pluginId;
  });
}

const migrationHost: ConfigMigrationHost = { hasPluginCheckout: hasAbsorbedPluginCheckout };

export async function loadConfig(dataDir: string): Promise<AppConfig> {
  const { config } = await loadConfigState(dataDir);
  return config;
}

async function loadConfigState(dataDir: string): Promise<{ config: AppConfig; needsSave: boolean }> {
  const configPath = configFileFor(dataDir);

  try {
    const raw = await readFile(configPath, "utf-8");
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const state = normalizeLoadedConfig(saved, dataDir, migrationHost);
    // A config.json that names a different directory than the one it belongs
    // to came along with a moved folder. Record where it lives now, so the next
    // launch reads it directly instead of through the missing-path fallback.
    const recorded = typeof saved.dataDir === "string" ? saved.dataDir : null;
    return { config: state.config, needsSave: state.needsSave || (recorded !== null && recorded !== dataDir) };
  } catch {
    // Fresh installs have no former built-in plugins to restore. Record the
    // current baseline so onboarding never waits for plugin network installs.
    return {
      config: { ...createDefaultConfig(dataDir), seededPlugins: EXTRACTED_PLUGINS.map((plugin) => plugin.id) },
      needsSave: true,
    };
  }
}

/** The save in flight or queued last for each config file; it never rejects. */
const saveQueues = new Map<string, Promise<void>>();
let tempFileCounter = 0;

async function writeConfigFile(configPath: string, contents: string): Promise<void> {
  await makePrivateDir(dirname(configPath));
  // Unique per call: a clock tick is not, and two saves can land in one.
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.${tempFileCounter++}.tmp`;
  try {
    // Readable by the user alone: config.json holds broker credentials.
    await writePrivateFile(tempPath, contents);
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => { /* Intentional ignore: Remove a partial temporary file while preserving the write error rethrown below. */ });
    throw error;
  }
}

/**
 * Saves to one file run one after another in call order, so the last call is
 * the one on disk and none is lost. A failed save rejects only its own caller
 * and the next one still runs.
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  // `:memory:` is the data directory of a config kept in memory (tests, as for
  // SQLite): there is no file, and writing one would land under the working directory.
  if (config.dataDir === IN_MEMORY_DATA_DIR) return;
  const configPath = configFileFor(config.dataDir);
  // Written as it was when called, however the caller's object changes while
  // earlier saves are still running.
  const contents = JSON.stringify(normalizeConfigForSave(config), null, 2);
  const result = (saveQueues.get(configPath) ?? Promise.resolve()).then(() => writeConfigFile(configPath, contents));
  const settled = result.catch(() => { /* Intentional ignore: The caller receives result; only the serialization chain consumes its duplicate rejection. */ });
  saveQueues.set(configPath, settled);
  void settled.then(() => {
    if (saveQueues.get(configPath) === settled) saveQueues.delete(configPath);
  });
  return result;
}

export async function initDataDir(dataDir: string): Promise<AppConfig> {
  configLog.info(`Initializing data directory: ${dataDir}`);
  await makePrivateDir(dataDir);
  const { config, needsSave } = await loadConfigState(dataDir);
  if (needsSave) {
    await saveConfig(config);
  }
  await tightenProfilePermissions(dataDir, [configFileFor(dataDir), getGloomberbDirs().configFile]);
  return config;
}

export async function resetAllData(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
  // Settings outside the data directory (the XDG config file) go too, or the
  // next launch would skip the setup wizard the reset promises.
  await rm(configFileFor(dataDir), { force: true });
}

export async function exportConfig(config: AppConfig, destPath: string): Promise<void> {
  const { dataDir, ...rest } = config;
  // The export carries broker credentials as config.json does.
  await writeFile(expandHomePath(destPath), JSON.stringify(rest, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function importConfig(dataDir: string, srcPath: string): Promise<AppConfig> {
  const raw = await readFile(expandHomePath(srcPath), "utf-8");
  const saved = JSON.parse(raw) as Record<string, unknown>;
  const { config } = normalizeLoadedConfig(saved, dataDir, migrationHost);
  await saveConfig(config);
  return config;
}
