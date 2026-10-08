import { describe, expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { loadPeBandInputs } from "./client";

const now = Date.now();
const closes: PricePoint[] = [{ date: new Date(now - 7 * 86_400_000), close: 100 }];
const coordinator = { loadChart: async () => ({ phase: "ready", data: closes, lastGoodData: closes, source: "test", fetchedAt: now,
  staleAt: now + 60_000, error: null, attempts: [] } satisfies QueryEntry<PricePoint[]>) } as unknown as MarketDataCoordinator;
const provider = (quote: Partial<Quote>) => createTestDataProvider({ getTickerFinancials: async () => createTestFinancials({ quote: createTestQuote(quote) }) });
const report = (symbol: string, date: string, fiscalPeriod: string | null) => ({ symbol, name: null, date, timing: null, timingSource: null,
  reportedAt: null, fiscalPeriod, marketCap: null, epsEstimate: null, epsActual: 1.2, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
  implied: null, realized: null, revenueActual: null });
const history = (symbol: string): EarningsHistoryPayload => ({ asOf: new Date(now).toISOString(), symbol, name: null,
  reports: [report(symbol, "2020-01-30", "2019-12"), report(symbol, "2020-04-30", null)] });
const recorder = (answer: (symbol: string) => Promise<EarningsHistoryPayload>) => {
  const calls: Array<[string, number | undefined]> = [];
  return { calls, getCloudEarningsHistory: (symbol: string, limit?: number) => { calls.push([symbol, limit]); return answer(symbol); } };
};

describe("P/E band inputs", () => {
  test("ask US listings for every report the server has, by the exchange named or the one the quote lists on", async () => {
    const named = recorder(async (symbol) => history(symbol));
    const byExchange = await loadPeBandInputs({ instrument: { symbol: "AAPL", exchange: "NASDAQ" } }, provider({}), coordinator, named);
    expect(named.calls).toEqual([["AAPL", 40]]);
    // The one report with a fiscal quarter, nothing else.
    expect(byExchange.reports).toEqual([{ date: "2020-01-30", fiscalPeriod: "2019-12", reportedAt: null }]);

    const quoted = recorder(async (symbol) => history(symbol));
    const bySymbol = await loadPeBandInputs({ instrument: { symbol: "AAPL" } }, provider({ listingExchangeName: "NYSE" }), coordinator, quoted);
    expect(quoted.calls).toEqual([["AAPL", 40]]);
    expect(bySymbol.reports).toHaveLength(1);
  });

  test("leave listings elsewhere alone, and carry on without reports when the history fails or is empty", async () => {
    const elsewhere = recorder(async (symbol) => history(symbol));
    for (const [instrument, quote] of [[{ symbol: "SAP.DE", exchange: "XETRA" }, {}], [{ symbol: "7203.T" }, { exchangeName: "JPX" }]] as const) {
      const inputs = await loadPeBandInputs({ instrument }, provider(quote), coordinator, elsewhere);
      expect(inputs).toMatchObject({ reports: [], error: null, historyError: null });
    }
    expect(elsewhere.calls).toEqual([]);

    for (const answer of [async () => { throw new Error("offline"); }, async (symbol: string) => ({ ...history(symbol), reports: [] })]) {
      const inputs = await loadPeBandInputs({ instrument: { symbol: "AAPL", exchange: "NASDAQ" } }, provider({}), coordinator, recorder(answer));
      expect(inputs).toMatchObject({ reports: [], error: null, historyError: null });
      expect(inputs.financials).not.toBeNull();
    }
  });
});
