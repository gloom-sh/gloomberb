import { expect, setSystemTime, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { convertMarketCapitalization } from "../../../utils/market-capitalization";
import { relativeValuationValues } from "./relative-valuation-model";
import { relativeValuationHeadless } from "./relative-valuation-headless";
import { exportRowsTable, renderReportCsv } from "../../../cli/report-tables";
import { headlessReportTables } from "../../../cli/pane-functions/headless";
import { renderFundamentalsReport } from "../../../cli/commands/ticker";
import { withSearchHints } from "../../../cli/not-a-ticker";

test("fresh quotes do not hide stale fundamentals in a peer research report", async () => {
  const symbols = ["BAC", "JPM"];
  let stale = true;
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) {
      return { annualStatements: [], quarterlyStatements: [], priceHistory: [],
        quote: { symbol, price: 60, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1789567200000, stale: false, marketCap: 420e9 },
        fundamentals: { trailingPE: 13.94, financialCurrency: "USD", source: "gloom" as const,
          fetchedAt: "2026-09-14T17:23:38.462Z", stale: symbol === "BAC" && stale },
      };
    },
  }) } as HeadlessPaneContext;
  const args = { symbols, argument: symbols, rawArgument: symbols.join(" "), options: {} };
  const report = await relativeValuationHeadless.load(args, ctx);
  expect(report.complete).toBe(false);
  expect(report.metadata?.staleFundamentalsSymbols).toEqual(["BAC"]);
  expect(report.errors).toEqual(["BAC: Fundamentals stale: retained values may be out of date"]);
  expect(report.rows[0]).toMatchObject({ price: 60, trailingPE: 13.94, fundamentalsProvenance: { stale: true } });
  stale = false;
  const refreshed = await relativeValuationHeadless.load(args, ctx);
  expect(refreshed.complete).toBe(true);
  expect(refreshed.errors).toEqual([]);
  expect(refreshed.metadata?.staleFundamentalsSymbols).toEqual([]);
});

test("relative valuation rows carry their quote's feed, so the report can name its status", async () => {
  const now = Date.now();
  const ctx = {
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      async getTickerFinancials(symbol) {
        return { annualStatements: [], quarterlyStatements: [], priceHistory: [],
          quote: { symbol, price: 10, change: 0, changePercent: 0, currency: "USD", lastUpdated: now, dataSource: "delayed" as const, marketCap: 100 },
          fundamentals: { financialCurrency: "USD", enterpriseValue: 200, revenue: 50 },
        };
      },
    }),
  } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols: ["AAA"], argument: ["AAA"], rawArgument: "AAA", options: {} }, ctx);
  expect(result.rows[0]).toMatchObject({ dataSource: "delayed" });
  expect(deriveHeadlessFreshness(relativeValuationHeadless, result, now)).toMatchObject({ status: "delayed" });
});

test("relative valuations share derived metrics, preserve zeroes, and identify missing peers", async () => {
  const symbols = ["GOOD", "ZERO", "EMPTY", "MISSING"];
  const ctx = {
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      async getTickerFinancials(symbol) {
        if (symbol === "MISSING") throw new Error("Unavailable");
        const empty = { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
        if (symbol === "EMPTY") return empty;
        return {
          ...empty,
          quote: { symbol, price: 10, change: 1, changePercent: 10, currency: "USD", lastUpdated: 1, marketCap: symbol === "ZERO" ? 0 : 100 },
          fundamentals: { financialCurrency: "USD", enterpriseValue: 200, revenue: symbol === "ZERO" ? 0 : 50, freeCashFlow: 5, revenueGrowth: 0, lastQuarterGrowth: 0.2, operatingMargin: 0.1 },
        };
      },
    }),
  } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: {} }, ctx);
  expect(result.rows[0]).toMatchObject({ evSales: 4, fcfYield: 0.05, revenueGrowth: 0, operatingMargin: 0.1 });
  expect(result.rows[1]).toMatchObject({ marketCap: 0, evSales: null, fcfYield: null, revenueGrowth: 0 });
  expect(result.unavailableSymbols).toEqual(["MISSING", "EMPTY"]);
  expect(result.errors).toEqual(["MISSING: Unavailable"]);
});


