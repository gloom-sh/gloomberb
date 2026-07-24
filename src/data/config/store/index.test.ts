import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { exportConfig, importConfig, loadConfig, sanitizeLayout, saveConfig } from "./index";
import {
  CURRENT_CONFIG_VERSION,
  DEFAULT_COLUMNS,
  DEFAULT_LAYOUT,
  DEFAULT_PORTFOLIO_COLUMN_IDS,
  findPaneInstance,
} from "../../../types/config";
import { getDockedPaneIds } from "../../../plugins/pane-manager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempConfigDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-config-"));
  tempDirs.push(dataDir);
  return dataDir;
}

function createSavedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    baseCurrency: "USD",
    refreshIntervalMinutes: 30,
    portfolios: [{ id: "main", name: "Main Portfolio", currency: "USD" }],
    watchlists: [{ id: "watchlist", name: "Watchlist" }],
    layout: DEFAULT_LAYOUT,
    layouts: [{ name: "Default", layout: DEFAULT_LAYOUT }],
    activeLayoutIndex: 0,
    brokerInstances: [],
    disabledPlugins: [],
    theme: "amber",
    chartPreferences: { defaultRenderMode: "area", renderer: "auto" },
    valueFlashingEnabled: true,
    recentTickers: [],
    ...overrides,
  };
}

async function writeConfigJson(dataDir: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(dataDir, "config.json"), JSON.stringify(config), "utf-8");
}

