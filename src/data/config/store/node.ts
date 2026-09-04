import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { AppConfig } from "../../../types/config";
import { createDefaultConfig } from "../../../types/config";
import { debugLog } from "../../../utils/debug-log";
import { EXTRACTED_PLUGINS } from "../../../plugins/seed";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "./normalize";

const configLog = debugLog.createLogger("config");

function getGlobalConfigDir(): string {
  return join(getHomeDir(), ".gloomberb");
}

function getGlobalConfigFile(): string {
  return join(getGlobalConfigDir(), "config.json");
}

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") return getHomeDir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(getHomeDir(), filePath.slice(2));
  }
  return filePath;
}

export async function getDataDir(): Promise<string | null> {
  try {
    const raw = await readFile(getGlobalConfigFile(), "utf-8");
    const config = JSON.parse(raw) as { dataDir?: string };
    return config.dataDir || null;
  } catch {
    return null;
  }
}

export async function loadConfig(dataDir: string): Promise<AppConfig> {
  const { config } = await loadConfigState(dataDir);
  return config;
}

async function loadConfigState(dataDir: string): Promise<{ config: AppConfig; needsSave: boolean }> {
  const configPath = join(dataDir, "config.json");

  try {
    const raw = await readFile(configPath, "utf-8");
    const saved = JSON.parse(raw) as Record<string, unknown>;
    return normalizeLoadedConfig(saved, dataDir);
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
  const { config } = normalizeLoadedConfig(saved, dataDir);
  await saveConfig(config);
  return config;
}