test("relative valuation does not divide unconverted foreign cash flows by a USD market value", () => {
  const financials = {
    annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "TWD",
    quote: { symbol: "TSM", price: 200, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 100 },
    fundamentals: { financialCurrency: "TWD", enterpriseValue: 110, revenue: 1000, freeCashFlow: 300, operatingMargin: 0.4 },
  };
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, fcfYield: null, operatingMargin: 0.4 });
  // Converted summary fundamentals are independent of the statement currency.
  financials.fundamentals.financialCurrency = "";
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, fcfYield: null });
  financials.fundamentals.financialCurrency = "USD";
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: 0.11, fcfYield: 3 });
});


test("peer market caps convert before ranking and missing FX never becomes a 1:1 conversion", () => {
  const rates = new Map([["JPY", 0.0065], ["GBP", 1.3]]);
  expect(convertMarketCapitalization(1e12, "JPY", "USD", rates)).toBe(6.5e9);
  expect(convertMarketCapitalization(1e9, "GBP", "USD", rates)).toBe(1.3e9);
  expect(convertMarketCapitalization(1e9, "EUR", "USD", rates)).toBeNull();
});


test("provider EV/S requires verified compatible reporting units even when a ratio is supplied", () => {
  // Reproduces the ADR summary whose vendor EV is inconsistent with its market cap.
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "TWD",
    quote: { symbol: "TSM", price: 426.22, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 2_257_983_274_434 },
    fundamentals: { financialCurrency: undefined as string | undefined, enterpriseToRevenue: 3.56, enterpriseValue: 501_458_070_727, revenue: 140_865_738_606 },
  };
  expect(relativeValuationValues(financials)).toMatchObject({ evSales: null, marketCap: 2_257_983_274_434 });
  financials.fundamentals.financialCurrency = "TWD";
  expect(relativeValuationValues(financials).evSales).toBeNull();

  // A separately verified summary currency permits the provider ratio; the
  // statement currency never supplies missing summary metadata.
  financials.fundamentals = { financialCurrency: "USD", enterpriseToRevenue: 4.2, enterpriseValue: 100, revenue: 25 };
  expect(relativeValuationValues(financials).evSales).toBe(4.2);
  financials.fundamentals.enterpriseToRevenue = NaN;
  expect(relativeValuationValues(financials).evSales).toBe(4);

  // A zero or non-finite enterprise value (a bank's) is a gap, and the ratio served beside it is junk from the same source.
  for (const enterpriseValue of [0, Number.NaN]) {
    financials.fundamentals = { financialCurrency: "USD", enterpriseToRevenue: -1.055, enterpriseValue, revenue: 25 };
    expect(relativeValuationValues(financials).evSales).toBeNull();
  }
  financials.fundamentals = { financialCurrency: "USD", enterpriseToRevenue: 4.2, enterpriseValue: 100, revenue: 25 };
  expect(relativeValuationValues(financials).evSales).toBe(4.2);
});

test("loss-making peers retain reported multiples without ranking them as cheap earnings", async () => {
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol: "LOSS", price: 16, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1, marketCap: 100 },
    fundamentals: { trailingPE: -5.2, forwardPE: -9, financialCurrency: "USD", freeCashFlow: -20 } };
  const ctx = { signal: new AbortController().signal,
    marketData: createTestDataProvider({ getTickerFinancials: async () => financials }) } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols: ["LOSS"], argument: ["LOSS"], rawArgument: "LOSS", options: {} }, ctx);
  expect(result.rows[0]).toMatchObject({ trailingPE: null, forwardPE: null, fcfYield: -0.2,
    reportedMultiples: { trailingPE: -5.2, forwardPE: -9 } });
  for (const key of ["trailingPE", "forwardPE"]) {
    const column = relativeValuationHeadless.columns!.find((column) => column.key === key)!;
    expect(column.format!(result.rows[0]![key], result.rows[0]!)).toBe("N/M");
  }
  expect(financials.fundamentals).toMatchObject({ trailingPE: -5.2, forwardPE: -9, freeCashFlow: -20 });
});

