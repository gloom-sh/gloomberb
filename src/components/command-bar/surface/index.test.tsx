import { describe, expect, test } from "bun:test";
import { act } from "react";
import { takeKeybindingCaptureRequest } from "../../../app/keybindings";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, WizardStep } from "../../../types/plugin";
import { CommandBarHarness, createCommandBarTestControls, expectSingleBackControl, makeDataProvider } from "./test-harness";
import { createTestTicker } from "../../../test-support/ticker";
import type { AppContextStoreValue } from "../../../state/app/context";

const tui = createOpenTuiTestHarness();

const { waitForFrameToContain, clickFrameText } = createCommandBarTestControls(() => tui.setup());

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
    await tui.render(<CommandBarHarness
      query="msf"
      dataProvider={makeDataProvider(async (query) => {
        searchQueries.push(query);
        return [
          { providerId: "gloom", symbol: "MSFT", name: "Microsoft Corp", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "gloom", symbol: "MSF", name: "MFS Municipal Fund", exchange: "NYSE", type: "ETF" },
        ];
      })}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    const frame = await waitForFrameToContain("Instruments");
    expect(searchQueries.length).toBeGreaterThan(0);
    // The listing split of the DES route is collapsed into one section, with
    // one row per symbol, and a symbol the query spells out is promoted.
    expect(frame).not.toContain("Other Listings");
    // Rows lead with a class badge, so the symbol is the second token, not the line start.
    expect(frame.split("\n").filter((line) => /^\s*\S+\s+MSFT\b/.test(line))).toHaveLength(1);
    expect(frame).toContain("Exact Match");
    expect(frame.indexOf("Exact Match")).toBeLessThan(frame.indexOf("Instruments"));
    // Signed out, the AI section is a sign-up offer, which sits under the answers.
    expect(frame.indexOf("Instruments")).toBeLessThan(frame.indexOf("Ask AI"));
  });

  test("keeps the row the user picked when an exact symbol lands above it", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    let releaseSearch = () => {};
    const held = new Promise<void>((resolve) => { releaseSearch = resolve; });
    await tui.render(<CommandBarHarness
      query="list"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsync = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
      dataProvider={makeDataProvider(async () => {
        await held;
        return [{ providerId: "gloom", symbol: "LIST", name: "List Corp", exchange: "NYSE", type: "EQUITY" }];
      })}
    />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();
    const before = tui.frame();
    expect(before).not.toContain("Exact Match");
    // Down moves off the first pane match onto the second one.
    await tui.emitKeypress({ name: "down" });
    releaseSearch();
    await waitForFrameToContain("Exact Match");

    // The symbol row renumbered everything under it; Enter still runs the
    // pane the user had picked, not whatever now sits at its old index.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-watchlist-pane", options: undefined }]);
  });

  test("keeps symbol search out of a query a prefix claims", async () => {
    const searchQueries: string[] = [];
    await tui.render(<CommandBarHarness
      query="PF"
      dataProvider={makeDataProvider(async (query) => {
        searchQueries.push(query);
        return [];
      })}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    await Bun.sleep(260);
    await tui.setup().renderOnce();

    expect(tui.frame()).toContain("Shortcut: Portfolio");
    expect(searchQueries).toEqual([]);
  });

  test("shows one account management result when searching profile", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(<CommandBarHarness
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
        pluginRegistry.createPaneFromTemplateAsync = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    const frame = await waitForFrameToContain("Account Management");
    expect(frame).not.toMatch(/\n\s*Profile\s*(?:\n|$)/);
    expect(frame.indexOf("Account Management")).toBeLessThan(frame.indexOf("Add Broker Account"));

    await tui.emitKeypress({ name: "return", sequence: "\r" });

    expect(created).toEqual([{ templateId: "account-management-pane", options: undefined }]);
  });

  test("shows theme picker rows and commits a filtered light theme", async () => {
    await tui.render(<CommandBarHarness query="TH light" live />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("GitHub Light");

    await clickFrameText("GitHub Light");
    await waitForFrameToContain("theme:github-light");
    expect(tui.frame()).not.toContain("GitHub Light");
  });

  test("preselects the theme named exactly over the committed one it also matches", async () => {
    await tui.render(<CommandBarHarness
      query="TH nord"
      live
      configureConfig={(config) => ({ ...config, theme: "nord-light" })}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Nord Light");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });
    await waitForFrameToContain("theme:nord");
    expect(tui.frame()).not.toContain("theme:nord-light");
  });

  test("starts focused window resize mode from WIN argument", async () => {
    const opened: Array<{ paneId: string | undefined; mode: string | undefined }> = [];

    await tui.render(<CommandBarHarness
      query="WIN resize"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.openWindowMode = (paneId?: string, mode?: string) => { opened.push({ paneId, mode }); };
      }}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Resize Window");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    expect(opened).toEqual([{ paneId: "portfolio-list:main", mode: "resize" }]);
  });

  test("opens plugin command shortcut arguments in the form for confirmation", async () => {
    const calls: Array<Record<string, string> | undefined> = [];

    await tui.render(<CommandBarHarness
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

    await tui.setup().renderOnce();

    const frame = tui.frame();
    expect(frame).toContain("Add Alert");
    expect(frame).toContain("AAPL above 200");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    const workflowFrame = await waitForFrameToContain("Target Price");
    expect(workflowFrame).toContain("AAPL");
    expect(workflowFrame).toContain("Above");
    expect(workflowFrame).toContain("200");
    expect(calls).toEqual([]);
  });

  test("opens partial plugin command shortcut arguments in the form", async () => {
    await tui.render(<CommandBarHarness
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

    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
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

    await tui.render(<CommandBarHarness
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

    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    const workflowFrame = await waitForFrameToContain("Advanced Micro Devices");
    expect(workflowFrame).toContain("201.5");
  });

  test("updates form select fields from the stacked picker", async () => {
    await tui.render(<CommandBarHarness
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

    await tui.setup().renderOnce();
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });
    await waitForFrameToContain("Target Price");

    await act(async () => {
      tui.setup().mockInput.pressTab();
      await tui.setup().renderOnce();
    });
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });
    let frame = await waitForFrameToContain("Below");
    expect(frame).toContain("Crosses");

    await act(async () => {
      tui.setup().mockInput.pressArrow("down");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    frame = await waitForFrameToContain("Target Price");
    expect(frame).toContain("Below");
  });

  test("Add Broker Account closes the bar and starts the Brokers pane's add flow", async () => {
    const shown: string[] = [];
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    await tui.render(<CommandBarHarness
      query="Add Broker Account"
      live
      storeRef={storeRef}
      configureConfig={(config) => ({
        ...config,
        layout: {
          ...config.layout,
          instances: [...config.layout.instances, { instanceId: "brokers:main", paneId: "brokers", binding: { kind: "none" } }],
        },
      })}
      configurePluginRegistry={(pluginRegistry) => {
        mutablePaneRegistryMap((pluginRegistry as MutablePaneRegistry).panes).set("brokers", {
          id: "brokers",
          name: "Brokers",
          component: () => null,
          defaultPosition: "right",
          defaultMode: "floating",
        });
        pluginRegistry.showPane = (paneId: string) => { shown.push(paneId); };
        pluginRegistry.getLayout = () => storeRef.current!.getState().config.layout;
        pluginRegistry.updatePaneRuntimeState = (paneId, patch) => {
          storeRef.current!.dispatch({ type: "UPDATE_PANE_STATE", paneId, patch });
        };
      }}
    />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    await waitForFrameToContain("Add Broker Account");
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, afterCommit: true });
    await waitForFrameToContain("bar:closed");

    expect(shown).toEqual(["brokers"]);
    expect(storeRef.current!.getState().paneState["brokers:main"]?.brokerAddRequest).toEqual(expect.any(Number));
  });

  test("opens ticker search from a launch request with saved ticker metadata", async () => {
    await tui.render(<CommandBarHarness
      query=""
      extraTickers={[createTestTicker("BRK.B", "Berkshire Hathaway Inc.", {
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
    await tui.render(<CommandBarHarness query="ticker research" />, {
      width: 100,
      height: 24,
    });

    await tui.setup().renderOnce();
    const rootFrame = tui.frame();
    const tickerResearchRow = rootFrame
      .split("\n")
      .find((line) => line.includes("Ticker Research"));
    // The shortcut sits in the badge column left of the label, not on the right.
    expect(tickerResearchRow).toMatch(/^\s*T\s+Ticker Research\s*$/);

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expectSingleBackControl(frame);
    expect(frame).toContain("Security Description");
    expect(frame).toContain("Search tickers");
  });

  test("keeps typed prefixes in the root query until a result is activated", async () => {
    await tui.render(<CommandBarHarness query="DES " />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();

    let frame = tui.frame();
    expect(frame).toContain("DES");
    expect(frame).toContain("Type a ticker symbol");
    expect(frame).not.toContain("Back");
  });

  test("QQ without an active ticker asks for the tickers in the form modal on enter", async () => {
    await tui.render(<CommandBarHarness query="QQ" live />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Quote Monitor");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    const frame = await waitForFrameToContain("Quote Tickers");
    expect(frame).toContain("Create Pane");
    expect(frame).toContain("bar:closed");
  });

  test("T without an active ticker opens ticker search on enter", async () => {
    await tui.render(<CommandBarHarness query="T" />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Description");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Back");
    expect(frame).toContain("Security Description");
  });

  test("QQ with an active ticker shows ghost completion and tab inserts the symbol", async () => {
    await tui.render(<CommandBarHarness query="QQ" live selectedTicker="AAPL" showQueryState />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("QQ AAPL");
    expect(tui.frame()).toContain("Shortcut: Quote Monitor for AAPL");
    expect(tui.frame()).toContain("query:QQ");

    await act(async () => {
      tui.setup().mockInput.pressTab();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("query:QQ AAPL");
  });

  test("typing a shorthand and pressing enter executes the inferred quote monitor shortcut", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(<CommandBarHarness
      query=""
      live
      selectedTicker="AAPL"
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsync = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();

    await act(async () => {
      await tui.setup().mockInput.typeText("QQ");
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
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

    await tui.render(<CommandBarHarness
      query="PF"
      live
      onUnhandledEnter={() => {
        leakedEnterCount += 1;
      }}
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsync = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    expect(created).toEqual([{ templateId: "new-portfolio-pane", options: undefined }]);
    expect(leakedEnterCount).toBe(0);
  });

  test("typing a chat channel shortcut opens that channel directly", async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    await tui.render(<CommandBarHarness
      query=""
      live
      configurePluginRegistry={(pluginRegistry) => {
        pluginRegistry.createPaneFromTemplateAsync = async (templateId, options) => {
          created.push({ templateId, options });
        };
      }}
    />, {
      width: 100,
      height: 20,
    });

    await tui.setup().renderOnce();

    await act(async () => {
      await tui.setup().mockInput.typeText("CHAT help");
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    expect(created).toEqual([{
      templateId: "new-chat-pane",
      options: {
        arg: "help",
      },
    }]);
  });

  test("clears the root query with cmd-backspace", async () => {
    await tui.render(<CommandBarHarness query="DES AMD" />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("DES AMD");

    await tui.emitKeypress({ name: "backspace", meta: true });

    const frame = tui.frame();
    expect(frame).toContain("Type a ticker symbol");
    expect(frame).not.toContain("DES AMD");
  });

  test("pressing the close shortcut at the root closes the command bar", async () => {
    await tui.render(<CommandBarHarness query="" live />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressKey("`");
      await tui.setup().renderOnce();
    });

    expect(tui.frame()).toContain("Search or run a command");
  });

  test("DES MSFT opens an exact ticker directly", async () => {
    const pinned: string[] = [];

    await tui.render(
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

    await tui.setup().renderOnce();
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(pinned).toEqual(["MSFT"]);
  });

  test("a run-query launch submits the text without a keypress", async () => {
    const pinned: string[] = [];

    await tui.render(
      <CommandBarHarness
        query="DES MSFT"
        configureState={(state) => ({
          ...state,
          commandBarLaunchRequest: { kind: "run-query", query: "DES MSFT", sequence: 1 },
        })}
        configurePluginRegistry={(pluginRegistry) => {
          pluginRegistry.pinTicker = (symbol) => {
            pinned.push(symbol);
          };
        }}
      />,
      { width: 100, height: 20 },
    );

    await act(async () => {
      await Bun.sleep(0);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(pinned).toEqual(["MSFT"]);
  });

  test("resolved text offers a Bind a key row that hands off to Help without being the default selection", async () => {
    const shown: string[] = [];
    await tui.render(
      <CommandBarHarness
        query="DES MSFT"
        configurePluginRegistry={(pluginRegistry) => {
          pluginRegistry.showPane = (paneId) => {
            shown.push(paneId);
          };
        }}
      />,
      { width: 100, height: 20 },
    );

    await tui.setup().renderOnce();
    const frame = tui.frame();
    expect(frame).toContain("Bind a key to DES MSFT");
    expect(frame.indexOf("▸")).toBeLessThan(frame.indexOf("Bind a key"));

    await act(async () => {
      await clickFrameText("Bind a key to DES MSFT");
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    expect(shown).toEqual(["help"]);
    expect(takeKeybindingCaptureRequest()).toEqual({ kind: "command", query: "DES MSFT" });
  });

  test("moves through long result lists with the mouse wheel", async () => {
    await tui.render(
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

    await tui.setup().renderOnce();

    const initialFrame = tui.frame();
    expect(initialFrame).toContain("Scratch Pane 00");
    expect(initialFrame).not.toContain("Scratch Pane 12");

    const rows = initialFrame.split("\n");
    const scrollRow = rows.findIndex((line) => line.includes("Scratch Pane 00"));
    const scrollCol = rows[scrollRow]?.indexOf("Scratch Pane 00") ?? -1;

    expect(scrollRow).toBeGreaterThanOrEqual(0);
    expect(scrollCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await tui.setup().mockMouse.scroll(scrollCol + 1, scrollRow, "down");
        await tui.setup().renderOnce();
      }
    });

    const scrolledFrame = tui.frame();
    expect(scrolledFrame).not.toContain("Scratch Pane 00");
    expect(scrolledFrame).toContain("Scratch Pane 12");
  });

  test("closes when clicking outside the command bar", async () => {
    await tui.render(<CommandBarHarness query="" live />, {
      width: 80,
      height: 24,
    });

    await tui.setup().renderOnce();

    // Below the sheet; the header row above it hosts the input and is not
    // click-away territory.
    await act(async () => {
      await tui.setup().mockMouse.click(0, 22);
      await tui.setup().renderOnce();
    });
    await tui.setup().renderOnce();

    expect(tui.frame()).toContain("Search or run a command");
  });

  test("groups ticker search sections and keeps saved matches above looser provider results", async () => {
    await tui.render(
      <CommandBarHarness
        query="DES appl"
        dataProvider={makeDataProvider(async () => [
          { providerId: "gloom", symbol: "IVSX", name: "Invsivx Holdings", exchange: "NYSE", type: "ETF" },
          { providerId: "gloom", symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "gloom", symbol: "AMAT", name: "Applied Materials", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "gloom", symbol: "AAOI", name: "Applied Optoelectronics", exchange: "NASDAQ", type: "EQUITY" },
          { providerId: "gloom", symbol: "APP", name: "AppLovin Corp", exchange: "NASDAQ", type: "EQUITY" },
        ])}
      />,
      { width: 80, height: 24 },
    );

    await tui.setup().renderOnce();
    await waitForFrameToContain("AAOI");

    const frame = tui.frame();
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
    await tui.render(
      <CommandBarHarness
        query=""
        extraTickers={[createTestTicker("APC", "Apple Inc.", {
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
            providerId: "gloom",
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
            providerId: "gloom",
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

    await tui.setup().renderOnce();
    const frame = await waitForFrameToContain("APLY");
    const rows = frame.split("\n");
    const aaplRow = rows.findIndex((line) => /^\s*\S+\s+AAPL\b/.test(line));
    const apcRow = rows.findIndex((line) => /^\s*\S+\s+APC\b/.test(line));

    expect(aaplRow).toBeGreaterThanOrEqual(0);
    expect(apcRow).toBeGreaterThanOrEqual(0);
    expect(aaplRow).toBeLessThan(apcRow);
  });

  test("renders a wizard's fields together in the form modal", async () => {
    await tui.render(
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

    await tui.setup().renderOnce();
    await clickFrameText("Auth Login");
    const frame = await waitForFrameToContain("Your password");
    expect(frame).toContain("Email");
    expect(frame).toContain("Password");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("bar:closed");
  });

  test("submits single-field form-layout wizards", async () => {
    const submitted: Array<Record<string, string> | undefined> = [];

    await tui.render(
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

    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("Research");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(submitted).toEqual([{ name: "Research" }]);
  });

  // Enter on a select opens its picker, and picking moves on without sending.
  test("sends a form whose last field is a select with Ctrl+S", async () => {
    const submitted: Array<Record<string, string> | undefined> = [];

    await tui.render(
      <CommandBarHarness
        query="event alert"
        live
        configurePluginRegistry={(pluginRegistry) => {
          (pluginRegistry.commands as Map<string, any>).set("event-alert", {
            id: "event-alert",
            label: "Event Alert",
            description: "Alert on an event",
            keywords: ["event", "alert"],
            category: "data",
            wizardLayout: "form",
            wizard: [{
              key: "event",
              label: "Event",
              type: "select",
              options: [
                { label: "Filing", value: "filing" },
                { label: "Insider Trade", value: "insider" },
              ],
            }],
            execute: async (values?: Record<string, string>) => {
              submitted.push(values);
            },
          } as any);
        }}
      />,
      { width: 80, height: 24 },
    );

    await tui.setup().renderOnce();
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true });
    await waitForFrameToContain("Filing");
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true });
    await waitForFrameToContain("Insider Trade");
    await tui.emitKeypress({ name: "down" }, { frames: 2, trackPropagation: true });
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true });
    expect(submitted).toEqual([]);

    await tui.emitKeypress({ name: "s", ctrl: true, sequence: "\x13" }, { frames: 2, trackPropagation: true });
    await act(async () => {
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    expect(submitted).toEqual([{ event: "insider" }]);
  });
});
