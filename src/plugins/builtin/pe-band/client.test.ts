import { describe, expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { CloudMarketResponse, CloudPricePointPayload } from "../../../api-client/types";
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
  return { calls, getCloudEarningsHistory: (symbol: string, limit?: number) => { calls.push([symbol, limit]); return answer(symbol); },
    getCloudHistory: async (): Promise<CloudMarketResponse<CloudPricePointPayload[]>> => { throw new Error("no FX history asked"); } };
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

  test("a dollar price with EPS in another currency loads that pair's daily closes once, from before the oldest statement", async () => {
    const statements = (dates: string[]) => dates.map((date) => ({ date, currency: "TWD", eps: 10 }));
    const adr = createTestDataProvider({ getTickerFinancials: async () => createTestFinancials({ quote: createTestQuote({ currency: "USD" }),
      annualStatements: statements(["2022-12-31", "2023-12-31"]), quarterlyStatements: statements(["2024-03-31"]) }) });
    const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
    const asked: Array<[string, string | undefined]> = [];
    const answer = (data: CloudPricePointPayload[], stale = false) => ({ ...recorder(async (symbol) => history(symbol)),
      getCloudHistory: async (symbol: string, _exchange: string, params?: { startDate?: string }) => {
        asked.push([symbol, params?.startDate]);
        return { status: "success", data, stale } as CloudMarketResponse<CloudPricePointPayload[]>;
      } });
    const closes = [3, 2, 1].map((offset) => ({ date: day(offset), close: 32 } as CloudPricePointPayload));

    const loaded = await loadPeBandInputs({ instrument: { symbol: "TSM", exchange: "NYSE" } }, adr, coordinator, answer(closes));
    // Taiwan dollars quote per dollar, so the pair inverts to dollars per Taiwan dollar.
    expect(asked).toEqual([["TWD=X", "2022-12-17"]]);
    expect(loaded.fx.get("TWD")?.closes.get(day(1))).toBe(1 / 32);
    expect(loaded.fxError).toBeNull();

    const stale = await loadPeBandInputs({ instrument: { symbol: "TSM", exchange: "NYSE" } }, adr, coordinator, answer(closes, true));
    expect(stale.fx.size).toBe(0);
    expect(stale.fxError).toBe("daily TWD FX closes are stale");
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
