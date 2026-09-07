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
  type DockLayoutNode,
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
export const BROWSER_WORLD_INDICES_ID = "world-indices:main";
export const BROWSER_SECTORS_ID = "sectors:main";
export const BROWSER_ECON_CALENDAR_ID = "econ-calendar:main";

/** The browser ships the monochrome theme the website uses. */
export const BROWSER_DEFAULT_THEME = "white";

function column(first: string, second: string, ratio = 0.5): DockLayoutNode {
  return {
    kind: "split",
    axis: "vertical",
    ratio,
    first: { kind: "pane", instanceId: first },
    second: { kind: "pane", instanceId: second },
  };
}

/**
 * The first-visit workspace: six panes, with one company down the middle.
 * The research pane owns the symbol; the news and chart panes follow it, so
 * typing a new ticker while the research pane is focused swaps all three.
 * The market panes on either side stay put.
 */
export function createBrowserResearchLayout(symbol: string): LayoutConfig {
  const follow = { kind: "follow" as const, sourceInstanceId: BROWSER_RESEARCH_PANE_ID };
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.3,
      first: column(BROWSER_WORLD_INDICES_ID, BROWSER_SECTORS_ID),
      second: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.57,
        first: column(BROWSER_RESEARCH_PANE_ID, BROWSER_RESEARCH_NEWS_ID),
        second: column(BROWSER_RESEARCH_CHART_ID, BROWSER_ECON_CALENDAR_ID),
      },
    },
    instances: [
      { instanceId: BROWSER_WORLD_INDICES_ID, paneId: "world-indices", binding: { kind: "none" } },
      { instanceId: BROWSER_SECTORS_ID, paneId: "sectors", binding: { kind: "none" } },
      {
        instanceId: BROWSER_RESEARCH_PANE_ID,
        paneId: TICKER_RESEARCH_PANE_ID,
        binding: { kind: "fixed", symbol },
        settings: { hideTabs: false },
      },
      { instanceId: BROWSER_RESEARCH_NEWS_ID, paneId: "ticker-news", binding: follow },
      { instanceId: BROWSER_RESEARCH_CHART_ID, paneId: CHART_COMPOSER_PANE_ID, binding: follow },
      { instanceId: BROWSER_ECON_CALENDAR_ID, paneId: "econ-calendar", binding: { kind: "none" } },
    ],
    floating: [],
    detached: [],
  };
}

function createBrowserDefaultConfig(dataDir: string, search = ""): AppConfig {
  const config = createDefaultConfig(dataDir);
  config.theme = BROWSER_DEFAULT_THEME;
  const entry = researchEntryFromSearch(search) ?? { symbol: "NVDA", tab: "overview" };
  // A first visit starts with a research workspace around one company. Saved
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
