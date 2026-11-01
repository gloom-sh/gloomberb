import { resolveCanonicalQuote } from "../../../market-data/quotes/resolution";
import { expect, setSystemTime, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { createTestFinancials, createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { HistoryRetentionError } from "../../../sources/history-retention";
import { createTestHeadlessContext } from "../../../test-support/headless";
import type { QuoteContribution } from "../../../types/financials";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { setCliColorEnabledOverride, setCliWidthOverride } from "../../../utils/cli-output";
import { financialStatementsHeadless, historicalPricesHeadless, quoteComparisonHeadless, returnsHeadless } from "./headless";

function args(symbols: string[], options: HeadlessPaneLoadArgs["options"] = {}): HeadlessPaneLoadArgs {
  return { symbols, options, argument: symbols, rawArgument: symbols.join(",") };
}

test("financial statements keep raw values, dated growth cells, and formatted columns without requiring a quote", async () => {
  const requested: string[] = [];
  const ctx = {
    marketData: createTestDataProvider({
      async getTickerFinancials(symbol, exchange, context) {
        requested.push(`${symbol}:${exchange}${context?.statementHistory ? ` ${context.statementHistory}` : ""}`);
        return {
          financialCurrency: "USD",
          annualStatements: [
            { date: "2024-12-31", totalRevenue: 100, dilutedShares: 10 },
            { date: "2025-12-31", totalRevenue: 150, dilutedShares: 12 },
          ],
          quarterlyStatements: [], priceHistory: [],
        };
      },
    }),
  } as HeadlessPaneContext;
  const result = await financialStatementsHeadless.load(args(["AAPL:NASDAQ"], { period: "annual", statement: "income" }), ctx);
  const revenue = result.rows.find((row) => String(row.metric).includes("Revenue"))!;
  const cells = revenue.cells as Array<{ date: string; value: number; growth: number; formatted: string }>;
  // The extended history is read only to tell whether GF goes further back.
  expect(requested).toEqual(["AAPL:NASDAQ", "AAPL:NASDAQ extended"]);
  expect(result.metadata).toMatchObject({ symbol: "AAPL:NASDAQ", period: "annual", statement: "income" });
  expect(revenue["2025-12-31"]).toBe(150);
  expect(cells[0]).toMatchObject({ date: "2025-12-31", value: 150, growth: 0.5 });
  const column = result.columns!.find((column) => column.key === "2025-12-31")!;
  expect(column.format!(150, revenue)).toContain(cells[0]!.formatted);
  expect(column.format!(150, revenue)).toContain("50");
  // Exports have no expansion controls: nested dilution data must remain accessible.
  const shares = result.rows.find((row) => String(row.id) === "dilutedShares:1")!;
  expect(shares["2025-12-31"]).toBe(12);
  expect((shares.cells as Array<{ growth: number }>)[0]!.growth).toBeCloseTo(0.2);
});

// EVN:ASX's statements stopped at 2024-06-30 in October 2026, with a FY2025 column of EPS alone, and nothing said so.
test("financial statements say how old a latest period over 15 months old is, past a newer column with only some figures", async () => {
  setSystemTime(new Date("2026-10-22T02:00:00Z"));
  try {
    const ctx = {
      marketData: createTestDataProvider({
        async getTickerFinancials() {
          return {
            financialCurrency: "AUD",
            annualStatements: [
              { date: "2023-06-30", totalRevenue: 2.29e9, netIncome: 1.6e8, totalAssets: 6.75e9, eps: 0.09 },
              { date: "2024-06-30", totalRevenue: 3.3e9, netIncome: 4.2e8, totalAssets: 8.82e9, eps: 0.22 },
              { date: "2025-06-30", eps: 0.46 },
            ],
            quarterlyStatements: [], priceHistory: [],
          };
        },
      }),
    } as HeadlessPaneContext;
    const load = (statement: string) => financialStatementsHeadless.load(args(["EVN:ASX"], { period: "annual", statement }), ctx);
    expect((await load("income")).notes?.[0]).toBe("Latest period 2024-06-30 is 27 months old; 2025-06-30 has only some figures.");
    expect((await load("balance")).notes?.[0]).toBe("Latest period 2024-06-30 is 27 months old.");
  } finally {
    setSystemTime();
  }
});

// The same statements with FY2025 and FY2026 filled from ASX, whose revenue is defined otherwise than the source's.
test("years filled from the exchange are named with their lines, and growth is not read across the two sources", async () => {
  setSystemTime(new Date("2026-10-22T02:00:00Z"));
  try {
    const filledFrom = (fields: Array<"totalRevenue" | "netIncome" | "totalAssets" | "totalLiabilities">) => ({
      source: "asx" as const, page: "https://www.asx.com.au/markets/company/EVN", retrievedAt: "2026-10-22T01:00:00.000Z", fields,
    });
    const ctx = {
      marketData: createTestDataProvider({
        async getTickerFinancials() {
          return {
            financialCurrency: "AUD",
            annualStatements: [
              { date: "2024-06-30", currency: "AUD", totalRevenue: 3.304e9, netIncome: 4.22e8, totalAssets: 8.82e9, eps: 0.2195 },
              { date: "2025-06-30", currency: "AUD", eps: 0.4641, totalRevenue: 4.351e9, netIncome: 9.26e8, filledFrom: filledFrom(["totalRevenue", "netIncome"]) },
              { date: "2026-06-30", currency: "AUD", totalRevenue: 5.559e9, netIncome: 1.475e9, totalAssets: 10.546e9, totalLiabilities: 4.717e9,
                filledFrom: filledFrom(["totalRevenue", "netIncome", "totalAssets", "totalLiabilities"]) },
            ],
            quarterlyStatements: [], priceHistory: [],
          };
        },
      }),
    } as HeadlessPaneContext;
    const load = (statement: string) => financialStatementsHeadless.load(args(["EVN:ASX"], { period: "annual", statement }), ctx);
    const income = await load("income");
    expect(income.notes?.[0]).toBe("From ASX key statistics (read 2026-10-22): 2026-06-30 revenue, net income; 2025-06-30 revenue, net income.");
    const growth = (metric: string) => Object.fromEntries((income.rows.find((row) => row.id === metric)!.cells as Array<{ date: string; growth: number | null }>)
      .map(({ date, growth }) => [date, growth]));
    // ASX's FY2026 against its FY2025, never against the source's FY2024; the source's EPS keeps its growth.
    expect(growth("income:revenue")["2026-06-30"]).toBeCloseTo(5.559 / 4.351 - 1, 6);
    expect(growth("income:revenue")["2025-06-30"]).toBeNull();
    expect(growth("eps:1")["2025-06-30"]).toBeCloseTo(0.4641 / 0.2195 - 1, 6);
    // JSON names each filled year's source and read time.
    expect((income.metadata?.columns as Array<{ date: string; filledFrom?: unknown }>).map(({ date, filledFrom }) => [date, filledFrom ?? null]))
      .toEqual([["2026-06-30", filledFrom(["totalRevenue", "netIncome", "totalAssets", "totalLiabilities"])], ["2025-06-30", filledFrom(["totalRevenue", "netIncome"])], ["2024-06-30", null]]);
    expect((await load("balance")).notes?.[0]).toBe("From ASX key statistics (read 2026-10-22): 2026-06-30 total assets, total liabilities.");
    // The cash flow statement shows net income, and none of ASX's other lines.
    expect((await load("cashflow")).notes?.[0]).toBe("From ASX key statistics (read 2026-10-22): 2026-06-30 net income; 2025-06-30 net income.");
  } finally {
    setSystemTime();
  }
});

test("financial exports distinguish provider dates from SEC period evidence and derived TTM", async () => {
  const dateEvidence = { accessionNumber: "0000909832-24-000049", filed: "2024-10-09", startDate: "2023-09-04" };
  const ctx = { marketData: createTestDataProvider({ async getTickerFinancials() {
    return { annualStatements: [
      { date: "2023-08-31", currency: "USD", dateSource: "provider" as const, totalRevenue: 100 },
      { date: "2024-09-01", currency: "USD", dateSource: "sec" as const, providerDate: "2024-08-31", dateEvidence, totalRevenue: 120 },
    ], quarterlyStatements: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date) => ({
      date, currency: "USD", dateSource: "sec" as const, dateEvidence, totalRevenue: 40,
    })), priceHistory: [] };
  } }) } as HeadlessPaneContext;
  const result = await financialStatementsHeadless.load(args(["COST"], { period: "annual", statement: "income" }), ctx);
  const columns = result.metadata!.columns as Array<Record<string, unknown>>;
  expect(columns.find(({ date }) => date === "2024-09-01")).toMatchObject({ dateSource: "sec", providerDate: "2024-08-31", dateEvidence, label: "2024-09-01 USD (SEC date)" });
  expect(columns.find(({ date }) => date === "2023-08-31")).toMatchObject({ dateSource: "provider", dateEvidence: null, label: "2023-08-31 USD (provider date)" });
  expect(columns.find(({ date }) => date === "TTM")).toMatchObject({ dateSource: "derived", dateEvidence: null, providerDate: null });
  expect(columns.every((column) => column.availableAt === null && column.fieldAvailability === null)).toBe(true);
  expect(result.columns?.find(({ key }) => key === "2023-08-31")?.header).toContain("provider date");
});

