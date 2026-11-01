import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { resetFuturesBoardTerms, useFuturesBoardTerms } from "./use-board-terms";
import { resetFrontContractReturns, useFrontContractReturns } from "./use-front-returns";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  resetFuturesBoardTerms();
  resetFrontContractReturns();
});

/** Every row's quote, priced now, so each row asks for its contract's history. */
function boardQuotes(): BoardQuoteMap {
  const lastUpdated = Date.parse("2026-10-30T18:00:00Z");
  return new Map(FUTURES_CONTRACTS.map((contract) => [contract.symbol, {
    quote: { symbol: contract.symbol, name: contract.name, price: 1, change: 0, changePercent: 0, currency: "USD", lastUpdated } as Quote,
    loading: false, error: null, stale: false,
  }]));
}

// Seventy-odd rows ask for a history and their terms each; twelve reads at a time is the board's whole share, not each hook's,
// wherever the reads go out one by one.
test("a board's contract histories and terms share one limit of twelve reads at a time, and every read gets its turn", async () => {
  let running = 0;
  let most = 0;
  let asked = 0;
  const held: Array<() => void> = [];
  const hold = <T,>(value: T) => new Promise<T>((resolve) => {
    asked += 1;
    running += 1;
    most = Math.max(most, running);
    held.push(() => {
      running -= 1;
      resolve(value);
    });
  });
  const quotes = boardQuotes();
  const provider = { getPriceHistory: () => hold<PricePoint[]>([]) } as unknown as DataProvider;
  const terms = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(() => hold(null as unknown as FuturesContractTermsPayload));
  // A service without the terms batch route.
  const batching = spyOn(apiClient, "batchesReads").mockReturnValue(false);
  function Probe() {
    useFrontContractReturns(FUTURES_CONTRACTS, quotes, provider, true);
    useFuturesBoardTerms(FUTURES_CONTRACTS, true);
    return null;
  }
  try {
    await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
    await act(async () => { await Bun.sleep(5); });
    expect(asked).toBe(12);
    for (let turn = 0; held.length > 0 && turn < 1_000; turn += 1) {
      await act(async () => {
        held.shift()!();
        await Bun.sleep(0);
      });
    }
    expect(held).toHaveLength(0);
    expect(most).toBe(12);
    // Every row's terms, and past twelve histories as well, so a limit for each would have run twenty-four: all read in turn.
    expect(terms).toHaveBeenCalledTimes(FUTURES_CONTRACTS.length);
    expect(asked - FUTURES_CONTRACTS.length).toBeGreaterThan(12);
  } finally {
    // The limit is the module's: a read left held would keep its place from the next test.
    while (held.length > 0) held.shift()!();
    await act(async () => { await Bun.sleep(5); });
    terms.mockRestore();
    batching.mockRestore();
  }
});

// Reads that go out in batch requests are asked in one moment, for the client to send sixteen a request.
test("a board whose terms and histories go out in batch requests asks every row's at once", async () => {
  let asked = 0;
  const held: Array<() => void> = [];
  const hold = <T,>(value: T) => new Promise<T>((resolve) => {
    asked += 1;
    held.push(() => resolve(value));
  });
  const contexts: unknown[] = [];
  const provider = { batchesReads: async () => true, getPriceHistory: (_symbol: string, _exchange: string, _range: string, context: unknown) => {
    contexts.push(context);
    return hold<PricePoint[]>([]);
  } } as unknown as DataProvider;
  const terms = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(() => hold(null as unknown as FuturesContractTermsPayload));
  const batching = spyOn(apiClient, "batchesReads").mockReturnValue(true);
  const quotes = boardQuotes();
  function Probe() {
    useFrontContractReturns(FUTURES_CONTRACTS, quotes, provider, true);
    useFuturesBoardTerms(FUTURES_CONTRACTS, true);
    return null;
  }
  try {
    await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
    await act(async () => { await Bun.sleep(5); });
    expect(terms).toHaveBeenCalledTimes(FUTURES_CONTRACTS.length);
    // Every row's terms and more than twelve histories in flight, none answered yet: nothing held back.
    expect(asked).toBeGreaterThan(FUTURES_CONTRACTS.length + 12);
    // Each marked as asked with the others, which is what the client batches.
    expect(contexts.every((context) => (context as { batch?: boolean }).batch === true)).toBe(true);
    expect(terms.mock.calls.every(([, options]) => options?.batch === true)).toBe(true);
  } finally {
    while (held.length > 0) held.shift()!();
    await act(async () => { await Bun.sleep(5); });
    terms.mockRestore();
    batching.mockRestore();
  }
});
