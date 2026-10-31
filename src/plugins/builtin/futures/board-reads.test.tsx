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

// Seventy-odd rows ask for a history and their terms each. Asked in one moment, the API client sends each kind in a
// few batch requests; asked a few at a time, as the board once did, they go out as seventy-odd requests apiece.
test("a board asks every row's contract history and terms in one moment, and every read is answered", async () => {
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
  const lastUpdated = Date.parse("2026-10-30T18:00:00Z");
  const quotes: BoardQuoteMap = new Map(FUTURES_CONTRACTS.map((contract) => [contract.symbol, {
    quote: { symbol: contract.symbol, name: contract.name, price: 1, change: 0, changePercent: 0, currency: "USD", lastUpdated } as Quote,
    loading: false, error: null, stale: false,
  }]));
  const provider = { getPriceHistory: () => hold<PricePoint[]>([]) } as unknown as DataProvider;
  const terms = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(() => hold(null as unknown as FuturesContractTermsPayload));
  function Probe() {
    useFrontContractReturns(FUTURES_CONTRACTS, quotes, provider, true);
    useFuturesBoardTerms(FUTURES_CONTRACTS, true);
    return null;
  }
  try {
    await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
    await act(async () => { await Bun.sleep(5); });
    const rows = FUTURES_CONTRACTS.length;
    expect(terms).toHaveBeenCalledTimes(rows);
    expect(asked).toBeGreaterThan(rows + 12);
    expect(most).toBe(asked);
    for (let turn = 0; held.length > 0 && turn < 1_000; turn += 1) {
      await act(async () => {
        held.shift()!();
        await Bun.sleep(0);
      });
    }
    expect(held).toHaveLength(0);
  } finally {
    // The limit is the module's: a read left held would keep its place from the next test.
    while (held.length > 0) held.shift()!();
    await act(async () => { await Bun.sleep(5); });
    terms.mockRestore();
  }
});