test("financial exports put share counts in ADRs only for the periods the service says count receipts", async () => {
  // BHP on NYSE from Gloom Cloud: FY2026 and FY2025 on the receipts, 2 ordinary shares each.
  const fy = (date: string, shareBasis: "depositary_receipt" | undefined, ordinarySharesNumber: number) => ({
    date, currency: "USD", ...(shareBasis ? { shareBasis } : {}), ordinarySharesNumber, totalAssets: 100e9,
  });
  const load = (annualStatements: ReturnType<typeof fy>[]) => financialStatementsHeadless.load(args(["BHP:NYSE"], { period: "annual", statement: "balance" }), {
    marketData: createTestDataProvider({ async getTickerFinancials() {
      return { fundamentals: { isDepositaryReceipt: true, adrRatio: 2, shareBasis: "depositary_receipt" as const }, annualStatements, quarterlyStatements: [], priceHistory: [] };
    } }),
  } as HeadlessPaneContext);

  const receipts = await load([fy("2025-06-30", "depositary_receipt", 2_536_000_000), fy("2026-06-30", "depositary_receipt", 2_540_081_549)]);
  expect(receipts.rows.find((row) => row.id === "ordinarySharesNumber:1")?.metric).toBe("Ordinary Shares (bn ADRs)");
  expect(receipts.metadata).toMatchObject({ shareBasis: "depositary_receipt", adrRatio: 2 });
  expect(receipts.metadata?.notices).toContain("Share counts are in ADRs and EPS is per ADR; 1 ADR = 2 ordinary shares.");

  // An older period the service left unclaimed still counts ordinaries: no label, and no growth across the bases.
  const mixed = await load([fy("2025-06-30", undefined, 5_080_163_098), fy("2026-06-30", "depositary_receipt", 2_540_081_549)]);
  const ordinary = mixed.rows.find((row) => row.id === "ordinarySharesNumber:1")!;
  expect(ordinary.metric).toBe("Ordinary Shares (bn)");
  expect((ordinary.cells as Array<{ growth: number | null }>)[0]!.growth).toBeNull();
  expect(mixed.metadata?.shareBasis).toBeNull();
  expect(mixed.metadata?.notices).toContain("Share counts are in ADRs and EPS is per ADR for 2026-06-30 (1 ADR = 2 ordinary shares); other periods as reported.");
});

