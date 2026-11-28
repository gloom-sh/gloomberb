import { expect, setSystemTime, test } from "bun:test";
import type { CloudFinancialsPayload } from "../../../api-client/types/ticker-data";
import { mapCloudFinancials } from "../../../sources/gloomberb-cloud/normalizers";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { FinancialStatement, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { loadExtraColumns } from "./relative-valuation-columns";

function listing(symbol: string, currency: string, price: number, statements: FinancialStatement[], fundamentals: CloudFinancialsPayload["fundamentals"], industry?: string): TickerFinancials {
  // An ADR's statements are in the company's currency, its quote and EV in dollars.
  const statementCurrency = statements[0]?.currency ?? currency;
  return mapCloudFinancials({
    annualStatements: [], quarterlyStatements: statements, priceHistory: [], financialCurrency: statementCurrency,
    quote: { symbol, price, change: 0, changePercent: 0, currency, lastUpdated: Date.parse("2026-11-06T21:00:00Z"), marketState: "CLOSED" },
    fundamentals: { financialCurrency: statementCurrency, marketCapCurrency: currency, ...fundamentals },
    ...industry ? { profile: { industry } } : {},
  } as unknown as CloudFinancialsPayload);
}

// NVDA on 2026-11-28: its 8-K gave the quarter to 2026-10-31 an EPS, and its 10-Qs file the quarters to 2026-07-26.
test("a quarter an earnings release dated with EPS alone leaves RV's gross margin and EV/EBITDA on the filed twelve months before it", async () => {
  setSystemTime(new Date("2026-11-28T00:24:00Z"));
  try {
    const dates = ["2025-10-26", "2026-01-25", "2026-04-26", "2026-07-26"];
    const revenue = [57.006, 68.127, 81.615, 96.221];
    const gross = [41.849, 51.059, 61.157, 72.142];
    const operating = [36.010, 44.299, 53.536, 63.734];
    const depreciation = [.601, .997, .997, 1.127];
    const published = ["2025-11-19", "2026-02-25", "2026-05-20", "2026-08-26"];
    const filed = (currency = "USD") => dates.map((date, index): FinancialStatement => ({ date, currency, availableAt: published[index],
      totalRevenue: revenue[index]! * 1e9, grossProfit: gross[index]! * 1e9, operatingIncome: operating[index]! * 1e9,
      depreciationAndAmortization: depreciation[index]! * 1e9 }));
    const release = (currency = "USD"): FinancialStatement => ({ date: "2026-10-31", currency, eps: 2.5, fieldAvailability: { eps: "2026-11-17" } });
    const read = async (statements: FinancialStatement[], stale = false) => {
      const financials = listing("NVDA", "USD", 150.49, statements, { enterpriseValue: 3.55e12, revenue: 303e9 });
      financials.quote = { ...financials.quote!, lastUpdated: Date.parse("2026-11-27T21:59:58Z"), stale };
      const context = { signal: new AbortController().signal, marketData: createTestDataProvider({ getTickerFinancials: async () => financials }) } as HeadlessPaneContext;
      return (await loadExtraColumns(["grossMargin", "evEbitda"], ["NVDA"], new Map(), context)).fields.get("NVDA")!;
    };
    const ordinary = await read(filed());
    const replay = await read([...filed(), release()]);
    expect(replay).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaAsOf: "2026-07-26" });
    expect(replay.grossMarginPercent as number).toBeCloseTo(74.67, 1);
    expect(replay.grossMarginPercent).toBe(ordinary.grossMarginPercent);
    expect(replay.evEbitda as number).toBeCloseTo(3_550 / 201.3, 2);
    expect(replay.evEbitda).toBe(ordinary.evEbitda);
    // A stale quote prices no EV multiple; the margin, which needs no price, stays.
    expect(await read([...filed(), release()], true)).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaGap: "quote stale" });
    // Statements in another currency than the EV, with no rate to convert them at: the margin, not the multiple.
    expect(await read([...filed("EUR"), release("EUR")])).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaGap: "statements in EUR" });
    // Three filed quarters complete no twelve months: the cells name the period they lack.
    expect(await read([...filed().slice(1), release()])).toMatchObject({ grossMarginGap: "no complete TTM to 2026-10-31", evEbitdaGap: "no complete TTM to 2026-10-31" });
    // The EV is read at Friday's 13:00 close, not the 16:59 late print the quote was last updated at: twelve months
    // filed between the two came after that price, and twelve months filed before the close stand.
    const atClose = async (filedAt: string) => {
      const rows = filed().map((row, index) => index === 3 ? { ...row, availableAt: filedAt } : row);
      const financials = listing("NVDA", "USD", 149.80, [...rows, release()], { enterpriseValue: 3.55e12, revenue: 303e9 });
      financials.quote = { ...financials.quote!, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "POSTPOST",
        regularClose: 150.49, regularCloseSessionDate: "2026-11-27", postMarketPrice: 149.80, lastUpdated: Date.parse("2026-11-27T21:59:58Z"), stale: false };
      const context = { signal: new AbortController().signal, marketData: createTestDataProvider({ getTickerFinancials: async () => financials }) } as HeadlessPaneContext;
      return (await loadExtraColumns(["grossMargin", "evEbitda"], ["NVDA"], new Map(), context)).fields.get("NVDA")!;
    };
    expect(await atClose("2026-11-27T20:00:00Z")).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaGap: "no complete TTM to 2026-10-31" });
    expect(await atClose("2026-11-27T17:30:00Z")).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaAsOf: "2026-07-26" });
    // One quarter with no filing time leaves the sum undated: no evidence it was out by the close, so no multiple.
    const undated = await read([...filed().map((row, index) => index === 1 ? { ...row, availableAt: undefined } : row), release()]);
    expect(undated).toMatchObject({ grossMarginAsOf: "2026-07-26", evEbitdaGap: "no filing date for TTM to 2026-07-26" });
    expect(undated.evEbitda).toBeUndefined();
  } finally { setSystemTime(); }
});
