import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
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
import { AppContext, createInitialState } from "../app/context";
import { INLINE_TICKER_STREAM_WEIGHT, useInlineTickers } from "./inline-tickers";
import { resetInlineTickerFailures } from "./inline-ticker-failures";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

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
      await testSetup!.renderOnce();
    });
    frame = testSetup!.captureCharFrame();
    if (frame.includes(status)) break;
  }
  return frame;
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
  }
  testSetup = undefined;
  resetInlineTickerFailures();
  setSharedMarketDataCoordinator(null);
  setSharedRegistryForTests(undefined);
});

describe("useInlineTickers", () => {
  test("keeps the badge for a ticker the provider cannot quote, and stops asking", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-inline-tickers-test");
    const state = createInitialState(config);
    state.tickers.set("LGD1L", {
      metadata: {
        ticker: "LGD1L",
        exchange: "NASDAQ",
        currency: "USD",
        name: "Unsupported quote",
        portfolios: [],
        watchlists: [],
        positions: [],
        broker_contracts: [],
        custom: {},
        tags: [],
      },
    });
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
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
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
    state.tickers.set("LGD1L", {
      metadata: {
        ticker: "LGD1L",
        exchange: "NASDAQ",
        currency: "USD",
        name: "Static badge",
        portfolios: [],
        watchlists: [],
        positions: [],
        broker_contracts: [],
        custom: {},
        tags: [],
      },
    });
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
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: () => {} }}>
          <InlineTickerHarness liveQuotes={false} />
        </AppContext>,
        { width: 20, height: 1 },
      );
    });

    await act(async () => {
      await testSetup!.renderOnce();
      await Promise.resolve();
    });

    expect(testSetup!.captureCharFrame()).toContain("ready");
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
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: () => {} }}>
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
    state.tickers.set("AAPL", {
      metadata: {
        ticker: "AAPL",
        exchange: "NASDAQ",
        currency: "USD",
        name: "Apple",
        portfolios: [],
        watchlists: [],
        positions: [],
        broker_contracts: [],
        custom: {},
        tags: [],
      },
    });
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
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: () => {} }}>
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
});