test("quote comparison retains successful exchange-qualified inputs when a peer fails", async () => {
  const ctx = {
    signal: new AbortController().signal,
    resolveInstrument: async (symbol: string) => ({ symbol, exchange: "NYSE" }),
    marketData: createTestDataProvider({
      async getQuote(symbol, exchange) {
        if (symbol === "MISSING") throw new Error("No quote");
        expect(exchange).toBe("NYSE");
        return { symbol, name: "Company", price: 105, change: 5, changePercent: 5, currency: "USD", lastUpdated: 123 };
      },
    }),
  } as HeadlessPaneContext;
  const result = await quoteComparisonHeadless.load(args(["ABC", "MISSING"]), ctx);
  expect(result.rows).toEqual([{
    symbol: "ABC", name: "Company", price: 105, change: 5, changePercent: 5, currency: "USD",
    extendedSession: null, extendedPrice: null, extendedChange: null, extendedChangePercent: null,
    marketCap: null, updatedAt: 123, stale: false,
  }]);
  expect(result.unavailableSymbols).toEqual(["MISSING"]);
  expect(result.errors).toEqual(["MISSING: No quote"]);
});

test("quote monitor exports retain FX precision and small changes without altering raw values", async () => {
  // Retained public EUR/USD quote fields; provider retrieval is not replayed here.
  const quote = { symbol: "EURUSD=X", name: "EUR/USD", instrumentType: "CURRENCY",
    price: 1.1602274179458618, change: -0.0010778820541381684,
    changePercent: -0.09281642425451501, currency: "USD", lastUpdated: 1789162140000 };
  const ctx = { signal: new AbortController().signal, marketData: createTestDataProvider({ getQuote: async () => quote }) } as HeadlessPaneContext;
  const input = args([quote.symbol]);
  const result = await quoteComparisonHeadless.load(input, ctx);
  expect(result.rows[0]).toMatchObject({ price: quote.price, change: quote.change, instrumentType: "CURRENCY" });
  const text = renderHeadlessPaneText(quoteComparisonHeadless, result, input, "Quote Monitor");
  expect(text).toContain("$1.160227");
  expect(text).toContain("-$0.001078");
  expect(text).not.toContain("-$0.00 ");
  const priceColumn = quoteComparisonHeadless.columns!.find(({ key }) => key === "price")!;
  expect(priceColumn.format!(0.00651236716657877, { instrumentType: "CURRENCY", currency: "USD" })).toBe("$0.006512");
  expect(priceColumn.format!(null, { currency: "USD" })).toBe("—");
});

test("quote monitor shows an index in points, as quote does, whatever its currency", async () => {
  const index = (symbol: string, currency: string, price: number, change: number) => ({
    symbol, name: symbol, instrumentType: "INDEX", price, change, changePercent: 0.1, currency, lastUpdated: 1789162140000,
  });
  const quotes = [index("^GSPC", "USD", 7805.45, -1.79), index("^N225", "JPY", 67744.29, 33.23)];
  const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({ getQuote: async (symbol) => quotes.find((quote) => quote.symbol === symbol)! }) });
  const input = args(["^GSPC", "^N225"]);
  const text = renderHeadlessPaneText(quoteComparisonHeadless, await quoteComparisonHeadless.load(input, ctx), input, "Quote Monitor");
  expect(text).toContain("7,805.45");
  expect(text).toContain("-1.79");
  expect(text).toContain("+33.23");
  expect(text).not.toMatch(/[$¥]/);
});

