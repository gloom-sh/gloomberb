import { expect, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { loadFxBoard } from "./client";
import { projectFxCrosses } from "./headless";

test("crosses read each leg as the pane does: a newer pair quote with a close moves it, a snapshot rate never does", async () => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const quote = (symbol: string, price: number, previousClose: number, minutesAgo: number): Quote => ({
    symbol, price, previousClose, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: now - minutesAgo * 60_000, dataSource: "delayed",
  } as Quote);
  const provider = {
    // EUR's snapshot is older than its quote; JPY's quote is older than its snapshot.
    getExchangeRateSnapshot: async (currency: string) => {
      if (currency === "GBP") throw new Error("no rate");
      return { fromCurrency: currency, toCurrency: "USD", rate: currency === "EUR" ? 1.1 : 1 / 150,
        source: "test", asOf: at(currency === "EUR" ? 30 : 5), fetchedAt: at(0), stale: false };
    },
    getQuotesBatch: async (targets: { symbol: string }[]) => targets.map((target) => ({ target, quote:
      target.symbol === "EURUSD=X" ? quote("EURUSD=X", 1.2, 1.18, 10)
        : target.symbol === "JPY=X" ? quote("JPY=X", 140, 141, 60) : null })),
  } as unknown as DataProvider;

  const result = projectFxCrosses(["USD", "EUR", "JPY", "GBP"], await loadFxBoard(["USD", "EUR", "JPY", "GBP"], provider), now);
  const row = (pair: string) => result.rows.find((candidate) => candidate.pair === pair)!;

  expect(row("EUR/USD")).toMatchObject({ rate: 1.2, asOf: at(10), stale: false, dataSource: "delayed" });
  expect(row("EUR/USD").movePercent).toBeCloseTo((1.2 / 1.18 - 1) * 100, 10);
  // JPY kept its newer snapshot rate, which has no previous close: no move on any JPY cross.
  expect(row("EUR/JPY")).toMatchObject({ movePercent: null, asOf: at(10) });
  expect(row("EUR/JPY").rate).toBeCloseTo(180, 10);
  expect(row("EUR/JPY").dataSource).toBeUndefined();
  // A leg with no rate leaves its crosses unavailable, never at parity.
  expect(row("GBP/USD")).toMatchObject({ rate: null, movePercent: null });
  expect(result.unavailableSymbols).toEqual(["GBP"]);
  expect(result.complete).toBe(false);
  expect(result.errors).toEqual(["GBP: no rate"]);
});
