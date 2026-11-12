import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { MarketDataRequestContext, QuoteBatchOptions, QuoteBatchResult, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { Text } from "../../../ui";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import {
  quoteBoardFooterInfo,
  quoteBoardStatus,
  useQuoteBoard,
  type BoardQuoteMap,
} from "./use-quote-board";

const SYMBOLS = ["^GSPC", "^FTSE"];
const POLL_MS = 40;

function quote(symbol: string, price: number): Quote {
  return {
    symbol,
    price,
    change: 1,
    changePercent: 1,
    marketState: "REGULAR",
    lastUpdated: 1_700_000_000_000,
  } as Quote;
}

interface BatchCall {
  symbols: string[];
  forceRefresh: boolean | undefined;
}

/** Batch-capable provider whose next answer the test swaps between loads. */
function batchProvider(reply: () => QuoteBatchResult[] | Error) {
  const calls: BatchCall[] = [];
  const provider = {
    getQuotesBatch: async (
      targets: Array<{ symbol: string }>,
      options?: { forceRefresh?: boolean },
    ): Promise<QuoteBatchResult[]> => {
      calls.push({
        symbols: targets.map((target) => target.symbol),
        forceRefresh: options?.forceRefresh,
      });
      const answer = reply();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { provider, calls };
}

let quotes: BoardQuoteMap = new Map();
let refreshBoard: () => void = () => {};
let setBoardSymbols: (symbols: string[]) => void = () => {};
let setBoardProvider: (provider: object | null) => void = () => {};

function Probe({ intervalMs, symbols }: { intervalMs: number; symbols: string[] }) {
  const board = useQuoteBoard(symbols, { fallbackIntervalMs: intervalMs });
  quotes = board.quotes;
  refreshBoard = board.refresh;
  return <Text>{`${board.quotes.size}`}</Text>;
}

function Harness({ provider, intervalMs }: { provider: object; intervalMs: number }) {
  const [symbols, setSymbols] = useState(SYMBOLS);
  const [activeProvider, setProvider] = useState<object | null>(provider);
  setBoardSymbols = setSymbols;
  setBoardProvider = setProvider;
  const runtime = useMemo(
    () => ({ getMarketData: () => activeProvider }) as unknown as PluginRuntimeAccess,
    [activeProvider],
  );
  return (
    <PluginRenderProvider runtime={runtime} pluginId="test">
      <Probe intervalMs={intervalMs} symbols={symbols} />
    </PluginRenderProvider>
  );
}

const tui = createOpenTuiTestHarness();

afterEach(() => {
  quotes = new Map();
  refreshBoard = () => {};
});

async function mount(provider: object, intervalMs = 10_000) {
  await tui.render(<Harness provider={provider} intervalMs={intervalMs} />, {
    width: 40,
    height: 6,
  });
  await settle();
}

async function settle(waitMs = 0) {
  await act(async () => {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

describe("useQuoteBoard cache bypass", () => {
  test("serves the cache on open, then forces every refresh after it", async () => {
    const { provider, calls } = batchProvider(() => (
      SYMBOLS.map((symbol) => ({ target: { symbol, exchange: "" }, quote: quote(symbol, 100) }))
    ));
    await mount(provider, POLL_MS);

    // Opening a pane may paint from cache; a refresh that returns cache is a lie.
    expect(calls[0]).toEqual({ symbols: SYMBOLS, forceRefresh: false });

    await act(async () => {
      refreshBoard();
    });
    await settle();
    expect(calls[1]?.forceRefresh).toBe(true);

    // The fallback poll is a refresh too, so it must bypass the provider cache as well.
    await settle(POLL_MS * 2);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.slice(1).every((call) => call.forceRefresh === true)).toBe(true);
  });

  test("the serial fallback asks for a fresh quote the same way", async () => {
    const contexts: Array<MarketDataRequestContext | undefined> = [];
    const provider = {
      getQuote: async (symbol: string, _exchange?: string, context?: MarketDataRequestContext) => {
        contexts.push(context);
        return quote(symbol, 100);
      },
    };
    await mount(provider);

    await act(async () => {
      refreshBoard();
    });
    await settle();

    expect(contexts.slice(0, SYMBOLS.length).every((context) => context === undefined)).toBe(true);
    expect(contexts.slice(SYMBOLS.length).every((context) => context?.cacheMode === "refresh"))
      .toBe(true);
  });
});

describe("useQuoteBoard failure handling", () => {
  test("keeps the last good quote and reports it stale instead of blanking", async () => {
    let fail = false;
    const { provider } = batchProvider(() => (
      fail
        ? SYMBOLS.map((symbol) => ({
          target: { symbol, exchange: "" },
          quote: null,
          error: new Error("upstream 503"),
        }))
        : SYMBOLS.map((symbol) => ({ target: { symbol, exchange: "" }, quote: quote(symbol, 100) }))
    ));
    await mount(provider);
    expect(quotes.get("^GSPC")?.quote?.price).toBe(100);

    fail = true;
    await act(async () => {
      refreshBoard();
    });
    await settle();

    const state = quotes.get("^GSPC");
    expect(state?.quote?.price).toBe(100);
    expect(state?.stale).toBe(true);
    expect(state?.error).toBe("upstream 503");

    const status = quoteBoardStatus(quotes);
    expect(status).toMatchObject({ loading: 0, stale: 2, unavailable: 0 });
    expect(quoteBoardFooterInfo(status).map((segment) => segment.id))
      .toEqual(["stale", "fresh"]);
  });

  test("a whole batch call that throws still leaves the board readable", async () => {
    let fail = false;
    const { provider } = batchProvider(() => (
      fail
        ? new Error("network down")
        : SYMBOLS.map((symbol) => ({ target: { symbol, exchange: "" }, quote: quote(symbol, 100) }))
    ));
    await mount(provider);

    fail = true;
    await act(async () => {
      refreshBoard();
    });
    await settle();

    expect(quotes.get("^FTSE")?.quote?.price).toBe(100);
    expect(quotes.get("^FTSE")?.stale).toBe(true);
    expect(quoteBoardStatus(quotes).stale).toBe(2);
  });

  test("a symbol that never resolved reports unavailable without requiring an error", async () => {
    const { provider } = batchProvider(() => SYMBOLS.map((symbol) => ({
      target: { symbol, exchange: "" },
      quote: symbol === "^GSPC" ? quote(symbol, 100) : null,
    })));
    await mount(provider);

    expect(quotes.get("^FTSE")?.quote).toBeNull();
    const status = quoteBoardStatus(quotes);
    expect(status).toMatchObject({ stale: 0, unavailable: 1 });
    expect(quoteBoardFooterInfo(status).map((segment) => segment.id)).toEqual(["error", "fresh"]);
  });
});

describe("useQuoteBoard cache first", () => {
  test("paints cached quotes, refreshes only listed rows, and a batch that never answers keeps its cached quotes, stale", async () => {
    // Twelve symbols refresh as a batch of eight and one of three; H0 never answers, Z is not listed.
    const symbols = [...Array.from({ length: 11 }, (_, index) => `H${index}`), "Z"];
    const cached = (symbol: string) => ({ ...quote(symbol, 1), lastUpdated: 1_600_000_000_000 });
    const refreshed: string[][] = [];
    const provider = {
      getQuotesBatch: (targets: QuoteSubscriptionTarget[], options?: { cacheOnly?: boolean }) => {
        if (options?.cacheOnly) return Promise.resolve(targets.map((target) => ({ target, quote: cached(target.symbol) })));
        refreshed.push(targets.map((target) => target.symbol));
        if (targets.some((target) => target.symbol === "H0")) return new Promise<QuoteBatchResult[]>(() => {});
        return Promise.resolve(targets.map((target) => ({ target, quote: quote(target.symbol, 2) })));
      },
    };
    let board: BoardQuoteMap = new Map();
    let list: (listed: ReadonlySet<string>) => void = () => {};
    function CacheFirstProbe() {
      const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set(symbols.slice(0, 11)));
      list = setListed;
      board = useQuoteBoard(symbols, { cacheFirst: true, listedSymbols: listed, refreshTimeoutMs: 40, liveStreaming: false }).quotes;
      return <Text>{`${board.size}`}</Text>;
    }
    const runtime = { getMarketData: () => provider } as unknown as PluginRuntimeAccess;
    await tui.render(<PluginRenderProvider runtime={runtime} pluginId="test"><CacheFirstProbe /></PluginRenderProvider>, { width: 40, height: 6 });
    await settle();

    expect(refreshed).toEqual([symbols.slice(0, 8), symbols.slice(8, 11)]);
    // H0's batch is still out: its rows show the cached quote while the other batch has landed.
    expect(board.get("H1")).toMatchObject({ quote: { price: 1 }, loading: true });
    expect(board.get("H9")).toMatchObject({ quote: { price: 2 }, loading: false, stale: false });
    expect(board.get("Z")).toMatchObject({ quote: null, loading: false });

    await settle(80);
    expect(board.get("H1")).toMatchObject({ quote: { price: 1 }, loading: false, stale: true, error: "Quote refresh timed out" });

    // Listing Z later fetches Z alone.
    await act(async () => list(new Set(symbols)));
    await settle();
    expect(refreshed.at(-1)).toEqual(["Z"]);
    expect(board.get("Z")?.quote?.price).toBe(2);
  });
});

describe("useQuoteBoard follow-ups", () => {
  test("a batch's priced rows paint as it answers; each symbol it leaves fills only its own row, or shows the batch's dated price as stale", async () => {
    const dated = { ...quote("C", 7), lastUpdated: 1_699_990_000_000, stale: true };
    const datedD = { ...quote("D", 9), lastUpdated: 1_699_990_000_000, stale: true };
    const asked: Array<[string, MarketDataRequestContext | undefined]> = [];
    const getQuote = (symbol: string, _exchange?: string, context?: MarketDataRequestContext): Promise<Quote> => {
      asked.push([symbol, context]);
      // B's and D's own reads never answer; C's fails.
      return symbol === "B" || symbol === "D" ? new Promise<Quote>(() => {}) : Promise.reject(new Error("UPSTREAM_ERROR"));
    };
    // Like the router: without deferred follow-ups it answers only once it has asked for B and C alone.
    const provider = {
      getQuote,
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[], options?: QuoteBatchOptions): Promise<QuoteBatchResult[]> => {
        if (options?.cacheOnly) return targets.map((target) => ({ target, quote: null }));
        const answer = (target: QuoteSubscriptionTarget): QuoteBatchResult => target.symbol === "A"
          ? { target, quote: quote("A", 2) }
          : { target, quote: target.symbol === "C" ? dated : target.symbol === "D" ? datedD : null, followUp: "default" };
        if (options?.deferFollowUps) return targets.map(answer);
        return Promise.all(targets.map(async (target) => {
          const result = answer(target);
          if (!result.followUp) return result;
          try { return { target, quote: await getQuote(target.symbol) }; }
          catch { return { target, quote: result.quote }; }
        }));
      },
    };
    const symbols = ["A", "B", "C", "D"];
    let board: BoardQuoteMap = new Map();
    function FollowUpProbe() {
      board = useQuoteBoard(symbols, { cacheFirst: true, refreshTimeoutMs: 40, liveStreaming: false }).quotes;
      return <Text>{`${board.size}`}</Text>;
    }
    const runtime = { getMarketData: () => provider } as unknown as PluginRuntimeAccess;
    await tui.render(<PluginRenderProvider runtime={runtime} pluginId="test"><FollowUpProbe /></PluginRenderProvider>, { width: 40, height: 6 });
    await settle();

    expect(board.get("A")).toMatchObject({ quote: { price: 2 }, loading: false, stale: false });
    expect(board.get("B")).toMatchObject({ quote: null, loading: true });
    expect(board.get("C")).toMatchObject({ quote: { price: 7 }, loading: false, stale: true, error: null });
    // A dated price shows while its own read is out, so what reads the row's contract (FUT's returns) starts on it.
    expect(board.get("D")).toMatchObject({ quote: { price: 9 }, loading: true, stale: true });
    expect(asked.map(([symbol, context]) => [symbol, context?.cacheMode])).toEqual([["B", "default"], ["C", "default"], ["D", "default"]]);

    await settle(80);
    expect(board.get("A")).toMatchObject({ quote: { price: 2 }, stale: false });
    expect(board.get("B")).toMatchObject({ quote: null, loading: false, error: "Quote refresh timed out" });
    expect(board.get("D")).toMatchObject({ quote: { price: 9 }, loading: false, stale: true, error: null });
    expect(quoteBoardStatus(board)).toMatchObject({ loading: 0, stale: 2, unavailable: 1 });
  });
});

describe("useQuoteBoard background top-ups", () => {
  test("a row that has a quote is never marked loading or stale while its symbol is asked for alone", async () => {
    // The poll's batch has only a dated price for each symbol and asks for it alone, a read that never answers here.
    let calls = 0;
    const provider = {
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => {
        calls += 1;
        return targets.map((target) => calls === 1 ? { target, quote: quote(target.symbol, 100) }
          : { target, quote: { ...quote(target.symbol, 90), lastUpdated: 1_699_990_000_000, stale: true }, followUp: "refresh" });
      },
      getQuote: () => new Promise<Quote>(() => {}),
    };
    await mount(provider, POLL_MS);
    expect(quotes.get("^GSPC")).toMatchObject({ quote: { price: 100 }, loading: false, stale: false });

    await settle(POLL_MS * 2);
    expect(calls).toBeGreaterThan(1);
    expect(quotes.get("^GSPC")).toMatchObject({ quote: { price: 100 }, loading: false, stale: false });
    expect(quoteBoardStatus(quotes)).toMatchObject({ loading: 0, stale: 0 });
  });
});

describe("useQuoteBoard late answers", () => {
  /** A cache-first board whose batch and single reads answer when the test says. */
  async function mountPending(symbols: string[]) {
    const batches: Array<(rows: QuoteBatchResult[]) => void> = [];
    const singles = new Map<string, (quote: Quote) => void>();
    const provider = {
      getQuotesBatch: (targets: QuoteSubscriptionTarget[], options?: QuoteBatchOptions) => options?.cacheOnly
        ? Promise.resolve(targets.map((target) => ({ target, quote: null })))
        : new Promise<QuoteBatchResult[]>((resolve) => batches.push(resolve)),
      getQuote: (symbol: string) => new Promise<Quote>((resolve) => singles.set(symbol, resolve)),
    };
    let board: BoardQuoteMap = new Map();
    let reload: () => void = () => {};
    function LateProbe() {
      const result = useQuoteBoard(symbols, { cacheFirst: true, refreshTimeoutMs: 40, liveStreaming: false });
      board = result.quotes;
      reload = result.refresh;
      return <Text>{`${board.size}`}</Text>;
    }
    const runtime = { getMarketData: () => provider } as unknown as PluginRuntimeAccess;
    await tui.render(<PluginRenderProvider runtime={runtime} pluginId="test"><LateProbe /></PluginRenderProvider>, { width: 40, height: 6 });
    await settle();
    return { batches, singles, board: () => board, reload: () => reload() };
  }

  test("a batch that answers after the timeout paints over the timeout error", async () => {
    const { batches, board } = await mountPending(["A", "B"]);
    await settle(80);
    expect(board().get("A")).toMatchObject({ quote: null, loading: false, error: "Quote refresh timed out" });

    await act(async () => batches[0]!([
      { target: { symbol: "A", exchange: "" }, quote: quote("A", 5) },
      { target: { symbol: "B", exchange: "" }, quote: quote("B", 6) },
    ]));
    await settle();
    expect(board().get("A")).toMatchObject({ quote: { price: 5 }, loading: false, error: null, stale: false });
    expect(board().get("B")).toMatchObject({ quote: { price: 6 }, loading: false, error: null, stale: false });
    expect(quoteBoardStatus(board())).toMatchObject({ loading: 0, stale: 0, unavailable: 0 });
  });

  test("a late answer from a load a newer one superseded is dropped", async () => {
    const { batches, board, reload } = await mountPending(["A", "B"]);
    await settle(80);

    await act(async () => reload());
    await settle();
    expect(batches).toHaveLength(2);
    await act(async () => batches[0]!([
      { target: { symbol: "A", exchange: "" }, quote: quote("A", 5) },
      { target: { symbol: "B", exchange: "" }, quote: quote("B", 6) },
    ]));
    await settle();
    expect(board().get("A")).toMatchObject({ quote: null, loading: true });

    await act(async () => batches[1]!([{ target: { symbol: "A", exchange: "" }, quote: quote("A", 7) }, { target: { symbol: "B", exchange: "" }, quote: quote("B", 8) }]));
    await settle();
    expect(board().get("A")?.quote?.price).toBe(7);
  });

  test("a symbol read alone that answers after the timeout paints", async () => {
    const { batches, singles, board } = await mountPending(["A"]);
    await act(async () => batches[0]!([{ target: { symbol: "A", exchange: "" }, quote: null, followUp: "default" }]));
    await settle(80);
    expect(board().get("A")).toMatchObject({ quote: null, loading: false, error: "Quote refresh timed out" });

    await act(async () => singles.get("A")!(quote("A", 9)));
    await settle();
    expect(board().get("A")).toMatchObject({ quote: { price: 9 }, error: null, stale: false });
  });
});

describe("useQuoteBoard target changes", () => {
  test("drops removed quotes and errors while retaining overlapping quotes across pending requests", async () => {
    const pending: Array<(rows: QuoteBatchResult[]) => void> = [];
    const provider = { getQuotesBatch: () => new Promise<QuoteBatchResult[]>((resolve) => pending.push(resolve)) };
    await mount(provider);
    const recent = { ...quote("^GSPC", 100), lastUpdated: 1_700_001_000_000 };
    const retained = quote("^FTSE", 200);
    await act(async () => pending.shift()!([
      { target: { symbol: "^GSPC" }, quote: recent },
      { target: { symbol: "^FTSE" }, quote: retained },
    ]));
    await settle();
    await act(async () => refreshBoard());
    const previousRequest = pending.shift()!;
    await act(async () => setBoardSymbols(["^FTSE", "DX-Y.NYB"]));
    await settle();
    const currentRequest = pending.shift()!;
    expect([...quotes.keys()]).toEqual(["^FTSE", "DX-Y.NYB"]);
    expect(quotes.get("^FTSE")?.quote).toBe(retained);
    expect(quoteBoardStatus(quotes).latestTs).toBe(retained.lastUpdated);
    await act(async () => previousRequest([
      { target: { symbol: "^GSPC" }, quote: null, error: new Error("removed listing failed") },
      { target: { symbol: "^FTSE" }, quote: quote("^FTSE", 999) },
    ]));
    await settle();
    expect([...quotes.keys()]).toEqual(["^FTSE", "DX-Y.NYB"]);
    expect(quotes.get("^FTSE")?.quote).toBe(retained);
    expect(quotes.get("^FTSE")?.loading).toBe(true);
    await act(async () => currentRequest([
      { target: { symbol: "^FTSE" }, quote: null, error: new Error("temporary outage") },
      { target: { symbol: "DX-Y.NYB" }, quote: null, error: new Error("unavailable") },
    ]));
    await settle();
    expect(quoteBoardStatus(quotes)).toMatchObject({ stale: 1, unavailable: 1, loading: 0, latestTs: retained.lastUpdated });
    expect(quotes.get("^FTSE")?.quote).toBe(retained);
    await act(async () => setBoardSymbols(["^FTSE"]));
    await settle();
    expect([...quotes.keys()]).toEqual(["^FTSE"]);
    expect(quoteBoardStatus(quotes).unavailable).toBe(0);
    await act(async () => pending.shift()!([{ target: { symbol: "^FTSE" }, quote: retained }]));
    await settle();
  });

  test("invalidates pending work and prunes selection when the provider disconnects", async () => {
    let finish!: (rows: QuoteBatchResult[]) => void;
    const provider = { getQuotesBatch: () => new Promise<QuoteBatchResult[]>((resolve) => { finish = resolve; }) };
    await mount(provider);
    await act(async () => { setBoardSymbols(["^FTSE"]); setBoardProvider(null); });
    await settle();
    expect([...quotes.keys()]).toEqual(["^FTSE"]);
    expect(quotes.get("^FTSE")?.loading).toBe(false);
    await act(async () => finish(SYMBOLS.map((symbol) => ({ target: { symbol }, quote: quote(symbol, 999) }))));
    await settle();
    expect([...quotes.keys()]).toEqual(["^FTSE"]);
    expect(quotes.get("^FTSE")?.quote).toBeNull();
    await act(async () => setBoardSymbols([]));
    await settle();
    expect(quoteBoardStatus(quotes)).toEqual({ loading: 0, stale: 0, unavailable: 0, latestTs: 0, savedAt: null });
  });
});

describe("useQuoteBoard streaming", () => {
  afterEach(() => {
    setSharedMarketDataCoordinator(null);
  });

  test("rides the shared feed and polls only the symbols the feed is not carrying", async () => {
    let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    let streamed: QuoteSubscriptionTarget[] = [];
    const coordinator = new MarketDataCoordinator(createTestDataProvider({
      subscribeQuotes: (targets, onQuote) => {
        streamed = targets;
        emit = onQuote;
        return () => {};
      },
    }));
    setSharedMarketDataCoordinator(coordinator);
    const { provider, calls } = batchProvider(() => SYMBOLS.map((symbol) => ({
      target: { symbol, exchange: "" },
      quote: quote(symbol, 100),
    })));
    await mount(provider, POLL_MS);

    // Index symbols go out on the feed with the listing the board loads them by.
    expect(streamed.map((target) => [target.symbol, target.exchange])).toEqual([["^FTSE", ""], ["^GSPC", ""]]);
    await act(async () => emit!(streamed.find((target) => target.symbol === "^GSPC")!, {
      ...quote("^GSPC", 101),
      lastUpdated: 1_700_000_060_000,
      delivery: "stream",
    }));
    // Store listeners hear about a change on a zero timer.
    await settle(5);
    expect(quotes.get("^GSPC")?.quote?.price).toBe(101);
    expect(quotes.get("^FTSE")?.quote?.price).toBe(100);

    const before = calls.length;
    await settle(POLL_MS * 3);
    const polls = calls.slice(before);
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((call) => call.forceRefresh === true && call.symbols.join() === "^FTSE")).toBe(true);
    // A late snapshot never replaces the newer streamed quote.
    expect(quotes.get("^GSPC")?.quote?.price).toBe(101);
    coordinator.destroy();
  });

  // A dropped stream read "17 stale" on a board of closed markets whose refresh had just come back.
  test("a dropped stream leaves closed markets current and asks again for the open ones at once; a failed refresh stays stale", async () => {
    let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    let streamed: QuoteSubscriptionTarget[] = [];
    const coordinator = new MarketDataCoordinator(createTestDataProvider({
      subscribeQuotes: (targets, onQuote) => {
        streamed = targets;
        emit = onQuote;
        return () => {};
      },
    }));
    setSharedMarketDataCoordinator(coordinator);
    let failing = false;
    // ^GSPC's source says its session is open; London's calendar says ^FTSE's has not opened.
    const states: Record<string, Quote["marketState"]> = { "^GSPC": "REGULAR", "^FTSE": "CLOSED" };
    const { provider, calls } = batchProvider(() => failing ? new Error("Service unavailable") : SYMBOLS.map((symbol) => ({
      target: { symbol, exchange: "" },
      quote: { ...quote(symbol, 100), marketState: states[symbol] },
    })));
    const random = Math.random;
    Math.random = () => 0;
    // Wed 11 Nov 2026 07:16 UTC, London not yet open; the clock keeps running.
    const realNow = Date.now;
    const offset = Date.parse("2026-11-11T07:16:00Z") - realNow();
    Date.now = () => realNow() + offset;
    try {
      await mount(provider, 60_000);
      await settle(2);
      // The feed's snapshot on subscribe is the same print the board loaded, a moment after it.
      await act(async () => {
        for (const target of streamed) emit!(target, { ...quote(target.symbol, 100), marketState: states[target.symbol], delivery: "stream" });
      });
      await settle(5);

      await act(async () => coordinator.setQuoteStreamDown(Date.now()));
      // The store tells the board on a zero timer, and the board asks on another.
      for (let wait = 0; wait < 40 && calls.length < 2; wait += 1) await settle(5);
      await settle(5);
      // Only the open market is asked for again; the closed one had nothing to bring.
      expect(calls.slice(1).map((call) => call.symbols.join())).toEqual(["^GSPC"]);
      expect(quoteBoardStatus(quotes).stale).toBe(0);

      failing = true;
      await act(async () => refreshBoard());
      await settle(5);
      expect(quotes.get("^GSPC")?.stale).toBe(true);
    } finally {
      Math.random = random;
      Date.now = realNow;
    }
    coordinator.destroy();
  });
});
