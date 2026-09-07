import {
  setConfigStoreHost,
  type ConfigStoreHost,
} from "../../data/config/store";
import {
  normalizeConfigForSave,
  normalizeLoadedConfig,
} from "../../data/config/store/normalize";
import {
  CHART_COMPOSER_PANE_ID,
  createDefaultConfig,
  TICKER_RESEARCH_PANE_ID,
  type AppConfig,
  type LayoutConfig,
} from "../../types/config";
import { researchEntryFromSearch } from "./research-entry";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";

export const BROWSER_DATA_DIR = "browser://local";

function browserReady(config: AppConfig): AppConfig {
  return { ...config, onboardingComplete: true, onboardingProgress: undefined };
}

export const BROWSER_RESEARCH_PANE_ID = "ticker-detail:main";
export const BROWSER_RESEARCH_CHART_ID = "chart-composer:research";
export const BROWSER_RESEARCH_NEWS_ID = "ticker-news:research";

/**
 * The first-visit workspace: one company across three panes. The research
 * pane owns the symbol; the chart and news panes follow it, so typing a new
 * ticker while the research pane is focused swaps the whole screen.
 */
export function createBrowserResearchLayout(symbol: string): LayoutConfig {
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.58,
      first: { kind: "pane", instanceId: BROWSER_RESEARCH_PANE_ID },
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.52,
        first: { kind: "pane", instanceId: BROWSER_RESEARCH_CHART_ID },
        second: { kind: "pane", instanceId: BROWSER_RESEARCH_NEWS_ID },
      },
    },
    instances: [
      {
        instanceId: BROWSER_RESEARCH_PANE_ID,
        paneId: TICKER_RESEARCH_PANE_ID,
        binding: { kind: "fixed", symbol },
        settings: { hideTabs: false },
      },
      {
        instanceId: BROWSER_RESEARCH_CHART_ID,
        paneId: CHART_COMPOSER_PANE_ID,
        binding: { kind: "follow", sourceInstanceId: BROWSER_RESEARCH_PANE_ID },
      },
      {
        instanceId: BROWSER_RESEARCH_NEWS_ID,
        paneId: "ticker-news",
        binding: { kind: "follow", sourceInstanceId: BROWSER_RESEARCH_PANE_ID },
      },
    ],
    floating: [],
    detached: [],
  };
}

function createBrowserDefaultConfig(dataDir: string, search = ""): AppConfig {
  const config = createDefaultConfig(dataDir);
  const entry = researchEntryFromSearch(search) ?? { symbol: "NVDA", tab: "overview" };
  // A first visit starts with a research workspace for one company. Saved
  // layouts retain their existing panes and bindings when a visitor returns.
  config.layouts[0] = {
    name: "Research",
    layout: createBrowserResearchLayout(entry.symbol),
    paneState: { [BROWSER_RESEARCH_PANE_ID]: { activeTabId: entry.tab } },
    focusedPaneId: BROWSER_RESEARCH_PANE_ID,
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
