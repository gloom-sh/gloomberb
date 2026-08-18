import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { MarketDataRequestContext, QuoteBatchResult } from "../../../types/data-provider";
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

function Probe({ intervalMs }: { intervalMs: number }) {
  const board = useQuoteBoard(SYMBOLS, intervalMs);
  quotes = board.quotes;
  refreshBoard = board.refresh;
  return <Text>{`${board.quotes.size}`}</Text>;
}

function Harness({ provider, intervalMs }: { provider: object; intervalMs: number }) {
  const runtime = useMemo(
    () => ({ getMarketData: () => provider }) as unknown as PluginRuntimeAccess,
    [provider],
  );
  return (
    <PluginRenderProvider runtime={runtime} pluginId="test">
      <Probe intervalMs={intervalMs} />
    </PluginRenderProvider>
  );
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  quotes = new Map();
  refreshBoard = () => {};
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

async function mount(provider: object, intervalMs = 10_000) {
  testSetup = await testRender(<Harness provider={provider} intervalMs={intervalMs} />, {
    width: 40,
    height: 6,
  });
  await settle();
}

async function settle(waitMs = 0) {
  await act(async () => {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
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

    // The poll is a refresh too, so it must bypass the provider cache as well.
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
