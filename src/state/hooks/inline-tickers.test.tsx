import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { setSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../market-data/coordinator";
import { buildQuoteKey } from "../../market-data/selectors";
import { createIdleEntry, type QueryEntry } from "../../market-data/result-types";
import type { InstrumentRef } from "../../market-data/request-types";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { InlineTickerBadge } from "../../components/ticker/badge";
import { setSharedRegistryForTests, type PluginRegistry } from "../../plugins/registry";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { AppContext, appReducer, createInitialState, type AppAction, type AppState } from "../app/context";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import { createStaticAppStore } from "../../test-support/app-store";
import { INLINE_TICKER_STREAM_WEIGHT, useInlineTickers } from "./inline-tickers";
import { resetInlineTickerFailures } from "./inline-ticker-failures";
import { createTestTicker } from "../../test-support/ticker";

const tui = createOpenTuiTestHarness();

function InlineTickerHarness({ liveQuotes = true }: { liveQuotes?: boolean }) {
  const { catalog } = useInlineTickers(["$LGD1L"], { liveQuotes });
  return <text>{catalog.LGD1L?.status ?? "none"}</text>;
}

/** Lookups leave on a timer, so settle real time, not just the microtask queue. */
async function renderUntil(status: string): Promise<string> {
  let frame = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await tui.setup().renderOnce();
    });
    frame = tui.frame();
    if (frame.includes(status)) break;
  }
  return frame;
}

afterEach(() => {
  resetInlineTickerFailures();
  setSharedMarketDataCoordinator(null);
  setSharedRegistryForTests(undefined);
});

