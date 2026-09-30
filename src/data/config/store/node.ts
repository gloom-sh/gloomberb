import { existsSync, readdirSync, type Dirent } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { expandUserHome, getGloomberbHome, isGloomberbHomeOverridden } from "../home";
import type { AppConfig } from "../../../types/config";
import { createDefaultConfig } from "../../../types/config";
import { debugLog } from "../../../utils/debug-log";
import { findAbsorbedCheckout, isDirectoryOrLink, isPluginDirectory } from "../../../plugins/loader";
import { EXTRACTED_PLUGINS } from "../../../plugins/extracted-plugins";
import type { ConfigMigrationHost } from "./migrations";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "./normalize";

const configLog = debugLog.createLogger("config");

function getGlobalConfigFile(): string {
  return join(getGloomberbHome(), "config.json");
}

const expandHomePath = expandUserHome;

/**
 * The data directory the global config records, or null on a first run.
 *
 * Under `GLOOMBERB_HOME`, a recorded directory that no longer exists gives
 * way to the home itself: a config.json carried along in a moved folder
 * still names the old `~/.gloomberb`, and honouring that would recreate the
 * old folder, which is the one thing the move was meant to avoid.
 */
export async function getDataDir(): Promise<string | null> {
  try {
    const raw = await readFile(getGlobalConfigFile(), "utf-8");
    const config = JSON.parse(raw) as { dataDir?: string };
    const recorded = config.dataDir || null;
    if (recorded && isGloomberbHomeOverridden() && !existsSync(recorded)) return getGloomberbHome();
    return recorded;
  } catch {
    return null;
  }
}

/**
 * Whether the plugins folder holds a copy of a plugin that is built in now,
 * under its own folder name or another whose gloom.json claims the id. Only a
 * one-time migration asks, so no ordinary load reads the folder. The home is
 * resolved per call, so a test can point it away from the real plugins.
 */
function hasAbsorbedPluginCheckout(pluginId: string): boolean {
  const pluginsDir = join(getGloomberbHome(), "plugins");
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
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
  const configPath = join(dataDir, "config.json");

  try {
    const raw = await readFile(configPath, "utf-8");
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const state = normalizeLoadedConfig(saved, dataDir, migrationHost);
    // A config.json that names a different directory than the one it sits in
    // came along with a moved folder. Record where it lives now, so the next
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

export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = join(config.dataDir, "config.json");
  await mkdir(dirname(configPath), { recursive: true });

  const persisted = normalizeConfigForSave(config);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(persisted, null, 2), "utf-8");
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function initDataDir(dataDir: string): Promise<AppConfig> {
  configLog.info(`Initializing data directory: ${dataDir}`);
  await mkdir(dataDir, { recursive: true });
  const { config, needsSave } = await loadConfigState(dataDir);
  if (needsSave) {
    await saveConfig(config);
  }
  return config;
}

export async function resetAllData(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}

export async function exportConfig(config: AppConfig, destPath: string): Promise<void> {
  const { dataDir, ...rest } = config;
  await writeFile(expandHomePath(destPath), JSON.stringify(rest, null, 2), "utf-8");
}

export async function importConfig(dataDir: string, srcPath: string): Promise<AppConfig> {
  const raw = await readFile(expandHomePath(srcPath), "utf-8");
  const saved = JSON.parse(raw) as Record<string, unknown>;
  const { config } = normalizeLoadedConfig(saved, dataDir, migrationHost);
  await saveConfig(config);
  return config;
}