test("historical prices use remembered exchanges and clip and sort the full OHLCV history", async () => {
  const requests: unknown[] = [];
  const ctx = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "ABC", exchange: "LSE" }),
    marketData: createTestDataProvider({
      async getPriceHistory(...request) {
        requests.push(request);
        return [
          { date: new Date("2026-03-09"), open: 20, high: 23, low: 19, close: 22, volume: 100 },
          { date: new Date("2026-01-01"), close: 10 },
          { date: new Date("2026-03-01"), close: 18 },
        ];
      },
    }),
  });
  const result = await historicalPricesHeadless.load(args(["ABC"], { range: "1M" }), ctx);
  expect(requests).toEqual([["ABC", "LSE", "1M"]]);
  expect(result.rows.map((row) => row.close)).toEqual([18, 22]);
  expect(result.rows[1]).toEqual({ date: "2026-03-09T00:00:00.000Z", open: 20, high: 23, low: 19, close: 22, volume: 100 });
});

test("historical prices print the prices the source meant, at one decimal count, not the float32 it served", async () => {
  // Gloom Cloud serves float32 prices: gold's 4013.4 arrives as 4013.39990234375, silver's 57.131 as 57.13000107.
  const served = (rows: Array<[string, number, number, number, number]>) => createTestHeadlessContext({
    marketData: createTestDataProvider({
      getPriceHistory: async () => rows.map(([date, open, high, low, close]) => ({ date: new Date(date), open, high, low, close, volume: 100 })),
    }),
  });
  const gold = served([
    ["2026-07-21", 4013.39990234375, 4092.5, 4003.300048828125, 4076.39990234375],
    ["2026-07-22", 4084.699951171875, 4171.39990234375, 4081, 4151.89990234375],
  ]);
  const goldArgs = args(["GC=F"]);
  const goldResult = await historicalPricesHeadless.load(goldArgs, gold);
  const goldText = renderHeadlessPaneText(historicalPricesHeadless, goldResult, goldArgs, "HP GC=F");
  for (const price of ["4,013.40", "4,092.50", "4,003.30", "4,076.40", "4,171.40", "4,081.00"]) expect(goldText).toContain(price);
  expect(goldText).not.toMatch(/\d,\d{3}\.\d{3,}/);
  // The rows hold the decimal each price is, as `history` does.
  expect(goldResult.rows[0]).toMatchObject({ open: 4013.4, low: 4003.3, close: 4076.4 });
  // A price under a hundred keeps the digits its tick needs.
  const silver = served([["2026-07-21", 56.33499908, 59.02500153, 56.33499908, 58.83499908]]);
  const silverText = renderHeadlessPaneText(historicalPricesHeadless, await historicalPricesHeadless.load(args(["SI=F"]), silver), args(["SI=F"]), "HP SI=F");
  expect(silverText).toContain("56.335");
  expect(silverText).toContain("59.025");
  expect(silverText).not.toContain("56.33499908");
});

test("historical prices mark a monthly bar whose month runs on and date it by the last session it covers", async () => {
  // Fri 16 Oct 2026 08:14 UTC: New York has not opened; Thursday's session is the latest close.
  setSystemTime(new Date("2026-10-16T08:14:00Z"));
  try {
    const monthly = ["2026-08-01", "2026-09-01", "2026-10-01"].map((date) => ({ date: new Date(date), close: 100 }));
    // A bare symbol is read on its quote's venue.
    const ctx = createTestHeadlessContext({
      marketData: createTestDataProvider({
        getPriceHistory: async () => monthly,
        getQuote: async (symbol) => ({ symbol, price: 100, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "NASDAQ", lastUpdated: Date.now() }),
      }),
    });
    const result = await historicalPricesHeadless.load(args(["CSCO"], { range: "ALL" }), ctx);
    expect(result.rows.map((row) => row.partial === true)).toEqual([false, false, true]);
    expect(result.freshness).toMatchObject({ basis: "monthly bars", periodToDate: { period: "month", through: "2026-10-15" } });
    const text = renderHeadlessPaneText(historicalPricesHeadless, result, args(["CSCO"], { range: "ALL" }), "HP CSCO");
    expect(text).toContain("month to date, through Thu 15 Oct 2026");
    // A month's bar reads as the month, and the one still running says so; the export keeps the day and adds a Partial column.
    expect(text).toContain("2026-10 MTD");
    expect(text).toMatch(/Month\s+Open/);
    expect(text).not.toContain("2026-10-01");
    expect(result.metadata).toMatchObject({ interval: "1mo" });
    expect(result.columns!.map((column) => column.key)).toContain("partial");
    expect(result.columns![0]!.format!(result.rows[2]!.date, result.rows[2]!)).toBe("2026-10-01");
    // September's bar on its own is complete.
    const september = createTestHeadlessContext({ marketData: createTestDataProvider({ getPriceHistory: async () => monthly.slice(0, 2) }) });
    const complete = await historicalPricesHeadless.load(args(["CSCO:NASDAQ"], { range: "ALL" }), september);
    expect(complete.rows.some((row) => row.partial)).toBe(false);
    expect(complete.freshness).not.toHaveProperty("periodToDate");
    // Dated by its last session, the day its close is from, not the 1st it is filed under.
    expect(complete.freshness).toMatchObject({ asOf: "2026-09-30" });
    expect(renderHeadlessPaneText(historicalPricesHeadless, complete, args(["CSCO:NASDAQ"], { range: "ALL" }), "HP CSCO")).toContain("Wed 30 Sep 2026");
  } finally {
    setSystemTime();
  }
});