describe("useInlineTickers", () => {
  test("keeps the badge for a ticker the provider cannot quote, and stops asking", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-inline-tickers-test");
    const state = createInitialState(config);
    state.tickers.set("LGD1L", createTestTicker("LGD1L", "Unsupported quote", { broker_contracts: [] }));
    const actions: unknown[] = [];
    setSharedRegistryForTests({
      marketData: {
        getQuote: async () => {
          throw new Error("No quote provider available for LGD1L");
        },
      },
      pinTicker: () => {},
    } as unknown as PluginRegistry);

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state, (action) => actions.push(action))}>
          <InlineTickerHarness />
        </AppContext>,
        { width: 20, height: 1 },
      );
    });

    expect(await renderUntil("ready")).toContain("ready");
    expect(actions).toEqual([]);
  });

  test("can resolve inline ticker badges without live quote lookups", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-inline-tickers-static-test");
    const state = createInitialState(config);
    state.tickers.set("LGD1L", createTestTicker("LGD1L", "Static badge", { broker_contracts: [] }));
    let quoteCalls = 0;
    setSharedRegistryForTests({
      marketData: {
        getQuote: async () => {
          quoteCalls += 1;
          throw new Error("quotes should be disabled");
        },
      },
      pinTicker: () => {},
    } as unknown as PluginRegistry);

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <InlineTickerHarness liveQuotes={false} />
        </AppContext>,
        { width: 20, height: 1 },
      );
    });

    await act(async () => {
      await tui.setup().renderOnce();
      await Promise.resolve();
    });

    expect(tui.frame()).toContain("ready");
    expect(quoteCalls).toBe(0);
  });

  test("a symbol with several listings stays a badge instead of failing", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-inline-tickers-ambiguous-test");
    const state = createInitialState(config);
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [
          { providerId: "test", symbol: "LGD1L", name: "Listing one", exchange: "NYSE", currency: "USD", type: "EQUITY" },
          { providerId: "test", symbol: "LGD1L", name: "Listing two", exchange: "TSX", currency: "CAD", type: "EQUITY" },
        ],
        getQuote: async () => {
          throw new Error("Quote unavailable");
        },
      }),
      pinTicker: () => {},
    } as unknown as PluginRegistry);

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <InlineTickerHarness />
        </AppContext>,
        { width: 20, height: 1 },
      );
    });

    expect(await renderUntil("ambiguous")).toContain("ambiguous");
  });

  test("streams badges as low-priority background targets and redraws only the badge on a tick", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-inline-tickers-badge-quotes-test");
    const state = createInitialState(config);
    state.tickers.set("AAPL", createTestTicker("AAPL", "Apple", { broker_contracts: [] }));
    // A store with the shape the hooks read: entries, per-key versions and listeners.
    const entries = new Map<string, QueryEntry<Quote>>();
    const versions = new Map<string, number>();
    const listeners = new Map<string, Set<() => void>>();
    const streamed: QuoteSubscriptionTarget[][] = [];
    const setQuote = (quote: Quote) => {
      const key = buildQuoteKey({ symbol: "AAPL", exchange: "NASDAQ", instrument: null });
      entries.set(key, { ...createIdleEntry<Quote>(), phase: "ready", data: quote, lastGoodData: quote });
      versions.set(key, (versions.get(key) ?? 0) + 1);
      for (const listener of listeners.get(key) ?? []) listener();
    };
    const coordinator = {
      subscribeQuotes: (targets: Array<{ instrument: InstrumentRef; priority: Omit<QuoteSubscriptionTarget, "symbol"> }>) => {
        streamed.push(targets.map(({ instrument, priority }) => ({ symbol: instrument.symbol, ...priority })));
        return () => {};
      },
      subscribeKeys: (keys: readonly string[], listener: () => void) => {
        for (const key of keys) {
          const set = listeners.get(key) ?? new Set();
          set.add(listener);
          listeners.set(key, set);
        }
        return () => {
          for (const key of keys) listeners.get(key)?.delete(listener);
        };
      },
      getKeysVersion: (keys: readonly string[]) => keys.reduce((total, key) => total + (versions.get(key) ?? 0), 0),
      getVersion: () => 0,
      subscribe: () => () => {},
      getQuoteEntry: (instrument: InstrumentRef) => entries.get(buildQuoteKey(instrument)) ?? createIdleEntry<Quote>(),
      loadQuotesBatch: async () => [],
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);
    setSharedRegistryForTests({ marketData: createTestDataProvider(), pinTicker: () => {} } as unknown as PluginRegistry);
    const quote = (changePercent: number): Quote => ({
      symbol: "AAPL", price: 200, change: 2, changePercent, currency: "USD", lastUpdated: Date.now(),
    });
    setQuote(quote(1.23));

    let hostRenders = 0;
    function Host() {
      hostRenders += 1;
      const { catalog, openTicker } = useInlineTickers(["$AAPL"], { badgeQuotes: true });
      const entry = catalog.AAPL;
      return entry ? <InlineTickerBadge symbol="AAPL" entry={entry} onOpen={openTicker} /> : <text>none</text>;
    }

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <Host />
        </AppContext>,
        { width: 20, height: 1 },
      );
    });
    expect(await renderUntil("+1.2%")).toContain("AAPL +1.2%");
    expect(streamed.at(-1)).toEqual([expect.objectContaining({
      symbol: "AAPL",
      surface: "inline",
      visible: false,
      weight: INLINE_TICKER_STREAM_WEIGHT,
    })]);

    const rendersBeforeTick = hostRenders;
    await act(async () => {
      setQuote(quote(3.45));
    });
    expect(await renderUntil("+3.5%")).toContain("AAPL +3.5%");
    expect(hostRenders).toBe(rendersBeforeTick);
  });

  test("a chat message's $7203:TSE, $247540:KRX and $SAN:EURONEXT badge the listing each symbol trades on", async () => {
    const listed: Record<string, Array<[exchange: string, name: string]>> = {
      "7203": [["JPX", "Toyota Motor Corporation"]],
      "247540": [["KOSDAQ", "EcoPro BM Co., Ltd."]],
      SAN: [["NYSE", "Banco Santander, S.A."], ["EPA", "Sanofi"]],
      RY: [["TSX", "Royal Bank of Canada"], ["NYSE", "Royal Bank of Canada"]],
    };
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async (query) => (listed[query.split(":")[0]!.toUpperCase()] ?? []).map(([exchange, name]) => ({
          providerId: "test", symbol: query.split(":")[0]!.toUpperCase(), name, exchange, currency: "USD", type: "EQUITY",
        })),
        getQuote: async () => { throw new Error("TSE read as Toronto"); },
      }),
      tickerRepository: new JsonTickerRepository(),
      events: { emit() {} },
      pinTicker: () => {},
    } as unknown as PluginRegistry);
    // A store that applies what the hook dispatches, as AppProvider does.
    let state: AppState = createInitialState(createDefaultConfig("/tmp/gloomberb-inline-tickers-listing-test"));
    const listeners = new Set<() => void>();
    const store = {
      dispatch: (action: AppAction) => {
        state = appReducer(state, action);
        for (const listener of listeners) listener();
      },
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    const message = "Toyota $7203:TSE, EcoPro BM $247540:KRX, Sanofi $SAN:EURONEXT and RBC $RY:TSE.";
    function ChatMessage() {
      const { catalog } = useInlineTickers([message], { liveQuotes: false });
      const read = ["7203:TSE", "247540:KRX", "SAN:EURONEXT", "RY:TSE"].map((tag) => catalog[tag]?.ticker?.metadata.ticker ?? "?");
      return <text>{read.join(" ")}</text>;
    }

    await act(async () => {
      await tui.render(<AppContext value={store}><ChatMessage /></AppContext>, { width: 60, height: 1 });
    });

    expect(await renderUntil("7203:JPX 247540:KOSDAQ SAN:EPA RY:TSX")).toContain("7203:JPX 247540:KOSDAQ SAN:EPA RY:TSX");
  });
});

