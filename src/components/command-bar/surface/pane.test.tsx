import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { AppAction, AppState } from "../../../state/app/context";
import { cloneLayout, type AppConfig } from "../../../types/config";
import type { PaneTemplateCreateOptions, WizardStep } from "../../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
  makeQuoteMonitorPaneSettingsDescriptor,
  makeTicker,
} from "./test-harness";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

const { waitForFrameToContain, clickFrameText, renderFrames } = createCommandBarTestControls(() => testSetup!);

type CreatedPaneCall = { templateId: string; options?: PaneTemplateCreateOptions };

type MutablePaneRegistry = {
  panes: ReadonlyMap<string, unknown>;
  paneTemplates: ReadonlyMap<string, unknown>;
};

type PaneCreationRegistry = {
  createPaneFromTemplateAsyncFn: (templateId: string, options?: PaneTemplateCreateOptions) => unknown;
};

function mutableRegistryMap(map: ReadonlyMap<string, unknown>): Map<string, unknown> {
  return map as Map<string, unknown>;
}

function recordPaneCreations(pluginRegistry: PaneCreationRegistry, created: CreatedPaneCall[]): void {
  pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
    created.push({ templateId, options });
  };
}

function registerComparisonChartPane(
  pluginRegistry: MutablePaneRegistry,
  options: {
    wizard?: WizardStep[];
    canCreate?: (_context: unknown, options?: { symbols?: string[] | null }) => boolean;
  } = {},
): void {
  mutableRegistryMap(pluginRegistry.panes).set("comparison-chart", {
    id: "comparison-chart",
    name: "Comparison Chart",
    component: () => null,
    defaultPosition: "right",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("comparison-chart-pane", {
    id: "comparison-chart-pane",
    paneId: "comparison-chart",
    label: "Comparison Chart",
    description: "Compare multiple symbols in one pane",
    shortcut: { prefix: "CMP", argPlaceholder: "tickers", argKind: "ticker-list" },
    ...options,
  });
}

const AI_SCREENER_WIZARD: WizardStep[] = [
  {
    key: "providerId",
    label: "AI Provider",
    type: "select",
    defaultValue: "claude",
    options: [{ label: "Claude", value: "claude" }],
  },
  {
    key: "prompt",
    label: "Screener Prompt",
    type: "textarea",
  },
];

function registerAiScreenerPane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("ai-screener", {
    id: "ai-screener",
    name: "AI Screener",
    component: () => null,
    defaultPosition: "right",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("new-ai-screener-pane", {
    id: "new-ai-screener-pane",
    paneId: "ai-screener",
    label: "AI Screener",
    description: "Create a prompt-driven screener pane.",
    shortcut: { prefix: "AI", argPlaceholder: "prompt", argKind: "text" },
    wizard: AI_SCREENER_WIZARD,
  });
}

function registerLocalAiWorkspacePane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("local-agent-workspace", {
    id: "local-agent-workspace",
    name: "Local AI",
    component: () => null,
    defaultPosition: "right",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("new-local-agent-workspace", {
    id: "new-local-agent-workspace",
    paneId: "local-agent-workspace",
    label: "Local AI Workspace",
    description: "Create a persistent local AI research thread.",
    keywords: ["ai", "agent", "local", "research", "thread"],
    shortcut: { prefix: "AGENT" },
    wizard: [{
      key: "providerId",
      label: "Local Runtime",
      type: "select",
      defaultValue: "claude",
      options: [{ label: "Claude", value: "claude" }],
    }],
  });
}

function registerOptionalTextPane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("optional-search", {
    id: "optional-search",
    name: "Optional Search",
    component: () => null,
    defaultPosition: "right",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("optional-search-pane", {
    id: "optional-search-pane",
    paneId: "optional-search",
    label: "Optional Search",
    description: "Open with an optional text query.",
    shortcut: { prefix: "OPT", argPlaceholder: "query", argKind: "text", argOptional: true },
  });
}

function registerOptionalTickerPane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("optional-ticker", {
    id: "optional-ticker",
    name: "Optional Ticker",
    component: () => null,
    defaultPosition: "right",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("optional-ticker-pane", {
    id: "optional-ticker-pane",
    paneId: "optional-ticker",
    label: "Optional Ticker",
    description: "Open market-wide or for one ticker.",
    shortcut: { prefix: "OT", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
  });
}

function registerQueryOnlyPane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("prediction-markets", {
    id: "prediction-markets",
    name: "Prediction Markets",
    component: () => null,
    defaultPosition: "left",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("new-prediction-markets-pane", {
    id: "new-prediction-markets-pane",
    paneId: "prediction-markets",
    label: "Prediction Markets",
    description: "Open a new prediction markets browser pane",
    keywords: ["prediction", "markets", "polymarket", "kalshi", "events"],
    shortcut: { prefix: "PM", argPlaceholder: "query", argKind: "text" },
  });
}

function registerShortcutOnlyPane(pluginRegistry: MutablePaneRegistry): void {
  mutableRegistryMap(pluginRegistry.panes).set("top-news", {
    id: "top-news",
    name: "Top News",
    component: () => null,
    defaultPosition: "right",
    defaultMode: "floating",
  });
  mutableRegistryMap(pluginRegistry.paneTemplates).set("top-news-pane", {
    id: "top-news-pane",
    paneId: "top-news",
    label: "Top News",
    description: "Curated top market stories ranked by importance",
    keywords: ["top", "news", "headlines", "stories"],
    shortcut: { prefix: "TOP" },
  });
}

describe("CommandBar pane and layout routes", () => {
  const layoutModeConfig = (config: AppConfig): AppConfig => {
    const research = cloneLayout(config.layout);
    research.dockRoot = { kind: "pane", instanceId: "portfolio-list:main" };
    research.floating = [{ instanceId: "ticker-detail:main", x: 8, y: 2, width: 36, height: 12 }];
    return {
      ...config,
      layouts: [
        { name: "Default", layout: cloneLayout(config.layout) },
        { name: "Research", layout: research },
      ],
    };
  };

  const layoutModeState = (state: AppState): AppState => ({
    ...state,
    layoutHistory: {
      0: {
        past: [cloneLayout(state.config.layout)],
        future: [],
      },
    },
  });

  test("renders layout mode with focused pane actions", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="LAY "
      configureConfig={layoutModeConfig}
      configureState={layoutModeState}
    />, {
      width: 90,
      height: 28,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Focused Pane");
    expect(frame).toContain("Float Pane");
    expect(frame).toContain("Undo Layout Change");
    expect(frame).toContain("Current Layout");
    expect(frame).toContain("Close All Floating Panes");
  });

  test("runs layout actions directly from root search", async () => {
    const actions: AppAction[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="undo layout change"
      live
      configureConfig={layoutModeConfig}
      configureState={layoutModeState}
      onAction={(action) => actions.push(action)}
    />, {
      width: 90,
      height: 24,
    });

    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("Undo Layout Change");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    expect(actions.some((action) => action.type === "UNDO_LAYOUT")).toBe(true);
  });

  test("renders filtered saved layouts with textual previews", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="LAY Research"
      configureConfig={layoutModeConfig}
      configureState={layoutModeState}
    />, {
      width: 120,
      height: 18,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Research");
    expect(frame).toContain("1c / 1d");
  });

  test("filters plugin-defined pane templates directly from the root query", async () => {
    testSetup = await testRender(<CommandBarHarness query="chat" />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Chat");
    expect(frame).not.toContain("float");
  });

  test("shows pane shortcuts in the default browse results", async () => {
    testSetup = await testRender(<CommandBarHarness query="" selectedTicker="AAPL" />, {
      width: 100,
      height: 24,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Panes");
    expect(frame).toContain("Quote Monitor");
    expect(frame).toContain("QQ");
  });

  test("matches direct pane shortcut queries", async () => {
    testSetup = await testRender(<CommandBarHarness query="QQ MSFT" selectedTicker="AAPL" />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor");
    expect(frame).toContain("QQ");
  });

  test("keeps related pane matches visible beside a bare shortcut", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="AI"
      configurePluginRegistry={(pluginRegistry) => {
        registerAiScreenerPane(pluginRegistry);
        registerLocalAiWorkspacePane(pluginRegistry);
      }}
    />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("AI Screener");
    expect(frame).toContain("Local AI Workspace");
    expect(frame).toContain("AGENT");
    expect(frame.indexOf("AI Screener")).toBeLessThan(frame.indexOf("Local AI Workspace"));
  });

  test("executes optional text pane shortcuts without opening the generated form", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="OPT"
      live
      configurePluginRegistry={(pluginRegistry) => {
        registerOptionalTextPane(pluginRegistry);
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{ templateId: "optional-search-pane", options: undefined }]);
    expect(testSetup.captureCharFrame()).not.toContain("Create Pane");
  });

  test("keeps an optional ticker shortcut market-wide when a ticker is active", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="OT"
      selectedTicker="AAPL"
      live
      configurePluginRegistry={(pluginRegistry) => {
        registerOptionalTickerPane(pluginRegistry);
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{ templateId: "optional-ticker-pane", options: undefined }]);
  });

  for (const scenario of [
    {
      query: "prediction markets",
      register: registerQueryOnlyPane,
      templateId: "new-prediction-markets-pane",
    },
    {
      query: "top news",
      register: registerShortcutOnlyPane,
      templateId: "top-news-pane",
    },
  ] as const) {
    test(`creates ${scenario.templateId} directly when it has no config fields`, async () => {
      const created: CreatedPaneCall[] = [];

      testSetup = await testRender(<CommandBarHarness
        query={scenario.query}
        live
        configurePluginRegistry={(pluginRegistry) => {
          scenario.register(pluginRegistry);
          recordPaneCreations(pluginRegistry, created);
        }}
      />, {
        width: 100,
        height: 18,
      });

      await testSetup.renderOnce();

      await act(async () => {
        testSetup!.mockInput.pressEnter();
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });

      expect(created).toEqual([{ templateId: scenario.templateId, options: undefined }]);
      expect(testSetup.captureCharFrame()).not.toContain("Create Pane");
    });
  }

  test("shows pane templates that share the same shortcut", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="DUP"
      configurePluginRegistry={(pluginRegistry) => {
        const paneTemplates = pluginRegistry.paneTemplates as Map<string, any>;
        paneTemplates.set("first-duplicate-pane", {
          id: "first-duplicate-pane",
          paneId: "first-duplicate",
          label: "First Duplicate",
          description: "First pane using a shared shortcut",
          shortcut: { prefix: "DUP" },
        });
        paneTemplates.set("second-duplicate-pane", {
          id: "second-duplicate-pane",
          paneId: "second-duplicate",
          label: "Second Duplicate",
          description: "Second pane using a shared shortcut",
          shortcut: { prefix: "DUP" },
        });
      }}
    />, {
      width: 100,
      height: 18,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("First Duplicate");
    expect(frame).toContain("Second Duplicate");
  });

  test("QQ MSFT executes directly without opening a secondary workflow", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="QQ MSFT"
      selectedTicker="AAPL"
      configurePluginRegistry={(pluginRegistry) => {
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "quote-monitor-pane",
      options: {
        arg: "MSFT",
        symbols: ["MSFT"],
      },
    }]);
  });

  test("QQ AAPL,MSFT creates a multi-symbol quote monitor directly", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="QQ AAPL,MSFT"
      selectedTicker="AAPL"
      configurePluginRegistry={(pluginRegistry) => {
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "quote-monitor-pane",
      options: {
        arg: "AAPL,MSFT",
        symbols: ["AAPL", "MSFT"],
      },
    }]);
  });

  test("CMP AAPL,MSFT creates the comparison chart directly", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="CMP AAPL,MSFT"
      configurePluginRegistry={(pluginRegistry) => {
        registerComparisonChartPane(pluginRegistry);
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "comparison-chart-pane",
      options: {
        arg: "AAPL,MSFT",
        symbols: ["AAPL", "MSFT"],
      },
    }]);
  });

  test("CMP AAPL, opens inline completion when the ticker list is incomplete", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="CMP AAPL,"
      configurePluginRegistry={(pluginRegistry) => {
        registerComparisonChartPane(pluginRegistry);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Comparison Chart");
    expect(frame).toContain("Tickers");
    expect(frame).toContain("AAPL,");
  });

  test("CMP with one resolved ticker opens inline completion instead of creating a one-symbol chart", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="CMP AMD"
      extraTickers={[makeTicker("AMD", "Advanced Micro Devices")]}
      configurePluginRegistry={(pluginRegistry) => {
        registerComparisonChartPane(pluginRegistry, {
          wizard: [{ key: "tickers", label: "Tickers", type: "text" }],
          canCreate: (_context: unknown, options?: { symbols?: string[] | null }) => !options?.symbols || options.symbols.length >= 2,
        });
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("Tickers");
    expect(created).toEqual([]);
    expect(frame).toContain("Comparison Chart");
    expect(frame).toContain("AMD");
  });

  test("AI <prompt> opens the inline workflow and prefills the textarea prompt", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="AI quality compounders"
      configurePluginRegistry={(pluginRegistry) => {
        registerAiScreenerPane(pluginRegistry);
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 24,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("AI Screener");
    expect(frame).toContain("AI Provider");
    expect(frame).toContain("quality compounders");
    expect(created).toEqual([]);
  });

  test("submits typed AI screener prompts from the textarea field", async () => {
    const created: CreatedPaneCall[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="AI"
      configurePluginRegistry={(pluginRegistry) => {
        registerAiScreenerPane(pluginRegistry);
        recordPaneCreations(pluginRegistry, created);
      }}
    />, {
      width: 100,
      height: 24,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("humanoid robot suppliers");
      await testSetup!.renderOnce();
    });
    await clickFrameText("Create Pane");
    await act(async () => {
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "new-ai-screener-pane",
      options: {
        arg: "humanoid robot suppliers",
        values: {
          providerId: "claude",
          prompt: "humanoid robot suppliers",
        },
      },
    }]);
  });

  test("edits pane settings inline inside the command bar", async () => {
    const appliedValues: Array<{ paneId: string; key: string; value: unknown }> = [];

    testSetup = await testRender(<CommandBarHarness
      query="PS"
      configureState={(state) => ({
        ...state,
        focusedPaneId: "quote-monitor:main",
      })}
      hasPaneSettings={(paneId) => paneId === "quote-monitor:main"}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.resolvePaneSettings = () => makeQuoteMonitorPaneSettingsDescriptor(pluginRegistry, [{
          key: "symbol",
          label: "Symbol",
          type: "text",
          description: "Ticker symbol to track",
        }]);
        pluginRegistry.applyPaneSettingValueFn = async (paneId, field, value) => {
          appliedValues.push({ paneId, key: field.key, value });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");
    expect(frame).toContain("Symbol");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    frame = testSetup.captureCharFrame();
    await clickFrameText("Symbol");
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Apply");
    expect(frame).toContain("Symbol");

    await act(async () => {
      await testSetup!.mockInput.typeText("MSFT");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(appliedValues).toEqual([{
      paneId: "quote-monitor:main",
      key: "symbol",
      value: "MSFT",
    }]);
  });

  test("clears the root shortcut query when opening pane settings and nested pickers", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="PS"
      configureState={(state) => ({
        ...state,
        focusedPaneId: "quote-monitor:main",
      })}
      hasPaneSettings={(paneId) => paneId === "quote-monitor:main"}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.resolvePaneSettings = () => makeQuoteMonitorPaneSettingsDescriptor(pluginRegistry, [{
          key: "range",
          label: "Range",
          type: "select",
          options: [
            { label: "1M", value: "1M" },
            { label: "1Y", value: "1Y" },
          ],
        }]);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await renderFrames();
    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");
    expect(frame).not.toContain("PS");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await renderFrames();
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("1M");
    expect(frame).toContain("1Y");
    expect(frame).not.toContain("No matches");
    expect(frame).not.toContain("PS");
  });

  test("opens focused pane settings directly from root search", async () => {
    const appliedValues: Array<{ paneId: string; key: string; value: unknown }> = [];

    testSetup = await testRender(<CommandBarHarness
      query="ticker symbol"
      configureState={(state) => ({
        ...state,
        focusedPaneId: "quote-monitor:main",
      })}
      hasPaneSettings={(paneId) => paneId === "quote-monitor:main"}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.resolvePaneSettings = () => makeQuoteMonitorPaneSettingsDescriptor(pluginRegistry, [{
          key: "symbol",
          label: "Symbol",
          type: "text",
          description: "Ticker symbol to track",
        }]);
        pluginRegistry.applyPaneSettingValueFn = async (paneId, field, value) => {
          appliedValues.push({ paneId, key: field.key, value });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");
    expect(frame).toContain("Symbol");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Apply");
    expect(frame).toContain("Symbol");

    await act(async () => {
      await testSetup!.mockInput.typeText("MSFT");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(appliedValues).toEqual([{
      paneId: "quote-monitor:main",
      key: "symbol",
      value: "MSFT",
    }]);
  });

  test("uses backspace as back only when a pane-settings route query is empty", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="PS"
      configureState={(state) => ({
        ...state,
        focusedPaneId: "quote-monitor:main",
      })}
      hasPaneSettings={(paneId) => paneId === "quote-monitor:main"}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.resolvePaneSettings = () => makeQuoteMonitorPaneSettingsDescriptor(pluginRegistry, [{
          key: "symbol",
          label: "Symbol",
          type: "text",
          description: "Ticker symbol to track",
        }]);
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await renderFrames();

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");

    await act(async () => {
      await testSetup!.mockInput.typeText("s");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");

    await emitKeypress(testSetup, { name: "backspace", sequence: "\b" });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Quote Monitor Settings");

    await act(async () => {
      testSetup!.mockInput.pressBackspace();
      await testSetup!.renderOnce();
    });
    await renderFrames();
    await act(async () => {
      testSetup!.mockInput.pressBackspace();
      await testSetup!.renderOnce();
    });
    await renderFrames();

    frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("Quote Monitor Settings");
    expect(frame).not.toContain("Back  Pane Settings");
  });

});