test("historical prices open on 3M daily bars and date an intraday bar by its time", async () => {
  const requests: unknown[] = [];
  const hourly = ["13:30", "14:30", "15:30"].map((time) => ({ date: new Date(`2026-10-09T${time}:00Z`), close: 100 }));
  const ctx = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "ABC", exchange: "LSE" }),
    marketData: createTestDataProvider({
      async getPriceHistory(...request) {
        requests.push(request);
        return request[2] === "1W" ? hourly : [{ date: new Date("2026-10-08"), close: 99 }, { date: new Date("2026-10-09"), close: 100 }];
      },
    }),
  });
  const fresh = await historicalPricesHeadless.load(args(["ABC"]), ctx);
  expect(requests).toEqual([["ABC", "LSE", "3M"]]);
  expect(historicalPricesHeadless.options.find((option) => option.key === "range")?.defaultValue).toBe("3M");
  expect(fresh.metadata).toMatchObject({ range: "3M", interval: "1d" });
  expect(fresh.freshness).toMatchObject({ basis: "daily closes" });

  const week = await historicalPricesHeadless.load(args(["ABC"], { range: "1W" }), ctx);
  expect(week.metadata).toMatchObject({ interval: "1h" });
  expect(week.freshness).toMatchObject({ basis: "intraday bars" });
  const text = renderHeadlessPaneText(historicalPricesHeadless, week, args(["ABC"], { range: "1W" }), "HP ABC");
  expect(text).toContain("Time (UTC)");
  expect(text).toContain("2026-10-09 14:30");
});

test("historical prices take today's bar from the quote while the session trades, as a partial day, or leave it out with none", async () => {
  // Fri 16 Oct 2026, 15:14 in New York. The source's copy of today's bar is a snapshot of the opening minutes.
  setSystemTime(new Date("2026-10-16T19:14:30Z"));
  try {
    const served = [
      { date: new Date("2026-10-14"), open: 344.61, high: 347.09, low: 341.72, close: 342.96, volume: 50_061_100 },
      { date: new Date("2026-10-15"), open: 346.95, high: 347.85, low: 341.6, close: 342, volume: 39_678_300 },
      { date: new Date("2026-10-16"), open: 346.085, high: 347.8, low: 341.12, close: 341.995, volume: 1_096_219 },
    ];
    const quote = (overrides: object = {}) => ({
      symbol: "AAPL", price: 340.91, change: -1.09, changePercent: -0.32, currency: "USD", previousClose: 342, open: 346.085, high: 347.82,
      low: 340.46, volume: 39_269_651, listingExchangeName: "NASDAQ", instrumentType: "Common Stock", marketState: "REGULAR" as const,
      changeSessionDate: "2026-10-16", lastUpdated: Date.now() - 15 * 60_000, ...overrides,
    });
    const load = (getQuote: () => Promise<ReturnType<typeof quote>>, history = served) => historicalPricesHeadless.load(args(["AAPL"]), createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "AAPL", exchange: "" }),
      marketData: createTestDataProvider({ getPriceHistory: async () => history, getQuote }),
    }));

    const result = await load(async () => quote());
    expect(result.rows.at(-1)).toMatchObject({ date: "2026-10-16T00:00:00.000Z", open: 346.085, high: 347.82, low: 340.46, close: 340.91, volume: 39_269_651, partial: true });
    expect(result.rows.slice(0, -1).some((row) => row.partial)).toBe(false);
    expect(result.columns!.map((column) => column.key)).toContain("partial");
    // Dated by the quote it was read from, and the line says the newest bar is not a close.
    expect(result.freshness).toMatchObject({ basis: "daily bars", asOf: "2026-10-16T18:59:30.000Z", note: "the newest bar is today so far" });
    const text = renderHeadlessPaneText(historicalPricesHeadless, result, args(["AAPL"]), "HP AAPL");
    expect(text).toContain("2026-10-16 DTD");
    expect(text).toContain("today so far");
    expect(text).not.toContain("341.995");

    // A range cut before the session opened gains the day.
    expect((await load(async () => quote(), served.slice(0, 2))).rows.map((row) => [row.date, row.partial === true]))
      .toEqual([["2026-10-14T00:00:00.000Z", false], ["2026-10-15T00:00:00.000Z", false], ["2026-10-16T00:00:00.000Z", true]]);
    // No current quote: the snapshot is not today's row.
    const stale = await load(async () => quote({ stale: true }));
    expect(stale.rows.map((row) => String(row.date).slice(0, 10))).toEqual(["2026-10-14", "2026-10-15"]);
    expect(stale.freshness).toMatchObject({ basis: "daily closes" });
    expect(stale.freshness).not.toHaveProperty("note");
  } finally {
    setSystemTime();
  }
});

