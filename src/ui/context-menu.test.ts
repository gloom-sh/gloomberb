import { describe, expect, test } from "bun:test";
import { resolveAlertListing } from "../cli/alert-listing";
import { subscribeFormModalRequests, type FormModalRequest } from "../components/form-modal/request";
import type { PluginRegistry } from "../plugins/registry";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { createTestTicker } from "../test-support/ticker";
import type { ContextMenuActionItem, ContextMenuItem } from "../types/context-menu";
import type { Quote } from "../types/financials";
import type { CommandDef } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import { tickerContextMenuItems } from "./context-menu";

function menuLabels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => item.type === "divider" ? [] : [item.label ?? ""]);
}

describe("context menu item builders", () => {
  test("ticker menu includes plugin ticker actions and hides remove actions without memberships", () => {
    const registry = {
      getEnabledTickerActions() { return [...this.tickerActions.values()]; },
    tickerActions: new Map([
        ["alert", {
          id: "alert",
          label: "Set Alert",
          execute: () => {},
        }],
      ]),
      navigateTicker: () => {},
      pinTicker: () => {},
      openCommandBar: () => {},
    } as unknown as PluginRegistry;

    const labels = menuLabels(tickerContextMenuItems({
      ticker: createTestTicker("AAPL", "Apple"),
      financials: null,
      registry,
      copyText: async () => {},
    }));

    expect(labels).toContain("Set Alert");
    expect(labels).toContain("Add to Watchlist...");
    expect(labels).not.toContain("Remove from Watchlist...");
    expect(labels).not.toContain("Remove from Portfolio...");
  });
});