test("qualified peers retain dated fundamental caps after stale quote removal and preserve cash-flow currency boundaries", async () => {
  const base = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 55_866_216_448, marketCapCurrency: "USD", financialCurrency: "USD",
      freeCashFlow: -7_940_250_112, source: "gloom" as const, fetchedAt: "2026-09-11T15:23:57.311Z", stale: false } };
  const values = relativeValuationValues(base);
  expect(values).toMatchObject({ price: null, currency: null, marketCap: base.fundamentals.marketCap, marketCapCurrency: "USD",
    marketCapProvenance: { kind: "fundamentals", source: "gloom", retrievedAt: base.fundamentals.fetchedAt, stale: false } });
  expect(values.fcfYield).toBeCloseTo(-7_940_250_112 / 55_866_216_448, 12);
  expect(relativeValuationValues({ ...base, fundamentals: { ...base.fundamentals, financialCurrency: undefined } }).fcfYield).toBeNull();
  expect(relativeValuationValues({ ...base, fundamentals: { ...base.fundamentals, financialCurrency: "EUR" } }).fcfYield).toBeNull();

  const requested: Array<[string, string | undefined]> = [];
  const ctx = { signal: new AbortController().signal,
    marketData: createTestDataProvider({ async getTickerFinancials(symbol, exchange) { requested.push([symbol, exchange]); return base; } }) } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols: ["F:XNYS"], argument: ["F:XNYS"], rawArgument: "F:XNYS", options: {} }, ctx);
  expect(result.rows[0]).toMatchObject({ symbol: "F:XNYS", marketCapCurrency: "USD", marketCapProvenance: values.marketCapProvenance });
  expect(result.unavailableSymbols).toEqual([]);
  expect(requested).toEqual([["F", "NYSE"]]);
  expect(result.metadata?.marketCapBasis).toContain("retrieval time is not a valuation date");
});

test("a foreign fundamental capitalization converts in its own currency, independently of the quote", () => {
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol: "TSM", price: 200, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 },
    fundamentals: { marketCap: 1000, marketCapCurrency: "TWD", financialCurrency: "TWD", freeCashFlow: 100 } };
  const row = relativeValuationValues(financials);
  expect(row).toMatchObject({ price: 200, currency: "USD", marketCap: 1000, marketCapCurrency: "TWD", fcfYield: 0.1 });
  expect(convertMarketCapitalization(row.marketCap, row.marketCapCurrency, "USD", new Map([["TWD", 0.03]]))).toBe(30);
  expect(convertMarketCapitalization(row.marketCap, row.marketCapCurrency, "USD", new Map())).toBeNull();
});

test("stale quotes cannot rank as current prices or seed quote-based cash-flow yields", async () => {
  const observed = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    // Condensed source boundary from the captured PLD financials response: the
    // financials envelope succeeded while its embedded quote was explicitly stale.
    quote: { symbol: "PLD", price: 135.75, change: 1.34, changePercent: .9969496317, currency: "USD",
      lastUpdated: 1789167600002, stale: true, marketCap: 131961405440, providerId: "gloomberb-cloud", dataSource: "delayed" as const },
    fundamentals: { trailingPE: 30.233854, freeCashFlow: 5406941184, financialCurrency: "USD", operatingMargin: .4,
      source: "gloom" as const, fetchedAt: "2026-09-11T23:52:16.139Z", stale: false } };
  const raw = structuredClone(observed);
  const values = relativeValuationValues(observed);
  expect(values).toMatchObject({ price: null, changePercent: null, marketCap: null, fcfYield: null,
    quoteStale: true, quoteAsOf: observed.quote.lastUpdated, trailingPE: 30.233854, operatingMargin: .4,
    reportedQuote: { price: 135.75, stale: true, marketCap: observed.quote.marketCap, lastUpdated: observed.quote.lastUpdated },
    fundamentalsProvenance: { source: "gloom", retrievedAt: observed.fundamentals.fetchedAt, stale: false } });
  expect(observed).toEqual(raw);
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    getTickerFinancials: async (symbol) => symbol === "MISSING" ? Promise.reject(new Error("source unavailable"))
      : { ...observed, quote: { ...observed.quote, symbol, stale: symbol === "PLD" } },
  }) } as HeadlessPaneContext;
  const symbols = ["PLD", "FRESH", "MISSING"];
  const result = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: {} }, ctx);
  expect(result.complete).toBe(false);
  expect(result.errors).toContain("PLD: Quote stale: quote-based values unavailable");
  expect(result.errors).toContain("MISSING: source unavailable");
  expect(result.unavailableSymbols).toEqual(["MISSING"]);
  expect(result.metadata?.staleSymbols).toEqual(["PLD"]);
  expect(result.rows[1]).toMatchObject({ price: 135.75, changePercent: observed.quote.changePercent,
    marketCap: observed.quote.marketCap, quoteStale: false });
  expect(Number(result.rows[1]!.fcfYield)).toBeCloseTo(observed.fundamentals.freeCashFlow / observed.quote.marketCap, 12);
  const priceColumn = relativeValuationHeadless.columns!.find((column) => column.key === "price")!;
  expect(priceColumn.format!(result.rows[0]!.price, result.rows[0]!)).toBe("quote stale");
  expect(relativeValuationHeadless.columns!.find((column) => column.key === "trailingPE")!.format!(values.trailingPE, values)).toBe("30.2");
});