test("historical prices read daily bars across a holiday as daily, not as a week still forming", async () => {
  // Golden Week closed Shanghai from 1 to 7 Oct 2026. On Thu 8 Oct, while it trades, the last two daily bars are 8 days apart.
  setSystemTime(new Date("2026-10-08T03:00:00Z"));
  try {
    const days = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08"];
    const ctx = createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "600519", exchange: "SSE" }),
      marketData: createTestDataProvider({ getPriceHistory: async () => days.map((date) => ({ date: new Date(date), close: 1500 })) }),
    });
    const result = await historicalPricesHeadless.load(args(["600519:SSE"], { range: "1M" }), ctx);
    expect(result.rows.some((row) => row.partial)).toBe(false);
    expect(result.freshness).toMatchObject({ basis: "daily closes" });
    expect(result.freshness).not.toHaveProperty("periodToDate");
  } finally {
    setSystemTime();
  }
});

test("returns mark a monthly bar whose month runs on, as historical prices do", async () => {
  // Fri 16 Oct 2026 08:14 UTC: New York has not opened; Thursday's session is the latest close.
  setSystemTime(new Date("2026-10-16T08:14:00Z"));
  try {
    const monthly = ["2026-08-01", "2026-09-01", "2026-10-01"].map((date, index) => ({ date: new Date(date), close: 100 + index }));
    const ctx = createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "CSCO", exchange: "NASDAQ" }),
      marketData: createTestDataProvider({
        getDetailedPriceHistoryWithMetadata: async () => ({ points: monthly, resolution: "1mo" }),
      }),
    });
    const input = args(["CSCO:NASDAQ"], { range: "ALL", interval: "1mo" });
    const result = await returnsHeadless.load(input, ctx);
    expect(result.rows.map((row) => row.partial === true)).toEqual([false, false, true]);
    expect(result.freshness).toMatchObject({ basis: "monthly bars", periodToDate: { period: "month", through: "2026-10-15" } });
    expect(result.columns!.map((column) => column.key)).toContain("partial");
    const text = renderHeadlessPaneText(returnsHeadless, result, input, "RETURN CSCO");
    expect(text).toContain("2026-10 MTD");
    expect(text).toContain("2026-09");
    expect(text).not.toContain("2026-10-01");
    // Without October's bar, September's is complete and dated by its last session.
    const september = createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "CSCO", exchange: "NASDAQ" }),
      marketData: createTestDataProvider({ getDetailedPriceHistoryWithMetadata: async () => ({ points: monthly.slice(0, 2), resolution: "1mo" }) }),
    });
    const complete = await returnsHeadless.load(input, september);
    expect(complete.freshness).toMatchObject({ asOf: "2026-09-30" });
    expect(complete.freshness).not.toHaveProperty("periodToDate");
    expect(renderHeadlessPaneText(returnsHeadless, complete, input, "RETURN CSCO")).toContain("Wed 30 Sep 2026");
  } finally {
    setSystemTime();
  }
});

test("a narrow RETURN drops its dollar moves, the interval's first, rather than put a column under every row; its notices wrap", async () => {
  setSystemTime(new Date("2026-10-31T00:30:00Z"));
  setCliColorEnabledOverride(false);
  try {
    // SBLK's hourly closes, Friday 30 Oct: seven sessions' worth of rows, each with a four-figure move.
    const hourly = Array.from({ length: 7 }, (_, hour) => ({ date: new Date(Date.UTC(2026, 9, 30, 13 + hour, 30)), close: 28.62 - hour * 0.045 }));
    const ctx = createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "SBLK", exchange: "NASDAQ" }),
      marketData: createTestDataProvider({ getDetailedPriceHistoryWithMetadata: async () => ({ points: hourly, resolution: "1h" }) }),
    });
    const input = args(["SBLK:NASDAQ"], { range: "1D", interval: "1h" });
    const result = await returnsHeadless.load(input, ctx);
    const at = (width: number | null) => {
      setCliWidthOverride(width);
      return renderHeadlessPaneText(returnsHeadless, result, input, "RETURN SBLK");
    };
    const header = (text: string) => text.split("\n").find((line) => line.startsWith("Time (UTC)"))!.split(/ {2,}/);
    expect(header(at(null))).toEqual(["Time (UTC)", "Price", "Int $", "Int %", "Total $", "Total %"]);
    const narrow = at(56);
    expect(header(narrow)).toEqual(["Time (UTC)", "Price", "Int %", "Total $", "Total %"]);
    expect(header(at(46))).toEqual(["Time (UTC)", "Price", "Int %", "Total %"]);
    // One line a row, and no line past the width: the drawdown notice wraps.
    expect(narrow.split("\n").filter((line) => line.startsWith("  "))).toEqual([]);
    expect(narrow.split("\n").filter((line) => line.length > 56)).toEqual([]);
    expect(narrow).toContain("Max drawdown");
    // An export keeps every figure.
    expect(result.columns!.map((column) => column.key)).toEqual(expect.arrayContaining(["intervalChange", "totalChange"]));
  } finally {
    setCliWidthOverride(null);
    setCliColorEnabledOverride(null);
    setSystemTime();
  }
});