describe("sanitizeLayout", () => {
  test("rewrites unbound ticker-detail panes to follow the first portfolio pane", () => {
    const layout = sanitizeLayout({
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "portfolio-list:main" },
        second: { kind: "pane", instanceId: "ticker-detail:main" },
      },
      instances: [
        {
          instanceId: "portfolio-list:main",
          paneId: "portfolio-list",
          binding: { kind: "none" },
          params: { collectionId: "main" },
        },
        {
          instanceId: "ticker-detail:main",
          paneId: "ticker-detail",
          binding: { kind: "none" },
        },
      ],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(findPaneInstance(layout, "ticker-detail:main")?.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "portfolio-list:main",
    });
    expect(getDockedPaneIds(layout)).toEqual(["portfolio-list:main", "ticker-detail:main"]);
  });

  test("removes follow panes whose source pane is missing", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "ticker-detail:main" },
      instances: [
        {
          instanceId: "ticker-detail:main",
          paneId: "ticker-detail",
          binding: { kind: "follow", sourceInstanceId: "portfolio-list:missing" },
        },
      ],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(findPaneInstance(layout, "ticker-detail:main")).toBeUndefined();
    expect(getDockedPaneIds(layout)).toHaveLength(0);
    expect(layout.dockRoot).toBeNull();
  });

  test("clamps floating placement memory and drops invalid docked placement hints", () => {
    const layout = sanitizeLayout({
      dockRoot: {
        kind: "split",
        axis: "vertical",
        ratio: 0.55,
        first: { kind: "pane", instanceId: "portfolio-list:main" },
        second: { kind: "pane", instanceId: "ticker-detail:main" },
      },
      instances: [
        {
          instanceId: "portfolio-list:main",
          paneId: "portfolio-list",
          binding: { kind: "none" },
          params: { collectionId: "main" },
          placementMemory: {
            docked: {
              columnIndex: "left",
              order: 0,
            },
          },
        },
        {
          instanceId: "ticker-detail:main",
          paneId: "ticker-detail",
          binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
          placementMemory: {
            docked: {
              columnIndex: 3,
              order: 2,
              height: "120%",
            },
            floating: {
              x: -5,
              y: 4,
              width: 0,
              height: 7,
              fixedGeometry: true,
            },
          },
        },
      ],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(layout.dockRoot?.kind).toBe("split");
    expect(layout.dockRoot && layout.dockRoot.kind === "split" ? layout.dockRoot.axis : null).toBe("vertical");
    expect(findPaneInstance(layout, "portfolio-list:main")?.placementMemory).toBeUndefined();
    expect(findPaneInstance(layout, "ticker-detail:main")?.placementMemory).toEqual({
      floating: {
        x: 0,
        y: 4,
        width: 1,
        height: 7,
        fixedGeometry: true,
      },
    });
  });

  test("preserves explicit fixed floating geometry through layout sanitization", () => {
    const layout = sanitizeLayout({
      dockRoot: null,
      instances: [{
        instanceId: "portfolio-list:main",
        paneId: "portfolio-list",
        binding: { kind: "none" },
      }],
      floating: [{
        instanceId: "portfolio-list:main",
        x: 50,
        y: 30,
        width: 10,
        height: 3,
        fixedGeometry: true,
      }],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(layout.floating).toEqual([{
      instanceId: "portfolio-list:main",
      x: 50,
      y: 30,
      width: 10,
      height: 3,
      fixedGeometry: true,
      zIndex: undefined,
    }]);
  });

  test("falls back to the default layout when given an obsolete column layout", () => {
    const layout = sanitizeLayout({
      columns: [{ width: "100%" }],
      instances: [
        {
          instanceId: "portfolio-list:main",
          paneId: "portfolio-list",
          binding: { kind: "none" },
        },
      ],
      docked: [{ instanceId: "portfolio-list:main", columnIndex: 0 }],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(layout).toEqual(DEFAULT_LAYOUT);
  });
});

describe("loadConfig", () => {
  test("defaults detached layouts to an empty list for older configs", async () => {
    const dataDir = await createTempConfigDir();
    const layoutWithoutDetached = {
      ...DEFAULT_LAYOUT,
      detached: undefined,
    };
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: CURRENT_CONFIG_VERSION - 1,
      layout: layoutWithoutDetached,
      layouts: [{ name: "Default", layout: layoutWithoutDetached }],
    }));

    const config = await loadConfig(dataDir);

    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.layout.detached).toEqual([]);
    expect(config.layouts[0]?.layout.detached).toEqual([]);
  });

  test("fills in missing chart preferences for older configs", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 5,
      recentTickers: [],
      chartPreferences: undefined,
    }));

    const config = await loadConfig(dataDir);

    expect(config.chartPreferences).toEqual({
      defaultRenderMode: "area",
      renderer: "auto",
    });
  });

  test("sanitizes invalid chart renderer values back to auto", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 7,
      chartPreferences: {
        defaultRenderMode: "hlc",
        renderer: "nope",
      },
    }));

    const config = await loadConfig(dataDir);

    expect(config.chartPreferences).toEqual({
      defaultRenderMode: "hlc",
      renderer: "auto",
    });
    expect(config.pluginConfig).toEqual({});
  });

  test("defaults value flashing on and preserves an explicit off setting", async () => {
    const missingDir = await createTempConfigDir();
    await writeConfigJson(missingDir, createSavedConfig({
      configVersion: 16,
      valueFlashingEnabled: undefined,
    }));

    const missingConfig = await loadConfig(missingDir);
    expect(missingConfig.valueFlashingEnabled).toBe(true);

    const disabledDir = await createTempConfigDir();
    await writeConfigJson(disabledDir, createSavedConfig({
      valueFlashingEnabled: false,
    }));

    const disabledConfig = await loadConfig(disabledDir);
    expect(disabledConfig.valueFlashingEnabled).toBe(false);
  });

  test("preserves plugin config state from disk", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 7,
      pluginConfig: {
        news: {
          displayMode: "expanded",
        },
      },
      chartPreferences: { defaultRenderMode: "line" },
    }));

    const config = await loadConfig(dataDir);

    expect(config.pluginConfig).toEqual({
      news: {
        displayMode: "expanded",
      },
    });
  });

  test("preserves disabled plugin ids without migration rewrites", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 9,
      disabledPlugins: ["chat", "news", "chat"],
    }));

    const config = await loadConfig(dataDir);

    expect(config.disabledPlugins).toEqual(["chat", "news"]);
  });

  test("migrates disabled built-in modules to their owning plugin ids", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: CURRENT_CONFIG_VERSION - 1,
      disabledPlugins: [
        "options",
        "sec",
        "thirteenf",
        "world-indices",
        "market-heatmap",
        "fear-greed",
        "earnings-calendar",
        "macro-tv",
        "ibkr",
        "broker-manager",
        "analytics",
        "kelly-sizer",
        "portfolio-list",
        "changelog",
        "help",
        "layout-manager",
        "application",
      ],
    }));

    const config = await loadConfig(dataDir);

    expect(config.disabledPlugins).toEqual([
      "ticker-research",
      "market-overview",
      "macro",
      "ibkr",
      "broker",
      "portfolio",
    ]);
  });

  test("migrates grouped built-in plugin config keys", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: CURRENT_CONFIG_VERSION - 1,
      pluginConfig: {
        options: {
          selectedExpiration: "2026-06-19",
        },
        "company-research": {
          preferredTab: "analyst-research",
        },
        "kelly-sizer": {
          inherited: true,
          shared: "legacy",
        },
        portfolio: {
          shared: "canonical",
        },
        changelog: {
          dismissedVersion: "1.2.3",
        },
      },
    }));

    const config = await loadConfig(dataDir);

    expect(config.pluginConfig).toEqual({
      "ticker-research": {
        selectedExpiration: "2026-06-19",
        preferredTab: "analyst-research",
      },
      portfolio: {
        inherited: true,
        shared: "canonical",
      },
      application: {
        dismissedVersion: "1.2.3",
      },
    });
  });

  test("does not repeat the legacy Cloud-to-Macro disable migration", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: CURRENT_CONFIG_VERSION - 1,
      disabledPlugins: ["gloomberb-cloud"],
    }));

    const config = await loadConfig(dataDir);

    expect(config.disabledPlugins).toEqual(["gloomberb-cloud"]);
  });

  test("enables Gloom Cloud when migrating older default configs", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 12,
      disabledPlugins: ["gloomberb-cloud", "news"],
    }));

    const config = await loadConfig(dataDir);

    expect(config.disabledPlugins).toEqual(["news"]);
  });

  test("preserves IBKR gateway configs without migration rewrites", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 11,
      brokerInstances: [{
        id: "ibkr-interactive-brokers",
        brokerType: "ibkr",
        label: "Interactive Brokers",
        connectionMode: "gateway",
        config: {
          connectionMode: "gateway",
          host: "127.0.0.1",
          port: 4002,
          clientId: 1,
        },
      }],
    }));

    const config = await loadConfig(dataDir);

    expect(config.brokerInstances[0]?.config).toEqual({
      connectionMode: "gateway",
      host: "127.0.0.1",
      port: 4002,
      clientId: 1,
    });
  });

  test("preserves saved layout pane state and focus metadata", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      layouts: [{
        name: "Chart",
        layout: DEFAULT_LAYOUT,
        paneState: {
          "ticker-detail:main": {
            activeTabId: "chart",
            pluginState: {
              "ticker-detail": { detailMetric: "revenue", shared: "legacy" },
              "ticker-research": { shared: "canonical" },
            },
          },
          "missing:pane": { activeTabId: "overview" },
        },
        focusedPaneId: "ticker-detail:main",
        activePanel: "right",
      }],
    }));

    const config = await loadConfig(dataDir);

    expect(config.layouts[0]?.paneState).toEqual({
      "ticker-detail:main": {
        activeTabId: "chart",
        pluginState: {
          "ticker-research": { detailMetric: "revenue", shared: "canonical" },
        },
      },
    });
    expect(config.layouts[0]?.focusedPaneId).toBe("ticker-detail:main");
    expect(config.layouts[0]?.activePanel).toBe("right");

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as {
      layouts: Array<{ paneState?: Record<string, unknown>; focusedPaneId?: string | null; activePanel?: string }>;
    };
    expect(persisted.layouts[0]?.paneState).toEqual({
      "ticker-detail:main": {
        activeTabId: "chart",
        pluginState: {
          "ticker-research": { detailMetric: "revenue", shared: "canonical" },
        },
      },
    });
    expect(persisted.layouts[0]?.focusedPaneId).toBe("ticker-detail:main");
    expect(persisted.layouts[0]?.activePanel).toBe("right");
  });

  test("migrates legacy main portfolio panes to the portfolio default columns", async () => {
    const dataDir = await createTempConfigDir();
    const legacyColumnIds = DEFAULT_COLUMNS.map((column) => column.id);
    const legacyLayout = {
      ...DEFAULT_LAYOUT,
      instances: DEFAULT_LAYOUT.instances.map((instance) => (
        instance.instanceId === "portfolio-list:main"
          ? {
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: legacyColumnIds,
            },
          }
          : instance
      )),
    };

    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 10,
      layout: legacyLayout,
      layouts: [{ name: "Default", layout: legacyLayout }],
    }));

    const config = await loadConfig(dataDir);

    expect(findPaneInstance(config.layout, "portfolio-list:main")?.settings?.columnIds).toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
    expect(findPaneInstance(config.layouts[0]?.layout ?? DEFAULT_LAYOUT, "portfolio-list:main")?.settings?.columnIds)
      .toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
  });

  test("does not replay the portfolio column migration for version 19 configs", async () => {
    const dataDir = await createTempConfigDir();
    const selectedColumnIds = DEFAULT_COLUMNS.map((column) => column.id);
    const layout = {
      ...DEFAULT_LAYOUT,
      instances: DEFAULT_LAYOUT.instances.map((instance) => (
        instance.instanceId === "portfolio-list:main"
          ? {
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: selectedColumnIds,
            },
          }
          : instance
      )),
    };

    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 19,
      layout,
      layouts: [{ name: "Default", layout }],
    }));

    const config = await loadConfig(dataDir);

    expect(findPaneInstance(config.layout, "portfolio-list:main")?.settings?.columnIds).toEqual(selectedColumnIds);
    expect(findPaneInstance(config.layouts[0]?.layout ?? DEFAULT_LAYOUT, "portfolio-list:main")?.settings?.columnIds)
      .toEqual(selectedColumnIds);
  });

  test("falls back to the default layout when persisted layouts use the obsolete column shape", async () => {
    const dataDir = await createTempConfigDir();
    const obsoleteLayout = {
      columns: [{ width: "100%" }],
      instances: [
        {
          instanceId: "portfolio-list:main",
          paneId: "portfolio-list",
          binding: { kind: "none" },
        },
      ],
      docked: [{ instanceId: "portfolio-list:main", columnIndex: 0 }],
      floating: [],
      detached: [],
    };

    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 6,
      layouts: [
        { name: "Default", layout: DEFAULT_LAYOUT },
        { name: "Research", layout: obsoleteLayout },
      ],
      activeLayoutIndex: 1,
    }));

    const config = await loadConfig(dataDir);

    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.activeLayoutIndex).toBe(1);
    expect(config.layouts.map((layout) => layout.name)).toEqual(["Default", "Research"]);
    expect(config.layout).toEqual(DEFAULT_LAYOUT);

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as {
      configVersion: number;
      layouts: Array<{ name: string; layout: Record<string, unknown> }>;
      activeLayoutIndex: number;
    };

    expect(persisted.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(persisted.activeLayoutIndex).toBe(1);
    expect(persisted.layouts[1]?.layout).toEqual(DEFAULT_LAYOUT as unknown as Record<string, unknown>);
  });
});

describe("config backup files", () => {
  test("expands a leading tilde when exporting and importing", async () => {
    const originalHome = process.env.HOME;
    const homeDir = await createTempConfigDir();
    const dataDir = await createTempConfigDir();
    const importDataDir = await createTempConfigDir();
    process.env.HOME = homeDir;

    try {
      const config = await loadConfig(dataDir);
      await exportConfig({ ...config, baseCurrency: "EUR" }, "~/gloomberb-config-backup.json");

      const backupPath = join(homeDir, "gloomberb-config-backup.json");
      const exported = JSON.parse(await readFile(backupPath, "utf-8")) as Record<string, unknown>;
      expect(exported.baseCurrency).toBe("EUR");
      expect(exported.dataDir).toBeUndefined();

      await writeFile(backupPath, JSON.stringify({ ...exported, baseCurrency: "JPY" }), "utf-8");
      const imported = await importConfig(importDataDir, "~/gloomberb-config-backup.json");

      expect(imported.baseCurrency).toBe("JPY");
      expect(imported.dataDir).toBe(importDataDir);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