test("a stale quote may use an independent fundamental cap with its own source and currency", async () => {
  const financials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol: "DUAL", price: 50, change: 1, changePercent: 2, currency: "USD", lastUpdated: 1789167600002, stale: true, marketCap: 500 },
    fundamentals: { marketCap: 100, marketCapCurrency: "EUR", freeCashFlow: 5, financialCurrency: "EUR", source: "gloom" as const,
      fetchedAt: "2026-09-11T23:52:16.139Z", stale: false } };
  const values = relativeValuationValues(financials);
  expect(values).toMatchObject({ price: null, marketCap: 100, marketCapCurrency: "EUR", fcfYield: .05,
    marketCapProvenance: { kind: "fundamentals", source: "gloom", retrievedAt: financials.fundamentals.fetchedAt, stale: false } });
  const recovered = relativeValuationValues({ ...financials, quote: { ...financials.quote, stale: false } });
  expect(recovered).toMatchObject({ price: 50, marketCap: 500, marketCapCurrency: "USD", fcfYield: null, quoteStale: false });
  const unknown = relativeValuationValues({ ...financials, quote: { ...financials.quote, stale: undefined } });
  expect(unknown.quoteStale).toBeNull();
  expect(unknown.reportedQuote?.stale).toBeNull();
});

test("every blank RV cell says why in the export's status, and the cap is the one valuation shows", async () => {
  // EVN:ASX on 2026-10-22: the quote's 24.4B cap rests on another count than the 1.99B shares served beside it,
  // and the TTM block names no currency and has no free cash flow. RMS:ASX has no quarter's revenue growth either.
  const evn = {
    annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "AUD",
    quote: { symbol: "EVN", price: 11.93, change: -0.2, changePercent: -1.65, currency: "AUD", lastUpdated: 1, marketCap: 24.4e9 },
    fundamentals: { marketCap: 24.4e9, marketCapCurrency: "AUD", sharesOutstanding: 1_985_877_758, enterpriseValue: 24.39e9,
      enterpriseToRevenue: 4.39, revenue: 5.56e9, trailingPE: 16.8, forwardPE: 11.38, operatingMargin: 0.276, lastQuarterGrowth: 0.192 },
  };
  const rms = { ...evn, quote: { ...evn.quote, symbol: "RMS", marketCap: undefined },
    fundamentals: { ...evn.fundamentals, lastQuarterGrowth: undefined, marketCap: undefined, sharesOutstanding: undefined } };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) { return symbol === "EVN" ? evn : rms; },
  }) } as HeadlessPaneContext;
  const result = await relativeValuationHeadless.load({ symbols: ["EVN", "RMS"], argument: ["EVN", "RMS"], rawArgument: "EVN RMS", options: {} }, ctx);
  const table = exportRowsTable("RV", relativeValuationHeadless.columns!, result.rows, { status: true });
  const status = table.columns.indexOf("status");
  expect(table.rows.map((row) => row[status])).toEqual([
    "EV/S: revenue ccy unstated; FCF Yield: no TTM FCF",
    "Mkt Cap, Quarter Revenue YoY: not reported; EV/S: revenue ccy unstated; FCF Yield: no TTM FCF",
  ]);
  // No blank figure without its reason; a session with no print is no missing figure.
  table.rows.forEach((row) => row.forEach((cell, index) => {
    const column = table.columns[index]!;
    if (cell === "" && index !== status && !/^(?:Pre-Market|After Hours|Overnight)/.test(column)) {
      expect(String(row[status])).toContain(column.replace(/ \(.*\)$| unit$/, ""));
    }
  }));
  // The share count times the price, as `valuation` shows it, with the provider's figure in the notices.
  expect(result.rows[0]!.marketCap).toBeCloseTo(1_985_877_758 * 11.93, 0);
  const valuation = renderFundamentalsReport({ ...evn, symbol: "EVN:ASX" }, "valuation").replace(/ {2,}/g, " ");
  expect(valuation).toContain("Market Cap 23.69B AUD\nShares Outstanding 1.99B\n");
  expect(valuation).toContain("Market cap 23.69B AUD is the 1.99B shares shown x 11.93 AUD; the provider's is 24.4B AUD.");
  expect(result.metadata?.notices).toContain("EVN: Market cap 23.69B AUD is the 1.99B shares shown x 11.93 AUD; the provider's is 24.4B AUD.");
});