test("HP and RETURN read a past window's bars: HP's with no quote and its drawdown, RETURN's in daily bars where hourly ones are not kept", async () => {
  // Thursday 22 Oct 2026 while New York trades.
  setSystemTime(new Date("2026-10-22T15:00:00Z"));
  try {
    const asked: string[] = [];
    let quoted = false;
    const now = Date.now();
    // Each session from Fri 27 Feb to Tue 31 Mar 2015: 61 on 2 Mar, 58 on 10 Mar, 60 otherwise.
    const sessions = Array.from({ length: 33 }, (_, day) => new Date(Date.UTC(2015, 1, 27 + day)))
      .filter((date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6);
    const close: Record<string, number> = { "2015-03-02": 61, "2015-03-10": 58 };
    const march = sessions.map((date) => ({ date, close: close[date.toISOString().slice(0, 10)] ?? 60 }));
    const ctx = createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "JPM", exchange: "NYSE" }),
      marketData: createTestDataProvider({
        getQuote: async () => { quoted = true; return createTestQuote({ symbol: "JPM" }); },
        getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, start, end, interval) => {
          asked.push(interval);
          // Gloom Cloud keeps two years of hourly bars, and says so.
          if (interval === "1h") {
            throw new HistoryRetentionError({ version: 1, source: "gloom", symbol: "JPM", exchange: "NYSE", interval: "1h",
              requestedStart: Math.floor(start.getTime() / 1000) * 1000, requestedEnd: Math.floor(end.getTime() / 1000) * 1000,
              observedAt: now, availableStart: now - 730 * 86_400_000 });
          }
          return { points: march, resolution: "1d" };
        },
      }),
    });
    // The pane functions fill in the default range, which the window replaces.
    const hp = await historicalPricesHeadless.load(args(["JPM"], { range: "3M", from: "2015-03-01", to: "2015-03-31" }), ctx);
    expect([hp.rows.length, String(hp.rows[0]!.date).slice(0, 10), String(hp.rows.at(-1)!.date).slice(0, 10)]).toEqual([22, "2015-03-02", "2015-03-31"]);
    expect(hp.metadata).toMatchObject({ range: null, requestedWindow: { from: "2015-03-01", to: "2015-03-31" },
      notices: ["Max drawdown -4.9% (daily closes): peak 61.00 on 2015-03-02, trough 58.00 on 2015-03-10, not back to the peak by 2015-03-31"] });
    expect(hp.freshness).toMatchObject({ status: "not-a-feed", basis: "daily bars, 2015-03-01 to 2015-03-31" });
    expect(quoted).toBe(false);

    const input = args(["JPM"], { range: "5D", interval: "1h", from: "2015-03-01", to: "2015-03-31" });
    const returns = await returnsHeadless.load(input, ctx);
    expect(asked).toEqual(["1d", "1h", "1d"]);
    // Measured from Friday 27 Feb's close, the session before the window.
    expect([returns.rows.length, returns.rows[0]!.time, returns.rows.at(-1)!.time]).toEqual([22, "2015-03-02", "2015-03-31"]);
    expect(returns.rows[0]!.totalReturnPct).toBeCloseTo(100 / 60, 9);
    expect(returns.metadata).toMatchObject({ interval: "1d", requestedInterval: "1h", requestedWindow: { from: "2015-03-01", to: "2015-03-31" } });
    expect(returns.metadata!.notices).toContain("1H bars do not cover 2015-03-01 to 2015-03-31; these are 1D bars.");
  } finally {
    setSystemTime();
  }
});

test("historical price exports preserve tiny OHLC values without changing raw data", async () => {
  const point = { date: new Date("2026-09-10"), open: 0.00000531, high: 0.00000542, low: 0.00000501, close: 0.00000532, volume: 123456 };
  const ctx = { marketData: createTestDataProvider({ getPriceHistory: async () => [point] }) } as HeadlessPaneContext;
  const result = await historicalPricesHeadless.load(args(["SHIB-USD:CCC"]), ctx);
  const row = result.rows[0]!;
  for (const key of ["open", "high", "low", "close"] as const) {
    const column = historicalPricesHeadless.columns!.find((column) => column.key === key)!;
    expect(row[key]).toBe(point[key]);
    expect(Number(column.format!(row[key], row))).toBe(point[key]);
    expect(column.format!(0, row)).toBe("0.00");
    expect(column.format!(null, row)).toBe("-");
    expect(column.format!(123.45, row)).toBe("123.45");
  }
});

test("financial JSON exports preserve selected metric availability separately from fiscal-period evidence", async () => {
  const fieldAvailability = { totalRevenue: "2018-08-03", netIncome: "2018-08-03", capitalExpenditure: "2017-08-02" };
  const dateEvidence = { accessionNumber: "0001564590-17-014900", filed: "2017-08-02", startDate: "2016-07-01" };
  const ctx = { marketData: createTestDataProvider({ getTickerFinancials: async () => ({
    annualStatements: [{ date: "2017-06-30", currency: "USD", dateSource: "sec", dateEvidence, availableAt: "2018-08-03", fieldAvailability, totalRevenue: 96_571_000_000, netIncome: 25_489_000_000 }],
    quarterlyStatements: [], priceHistory: [],
  }) }) } as HeadlessPaneContext;
  const result = await financialStatementsHeadless.load(args(["MSFT"], { period: "annual", statement: "income" }), ctx);
  const restored = JSON.parse(JSON.stringify(result));
  expect(restored.metadata.columns[0]).toMatchObject({ date: "2017-06-30", dateEvidence, availableAt: "2018-08-03", fieldAvailability });
  expect(restored.rows.find((row: { metric: string }) => row.metric.includes("Revenue"))["2017-06-30"]).toBe(96_571_000_000);
});


