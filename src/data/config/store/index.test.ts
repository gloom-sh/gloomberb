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
    chartPreferences: { renderer: "auto" },
    valueFlashingEnabled: true,
    recentTickers: [],
    ...overrides,
  };
}

async function writeConfigJson(dataDir: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(dataDir, "config.json"), JSON.stringify(config), "utf-8");
}

describe("sanitizeLayout", () => {
  test("ships a focused Home layout with portfolio, chat, and following research", () => {
    expect(DEFAULT_LAYOUT.instances.map((instance) => instance.instanceId)).toEqual([
      "portfolio-list:main",
      "ticker-detail:main",
      "chat:main",
    ]);
    expect(getDockedPaneIds(DEFAULT_LAYOUT)).toEqual([
      "portfolio-list:main",
      "chat:main",
      "ticker-detail:main",
    ]);
    expect(DEFAULT_LAYOUT.dockRoot).toMatchObject({
      kind: "split",
      axis: "horizontal",
      ratio: 0.34,
      first: {
        kind: "split",
        axis: "vertical",
        ratio: 0.6,
      },
      second: { kind: "pane", instanceId: "ticker-detail:main" },
    });
    expect(DEFAULT_LAYOUT.floating).toEqual([]);
  });

  test("keeps the default research layout free of retired chart settings", () => {
    const researchPanes = DEFAULT_LAYOUT.instances.filter((instance) => instance.paneId === "ticker-research");
    expect(researchPanes.length).toBeGreaterThan(0);
    for (const pane of researchPanes) {
      expect(pane.settings).not.toHaveProperty("chartRangePreset");
      expect(pane.settings).not.toHaveProperty("chartResolution");
      expect(pane.settings).not.toHaveProperty("chartAxisMode");
      expect(pane.settings).not.toHaveProperty("chartRenderMode");
    }
  });

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
      },
    });
  });

  test("converts retired chart panes into composer specs", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "comparison-chart:main" },
      instances: [{
        instanceId: "comparison-chart:main",
        paneId: "comparison-chart",
        binding: { kind: "none" },
        settings: {
          symbols: ["AAPL", "MSFT"],
          axisMode: "percent",
          rangePreset: "1Y",
          chartResolution: "1d",
        },
      }],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    const pane = findPaneInstance(layout, "comparison-chart:main");
    expect(pane?.paneId).toBe("chart-composer");
    expect(pane?.settings).toEqual({
      chartSpec: expect.objectContaining({
        version: 1,
        viewport: { range: "1Y", resolution: "1d" },
        series: [
          expect.objectContaining({
            transform: "percent",
            interpolation: "none",
            source: expect.objectContaining({ fieldId: "market.close" }),
          }),
          expect.objectContaining({
            transform: "percent",
            interpolation: "none",
            source: expect.objectContaining({ fieldId: "market.close" }),
          }),
        ],
      }),
    });
  });

  test("migrates ticker research chart settings into one composer spec", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "ticker-detail:aapl" },
      instances: [{
        instanceId: "ticker-detail:aapl",
        paneId: "ticker-research",
        binding: { kind: "fixed", symbol: "AAPL" },
        settings: {
          hideTabs: true,
          lockedTabId: "fundamental-graphs",
          chartAxisMode: "percent",
          chartRangePreset: "1Y",
          chartResolution: "1wk",
        },
      }],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    const settings = findPaneInstance(layout, "ticker-detail:aapl")?.settings;
    expect(settings).toEqual({
      hideTabs: true,
      lockedTabId: "chart",
      chartSpec: expect.objectContaining({
        version: 1,
        viewport: { range: "1Y", resolution: "1wk" },
        series: [expect.objectContaining({
          transform: "percent",
          interpolation: "none",
          source: expect.objectContaining({
            kind: "security",
            instrument: { symbol: "AAPL" },
            fieldId: "market.ohlcv",
          }),
        })],
      }),
    });
    expect(settings).not.toHaveProperty("chartAxisMode");
    expect(settings).not.toHaveProperty("chartRangePreset");
    expect(settings).not.toHaveProperty("chartResolution");
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
  test("folds saved graph plugin state into composer specs and removes only chart-owned state", async () => {
    const dataDir = await createTempConfigDir();
    const legacyLayout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "fundamental-graph:pair" },
        second: { kind: "pane" as const, instanceId: "ticker-detail:nvda" },
      },
      instances: [
        {
          instanceId: "fundamental-graph:pair",
          paneId: "fundamental-graph",
          binding: { kind: "fixed" as const, symbol: "AAPL" },
          settings: {
            chartKind: "fundamental",
            metric: "totalRevenue",
            period: "quarterly",
            periods: 8,
            symbols: ["AAPL", "MSFT"],
            symbolsText: "AAPL, MSFT",
          },
        },
        {
          instanceId: "ticker-detail:nvda",
          paneId: "ticker-research",
          binding: { kind: "fixed" as const, symbol: "NVDA" },
          settings: {
            hideTabs: true,
            lockedTabId: "fundamental-graphs",
            chartRangePreset: "1Y",
            chartResolution: "1wk",
          },
        },
      ],
      floating: [],
      detached: [],
    };
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 19,
      layout: legacyLayout,
      layouts: [{
        name: "Graphs",
        layout: legacyLayout,
        paneState: {
          "fundamental-graph:pair": {
            cursorSymbol: "AAPL",
            pluginState: {
              "ticker-detail": {
                period: "annual",
                chartKind: "valuation",
                metric: "evSales",
                periods: 3,
                selectedIdx: 4,
                hiddenSeriesIds: ["MSFT"],
                retainedPreference: "keep",
              },
            },
          },
          "ticker-detail:nvda": {
            activeTabId: "fundamental-graphs",
            financialSubTab: "cashflow",
            pluginState: {
              "ticker-detail": {
                detailPeriod: "annual",
                detailChartKind: "fundamental",
                detailMetric: "grossProfit",
                selectedIdx: 2,
                hiddenSeriesIds: [],
                retainedPreference: "keep-too",
              },
            },
          },
        },
      }],
      activeLayoutIndex: 0,
    }));

    const config = await loadConfig(dataDir);
    const standalone = findPaneInstance(config.layout, "fundamental-graph:pair");
    const standaloneSpec = standalone?.settings?.chartSpec as any;
    expect(standalone?.paneId).toBe("chart-composer");
    expect(standalone?.settings).toEqual({ chartSpec: expect.any(Object) });
    expect(standaloneSpec.viewport).toEqual({ range: "ALL", resolution: "auto", maxPoints: 3 });
    expect(standaloneSpec.series.map((series: any) => ({
      symbol: series.source.instrument.symbol,
      fieldId: series.source.fieldId,
      period: series.source.period,
      visible: series.visible,
    }))).toEqual([
      { symbol: "AAPL", fieldId: "valuation.evSales", period: "annual", visible: true },
      { symbol: "MSFT", fieldId: "valuation.evSales", period: "annual", visible: false },
    ]);

    const research = findPaneInstance(config.layout, "ticker-detail:nvda");
    const researchSpec = research?.settings?.chartSpec as any;
    expect(research?.settings?.lockedTabId).toBe("chart");
    expect(researchSpec.viewport).toEqual({ range: "ALL", resolution: "auto", maxPoints: undefined });
    expect(researchSpec.series[0]).toEqual(expect.objectContaining({
      style: "columns",
      source: expect.objectContaining({
        fieldId: "fundamental.grossProfit",
        period: "annual",
      }),
    }));

    expect(config.layouts[0]?.paneState).toEqual({
      "fundamental-graph:pair": {
        cursorSymbol: "AAPL",
        pluginState: { "ticker-research": { retainedPreference: "keep" } },
      },
      "ticker-detail:nvda": {
        activeTabId: "chart",
        financialSubTab: "cashflow",
        pluginState: { "ticker-research": { retainedPreference: "keep-too" } },
      },
    });
  });

  test("migrates global indicator selection and render mode without retaining plugin keys", async () => {
    const dataDir = await createTempConfigDir();
    const legacyLayout = {
      dockRoot: { kind: "pane" as const, instanceId: "ticker-chart:aapl" },
      instances: [{
        instanceId: "ticker-chart:aapl",
        paneId: "ticker-chart",
        binding: { kind: "fixed" as const, symbol: "AAPL" },
        settings: {
          chartAxisMode: "percent",
          chartRangePreset: "6M",
          chartResolution: "1d",
          chartRenderMode: "candles",
        },
      }],
      floating: [],
      detached: [],
    };
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 19,
      layout: legacyLayout,
      layouts: [{ name: "Price", layout: legacyLayout }],
      activeLayoutIndex: 0,
      chartPreferences: { renderer: "kitty", defaultRenderMode: "line" },
      pluginConfig: {
        "ticker-detail": {
          chartIndicators: ["sma50", "bollinger20"],
          chartIndicatorsVersion: 2,
          retainedPreference: "keep",
        },
      },
    }));

    const config = await loadConfig(dataDir);
    const pane = findPaneInstance(config.layout, "ticker-chart:aapl");
    const spec = pane?.settings?.chartSpec as any;
    expect(pane?.paneId).toBe("chart-composer");
    expect(spec.viewport).toEqual({ range: "6M", resolution: "1d" });
    expect(spec.series[0]).toEqual(expect.objectContaining({ style: "candles", transform: "raw" }));
    expect(spec.studies.map((study: any) => ({ kind: study.kind, parameters: study.parameters }))).toEqual([
      { kind: "sma", parameters: { period: 50 } },
      { kind: "bollinger", parameters: { period: 20, stdDev: 2 } },
    ]);
    expect(config.pluginConfig).toEqual({
      "ticker-research": { retainedPreference: "keep" },
    });
    expect(config.chartPreferences).toEqual({ renderer: "kitty" });
  });

  test("defaults detached layouts to an empty list for older configs", async () => {
    const dataDir = await createTempConfigDir();
    const layoutWithoutDetached = {
      ...DEFAULT_LAYOUT,
      detached: undefined,
    };
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 19,
      layout: layoutWithoutDetached,
      layouts: [{ name: "Default", layout: layoutWithoutDetached }],
    }));

    const config = await loadConfig(dataDir);

    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.layout.detached).toEqual([]);
    expect(config.layouts[0]?.layout.detached).toEqual([]);
  });

  test("migrates the retired security step and drops malformed onboarding progress", async () => {
    const validDir = await createTempConfigDir();
    await writeConfigJson(validDir, createSavedConfig({
      onboardingComplete: true,
      onboardingProgress: {
        version: 1,
        stage: "open-security",
        path: "manual",
        portfolioId: "main",
        tickerSymbol: "AAPL",
      },
    }));

    const validConfig = await loadConfig(validDir);
    expect(validConfig.onboardingComplete).toBe(false);
    expect(validConfig.onboardingProgress).toEqual({
      version: 1,
      stage: "account",
      path: "manual",
      portfolioId: "main",
      tickerSymbol: "AAPL",
      brokerName: undefined,
      positionsImported: undefined,
      accountStatus: undefined,
      checkoutOpenedAt: undefined,
    });

    const invalidDir = await createTempConfigDir();
    await writeConfigJson(invalidDir, createSavedConfig({
      onboardingProgress: { version: 1, stage: "unknown" },
    }));

    const invalidConfig = await loadConfig(invalidDir);
    expect(invalidConfig.onboardingProgress).toBeUndefined();
  });

  test("marks pre-onboarding configs complete so existing users skip the wizard", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 20,
      onboardingProgress: { version: 1, stage: "ready" },
    }));

    const config = await loadConfig(dataDir);

    expect(config.onboardingComplete).toBe(true);
    expect(config.onboardingProgress).toBeUndefined();
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
      renderer: "auto",
    });
  });

  test("sanitizes invalid chart renderer values back to auto", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 7,
      chartPreferences: {
        renderer: "nope",
      },
    }));

    const config = await loadConfig(dataDir);

    expect(config.chartPreferences).toEqual({
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
      chartPreferences: { renderer: "auto" },
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
      configVersion: 19,
      disabledPlugins: [
        "options",
        "sec",
        "thirteenf",
        "world-indices",
        "market-heatmap",
        "fear-greed",
        "chart-composer",
        "comparison-chart",
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
      configVersion: 19,
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
      configVersion: 19,
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

  test("runs the Cloud-to-Macro split only before its v15 boundary", async () => {
    const beforeDir = await createTempConfigDir();
    await writeConfigJson(beforeDir, createSavedConfig({
      configVersion: 14,
      disabledPlugins: ["gloomberb-cloud"],
      disabledSources: [],
    }));
    const before = await loadConfig(beforeDir);
    expect(before.disabledPlugins).toEqual(["gloomberb-cloud", "macro"]);
    expect(before.disabledSources).toEqual(["gloomberb-cloud"]);

    const atBoundaryDir = await createTempConfigDir();
    await writeConfigJson(atBoundaryDir, createSavedConfig({
      configVersion: 15,
      disabledPlugins: ["gloomberb-cloud"],
      disabledSources: [],
    }));
    const atBoundary = await loadConfig(atBoundaryDir);
    expect(atBoundary.disabledPlugins).toEqual(["gloomberb-cloud"]);
    expect(atBoundary.disabledSources).toEqual([]);
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

  test("migrates legacy saved pane tab IDs and preserves focus metadata", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 19,
      layouts: [{
        name: "Chart",
        layout: DEFAULT_LAYOUT,
        paneState: {
          "ticker-detail:main": {
            activeTabId: "fundamental-graphs",
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
          "ticker-research": { shared: "canonical" },
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
          "ticker-research": { shared: "canonical" },
        },
      },
    });
    expect(persisted.layouts[0]?.focusedPaneId).toBe("ticker-detail:main");
    expect(persisted.layouts[0]?.activePanel).toBe("right");
  });

  test("does not replay historical migrations for current configs or saves", async () => {
    const dataDir = await createTempConfigDir();
    const selectedPortfolioColumns = DEFAULT_COLUMNS.map((column) => column.id);
    const currentLayout = {
      ...DEFAULT_LAYOUT,
      instances: DEFAULT_LAYOUT.instances.map((instance) => (
        instance.instanceId === "ticker-detail:main"
          ? {
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              chartRangePreset: "6M",
              chartResolution: "1d",
            },
          }
          : instance.instanceId === "portfolio-list:main"
            ? {
              ...instance,
              settings: {
                ...(instance.settings ?? {}),
                columnIds: selectedPortfolioColumns,
              },
            }
          : instance
      )),
    };
    const legacyPaneState = {
      "ticker-detail:main": {
        activeTabId: "fundamental-graphs",
        pluginState: {
          "ticker-detail": { detailMetric: "revenue", shared: "legacy" },
          "ticker-research": { shared: "canonical" },
        },
      },
    };
    const legacyPluginConfig = {
      "ticker-detail": {
        chartIndicators: ["sma50"],
        chartIndicatorsVersion: 2,
        retainedPreference: "keep",
      },
    };
    await writeConfigJson(dataDir, createSavedConfig({
      layout: currentLayout,
      layouts: [{ name: "Current", layout: currentLayout, paneState: legacyPaneState }],
      pluginConfig: legacyPluginConfig,
      disabledPlugins: ["options", "gloomberb-cloud"],
      disabledSources: [],
    }));

    const config = await loadConfig(dataDir);
    expect(findPaneInstance(config.layout, "ticker-detail:main")?.settings).toEqual(expect.objectContaining({
      chartRangePreset: "6M",
      chartResolution: "1d",
    }));
    expect(config.layouts[0]?.paneState).toEqual(legacyPaneState);
    expect(config.pluginConfig).toEqual(legacyPluginConfig);
    expect(config.disabledPlugins).toEqual(["options", "gloomberb-cloud"]);
    expect(findPaneInstance(config.layout, "portfolio-list:main")?.settings?.columnIds)
      .toEqual(selectedPortfolioColumns);

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as typeof config;
    expect(persisted.layouts[0]?.paneState).toEqual(legacyPaneState);
    expect(persisted.pluginConfig).toEqual(legacyPluginConfig);
    expect(persisted.disabledPlugins).toEqual(["options", "gloomberb-cloud"]);
    expect(findPaneInstance(persisted.layout, "portfolio-list:main")?.settings?.columnIds)
      .toEqual(selectedPortfolioColumns);
    expect(findPaneInstance(persisted.layout, "ticker-detail:main")?.settings).toEqual(expect.objectContaining({
      chartRangePreset: "6M",
      chartResolution: "1d",
    }));
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

  test("does not replay the portfolio column migration at its v17 boundary", async () => {
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
      configVersion: 17,
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
    const expectedLayout = sanitizeLayout(DEFAULT_LAYOUT, DEFAULT_LAYOUT);
    expect(config.layout).toEqual(expectedLayout);

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as {
      configVersion: number;
      layouts: Array<{ name: string; layout: Record<string, unknown> }>;
      activeLayoutIndex: number;
    };

    expect(persisted.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(persisted.activeLayoutIndex).toBe(1);
    expect(persisted.layouts[1]?.layout).toEqual(JSON.parse(JSON.stringify(expectedLayout)));
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