test("RV reads the EV valuation shows: an insurer's computed one, N/M at or below zero, and the cap on the shares shown", async () => {
  // /market/financials on 2026-10-23 before the open, in the shapes Gloom Cloud serves them.
  const close = { change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.parse("2026-10-23T12:05:00Z"), marketState: "PRE" as const,
    regularCloseSessionDate: "2026-10-22", changeSessionDate: "2026-10-23", exchangeName: "NYSE", listingExchangeName: "NYSE" };
  const brk = { annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "USD",
    quote: { ...close, symbol: "BRK-B", price: 545.03, regularClose: 546.97, regularChange: 7.98, regularChangePercent: 1.48, marketCap: 1_142_954_312_070 },
    fundamentals: { marketCap: 1_142_954_312_070, marketCapCurrency: "USD", sharesOutstanding: 2_089_610_604, revenue: 384_687_013_888,
      financialCurrency: "USD", enterpriseValue: 1_230_944_312_070, enterpriseToRevenue: 3.1998,
      enterpriseValueCheck: { status: "computed" as const, source: -229_834_882_468, currency: "USD", marketCap: 1_142_954_312_070,
        totalDebt: 128_599_000_000, cash: 40_609_000_000, balanceSheetDate: "2026-06-30", computed: 1_230_944_312_070, investmentsKept: true as const } },
  };
  const reason = "Cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)";
  const arvn = { annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "USD",
    quote: { ...close, symbol: "ARVN", price: 7.15, regularClose: 7.17, regularChange: 0.1, regularChangePercent: 1.4, marketCap: 468_423_897 },
    fundamentals: { marketCap: 468_423_897, marketCapCurrency: "USD", sharesOutstanding: 65_300_000, revenue: 317_000_000, financialCurrency: "USD",
      unavailableFields: ["enterpriseValue" as const, "enterpriseToRevenue" as const],
      enterpriseValueCheck: { status: "not-meaningful" as const, source: -85_196_256, currency: "USD", marketCap: 468_423_897,
        totalDebt: 500_000, cash: 567_900_000, balanceSheetDate: "2026-06-30", computed: -98_976_103, reason } },
  };
  // The provider's 1.34B rests on 264.9M shares at the 5.06 pre-market print; the 274.5M shown x the 5.07 close is 1.39B.
  const cour = { annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: "USD",
    quote: { ...close, symbol: "COUR", price: 5.06, regularClose: 5.07, regularChange: 0.1, regularChangePercent: 2.01, marketCap: 1_340_508_032 },
    fundamentals: { marketCap: 1_340_508_032, marketCapCurrency: "USD", sharesOutstanding: 274_500_000, revenue: 885_400_000,
      financialCurrency: "USD", enterpriseValue: 255_245_975, enterpriseToRevenue: 0.2885, eps: -0.71, forwardPE: 6.147, forwardEps: 0.82313 },
  };
  const loaded: Record<string, typeof brk | typeof arvn | typeof cour> = { "BRK-B": brk, ARVN: arvn, COUR: cour };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) { return loaded[symbol]!; },
  }) } as HeadlessPaneContext;
  const symbols = ["BRK-B", "ARVN", "COUR"];
  const result = await relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(" "), options: {} }, ctx);
  const [brkRow, arvnRow, courRow] = result.rows as Array<ReturnType<typeof relativeValuationValues>>;
  // About 1.23T over 384.69B of revenue, at the close: not the -0.6 the provider's EV gave.
  expect(brkRow!.evSales).toBeCloseTo(3.2, 1);
  expect(arvnRow!.evSales).toBeNull();
  expect(arvnRow!.notMeaningful).toEqual({ evSales: reason });
  const evSales = relativeValuationHeadless.columns!.find((column) => column.key === "evSales")!;
  expect(evSales.format!(arvnRow!.evSales, arvnRow as unknown as Record<string, unknown>)).toBe("N/M");
  expect(result.metadata?.notices).toContain(`ARVN: EV N/M: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`);
  // One cap for COUR, the one `valuation` shows.
  expect(courRow!.marketCap).toBe(Math.round(274_500_000 * 5.07));
  const valuation = renderFundamentalsReport({ ...cour, symbol: "COUR" }, "valuation").replace(/ {2,}/g, " ");
  expect(valuation).toContain("Market Cap 1.39B USD\n");
  expect(result.metadata?.notices).toContain("COUR: Market cap 1.39B USD is the 274.5M shares shown x 5.07 USD; the provider's is 1.34B USD.");
});