test("canonical missing changes survive JSON roundtrip into default Quote Monitor text beside zero and derived change", async () => {
  const base = { symbol: "MISSING", providerId: "test-provider", price: 12, currency: "USD", lastUpdated: Date.now(), marketState: "CLOSED" as const };
  // A provider can leave the daily change out, which the contribution type does not model.
  const withoutChange = (quote: Omit<QuoteContribution, "change" | "changePercent">) => quote as QuoteContribution;
  const inputs = [withoutChange(base), { ...base, symbol: "ZERO", change: 0, changePercent: 0 }, withoutChange({ ...base, symbol: "DERIVED", previousClose: 10 })];
  const quotes = inputs.map(quote => resolveCanonicalQuote({ quote }).quote!);
  expect(quotes[0]!.change).toBeNaN();
  expect(quotes[0]!.changePercent).toBeNaN();
  const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({ getQuote: async symbol => quotes.find(quote => quote.symbol === symbol)! }) });
  const input = args(["MISSING", "ZERO", "DERIVED"]);
  const model = await quoteComparisonHeadless.load(input, ctx);
  const transported = JSON.parse(JSON.stringify(model));
  expect(transported.rows[0]).toMatchObject({ change: null, changePercent: null });
  const text = renderHeadlessPaneText(quoteComparisonHeadless, transported, input, "Quote Monitor");
  expect(text.split("\n").find(line => line.trim().startsWith("MISSING "))).not.toContain("0.00%");
  expect(text.split("\n").find(line => line.trim().startsWith("ZERO "))).toContain("0.00%");
  expect(text.split("\n").find(line => line.trim().startsWith("DERIVED "))).toContain("+20.00%");
});

test("historical prices count a coin's bars without volume as history does, not the latest trade its hourly bars end with", async () => {
  const bar = (date: string, volume?: number) => ({ date: new Date(date), open: 81_000, high: 81_100, low: 80_900, close: 81_050, volume });
  const latest = bar("2026-10-18T15:57:53Z");
  const load = async (points: ReturnType<typeof bar>[]) => historicalPricesHeadless.load(args(["BTC-USD"], { range: "1W" }), createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "BTC-USD", exchange: "CCC" }),
    marketData: createTestDataProvider({ getPriceHistory: async () => points }),
  }));
  const signedIn = await load([bar("2026-10-18T13:00:00Z", 61_200_000), bar("2026-10-18T14:00:00Z", 73_800_000),
    bar("2026-10-18T15:00:00Z", 24_100_000), latest]);
  expect(signedIn.rows.at(-1)).toMatchObject({ date: "2026-10-18T15:57:53.000Z", volume: null });
  // Before: "1 of 4 bars has no reported volume (—)".
  expect(signedIn.notes).toBeUndefined();
  const hole = await load([bar("2026-10-18T13:00:00Z", 61_200_000), bar("2026-10-18T14:00:00Z"), bar("2026-10-18T15:00:00Z", 24_100_000), latest]);
  expect(hole.notes).toEqual(["1 of 4 bars has no reported volume (\u2014)"]);
});


test("FA cash-only runway labels its actual input and caps only formatted values; financials omit runway", async () => {
  const financials = createTestFinancials({
    annualStatements: [], quarterlyStatements: [{ date: "2026-06-30", totalRevenue: 0, cashAndCashEquivalents: 32_000, operatingCashFlow: -1 }],
  });
  const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({ getTickerFinancials: async () => financials }) });
  const request = args(["TEST:XETRA"], { statement: "liquidity", period: "quarterly" });
  const report = await financialStatementsHeadless.load(request, ctx);
  expect(report.notes?.join(" ")).toContain("cash (no ST investments reported)");
  expect(report.rows.find((row) => row.id === "runway-quarter:0")?.metric).toMatch(/^Cash \(.*\)$/);
  expect(report.rows.find((row) => row.id === "runway-quarter")?.cells).toEqual([
    expect.objectContaining({ value: 96_000, formatted: "> 120 mo" }),
  ]);
  expect(report.rows.find((row) => row.id === "runway-ttm")?.cells).toEqual([
    expect.objectContaining({ gap: "< 4 quarters" }),
  ]);
  // A total outside the displayed quarterly columns still governs the input label and fallback.
  financials.annualStatements = [{ date: "2025-12-31", cashCashEquivalentsAndShortTermInvestments: 50_000 }];
  const sparse = await financialStatementsHeadless.load(request, ctx);
  expect(sparse.rows.find((row) => row.id === "runway-quarter:0")?.metric).toContain("Cash + ST Inv");
  expect(sparse.rows.find((row) => row.id === "runway-quarter")?.cells).toEqual([
    expect.objectContaining({ gap: "not reported" }),
  ]);
  financials.profile = { sector: "Financial Services" };
  const bank = await financialStatementsHeadless.load(request, ctx);
  expect(bank.rows.some((row) => String(row.id).startsWith("runway-"))).toBe(false);
  expect(bank.notes?.some((note) => note.startsWith("Runway:"))).toBe(false);
});
