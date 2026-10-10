import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { exportConfig, importConfig, loadConfig, sanitizeLayout, saveConfig } from "./index";
import { normalizeLoadedConfig } from "./normalize";
import {
  CURRENT_CONFIG_VERSION,
  DEFAULT_LAYOUT,
  findPaneInstance,
  type AppConfig,
} from "../../../types/config";
import { getDockedPaneIds } from "../../../layout/pane-manager";
import { EXTRACTED_PLUGINS, seedExtractedPlugins } from "../../../plugins/extracted-plugins";

const tempDirs: string[] = [];
const originalGloomberbHome = process.env.GLOOMBERB_HOME;

afterEach(async () => {
  if (originalGloomberbHome === undefined) delete process.env.GLOOMBERB_HOME;
  else process.env.GLOOMBERB_HOME = originalGloomberbHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempConfigDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-config-"));
  tempDirs.push(dataDir);
  return dataDir;
}

/** A migration can look for plugin checkouts: give it these rather than the real ones. */
async function usePluginCheckouts(...directories: string[]): Promise<void> {
  const home = await createTempConfigDir();
  for (const directory of directories) await mkdir(join(home, "plugins", directory), { recursive: true });
  process.env.GLOOMBERB_HOME = home;
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

test("recent panes survive a save and reload", async () => {
  const dataDir = await createTempConfigDir();
  const loaded = await loadConfig(dataDir);
  await saveConfig({
    ...loaded,
    recentCommands: [
      { id: "pane-template:ticker-news-pane", label: "Ticker News", arg: "AAPL" },
      { id: "pane-template:chart", label: "Chart" },
      { id: "blank-arg", label: "Blank", arg: "" },
      { id: "", label: "drop" },
    ],
  });
  expect((await loadConfig(dataDir)).recentCommands).toEqual([
    { id: "pane-template:ticker-news-pane", label: "Ticker News", arg: "AAPL" },
    { id: "pane-template:chart", label: "Chart" },
    { id: "blank-arg", label: "Blank" },
  ]);
});

test("a portfolio's cash and target weights survive a save and reload, and malformed ones are dropped", async () => {
  const dataDir = await createTempConfigDir();
  await writeConfigJson(dataDir, createSavedConfig({
    portfolios: [
      { id: "main", name: "Main", currency: "USD", cash: { amount: 500_000, currency: "USD" }, targetWeights: { VTI: 60, CASH: 40 } },
      { id: "bad", name: "Bad", currency: "USD", cash: { amount: "lots", currency: "USD" }, targetWeights: { VTI: 140, GLD: -1, BIL: "ten" } },
    ],
  }));
  const loaded = await loadConfig(dataDir);
  await saveConfig(loaded);
  const [main, bad] = (await loadConfig(dataDir)).portfolios;
  expect(main).toEqual({ id: "main", name: "Main", currency: "USD", cash: { amount: 500_000, currency: "USD" }, targetWeights: { VTI: 60, CASH: 40 } });
  expect(bad).toEqual({ id: "bad", name: "Bad", currency: "USD" });
});

test("the star prompt's record and off switch survive a save and reload, and junk is dropped", async () => {
  const dataDir = await createTempConfigDir();
  await writeConfigJson(dataDir, createSavedConfig({
    starPrompt: { enabled: false, days: ["2026-10-01", "2026-10-01", "yesterday", 3, "2026-10-02"], outcome: "starred" },
  }));
  const loaded = await loadConfig(dataDir);
  expect(loaded.starPrompt).toEqual({ enabled: false, days: ["2026-10-01", "2026-10-02"] });

  await saveConfig({ ...loaded, starPrompt: { shownAt: "2026-10-03T09:00:00.000Z", outcome: "dismissed" } });
  expect((await loadConfig(dataDir)).starPrompt).toEqual({ shownAt: "2026-10-03T09:00:00.000Z", outcome: "dismissed" });

  await saveConfig({ ...loaded, starPrompt: {} });
  const saved = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
  expect("starPrompt" in saved).toBe(false);
});

test("fresh installs skip plugin restoration across config reloads", async () => {
  const dataDir = await createTempConfigDir();
  const fresh = await loadConfig(dataDir);
  await saveConfig(fresh);
  const reloaded = await loadConfig(dataDir);
  const installed: string[] = [];
  await seedExtractedPlugins(reloaded, async (ref) => { installed.push(ref); }, dataDir);
  expect(installed).toEqual([]);
  expect(reloaded.seededPlugins).toEqual(EXTRACTED_PLUGINS.map((plugin) => plugin.id));
});

test("existing users retain pending and completed plugin migrations", async () => {
  const dataDir = await createTempConfigDir();
  await writeConfigJson(dataDir, createSavedConfig());
  expect((await loadConfig(dataDir)).seededPlugins).toEqual([]);
  await writeConfigJson(dataDir, createSavedConfig({ seededPlugins: ["substack", "substack", 42] }));
  const loaded = await loadConfig(dataDir);
  expect(loaded.seededPlugins).toEqual(["substack"]);
  await saveConfig(loaded);
  expect((await loadConfig(dataDir)).seededPlugins).toEqual(["substack"]);
});

describe("sanitizeLayout", () => {
  test("disk reload keeps explicit public and broker selections for fixed panes and their followers", async () => {
    const dataDir = await createTempConfigDir();
    const selections = [
      { kind: "fixed", symbol: "ASML:XAMS", instrument: null, listing: { name: "ASML", exchange: "AMS", currency: "EUR", type: "EQUITY" } },
      { kind: "fixed", symbol: "ES", instrument: { brokerId: "ibkr", brokerInstanceId: "retirement", conId: 123, symbol: "ES", localSymbol: "ESZ6", secType: "FUT", exchange: "CME", primaryExchange: "CME", currency: "USD", lastTradeDateOrContractMonth: "20261218", multiplier: "50", tradingClass: "ES" } },
      { kind: "fixed", symbol: "SPY", instrument: { brokerId: "ibkr", brokerInstanceId: "taxable", symbol: "SPY", secType: "OPT", exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: "20260918", right: "P", strike: 700, multiplier: "100" } },
    ];
    const layout = { dockRoot: null, instances: [
      ...selections.map((binding, i) => ({ instanceId: `ticker-research:${i}`, paneId: "ticker-research", binding })),
      { instanceId: "follower", paneId: "chart-composer", binding: { kind: "follow", sourceInstanceId: "ticker-research:1" } },
    ], floating: [...selections.map((_, i) => `ticker-research:${i}`), "follower"].map(instanceId => ({ instanceId, x: 0, y: 0, width: 80, height: 24 })), detached: [] };
    await writeConfigJson(dataDir, createSavedConfig({ layout, layouts: [{ name: "Contracts", layout }] }));
    const loaded = await loadConfig(dataDir);
    await saveConfig(loaded);
    const reopened = await loadConfig(dataDir);
    expect(reopened.layout.instances.map(pane => pane.binding)).toEqual(layout.instances.map(pane => pane.binding));
    expect(reopened.layouts[0]?.layout.instances.map(pane => pane.binding)).toEqual(layout.instances.map(pane => pane.binding));
  });

  test("preserves an intentionally blank layout", () => {
    expect(sanitizeLayout({
      dockRoot: null,
      instances: [],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT)).toEqual({
      dockRoot: null,
      instances: [],
      floating: [],
      detached: [],
    });
  });

  test("keeps the pane lock across a save/load round trip", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "portfolio-list:locked" },
      instances: [
        {
          instanceId: "portfolio-list:locked",
          paneId: "portfolio-list",
          binding: { kind: "none" },
          locked: true,
        },
      ],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(layout.instances[0]?.locked).toBe(true);
  });

  test("prunes abandoned panes while retaining a hidden follow source", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "ticker-research:visible" },
      instances: [
        {
          instanceId: "portfolio-list:source",
          paneId: "portfolio-list",
          binding: { kind: "none" },
        },
        {
          instanceId: "ticker-research:visible",
          paneId: "ticker-research",
          binding: { kind: "follow", sourceInstanceId: "portfolio-list:source" },
        },
        {
          instanceId: "ticker-research:closed",
          paneId: "ticker-research",
          binding: { kind: "fixed", symbol: "NVDA" },
        },
      ],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(layout.instances.map((instance) => instance.instanceId)).toEqual([
      "portfolio-list:source",
      "ticker-research:visible",
    ]);
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

  test("keeps a ticker research pane safely unlinked when its source is missing", () => {
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

    expect(findPaneInstance(layout, "ticker-detail:main")?.binding).toEqual({ kind: "none" });
    expect(getDockedPaneIds(layout)).toEqual(["ticker-detail:main"]);
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
    }, DEFAULT_LAYOUT, { migrateLegacy: true });

    const pane = findPaneInstance(layout, "comparison-chart:main");
    expect(pane?.paneId).toBe("chart-composer");
    expect(pane?.settings).toEqual({
      chartSpec: expect.objectContaining({
        version: 2,
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
    }, DEFAULT_LAYOUT, { migrateLegacy: true });

    const settings = findPaneInstance(layout, "ticker-detail:aapl")?.settings;
    expect(settings).toEqual({
      hideTabs: true,
      lockedTabId: "chart",
      chartSpec: expect.objectContaining({
        version: 2,
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

  test("does not convert legacy chart settings during ordinary sanitization", () => {
    const layout = sanitizeLayout({
      dockRoot: { kind: "pane", instanceId: "ticker-detail:aapl" },
      instances: [{
        instanceId: "ticker-detail:aapl",
        paneId: "ticker-research",
        binding: { kind: "fixed", symbol: "AAPL" },
        settings: {
          chartRangePreset: "1Y",
          chartResolution: "1wk",
        },
      }],
      floating: [],
      detached: [],
    }, DEFAULT_LAYOUT);

    expect(findPaneInstance(layout, "ticker-detail:aapl")?.settings).toEqual({
      chartRangePreset: "1Y",
      chartResolution: "1wk",
    });
  });
});

describe("loadConfig", () => {
  test("migrates unreachable pane instances and their saved state", async () => {
    const dataDir = await createTempConfigDir();
    const hiddenPaneId = "ticker-research:closed";
    const legacyLayout = {
      ...DEFAULT_LAYOUT,
      instances: [
        ...DEFAULT_LAYOUT.instances.map((instance) => instance.instanceId === "chat:main"
          ? {
            ...instance,
            placementMemory: {
              docked: {
                anchorInstanceId: hiddenPaneId,
                position: "right" as const,
              },
            },
          }
          : instance),
        {
          instanceId: hiddenPaneId,
          paneId: "ticker-research",
          binding: { kind: "fixed" as const, symbol: "NVDA" },
          placementMemory: { floating: { x: 12, y: 4, width: 90, height: 30 } },
        },
      ],
    };
    await writeConfigJson(dataDir, createSavedConfig({
      configVersion: 21,
      layout: legacyLayout,
      layouts: [{
        name: "Default",
        layout: legacyLayout,
        paneState: {
          "chat:main": { draft: "keep" },
          [hiddenPaneId]: { activeTabId: "overview" },
        },
        focusedPaneId: hiddenPaneId,
      }],
    }));

    const config = await loadConfig(dataDir);

    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.layout.instances.some((instance) => instance.instanceId === hiddenPaneId)).toBe(false);
    expect(config.layouts[0]?.layout.instances.some((instance) => instance.instanceId === hiddenPaneId)).toBe(false);
    expect(config.layouts[0]?.paneState).toEqual({ "chat:main": { draft: "keep" } });
    expect(config.layouts[0]?.focusedPaneId).toBeNull();
    expect(findPaneInstance(config.layout, "chat:main")?.placementMemory?.docked).toEqual({
      anchorInstanceId: undefined,
      path: undefined,
      position: "right",
    });
  });

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

  test("keeps keybinding overrides, including ones that do not parse, and drops junk shapes", async () => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({
      keybindings: {
        actions: { "ticker-search": ["Ctrl+T", 7], help: null, "command-bar": "Bogus+P", "": "F1", quit: 3 },
        commands: { "Alt+1": "DES AAPL", F5: "", F6: 12 },
        extra: true,
      },
    }));

    const config = await loadConfig(dataDir);
    expect(config.keybindings).toEqual({
      actions: { "ticker-search": ["Ctrl+T"], help: null, "command-bar": "Bogus+P" },
      commands: { "Alt+1": "DES AAPL" },
    });

    await saveConfig({ ...config, keybindings: { actions: {}, commands: {} } });
    const saved = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
    expect("keybindings" in saved).toBe(false);

    const emptyDir = await createTempConfigDir();
    await writeConfigJson(emptyDir, createSavedConfig({ keybindings: "Ctrl+T" }));
    expect((await loadConfig(emptyDir)).keybindings).toBeUndefined();
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

  const layoutWithoutDetached = { ...DEFAULT_LAYOUT, detached: undefined };
  const defaultFillCases: Array<{
    name: string;
    patch: Record<string, unknown>;
    select: (config: AppConfig) => unknown;
    expected: unknown;
  }> = [
    {
      name: "defaults detached layouts to an empty list for older configs",
      patch: {
        configVersion: 19,
        layout: layoutWithoutDetached,
        layouts: [{ name: "Default", layout: layoutWithoutDetached }],
      },
      select: (config) => [config.layout.detached, config.layouts[0]?.layout.detached],
      expected: [[], []],
    },
    {
      name: "fills in missing chart preferences for older configs",
      patch: { configVersion: 5, chartPreferences: undefined },
      select: (config) => config.chartPreferences,
      expected: { renderer: "auto" },
    },
    {
      name: "sanitizes invalid chart renderer values back to auto",
      patch: { configVersion: 7, chartPreferences: { renderer: "nope" } },
      select: (config) => [config.chartPreferences, config.pluginConfig],
      expected: [{ renderer: "auto" }, {}],
    },
    {
      name: "defaults value flashing on",
      patch: { configVersion: 16, valueFlashingEnabled: undefined },
      select: (config) => config.valueFlashingEnabled,
      expected: true,
    },
    {
      name: "preserves an explicit value flashing off setting",
      patch: { valueFlashingEnabled: false },
      select: (config) => config.valueFlashingEnabled,
      expected: false,
    },
    {
      name: "preserves plugin config state from disk",
      patch: { configVersion: 7, pluginConfig: { news: { displayMode: "expanded" } } },
      select: (config) => config.pluginConfig,
      expected: { news: { displayMode: "expanded" } },
    },
  ];

  test.each(defaultFillCases)("$name", async ({ patch, select, expected }) => {
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig(patch));

    expect(select(await loadConfig(dataDir))).toEqual(expected);
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
    await usePluginCheckouts();
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
      // Each module went with its pane when Ticker Research and Market
      // Overview were split, so it no longer turns off the rest of its old
      // plugin either.
      "options-volatility",
      "filings",
      "ownership",
      "global-markets",
      // Their own built-ins now, so a legacy id means the plugin of that name
      // rather than the built-in that used to contain it.
      "market-heatmap",
      "fear-greed",
      "ticker-core",
      // The earnings calendar went to Earnings when Macro was split, while TV
      // left for its own repository, so turning it off still means all of Macro.
      "earnings",
      "rates-macro",
      "credit",
      "ibkr",
      "broker",
      "portfolio",
      // Built in again, and off like the rest of Macro.
      "ipo-calendar",
    ]);
  });

  /**
   * Market Heatmap, Market Halts and Fear & Greed were Market Overview
   * modules, then plugins the seeder did not install while Market Overview
   * was off. Built in again, they would come back on under their own ids.
   */
  test("keeps the absorbed Market Overview modules off where Market Overview was off", async () => {
    // Installed by hand since, so wanted, and loaded as the built-in now.
    await usePluginCheckouts("gloom-market-heatmap");
    const dataDir = await createTempConfigDir();
    const saved = createSavedConfig({ configVersion: 22, disabledPlugins: ["market-overview"] });
    await writeConfigJson(dataDir, saved);

    const marketOverview = ["global-markets", "screeners", "futures-commodities", "crypto", "alt-data", "quant"];
    const migrated = await loadConfig(dataDir);
    expect(migrated.disabledPlugins).toEqual([...marketOverview, "market-halts", "fear-greed"]);
    // The web bundled all three whatever Market Overview said.
    expect(normalizeLoadedConfig(saved, dataDir).config.disabledPlugins).toEqual(marketOverview);

    // Switched on since, then saved by an older build, which writes its own
    // configVersion back: the migration runs again but leaves them on.
    await saveConfig({ ...migrated, disabledPlugins: marketOverview });
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as Record<string, unknown>;
    expect(persisted.disabledPlugins).toEqual(["market-overview"]);
    await writeConfigJson(dataDir, { ...persisted, configVersion: 22 });
    expect((await loadConfig(dataDir)).disabledPlugins).toEqual(marketOverview);
  });

  /** The IPO Calendar was a Macro module, then a plugin the seeder skipped while Macro was off. */
  test("keeps the IPO Calendar off where Macro was off, unless a copy was installed since", async () => {
    await usePluginCheckouts();
    const dataDir = await createTempConfigDir();
    await writeConfigJson(dataDir, createSavedConfig({ configVersion: 22, disabledPlugins: ["macro"] }));
    expect((await loadConfig(dataDir)).disabledPlugins).toEqual(["rates-macro", "credit", "earnings", "ipo-calendar"]);

    // Saved at 23 by a build that absorbed only the Market Overview modules.
    const afterMarketOverview = await createTempConfigDir();
    await writeConfigJson(afterMarketOverview, createSavedConfig({
      configVersion: 23,
      disabledPlugins: ["macro"],
      seededPlugins: ["absorbed:market-heatmap", "absorbed:market-halts", "absorbed:fear-greed"],
    }));
    expect((await loadConfig(afterMarketOverview)).disabledPlugins).toEqual(["rates-macro", "credit", "earnings", "ipo-calendar"]);

    await usePluginCheckouts("gloom-ipo-calendar");
    const installed = await createTempConfigDir();
    await writeConfigJson(installed, createSavedConfig({ configVersion: 22, disabledPlugins: ["macro"] }));
    expect((await loadConfig(installed)).disabledPlugins).toEqual(["rates-macro", "credit", "earnings"]);
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

  test("enables Gloom Cloud only for configs saved before it became the default", async () => {
    const beforeDir = await createTempConfigDir();
    await writeConfigJson(beforeDir, createSavedConfig({
      configVersion: 12,
      disabledPlugins: ["gloomberb-cloud", "news"],
    }));
    expect((await loadConfig(beforeDir)).disabledPlugins).toEqual(["news"]);

    const atBoundaryDir = await createTempConfigDir();
    await writeConfigJson(atBoundaryDir, createSavedConfig({
      configVersion: 13,
      disabledPlugins: ["gloomberb-cloud"],
    }));
    expect((await loadConfig(atBoundaryDir)).disabledPlugins).toEqual(["gloomberb-cloud"]);
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
    expect(config.layouts[0]).not.toHaveProperty("activePanel");

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as {
      layouts: Array<{ paneState?: Record<string, unknown>; focusedPaneId?: string | null }>;
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
    expect(persisted.layouts[0]).not.toHaveProperty("activePanel");
  });

  test("does not replay historical migrations for current configs or saves", async () => {
    const dataDir = await createTempConfigDir();
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

    await saveConfig(config);
    const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf-8")) as typeof config;
    expect(persisted.layouts[0]?.paneState).toEqual(legacyPaneState);
    expect(persisted.pluginConfig).toEqual(legacyPluginConfig);
    expect(persisted.disabledPlugins).toEqual(["options", "gloomberb-cloud"]);
    expect(findPaneInstance(persisted.layout, "ticker-detail:main")?.settings).toEqual(expect.objectContaining({
      chartRangePreset: "6M",
      chartResolution: "1d",
    }));
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
