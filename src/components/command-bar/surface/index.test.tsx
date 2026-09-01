import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { CommandDef, CommandShortcutArgContext, PaneTemplateCreateOptions, WizardStep } from "../../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
  expectSingleBackControl,
  makeDataProvider,
  makeTicker,
} from "./test-harness";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

const { waitForFrameToContain, clickFrameText } = createCommandBarTestControls(() => testSetup!);

type MutableCommandRegistry = {
  commands: ReadonlyMap<string, CommandDef>;
};

type MutablePaneRegistry = {
  panes: ReadonlyMap<string, unknown>;
  paneTemplates: ReadonlyMap<string, unknown>;
};

const DEFAULT_ALERT_OPTIONS = [
  { label: "Above", value: "above" },
  { label: "Below", value: "below" },
];

function alertWizard(options = DEFAULT_ALERT_OPTIONS): WizardStep[] {
  return [
    { key: "symbol", label: "Symbol", type: "text" },
    {
      key: "condition",
      label: "Condition",
      type: "select",
      options,
    },
    { key: "price", label: "Target Price", type: "number" },
  ];
}

function registerAlertCommand(
  pluginRegistry: MutableCommandRegistry,
  overrides: Partial<CommandDef> = {},
): void {
  (pluginRegistry.commands as Map<string, CommandDef>).set("set-alert", {
    id: "set-alert",
    label: "Add Alert",
    description: "Create a price alert from a symbol, condition, and target price",
    keywords: ["add", "set", "alert", "price", "trigger"],
    shortcut: "SA",
    shortcutArg: {
      placeholder: "symbol condition price",
      kind: "text",
      parse: (arg: string) => {
        const [symbol = "", condition = "", price = ""] = arg.split(/\s+/);
        return { symbol, condition, price };
      },
    },
    category: "data",
    wizardLayout: "form",
    wizard: alertWizard(),
    execute: async () => {},
    ...overrides,
  });
}

function mutablePaneRegistryMap(map: ReadonlyMap<string, unknown>): Map<string, unknown> {
  return map as Map<string, unknown>;
}

