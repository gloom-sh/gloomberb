import {
  setConfigStoreHost,
  type ConfigStoreHost,
} from "../../data/config/store";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "../../data/config/store/normalize";
import { createDefaultConfig, type AppConfig } from "../../types/config";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";

export const BROWSER_DATA_DIR = "browser://local";

function browserReady(config: AppConfig): AppConfig {
  return { ...config, onboardingComplete: true, onboardingProgress: undefined };
}

function createBrowserDefaultConfig(dataDir: string): AppConfig {
  return browserReady(createDefaultConfig(dataDir));
}

export function createBrowserConfigStore(storage: StorageLike): ConfigStoreHost {
  const data = new SafeJsonStorage<unknown>(storage, BROWSER_STORAGE_KEYS.config, null);
  return {
    async getDataDir() { return BROWSER_DATA_DIR; },
    async loadConfig(dataDir) {
      const saved = data.get();
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        return createBrowserDefaultConfig(dataDir);
      }
      return browserReady(normalizeLoadedConfig(saved as Record<string, unknown>, dataDir).config);
    },
    async saveConfig(config) {
      data.set(normalizeConfigForSave(browserReady({ ...config, dataDir: BROWSER_DATA_DIR })));
    },
    async initDataDir(dataDir) {
      const config = createBrowserDefaultConfig(dataDir);
      data.set(config);
      return config;
    },
    async resetAllData(dataDir) {
      for (const key of Object.values(BROWSER_STORAGE_KEYS)) {
        try { storage.removeItem(key); } catch {}
      }
      data.set(createBrowserDefaultConfig(dataDir));
    },
    async exportConfig() {
      throw new Error("Config file export is unavailable in the browser.");
    },
    async importConfig() {
      throw new Error("Config file import is unavailable in the browser.");
    },
  };
}

export function installBrowserConfigStore(storage: StorageLike = localStorage): void {
  setConfigStoreHost(createBrowserConfigStore(storage));
}
