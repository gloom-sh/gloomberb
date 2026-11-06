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
  type SavedLayout,
} from "../../types/config";
import { buildDockStack } from "../../layout/pane-manager/dock-stack";
import { getDockedPaneIds } from "../../layout/pane-manager/dock-tree";
import { holdsPaneGrid } from "../../layout/pane-manager/gridlock";
import { researchEntryFromSearch } from "./research-entry";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "../../data/json-storage";
import { stopBootFrameRecorders } from "../dom/boot-frame";
import { logFailure } from "../../utils/log-failure";

export const BROWSER_DATA_DIR = "browser://local";

function browserReady(config: AppConfig): AppConfig {
  return { ...config, onboardingComplete: true, onboardingProgress: undefined };
}

export const BROWSER_RESEARCH_PANE_ID = "ticker-detail:main";
export const BROWSER_RESEARCH_CHART_ID = "chart-composer:research";
const BROWSER_RESEARCH_NEWS_ID = "ticker-news:research";
const BROWSER_WORLD_INDICES_ID = "world-indices:main";
const BROWSER_SECTORS_ID = "sectors:main";
const BROWSER_ECON_CALENDAR_ID = "econ-calendar:main";

function column(first: string, second: string, ratio = 0.5): DockLayoutNode {
  return {
    kind: "split",
    axis: "vertical",
    ratio,
    first: { kind: "pane", instanceId: first },
    second: { kind: "pane", instanceId: second },
  };
}

/** The window in grid cells, for the first-visit workspace to fit. */
export type BrowserScreen = { width: number; height: number };

/** Without a screen to fit, the grid. */
function holdsGrid(screen: BrowserScreen | undefined): boolean {
  return !screen || holdsPaneGrid(screen);
}

/**
 * The first-visit workspace: six panes, with one company down the middle.
 * The research pane owns the symbol; the news and chart panes follow it, so
 * typing a new ticker while the research pane is focused swaps all three.
 * The market panes on either side stay put.
 *
 * A screen that holds no grid of panes (a phone, upright or on its side) gets
 * the same panes as one stack of tabs at the full width instead, the
 * company's first and the research pane in front: six panes side by side
 * there were a dozen columns each.
 */
export function createBrowserResearchLayout(symbol: string, screen?: BrowserScreen): LayoutConfig {
  const follow = { kind: "follow" as const, sourceInstanceId: BROWSER_RESEARCH_PANE_ID };
  const dockRoot: DockLayoutNode = holdsGrid(screen)
    ? {
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
    }
    : buildDockStack([
      BROWSER_RESEARCH_PANE_ID,
      BROWSER_RESEARCH_CHART_ID,
      BROWSER_RESEARCH_NEWS_ID,
      BROWSER_WORLD_INDICES_ID,
      BROWSER_SECTORS_ID,
      BROWSER_ECON_CALENDAR_ID,
    ], BROWSER_RESEARCH_PANE_ID)!;
  return {
    dockRoot,
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

/** A starter tab's panes as one stack, in the order its layout lists them, the focused one (or the first) in front. */
function asOneStack(saved: SavedLayout): SavedLayout {
  return { ...saved, layout: { ...saved.layout, dockRoot: buildDockStack(getDockedPaneIds(saved.layout), saved.focusedPaneId) } };
}

function createBrowserDefaultConfig(dataDir: string, search = "", screen?: BrowserScreen): AppConfig {
  const config = createDefaultConfig(dataDir);
  const entry = researchEntryFromSearch(search) ?? { symbol: "NVDA", tab: "overview" };
  // A first visit starts with a research workspace around one company. Saved
  // layouts retain their existing panes and bindings when a visitor returns,
  // on any screen.
  const research: SavedLayout = {
    name: "Research",
    layout: createBrowserResearchLayout(entry.symbol, screen),
    paneState: { [BROWSER_RESEARCH_PANE_ID]: { activeTabId: entry.tab } },
    focusedPaneId: BROWSER_RESEARCH_PANE_ID,
  };
  // The tabs beside it fit the screen the same way: a phone gets each as one stack.
  const rest = config.layouts.slice(1);
  config.layouts = [research, ...holdsGrid(screen) ? rest : rest.map(asOneStack)];
  config.layout = research.layout;
  return browserReady(config);
}

/**
 * `screen` is read when the starter workspace is made (a first visit, or a
 * reset), so it fits the window then; without one it is the grid.
 */
export function createBrowserConfigStore(storage: StorageLike, search = "", screen?: () => BrowserScreen): ConfigStoreHost {
  const data = new SafeJsonStorage<unknown>(storage, BROWSER_STORAGE_KEYS.config, null);
  return {
    async getDataDir() { return BROWSER_DATA_DIR; },
    async loadConfig(dataDir) {
      const saved = data.get();
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        return createBrowserDefaultConfig(dataDir, search, screen?.());
      }
      return browserReady(normalizeLoadedConfig(saved as Record<string, unknown>, dataDir).config);
    },
    async saveConfig(config) {
      data.set(normalizeConfigForSave(browserReady({ ...config, dataDir: BROWSER_DATA_DIR })));
    },
    async initDataDir(dataDir) {
      const config = createBrowserDefaultConfig(dataDir, search, screen?.());
      data.set(config);
      return config;
    },
    async resetAllData(dataDir) {
      // Before the keys go, or the frame saved as the page closes would bring the old layout back.
      stopBootFrameRecorders();
      for (const key of Object.values(BROWSER_STORAGE_KEYS)) {
        try { storage.removeItem(key); } catch (error) { logFailure("web-config", "Could not remove saved browser data on reset")(error); }
      }
      data.set(createBrowserDefaultConfig(dataDir, search, screen?.()));
    },
    async exportConfig() {
      throw new Error("Config file export is unavailable in the browser.");
    },
    async importConfig() {
      throw new Error("Config file import is unavailable in the browser.");
    },
  };
}

/** False on a first visit, which opens the starter workspace rather than a saved one. */
export function hasSavedBrowserConfig(storage: StorageLike = localStorage): boolean {
  try {
    return storage.getItem(BROWSER_STORAGE_KEYS.config) !== null;
  } catch {
    // Intentional ignore: storage the page cannot read holds no config to open, so the starter workspace opens.
    return false;
  }
}

/** `screen` gives the window in cells, as the renderer reports it to the dock and Tidy. */
export function installBrowserConfigStore(screen: () => BrowserScreen, storage: StorageLike = localStorage): void {
  setConfigStoreHost(createBrowserConfigStore(storage, typeof location !== "undefined" ? location.search : "", screen));
}