test("RV's footer dates the trailing figures and the quarter its growth column compares, peer by peer when they differ", async () => {
  const statements = (...dates: string[]) => dates.map((date) => ({ date }));
  const peers: Record<string, { annual: string[]; quarterly: string[]; revenueGrowth?: number }> = {
    DUOL: { annual: ["2025-12-31"], quarterly: ["2026-03-31", "2026-06-30"], revenueGrowth: 0.18 },
    MSFT: { annual: ["2025-06-30"], quarterly: ["2026-03-31", "2026-06-30"], revenueGrowth: 0.17 },
    // June fiscal year, quarter not reported yet: its trailing figures reach the year's end.
    LRN: { annual: ["2026-06-30"], quarterly: ["2026-03-31"], revenueGrowth: 0.03 },
  };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) {
      const peer = peers[symbol]!;
      return { annualStatements: statements(...peer.annual), quarterlyStatements: statements(...peer.quarterly), priceHistory: [],
        quote: { symbol, price: 10, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 100 },
        fundamentals: { financialCurrency: "USD", revenueGrowth: peer.revenueGrowth, operatingMargin: 0.1 } };
    },
  }) } as HeadlessPaneContext;
  const load = async (symbols: string[]) => relativeValuationHeadless.load({ symbols, argument: symbols, rawArgument: symbols.join(","), options: {} }, ctx);
  // One period for every peer, and growth for the quarter that ends it: one clause.
  expect((await load(["DUOL", "MSFT"])).freshness?.note).toBe("fundamentals through 2026-06-30, Quarter Revenue YoY for that quarter");
  const mixed = await load(["DUOL", "MSFT", "LRN"]);
  expect(mixed.rows.map((row) => [row.fundamentalsThrough, row.revenueGrowthQuarter]))
    .toEqual([["2026-06-30", "2026-06-30"], ["2026-06-30", "2026-06-30"], ["2026-06-30", "2026-03-31"]]);
  expect(mixed.freshness?.note).toBe("fundamentals through 2026-06-30 · Quarter Revenue YoY: quarter to 2026-06-30 (LRN 2026-03-31)");
});

