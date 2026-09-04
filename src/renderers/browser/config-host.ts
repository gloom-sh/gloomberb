import {
  setConfigStoreHost,
  type ConfigStoreHost,
} from "../../data/config/store";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "../../data/config/store/normalize";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID, type AppConfig } from "../../types/config";
import { researchEntryFromSearch } from "./research-entry";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";

export const BROWSER_DATA_DIR = "browser://local";

function browserReady(config: AppConfig): AppConfig {
  return { ...config, onboardingComplete: true, onboardingProgress: undefined };
}

function createBrowserDefaultConfig(dataDir: string, search = ""): AppConfig {
  const config = createDefaultConfig(dataDir);
  const entry = researchEntryFromSearch(search) ?? { symbol: "NVDA", tab: "overview" };
  // A first visit starts with one useful research pane. Saved layouts retain
  // their existing panes and bindings when a visitor returns.
  config.layouts[0] = {
    name: "Research",
    layout: {
      dockRoot: { kind: "pane", instanceId: "ticker-detail:main" },
      instances: [{ instanceId: "ticker-detail:main", paneId: TICKER_RESEARCH_PANE_ID,
        binding: { kind: "fixed", symbol: entry.symbol }, settings: { hideTabs: false } }],
      floating: [], detached: [],
    },
    paneState: { "ticker-detail:main": { activeTabId: entry.tab } },
  };
  config.layout = config.layouts[0].layout;
  return browserReady(config);
}

export function createBrowserConfigStore(storage: StorageLike, search = ""): ConfigStoreHost {
  const data = new SafeJsonStorage<unknown>(storage, BROWSER_STORAGE_KEYS.config, null);
  return {
    async getDataDir() { return BROWSER_DATA_DIR; },
    async loadConfig(dataDir) {
      const saved = data.get();
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        return createBrowserDefaultConfig(dataDir, search);
      }
      return browserReady(normalizeLoadedConfig(saved as Record<string, unknown>, dataDir).config);
    },
    async saveConfig(config) {
      data.set(normalizeConfigForSave(browserReady({ ...config, dataDir: BROWSER_DATA_DIR })));
    },
    async initDataDir(dataDir) {
      const config = createBrowserDefaultConfig(dataDir, search);
      data.set(config);
      return config;
    },
    async resetAllData(dataDir) {
      for (const key of Object.values(BROWSER_STORAGE_KEYS)) {
        try { storage.removeItem(key); } catch {}
      }
      data.set(createBrowserDefaultConfig(dataDir, search));
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
  setConfigStoreHost(createBrowserConfigStore(storage, typeof location !== "undefined" ? location.search : ""));
}