describe("CommandBar", () => {
  test("runs symbol search for plain text and folds the hits under the local matches", async () => {
    const searchQueries: string[] = [];
    testSetup = await testRender(<CommandBarHarness
      query="msf"
      dataProvider={makeDataProvider(async (query) => {
        searchQueries.push(query);
        return [
          { providerId: "yahoo", symbol: "MSFT", name: "Microsoft Corp", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "yahoo", symbol: "MSF", name: "MFS Municipal Fund", exchange: "NYSE", type: "ETF" },
        ];
      })}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    const frame = await waitForFrameToContain("Instruments");
    expect(searchQueries.length).toBeGreaterThan(0);
    // The listing split of the DES route is collapsed into one section, with
    // one row per symbol, and a symbol the query spells out is promoted.
    expect(frame).not.toContain("Other Listings");
    // Rows lead with a class badge, so the symbol is the second token, not the line start.
    expect(frame.split("\n").filter((line) => /^\s*\S+\s+MSFT\b/.test(line))).toHaveLength(1);
    expect(frame).toContain("Exact Match");
    expect(frame.indexOf("Exact Match")).toBeLessThan(frame.indexOf("Instruments"));
    expect(frame.indexOf("Instruments")).toBeLessThan(frame.indexOf("Ask AI"));
  });

  test("keeps the row the user picked when an exact symbol lands above it", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    let releaseSearch = () => {};
    const held = new Promise<void>((resolve) => { releaseSearch = resolve; });
    testSetup = await testRender(<CommandBarHarness
      query="list"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
      dataProvider={makeDataProvider(async () => {
        await held;
        return [{ providerId: "yahoo", symbol: "LIST", name: "List Corp", exchange: "NYSE", type: "EQUITY" }];
      })}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    const before = testSetup.captureCharFrame();
    expect(before).not.toContain("Exact Match");
    // Down moves off the first pane match onto the second one.
    await emitKeypress(testSetup, { name: "down" });
    releaseSearch();
    await waitForFrameToContain("Exact Match");

    // The symbol row renumbered everything under it; Enter still runs the
    // pane the user had picked, not whatever now sits at its old index.
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-watchlist-pane", options: undefined }]);
  });

  test("keeps symbol search out of a query a prefix claims", async () => {
    const searchQueries: string[] = [];
    testSetup = await testRender(<CommandBarHarness
      query="PF"
      dataProvider={makeDataProvider(async (query) => {
        searchQueries.push(query);
        return [];
      })}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    await Bun.sleep(260);
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("Shortcut: Portfolio");
    expect(searchQueries).toEqual([]);
  });

  test("runs check for updates from the command bar", async () => {
    const calls: number[] = [];

    testSetup = await testRender(<CommandBarHarness query="check for updates" live onCheckForUpdates={() => { calls.push(Date.now()); }} />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Check for Updates");

    await clickFrameText("Check for Updates");
    await Bun.sleep(0);
    await testSetup.renderOnce();

    expect(calls).toHaveLength(1);
    expect(testSetup.captureCharFrame()).not.toContain("Commands");
  });

  test("shows one account management result when searching profile", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(<CommandBarHarness
      query="profile"
      live
      configurePluginRegistry={(pluginRegistry) => {
        const registry = pluginRegistry as MutablePaneRegistry;
        mutablePaneRegistryMap(registry.panes).set("account-management", {
          id: "account-management",
          name: "Account Management",
          component: () => null,
          defaultPosition: "right",
          defaultMode: "floating",
        });
        mutablePaneRegistryMap(registry.paneTemplates).set("account-management-pane", {
          id: "account-management-pane",
          paneId: "account-management",
          label: "Account Management",
          description: "Edit your Gloom Cloud profile, password, and public portfolio sharing settings",
          keywords: ["account", "profile", "cloud", "acm", "password", "settings"],
          shortcut: { prefix: "ACM" },
        });
        pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    const frame = await waitForFrameToContain("Account Management");
    expect(frame).not.toMatch(/\n\s*Profile\s*(?:\n|$)/);
    expect(frame.indexOf("Account Management")).toBeLessThan(frame.indexOf("Add Broker Account"));

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });

    expect(created).toEqual([{ templateId: "account-management-pane", options: undefined }]);
  });

  test("shows theme picker rows and commits a filtered light theme", async () => {
    testSetup = await testRender(<CommandBarHarness query="TH light" live />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("GitHub Light");

    await clickFrameText("GitHub Light");
    await waitForFrameToContain("theme:github-light");
    expect(testSetup.captureCharFrame()).not.toContain("GitHub Light");
  });

  test("finds the tidy windows command by its snap alias", async () => {
    const calls: string[] = [];

    testSetup = await testRender(<CommandBarHarness
      query="snap"
      configurePluginRegistry={(pluginRegistry) => {
        (pluginRegistry.commands as Map<string, any>).set("gridlock-all", {
          id: "gridlock-all",
          label: "Tidy Windows",
          description: "Arrange every window into one tiled layout",
          keywords: ["tidy", "snap", "grid", "gridlock", "tile", "arrange", "organize", "organise", "cleanup", "dock", "floating", "windows", "layout"],
          shortcut: "GL",
          category: "config",
          execute: async () => {
            calls.push("gridlock-all");
          },
        });
        (pluginRegistry.allPlugins as Map<string, any>).set("application", {
          id: "application",
          name: "Application",
          version: "1.0.0",
          description: "Pane layout management commands",
        });
        const getCommandPluginId = pluginRegistry.getCommandPluginId;
        pluginRegistry.getCommandPluginId = (commandId: string) => (
          commandId === "gridlock-all" ? "application" : getCommandPluginId(commandId)
        );
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Tidy Windows");
    expect(frame).toContain("GL");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(calls).toEqual(["gridlock-all"]);
  });

  test("starts focused window resize mode from WIN argument", async () => {
    const opened: Array<{ paneId: string | undefined; mode: string | undefined }> = [];

    testSetup = await testRender(<CommandBarHarness
      query="WIN resize"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.openWindowMode = (paneId?: string, mode?: string) => { opened.push({ paneId, mode }); };
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Resize Window");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    expect(opened).toEqual([{ paneId: "portfolio-list:main", mode: "resize" }]);
  });

  test("surfaces plugin commands by add-style search terms", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="add alert"
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry);
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Add Alert");
    expect(frame).toContain("SA");
  });

  test("opens plugin command shortcut arguments in the wizard for confirmation", async () => {
    const calls: Array<Record<string, string> | undefined> = [];

    testSetup = await testRender(<CommandBarHarness
      query="SA AAPL above 200"
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry, {
          execute: async (values?: Record<string, string>) => {
            calls.push(values);
          },
        });
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Add Alert");
    expect(frame).toContain("AAPL above 200");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    const workflowFrame = await waitForFrameToContain("Target Price");
    expect(workflowFrame).toContain("AAPL");
    expect(workflowFrame).toContain("Above");
    expect(workflowFrame).toContain("200");
    expect(calls).toEqual([]);
  });

  test("opens partial plugin command shortcut arguments in the wizard", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="SA AMD"
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry, {
          shortcutArg: {
            placeholder: "symbol condition price",
            kind: "text",
            parse: (arg: string) => ({ symbol: arg.trim().toUpperCase() }),
          },
          wizard: alertWizard([{ label: "Above", value: "above" }]),
        });
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    const workflowFrame = await waitForFrameToContain("Target Price");
    expect(workflowFrame).toContain("AMD");
  });

  test("prefills alert command targets from the resolved quote", async () => {
    const quoteProvider = createTestDataProvider({
      id: "test",
      search: async () => [],
      getQuote: async (symbol: string) => ({
        symbol,
        price: 201.5,
        currency: "USD",
        change: 1,
        changePercent: 0.5,
        name: "Advanced Micro Devices",
        exchangeName: "NASDAQ",
        lastUpdated: Date.now(),
        dataSource: "live",
      }),
    });

    testSetup = await testRender(<CommandBarHarness
      query="SA AMD"
      dataProvider={quoteProvider}
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry, {
          shortcutArg: {
            placeholder: "symbol condition price",
            kind: "ticker",
            parse: (arg: string) => ({ symbol: arg.trim().toUpperCase() }),
          },
          wizard: alertWizard([{ label: "Above", value: "above" }]),
        });
      }}
    />, {
      width: 90,
      height: 24,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    const workflowFrame = await waitForFrameToContain("Advanced Micro Devices");
    expect(workflowFrame).toContain("201.5");
  });

  test("updates workflow select fields from the option picker", async () => {
    testSetup = await testRender(<CommandBarHarness
      query="SA AMD"
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry, {
          shortcutArg: {
            placeholder: "symbol condition price",
            kind: "text",
            parse: (arg: string) => ({ symbol: arg.trim().toUpperCase() }),
          },
          wizard: alertWizard([
            { label: "Above", value: "above" },
            { label: "Below", value: "below" },
            { label: "Crosses", value: "crosses" },
          ]),
        });
      }}
    />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });
    await waitForFrameToContain("Target Price");

    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    let frame = await waitForFrameToContain("Below");
    expect(frame).toContain("Crosses");

    await act(async () => {
      testSetup!.mockInput.pressArrow("down");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    frame = await waitForFrameToContain("Target Price");
    expect(frame).toContain("Below");
  });

  test("opens plugin command workflows from a launch request", async () => {
    testSetup = await testRender(<CommandBarHarness
      query=""
      selectedTicker="AMD"
      extraTickers={[makeTicker("AMD", "Advanced Micro Devices")]}
      configureState={(state) => ({
        ...state,
        commandBarLaunchRequest: {
          kind: "plugin-command",
          commandId: "set-alert",
          sequence: 1,
        },
      })}
      configurePluginRegistry={(pluginRegistry) => {
        registerAlertCommand(pluginRegistry, {
          label: "Set Alert",
          keywords: ["alert", "price", "trigger"],
          shortcutArg: {
            placeholder: "symbol condition price",
            kind: "ticker",
            parse: (_arg: string, context: CommandShortcutArgContext): Record<string, string> => (
              context?.activeTicker ? { symbol: context.activeTicker } : {}
            ),
          },
        });
      }}
    />, {
      width: 80,
      height: 24,
    });

    const frame = await waitForFrameToContain("Target Price");
    expect(frame).toContain("Set Alert");
    expect(frame).toContain("Symbol");
    expect(frame).toContain("Condition");
    expect(frame).toContain("AMD");
  });

  test("opens ticker search from a launch request with saved ticker metadata", async () => {
    testSetup = await testRender(<CommandBarHarness
      query=""
      extraTickers={[makeTicker("BRK.B", "Berkshire Hathaway Inc.", {
        exchange: "NYSE",
        assetCategory: "STK",
      })]}
      configureState={(state) => ({
        ...state,
        commandBarLaunchRequest: {
          kind: "ticker-search",
          query: "",
          sequence: 1,
        },
      })}
    />, {
      width: 100,
      height: 24,
    });

    const frame = await waitForFrameToContain("Security Description");
    expectSingleBackControl(frame);
    expect(frame).toContain("BRK.B");
    // The class moved into the left badge; the trailing text carries only the venue.
    expect(frame).toMatch(/EQ\s+BRK\.B.*NYSE/);
    expect(frame).not.toContain("Equity NYSE");
  });

  test("opens ticker search when activating the Ticker Research pane item without a ticker", async () => {
    testSetup = await testRender(<CommandBarHarness query="ticker research" />, {
      width: 100,
      height: 24,
    });

    await testSetup.renderOnce();
    const rootFrame = testSetup.captureCharFrame();
    const tickerResearchRow = rootFrame
      .split("\n")
      .find((line) => line.includes("Ticker Research"));
    // The shortcut sits in the badge column left of the label, not on the right.
    expect(tickerResearchRow).toMatch(/^\s*T\s+Ticker Research\s*$/);

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expectSingleBackControl(frame);
    expect(frame).toContain("Security Description");
    expect(frame).toContain("Search tickers");
  });

  test("keeps typed prefixes in the root query until a result is activated", async () => {
    testSetup = await testRender(<CommandBarHarness query="DES " />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Commands");
    expect(frame).toContain("DES");
    expect(frame).toContain("Type a ticker symbol");
    expect(frame).not.toContain("Back");
  });

  test("QQ without an active ticker opens inline ticker-list entry on enter", async () => {
    testSetup = await testRender(<CommandBarHarness query="QQ" />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Quote Monitor");
    expect(testSetup.captureCharFrame()).not.toContain("Back");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Back");
    expect(frame).toContain("Quote Tickers");
  });

  test("T without an active ticker opens ticker search on enter", async () => {
    testSetup = await testRender(<CommandBarHarness query="T" />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Description");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Back");
    expect(frame).toContain("Security Description");
  });

  test("QQ with an active ticker shows ghost completion and tab inserts the symbol", async () => {
    testSetup = await testRender(<CommandBarHarness query="QQ" live selectedTicker="AAPL" showQueryState />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("QQ AAPL");
    expect(testSetup.captureCharFrame()).toContain("Shortcut: Quote Monitor for AAPL");
    expect(testSetup.captureCharFrame()).toContain("query:QQ");

    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("query:QQ AAPL");
  });

  test("typing a shorthand and pressing enter executes the inferred quote monitor shortcut", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(<CommandBarHarness
      query=""
      live
      selectedTicker="AAPL"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    await act(async () => {
      await testSetup!.mockInput.typeText("QQ");
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "quote-monitor-pane",
      options: {
        arg: "AAPL",
        symbols: ["AAPL"],
      },
    }]);
  });

  test("consumes enter before focused pane shortcuts when executing a pane shortcut", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    let leakedEnterCount = 0;

    testSetup = await testRender(<CommandBarHarness
      query="PF"
      live
      onUnhandledEnter={() => {
        leakedEnterCount += 1;
      }}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
          created.push({ templateId, options });
        };
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

    expect(created).toEqual([{ templateId: "new-portfolio-pane", options: undefined }]);
    expect(leakedEnterCount).toBe(0);
  });

  test("typing a chat channel shortcut opens that channel directly", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(<CommandBarHarness
      query=""
      live
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await testSetup.renderOnce();

    await act(async () => {
      await testSetup!.mockInput.typeText("CHAT help");
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(created).toEqual([{
      templateId: "new-chat-pane",
      options: {
        arg: "help",
      },
    }]);
  });

  test("clears the root query with cmd-backspace", async () => {
    testSetup = await testRender(<CommandBarHarness query="DES AMD" />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("DES AMD");

    await act(async () => {
      testSetup!.mockInput.pressKey("backspace", { meta: true });
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Commands");
    expect(frame).toContain("Search");
    expect(frame).not.toContain("DES AMD");
  });

  test("pressing the close shortcut at the root closes the command bar", async () => {
    testSetup = await testRender(<CommandBarHarness query="" live />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressKey("`");
      await testSetup!.renderOnce();
    });

    expect(testSetup.captureCharFrame()).not.toContain("Commands");
  });

  test("DES MSFT opens an exact ticker directly", async () => {
    const pinned: string[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="DES MSFT"
        configurePluginRegistry={(pluginRegistry) => {
          pluginRegistry.pinTicker = (symbol) => {
            pinned.push(symbol);
          };
        }}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(pinned).toEqual(["MSFT"]);
  });

  test("T AMD opens an exact ticker directly", async () => {
    const pinned: string[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="T AMD"
        extraTickers={[makeTicker("AMD", "Advanced Micro Devices")]}
        configurePluginRegistry={(pluginRegistry) => {
          pluginRegistry.pinTicker = (symbol) => {
            pinned.push(symbol);
          };
        }}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(pinned).toEqual(["AMD"]);
  });

  test("moves through long result lists with the mouse wheel", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="scratch"
        configurePluginRegistry={(pluginRegistry) => {
          const paneTemplates = pluginRegistry.paneTemplates as Map<string, any>;
          for (let index = 0; index < 20; index++) {
            const suffix = String(index).padStart(2, "0");
            paneTemplates.set(`scratch-${suffix}`, {
              id: `scratch-${suffix}`,
              paneId: "chat",
              label: `Scratch Pane ${suffix}`,
              description: `Open scratch pane ${suffix}`,
            });
          }
        }}
      />,
      { width: 100, height: 18 },
    );

    await testSetup.renderOnce();

    const initialFrame = testSetup.captureCharFrame();
    expect(initialFrame).toContain("Scratch Pane 00");
    expect(initialFrame).not.toContain("Scratch Pane 12");

    const rows = initialFrame.split("\n");
    const scrollRow = rows.findIndex((line) => line.includes("Scratch Pane 00"));
    const scrollCol = rows[scrollRow]?.indexOf("Scratch Pane 00") ?? -1;

    expect(scrollRow).toBeGreaterThanOrEqual(0);
    expect(scrollCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await testSetup!.mockMouse.scroll(scrollCol + 1, scrollRow, "down");
        await testSetup!.renderOnce();
      }
    });

    const scrolledFrame = testSetup.captureCharFrame();
    expect(scrolledFrame).not.toContain("Scratch Pane 00");
    expect(scrolledFrame).toContain("Scratch Pane 12");
  });

  test("closes when clicking outside the command bar", async () => {
    testSetup = await testRender(<CommandBarHarness query="" live />, {
      width: 80,
      height: 24,
    });

    await testSetup.renderOnce();

    // Below the sheet; the header row above it hosts the input and is not
    // click-away territory.
    await act(async () => {
      await testSetup!.mockMouse.click(0, 22);
      await testSetup!.renderOnce();
    });
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).not.toContain("Commands");
  });

  test("groups ticker search sections and keeps saved matches above looser provider results", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="DES appl"
        dataProvider={makeDataProvider(async () => [
          { providerId: "yahoo", symbol: "IVSX", name: "Invsivx Holdings", exchange: "NYSE", type: "ETF" },
          { providerId: "yahoo", symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "yahoo", symbol: "AMAT", name: "Applied Materials", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "yahoo", symbol: "AAOI", name: "Applied Optoelectronics", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "yahoo", symbol: "APP", name: "AppLovin Corp", exchange: "NASDAQ", type: "EQUITY" },
        ])}
      />,
      { width: 80, height: 24 },
    );

    await testSetup.renderOnce();
    await waitForFrameToContain("AAOI");

    const frame = testSetup.captureCharFrame();
    const rows = frame.split("\n");
    const savedHeadings = frame.split("\n").filter((line) => line.trim() === "Saved");
    const otherListingsHeadings = frame.split("\n").filter((line) => line.trim() === "Other Listings");
    const aaplRow = rows.findIndex((line) => /^\s*\S+\s+AAPL\b/.test(line));
    const appRow = rows.findIndex((line) => /^\s*\S+\s+APP\b/.test(line));
    expect(savedHeadings).toHaveLength(1);
    expect(otherListingsHeadings).toHaveLength(1);
    expect(aaplRow).toBeGreaterThanOrEqual(0);
    expect(appRow).toBeGreaterThanOrEqual(0);
    expect(aaplRow).toBeLessThan(appRow);
  });

  test("keeps the provider-ranked canonical listing ahead of provisional saved order", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query=""
        extraTickers={[makeTicker("APC", "Apple Inc.", {
          exchange: "XETRA",
          currency: "EUR",
          assetCategory: "STK",
        })]}
        configureState={(state) => ({
          ...state,
          commandBarLaunchRequest: {
            kind: "ticker-search",
            query: "Apple",
            sequence: 1,
          },
          tickers: new Map([
            ["APC", state.tickers.get("APC")!],
            ["AAPL", state.tickers.get("AAPL")!],
            ["MSFT", state.tickers.get("MSFT")!],
          ]),
        })}
        dataProvider={makeDataProvider(async () => [
          {
            providerId: "yahoo",
            symbol: "AAPL",
            name: "Apple Inc.",
            exchange: "NASDAQ",
            primaryExchange: "NASDAQ",
            type: "EQUITY",
            currency: "USD",
          },
          {
            providerId: "broker",
            symbol: "APC",
            name: "Apple Inc.",
            exchange: "XETRA",
            primaryExchange: "XETRA",
            type: "EQUITY",
            currency: "EUR",
          },
          {
            providerId: "yahoo",
            symbol: "APLY",
            name: "Apple Yield Shares ETF",
            exchange: "NYSE Arca",
            type: "ETF",
            currency: "USD",
          },
        ])}
      />,
      { width: 100, height: 24 },
    );

    await testSetup.renderOnce();
    const frame = await waitForFrameToContain("APLY");
    const rows = frame.split("\n");
    const aaplRow = rows.findIndex((line) => /^\s*\S+\s+AAPL\b/.test(line));
    const apcRow = rows.findIndex((line) => /^\s*\S+\s+APC\b/.test(line));

    expect(aaplRow).toBeGreaterThanOrEqual(0);
    expect(apcRow).toBeGreaterThanOrEqual(0);
    expect(aaplRow).toBeLessThan(apcRow);
  });

  test("renders form-layout wizard fields together on one screen", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="auth login"
        live
        configurePluginRegistry={(pluginRegistry) => {
          (pluginRegistry.commands as Map<string, any>).set("auth-login", {
            id: "auth-login",
            label: "Auth Login",
            description: "Log in to your account",
            keywords: ["login", "auth"],
            category: "config",
            wizardLayout: "form",
            wizard: [
              { key: "email", label: "Email", type: "text", placeholder: "email@example.com" },
              { key: "password", label: "Password", type: "password", placeholder: "Your password" },
            ],
            execute: async () => {},
          } as any);
        }}
      />,
      { width: 80, height: 24 },
    );

    await testSetup.renderOnce();
    await clickFrameText("Auth Login");
    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Back");
    expect(frame).toContain("Email");
    expect(frame).toContain("Password");
    expect(frame).toContain("Your password");
    expectSingleBackControl(frame);
  });

  test("submits single-field form-layout wizards", async () => {
    const submitted: Array<Record<string, string> | undefined> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="workspace"
        live
        configurePluginRegistry={(pluginRegistry) => {
          (pluginRegistry.commands as Map<string, any>).set("new-workspace", {
            id: "new-workspace",
            label: "Workspace",
            description: "Create a workspace",
            keywords: ["workspace"],
            category: "config",
            wizardLayout: "form",
            wizard: [
              { key: "name", label: "Name", type: "text", placeholder: "Research" },
            ],
            execute: async (values?: Record<string, string>) => {
              submitted.push(values);
            },
          } as any);
        }}
      />,
      { width: 80, height: 24 },
    );

    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("Research");
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(submitted).toEqual([{ name: "Research" }]);
  });
});