test("--peers on a word that is no ticker says so, with the search to run, before it looks for an industry", async () => {
  let screened = false;
  const ctx = { signal: new AbortController().signal, apiClient: { equityScreener: async () => { screened = true; throw new Error("unreachable"); } },
    marketData: createTestDataProvider({ async getTickerFinancials(symbol) { throw new Error(`Not a ticker: ${symbol}.`); } }) } as unknown as HeadlessPaneContext;
  const args = { symbols: ["DUOLINGO"], argument: ["DUOLINGO"], rawArgument: "duolingo", options: { peers: true } };
  const failure = await relativeValuationHeadless.expandArgument!(args, ctx).then(() => null, (error: Error) => error.message);
  expect(failure).toBe("Not a ticker: DUOLINGO.");
  // The CLI reads it as it reads `fn RV duolingo lrn`'s.
  expect(withSearchHints(failure!, ["RV", "duolingo", "--peers"])).toBe("Not a ticker: DUOLINGO. Try `gloom search duolingo`.");
  expect(screened).toBe(false);
});

// NESN's last in francs beside AAPL's in dollars: the header claims no currency, each row names its own.
test("RV's export writes each peer's Last as a number in its own currency, named on its row with its ticker, in every market state", async () => {
  const quote = (symbol: string, currency: string, price: number, at: string, extra: Record<string, unknown> = {}) => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [], financialCurrency: currency,
    quote: { symbol, price, change: 0.5, changePercent: 0.6, previousClose: price - 0.5, currency, lastUpdated: Date.parse(at), ...extra },
    fundamentals: { marketCap: 2e11, marketCapCurrency: currency, trailingPE: 20, eps: price / 20 },
  });
  const peers: Record<string, ReturnType<typeof quote>> = {
    NESN: quote("NESN", "CHF", 84.37, "2026-10-23T15:30:00Z", { marketState: "CLOSED", listingExchangeName: "SWX" }),
    AAPL: quote("AAPL", "USD", 336.64, "2026-10-23T20:55:00Z", { marketState: "POST", listingExchangeName: "NASDAQ", regularClose: 336.64,
      regularCloseSessionDate: "2026-10-23", postMarketPrice: 337.2, postMarketChange: 0.56, postMarketChangePercent: 0.1664 }),
  };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({
    async getTickerFinancials(symbol) { return peers[symbol]!; },
  }) } as HeadlessPaneContext;
  const csvOf = async (symbols: string[]) => {
    const args = { symbols, argument: symbols, rawArgument: symbols.join(","), options: {} };
    const result = await relativeValuationHeadless.load(args, ctx);
    const freshness = deriveHeadlessFreshness(relativeValuationHeadless, result);
    const tables = headlessReportTables(relativeValuationHeadless, result, args, "RV", freshness, { complete: true, unavailableSymbols: [] });
    const lines = renderReportCsv(tables, freshness).split("\n\n")[0]!.split("\n");
    const cells = (line: string) => line.match(/("[^"]*"|[^,]*)(,|$)/g)!.slice(0, -1).map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, ""));
    const [header, ...rows] = lines.map(cells);
    return { header: header!, row: (ticker: string) => Object.fromEntries(header!.map((column, index) => [column, rows.find((row) => row[0] === ticker)![index]])) };
  };
  setSystemTime(new Date("2026-10-23T21:00:00Z"));
  try {
    const both = await csvOf(["NESN:SWX", "AAPL"]);
    expect(both.header.slice(0, 3)).toEqual(["Ticker", "Last", "Chg%"]);
    expect(both.row("NESN:SWX")).toMatchObject({ Last: "84.37", symbol_or_series: "NESN:SWX", currency_or_unit: "CHF", "Mkt Cap unit": "CHF" });
    expect(both.row("AAPL")).toMatchObject({ Last: "336.64", "After Hours": "337.2", symbol_or_series: "AAPL", currency_or_unit: "USD" });
    expect(Number(both.row("AAPL")["After Hours Chg%"])).toBeCloseTo(0.1663, 4);
    // A figure a peer does not have is empty, its reason in status, never words in a column of numbers.
    expect(both.row("AAPL")).toMatchObject({ "Fwd P/E": "", "P/E": "20" });
    expect(both.row("AAPL").status).toMatch(/^Fwd P\/E[^;]*: not reported/);
    // A peer set with no extended print, or all in one currency, has the same header.
    expect((await csvOf(["NESN:SWX"])).header).toEqual(both.header);
  } finally {
    setSystemTime();
  }
});
