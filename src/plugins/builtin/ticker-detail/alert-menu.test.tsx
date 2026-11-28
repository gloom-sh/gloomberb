import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { subscribeFormModalRequests, type FormModalRequest } from "../../../components/form-modal/request";
import type { CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState, type AppState } from "../../../state/app/context";
import { createTestQuote } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type LayoutConfig } from "../../../types/config";
import type { ContextMenuActionItem, ContextMenuItem } from "../../../types/context-menu";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { CommandDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { Box, Text } from "../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { tickerAlertMenuItems } from "./alert-menu";
import { TickerResearchPane } from "./pane";

const ALERT_ITEMS = ["add-price-alert", "add-earnings-alert", "add-filing-alert"];

function alertsRegistry({ commands = ["set-alert", "set-event-alert"], hidden = [] as string[] } = {}) {
  const executed: unknown[] = [];
  const registry = {
    commands: new Map(commands.map((id) => [id, {
      id, label: id, keywords: [], category: "data",
      execute: async (values?: Record<string, string>) => { executed.push(values); },
      ...(hidden.includes(id) ? { hidden: () => true } : {}),
    } as CommandDef])),
    getCommandPluginId: (id: string) => commands.includes(id) ? "alerts" : undefined,
    getConfig: () => ({ disabledPlugins: [] }),
    notify: () => {},
    paneTemplates: new Map(),
    tickerResearchTabs: new Map([["overview", { id: "overview", name: "Overview", order: 0, component: () => <Text>OVERVIEW</Text> }]]),
  } as unknown as PluginRegistry;
  return { registry, executed };
}

function alertItems(menu: ContextMenuItem[]): ContextMenuActionItem[] {
  return menu.filter((item): item is ContextMenuActionItem => item.type !== "divider" && item.type !== "role" && ALERT_ITEMS.includes(item.id));
}

/** What each alert item asks the form host to open, in the menu's order; nothing is sent. */
async function formsOpened(items: ContextMenuActionItem[]): Promise<Array<[string, FormModalRequest | undefined]>> {
  const opened: Array<[string, FormModalRequest | undefined]> = [];
  for (const item of items) {
    const requests: FormModalRequest[] = [];
    const unsubscribe = subscribeFormModalRequests((request) => { requests.push(request); return true; });
    try {
      await item.onSelect!();
    } finally {
      unsubscribe();
    }
    opened.push([item.id, requests[0]]);
  }
  return opened;
}

const price = (symbol: string) => ({ kind: "plugin-command", commandId: "set-alert", values: { kind: "price", symbol } });
const events = (symbol: string, exchange: string) => [
  ["add-earnings-alert", { kind: "plugin-command", commandId: "set-event-alert", values: { event: "earnings_date", "earnings_date:symbol": symbol, "earnings_date:exchange": exchange } }],
  ["add-filing-alert", { kind: "plugin-command", commandId: "set-event-alert", values: { event: "filing_type", "filing_type:symbol": symbol, "filing_type:exchange": exchange } }],
] as const;

describe("DES alert menu items", () => {
  test("each form gets the listing on screen; earnings and filings only for a company's shares on a US exchange", async () => {
    const { registry, executed } = alertsRegistry();
    const quoted = (instrumentType: string, overrides: Partial<Quote> = {}): TickerFinancials => ({
      annualStatements: [], quarterlyStatements: [], priceHistory: [],
      quote: createTestQuote({ instrumentType, ...overrides }),
    });
    const cases: Array<[string, TickerRecord, TickerFinancials | null, unknown[]]> = [
      ["a US company", createTestTicker("AAPL", "Apple"), null, [["add-price-alert", price("AAPL:NASDAQ")], ...events("AAPL", "NASDAQ")]],
      // Cross-listed: BHP's NYSE receipt is the US line; its Sydney line and Sanofi's Paris line, saved under the bare
      // SAN that is Banco Santander's NYSE receipt, get a price alert on their own venue and no US company rule.
      ["BHP's NYSE receipt", createTestTicker("BHP", "BHP Group ADR", { exchange: "NYSE" }), null, [["add-price-alert", price("BHP:NYSE")], ...events("BHP", "NYSE")]],
      ["BHP on ASX", createTestTicker("BHP:XASX", "BHP Group", { exchange: "ASX", currency: "AUD" }), null, [["add-price-alert", price("BHP:ASX")]]],
      ["Sanofi saved as SAN", createTestTicker("SAN", "Sanofi", { exchange: "EPA", currency: "EUR" }), null, [["add-price-alert", price("SAN:EPA")]]],
      // A venue only the quote names is still the listing's own.
      ["a venue from the quote", createTestTicker("IBM", "IBM", { exchange: "" }), quoted("EQUITY", { listingExchangeName: "NYSE" }), [["add-price-alert", price("IBM")], ...events("IBM", "NYSE")]],
      ["a fund", createTestTicker("SPY", "SPDR S&P 500", { exchange: "ARCA", assetCategory: "ETF" }), null, [["add-price-alert", price("SPY:ARCA")]]],
      ["a coin", createTestTicker("BTC-USD", "Bitcoin", { exchange: "CCC", assetCategory: "CRYPTOCURRENCY" }), null, [["add-price-alert", price("BTC-USD:CCC")]]],
      ["over the counter", createTestTicker("TCEHY", "Tencent ADR", { exchange: "OTC" }), null, [["add-price-alert", price("TCEHY:OTC")]]],
      // Every form refuses a listing that no longer trades.
      ["a delisted company", createTestTicker("TWTR", "Twitter", { exchange: "NYSE" }),
        quoted("EQUITY", { delisting: { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2013-11-07" } }), []],
    ];
    for (const [name, ticker, financials, expected] of cases) {
      const items = alertItems(tickerAlertMenuItems({ ticker, financials, registry, disabledPlugins: [] }));
      expect([name, await formsOpened(items)]).toEqual([name, expected as never]);
    }
    expect(executed).toEqual([]);
  });

  test("a command that is missing, hidden or whose plugin is off offers nothing of its own", () => {
    const ids = (registry: PluginRegistry, disabledPlugins: string[] = []) =>
      alertItems(tickerAlertMenuItems({ ticker: createTestTicker("AAPL"), financials: null, registry, disabledPlugins })).map((item) => item.id);
    expect(ids(alertsRegistry().registry, ["alerts"])).toEqual([]);
    expect(ids(alertsRegistry({ commands: ["set-alert"] }).registry)).toEqual(["add-price-alert"]);
    expect(ids(alertsRegistry({ hidden: ["set-alert"] }).registry)).toEqual(["add-earnings-alert", "add-filing-alert"]);
  });
});

describe("DES pane menu", () => {
  const tui = createOpenTuiTestHarness({ width: 140, height: 16 });
  afterEach(() => setSharedRegistryForTests(undefined));

  test("a pinned pane keeps its listing; a linked one offers what the listing it follows now takes", async () => {
    const { registry } = alertsRegistry();
    setSharedRegistryForTests(registry);
    const config = createDefaultConfig("/synthetic/des-alert-menu");
    const list = config.layout.instances.find((instance) => instance.instanceId === "portfolio-list:main")!;
    const layout: LayoutConfig = {
      dockRoot: { kind: "pane", instanceId: list.instanceId },
      instances: [
        list,
        { instanceId: "des:pinned", paneId: TICKER_RESEARCH_PANE_ID, binding: { kind: "fixed", symbol: "BHP:XASX" } },
        { instanceId: "des:linked", paneId: TICKER_RESEARCH_PANE_ID, binding: { kind: "follow", sourceInstanceId: list.instanceId } },
      ],
      floating: [], detached: [],
    };
    const initial = createInitialState({ ...config, layout, layouts: [{ name: "Default", layout: cloneLayout(layout) }] });
    initial.tickers.set("BHP:XASX", createTestTicker("BHP:XASX", "BHP Group", { exchange: "ASX", currency: "AUD" }));
    initial.tickers.set("BHP", createTestTicker("BHP", "BHP Group ADR", { exchange: "NYSE" }));
    initial.paneState[list.instanceId] = { cursorSymbol: "BHP:XASX" };
    const menus: Record<string, ContextMenuItem[]> = {};
    let update!: (change: (state: AppState) => AppState) => void;
    const runtime = createTestPluginRuntime();
    function Harness() {
      const [state, setState] = useState(initial);
      update = setState;
      return <Box flexDirection="row">
        {["des:pinned", "des:linked"].map((paneId) => (
          <TestPaneFrame key={paneId} state={state} paneId={paneId} pluginId="ticker-research" runtime={runtime} width={70} height={16}>
            {({ width, height }, footer: CombinedPaneFooter) => {
              menus[paneId] = footer.menu;
              return <TickerResearchPane paneId={paneId} paneType={TICKER_RESEARCH_PANE_ID} focused={false} width={width} height={height} />;
            }}
          </TestPaneFrame>
        ))}
      </Box>;
    }
    await tui.render(<Harness />);
    await tui.waitForFrameToContain("OVERVIEW");
    const offered = async () => Object.fromEntries(await Promise.all(Object.entries(menus).map(async ([paneId, menu]) => [paneId, await formsOpened(alertItems(menu))])));

    // Both show BHP's Sydney line: a price alert on it, nothing that would follow the NYSE receipt.
    expect(await offered()).toEqual({
      "des:pinned": [["add-price-alert", price("BHP:ASX")]],
      "des:linked": [["add-price-alert", price("BHP:ASX")]],
    });
    // The list moves to the receipt: the linked pane offers its price and its company's US rules, the pinned one is as it was.
    await act(async () => { update((state) => ({ ...state, paneState: { ...state.paneState, [list.instanceId]: { cursorSymbol: "BHP" } } })); });
    await tui.waitForFrameToContain("OVERVIEW");
    expect(await offered()).toEqual({
      "des:pinned": [["add-price-alert", price("BHP:ASX")]],
      "des:linked": [["add-price-alert", price("BHP:NYSE")], ...events("BHP", "NYSE")],
    });
    // Turning the alerts plugin off takes them out of both menus.
    await act(async () => { update((state) => ({ ...state, config: { ...state.config, disabledPlugins: ["alerts"] } })); });
    await tui.waitForFrameToContain("OVERVIEW");
    expect(await offered()).toEqual({ "des:pinned": [], "des:linked": [] });
  });
});