describe("Add Alert in the ticker menu", () => {
  function alertsRegistry({ disabledPlugins = [] as string[], command = {} as Partial<CommandDef> | null } = {}) {
    const executed: unknown[] = [];
    const notes: Array<{ body?: string; type?: string }> = [];
    const commands = new Map<string, CommandDef>();
    if (command) {
      commands.set("set-alert", {
        id: "set-alert", label: "Add Alert", keywords: [], category: "data",
        execute: async (values) => { executed.push(values); },
        ...command,
      } as CommandDef);
    }
    const registry = {
      commands,
      getCommandPluginId: (id: string) => commands.has(id) ? "alerts" : undefined,
      getConfig: () => ({ disabledPlugins }),
      getEnabledTickerActions: () => [{ id: "thesis", label: "Thesis", execute: () => {} }],
      notify: (notification: { body?: string; type?: string }) => { notes.push(notification); },
      navigateTicker: () => {},
      pinTicker: () => {},
      openCommandBar: () => {},
    } as unknown as PluginRegistry;
    return { registry, executed, notes };
  }

  function menu(ticker: TickerRecord, registry: PluginRegistry): ContextMenuItem[] {
    return tickerContextMenuItems({ ticker, financials: null, registry, copyText: async () => {} });
  }

  function addAlertItem(ticker: TickerRecord, registry: PluginRegistry): ContextMenuActionItem | undefined {
    return menu(ticker, registry).find((item): item is ContextMenuActionItem => item.type !== "divider" && item.type !== "role" && item.id === "ticker:add-alert");
  }

  /** The requests a form host would get, answered as `open` says: false is a window with no host. */
  async function selectAddAlert(ticker: TickerRecord, registry: PluginRegistry, open = true): Promise<FormModalRequest[]> {
    const requests: FormModalRequest[] = [];
    const unsubscribe = subscribeFormModalRequests((request) => {
      requests.push(request);
      return open;
    });
    try {
      await addAlertItem(ticker, registry)!.onSelect!();
    } finally {
      unsubscribe();
    }
    return requests;
  }

  test("sits after Add to Portfolio while alerts are on, and is gone when the plugin is off or the command is missing or hidden", () => {
    const followed = createTestTicker("AAPL", "Apple", { watchlists: ["watchlist:tech"], portfolios: ["portfolio:main"] });
    expect(menuLabels(menu(followed, alertsRegistry().registry))).toEqual([
      "Open {symbol} Ticker Research", "Open {symbol} in New Floating Ticker Research", "Copy Symbol",
      "Add to Watchlist...", "Add to Portfolio...", "Add Alert...", "Remove from Watchlist...", "Remove from Portfolio...",
      "Thesis",
    ].map((label) => label.replace("{symbol}", "AAPL")));

    // A disabled plugin keeps its command registered: the item goes with the plugin, not with the command.
    expect(addAlertItem(followed, alertsRegistry({ disabledPlugins: ["alerts"] }).registry)).toBeUndefined();
    expect(addAlertItem(followed, alertsRegistry({ command: null }).registry)).toBeUndefined();
    expect(addAlertItem(followed, alertsRegistry({ command: { hidden: () => true } }).registry)).toBeUndefined();
    expect(addAlertItem(followed, null as unknown as PluginRegistry)).toBeUndefined();
  });

  test("opens Add Alert's form with the row's listing and adds nothing; a window without the form says where to open it", async () => {
    const { registry, executed, notes } = alertsRegistry();
    const asx = createTestTicker("BHP:XASX", "BHP Group Limited", { exchange: "ASX", currency: "AUD" });

    expect(await selectAddAlert(asx, registry)).toEqual([
      { kind: "plugin-command", commandId: "set-alert", values: { symbol: "BHP:ASX" } },
    ]);
    expect(executed).toEqual([]);
    expect(notes).toEqual([]);

    expect(await selectAddAlert(asx, registry, false)).toHaveLength(1);
    expect(executed).toEqual([]);
    expect(notes).toEqual([{ body: "Open this from the main window.", type: "info" }]);
  });

  test("the form's symbol is read as the row's own listing, never the same symbol's US ADR", async () => {
    // Followed rows as the store keeps them: BHP's NYSE ADR under the bare key and its Sydney line under the
    // venue's code; Sanofi in Paris under the bare SAN, which Banco Santander's ADR trades as on NYSE.
    const rows = [
      createTestTicker("BHP", "BHP Group Limited ADR", { exchange: "NYSE" }),
      createTestTicker("BHP:XASX", "BHP Group Limited", { exchange: "ASX", currency: "AUD" }),
      createTestTicker("SAN", "Sanofi", { exchange: "EPA", currency: "EUR" }),
    ];
    const listing = (symbol: string, name: string, exchange: string, currency = "USD") => ({
      providerId: "test", symbol, name, exchange, currency, type: "Common Stock",
    });
    const listings = [
      listing("BHP", "BHP Group Limited ADR", "NYSE"), listing("BHP", "BHP Group Limited", "ASX", "AUD"),
      listing("SAN", "Banco Santander, S.A. Sponsored ADR", "NYSE"), listing("SAN", "Sanofi SA", "EPA", "EUR"),
    ];
    const quotes: Record<string, Quote> = Object.fromEntries(listings.map((row) => [
      `${row.symbol}:${row.exchange}`,
      createTestQuote({ symbol: row.symbol, name: row.name, currency: row.currency, listingExchangeName: row.exchange, instrumentType: "EQUITY" }),
    ]));
    const deps = {
      store: {
        loadTicker: async (symbol: string) => rows.find((row) => row.metadata.ticker === symbol.toUpperCase()) ?? null,
        loadAllTickers: async () => rows,
      },
      dataProvider: createTestDataProvider({
        search: async (query) => listings.filter((row) => row.symbol === query.trim().toUpperCase().split(":")[0]),
        getQuote: async (symbol, exchange) => {
          const quote = quotes[symbol.includes(":") ? symbol : `${symbol}:${exchange || "NYSE"}`];
          if (!quote) throw new Error(`No quote for ${symbol}`);
          return quote;
        },
      }),
    };
    const { registry } = alertsRegistry();
    const prefilled = async (row: TickerRecord) => {
      const [request] = await selectAddAlert(row, registry);
      return request?.kind === "plugin-command" ? request.values?.symbol ?? "" : "";
    };

    for (const [row, symbol, name] of [
      [rows[0]!, "BHP:NYSE", "BHP Group Limited ADR"],
      [rows[1]!, "BHP:ASX", "BHP Group Limited"],
      [rows[2]!, "SAN:EPA", "Sanofi SA"],
    ] as const) {
      expect(await prefilled(row)).toBe(symbol);
      const read = await resolveAlertListing(symbol, null, deps);
      expect({ key: read.listing.key, name: read.quote.name }).toEqual({ key: symbol, name });
    }
    // The bare key the Sanofi row is saved under is Santander's ADR to Add Alert, the alert the menu must not set.
    expect((await resolveAlertListing("SAN", null, deps)).quote.name).toBe("Banco Santander, S.A. Sponsored ADR");
  });
});
