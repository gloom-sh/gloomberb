import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ManualChartResolution } from "../../../time-series/resolution";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerRecord } from "../../../types/ticker";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { loadFuturesContractTermsCached } from "../../../market-data/futures-contract";
import { collectionHoldingsHeadless } from "./headless";

afterEach(() => { setSystemTime(); });

const BROKER = { id: "broker:ibkr-main:U1234567", name: "U1234567", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-main", brokerAccountId: "U1234567" };
const MANUAL = { id: "main", name: "Main", currency: "USD" };

function holding(symbol: string, shares: number, avgCost: number, portfolio = BROKER.id): TickerRecord {
  return createTestTicker(symbol, `${symbol} Inc`, {
    portfolios: [portfolio],
    positions: [{ portfolio, shares, avgCost, currency: "USD", broker: portfolio === BROKER.id ? "ibkr" : "manual" }],
  });
}

const prices: Record<string, number> = { NVDA: 100, MSFT: 400, AAPL: 200, TSLA: 250, SPY: 500 };
const tickers = [
  holding("1211", 2_000, 250),
  holding("NVDA", 100, 50),
  holding("MSFT", 30, 300),
  holding("AAPL", 10, 150),
  holding("TSLA", -20, 300),
  createTestTicker("SPY", "SPDR S&P 500", { watchlists: ["tech"] }),
];

function context(
  held: readonly TickerRecord[] = tickers,
  quoted: Record<string, number> = prices,
  manual: typeof MANUAL & { targetWeights?: Record<string, number> } = MANUAL,
): HeadlessPaneContext {
  const config = {
    ...createDefaultConfig("/unused/pf-headless"),
    portfolios: [manual, BROKER],
    watchlists: [{ id: "tech", name: "Tech" }],
  };
  return {
    config,
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      getQuote: async (symbol) => {
        if (!quoted[symbol]) throw new Error(`No quote for ${symbol}`);
        return createTestQuote({ symbol, price: quoted[symbol], changePercent: 1.5 });
      },
    }),
    resolvePortfolio: async (id: string) => {
      const portfolio = config.portfolios.find((entry) => entry.id === id);
      return portfolio ? { portfolio, tickers: held.filter((entry) => entry.metadata.portfolios.includes(id)) } : null;
    },
    resolveWatchlist: async (id: string) => held.filter((entry) => entry.metadata.watchlists.includes(id)),
  } as unknown as HeadlessPaneContext;
}

function args(rawArgument: string, options: Record<string, number> = {}) {
  return { rawArgument, argument: rawArgument || null, symbols: [], options };
}

test("a broker portfolio's positions come largest first with weights and totals over every position", async () => {
  const all = await collectionHoldingsHeadless.load(args(BROKER.id), context());
  // A holding without a quote has no market value and goes last, not first.
  expect(all.rows.map((row) => row.symbol)).toEqual(["MSFT", "NVDA", "TSLA", "AAPL", "1211"]);
  expect(all.errors).toEqual(["No market value for 1211; totals and weights leave it out."]);

  const result = await collectionHoldingsHeadless.load(args(BROKER.id, { limit: 3 }), context());

  expect(result.rows.map((row) => row.symbol)).toEqual(["MSFT", "NVDA", "TSLA"]);
  expect(result.rows[0]).toMatchObject({ shares: 30, price: 400, marketValue: 12_000, unrealizedPnl: 3_000, priceCurrency: "USD" });
  // A short is negative exposure, and a book that holds one weighs against its gross exposure, as `portfolio show` weighs it.
  expect(result.rows[2]).toMatchObject({ shares: -20, marketValue: -5_000, unrealizedPnl: 1_000 });
  expect(result.rows[0]!.weight).toBeCloseTo((12_000 / 29_000) * 100, 8);
  expect(result.rows[2]!.weight).toBeCloseTo((-5_000 / 29_000) * 100, 8);
  expect(result.columns?.find((column) => column.key === "weight")?.description).toContain("Percent of gross exposure");
  // Market value and P&L are in the book's currency beside a quote's own, and their headers say which.
  expect(result.columns?.filter((column) => ["marketValue", "unrealizedPnl", "price"].includes(column.key)).map((column) => column.header))
    .toEqual(["Last", "Mkt Val (USD)", "P&L (USD)"]);
  expect(result.metadata).toMatchObject({
    collection: { kind: "portfolio", id: BROKER.id, broker: true },
    currency: "USD",
    positions: 5,
    totals: { marketValue: 19_000, grossMarketValue: 29_000, longMarketValue: 24_000, shortMarketValue: -5_000, unrealizedPnl: 9_500 },
    weightBasis: "gross",
    weightBase: 29_000,
    notices: [
      "Exposure: long $24,000, short -$5,000, net $19,000, gross $29,000",
      "Weights are shares of gross exposure ($29,000), longs plus shorts at their absolute value, as the book holds a short; cash has no weight.",
      "2 more positions not shown; totals include every position.",
      // No account was synced here, so the total weighs only the positions.
      expect.stringContaining("cash and margin are unknown"),
    ],
  });
});

test("every column PF declares is a field of its position rows, the listing included", async () => {
  // Ask Gloom's scripts read rows by the declared keys: a declared key the rows
  // lack reads undefined, and an undeclared field is never printed (a turn took
  // two European holdings for their US listings).
  const keys = (collectionHoldingsHeadless.columns ?? []).map((column) => column.key);
  expect(keys).toContain("exchange");
  const result = await collectionHoldingsHeadless.load(args(BROKER.id), context());
  expect(result.rows.length).toBeGreaterThan(0);
  for (const row of result.rows) {
    for (const key of keys) expect(row).toHaveProperty(key);
  }
  expect(result.rows[0]).toMatchObject({ exchange: "NASDAQ" });
});

test("a watchlist reads by name, and an unknown id lists the ones that exist", async () => {
  const watchlist = await collectionHoldingsHeadless.load(args("tech"), context());
  expect(watchlist.rows).toEqual([{ symbol: "SPY", name: "SPDR S&P 500", exchange: "NASDAQ", price: 500, priceCurrency: "USD", changePercent: 1.5, changeBasis: "regular-session", extendedChangeBasis: null, extendedSession: null, extendedPrice: null, extendedChange: null, extendedChangePercent: null, stale: false, updatedAt: expect.any(Number) }]);
  expect(watchlist.metadata).toMatchObject({ collection: { kind: "watchlist", id: "tech" }, tickers: 1 });

  await expect(collectionHoldingsHeadless.load(args("default"), context()))
    .rejects.toThrow(`Unknown portfolio or watchlist "default". Portfolios and watchlists: Main (main), U1234567 (${BROKER.id}), Tech (tech).`);
});

test("a watchlist and a portfolio date a pre-market quote nothing has traded in by the close they show, as quote does", async () => {
  // Fri 16 Oct 2026 before 08:00 UTC trades: the price is Thursday's last after-hours print, the row shows Thursday's close.
  const waiting = (symbol: string) => createTestQuote({
    symbol, price: 500.4, change: 0.4, changePercent: 0.08, previousClose: 500, regularClose: 500, regularCloseSessionDate: "2026-10-15",
    regularChange: 2, regularChangePercent: 0.4, changeSessionDate: "2026-10-16", marketState: "PRE", extendedSessionPrint: false,
    listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-15T23:59:00Z"),
  });
  const ctx = { ...context(), marketData: createTestDataProvider({ getQuote: async (symbol) => waiting(symbol) }) } as HeadlessPaneContext;
  const close = Date.parse("2026-10-15T20:00:00Z");
  expect((await collectionHoldingsHeadless.load(args("tech"), ctx)).rows[0]).toMatchObject({ price: 500, updatedAt: close });
  const held = (await collectionHoldingsHeadless.load(args(BROKER.id), ctx)).rows.filter((row) => row.symbol);
  expect(held.length).toBeGreaterThan(0);
  expect(held.map((row) => row.updatedAt)).toEqual(held.map(() => close));
});

test("the text Ticker column names two listings of one symbol SAN:EPA and SAN:NYSE, while JSON and CSV keep the stored key", async () => {
  const membership = { portfolios: ["main"], watchlists: ["growth"] };
  const held = (portfolio: string) => ({ portfolio, shares: 5, avgCost: 10, currency: "USD", broker: "manual" });
  // Sanofi under the bare key, Banco Santander's New York line under its venue key.
  const san = [
    createTestTicker("SAN", "Sanofi", { exchange: "EPA", positions: [held("main")], ...membership }),
    createTestTicker("SAN:XNYS", "Banco Santander", { exchange: "NYSE", positions: [held("main")], ...membership }),
  ];
  const portfolio = { id: "main", name: "Main", currency: "USD", targetWeights: { SAN: 10, "SAN:XNYS": 20 } };
  const ctx = {
    config: { ...createDefaultConfig("/unused/pf-headless"), portfolios: [portfolio], watchlists: [{ id: "growth", name: "Growth" }] },
    signal: new AbortController().signal,
    marketData: createTestDataProvider({ getQuote: async (symbol) => createTestQuote({ symbol, price: 12 }) }),
    resolvePortfolio: async () => ({ portfolio, tickers: san }),
    resolveWatchlist: async () => san,
  } as unknown as HeadlessPaneContext;
  setCliColorEnabledOverride(false);

  try {
    for (const target of ["main", "growth"]) {
      const result = await collectionHoldingsHeadless.load(args(target), ctx);
      const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args(target), "PF");
      expect(text.split("\n").filter((line) => /^SAN/.test(line)).map((line) => line.split(/\s+/)[0])).toEqual(["SAN:EPA", "SAN:NYSE"]);

      // Rows, JSON and CSV read the stored key.
      expect(result.rows.map((row) => row.symbol)).toEqual(["SAN", "SAN:XNYS"]);
      const json = serializeHeadlessPaneResult(collectionHoldingsHeadless, result) as { rows: { symbol: string }[] };
      expect(json.rows.map((row) => row.symbol)).toEqual(["SAN", "SAN:XNYS"]);
      const freshness = deriveHeadlessFreshness(collectionHoldingsHeadless, result);
      const table = headlessReportTables(collectionHoldingsHeadless, result, args(target), "PF", freshness, { complete: true, unavailableSymbols: [] }).tables[0]!;
      expect(table.rows.map((row) => row[table.columns.indexOf("Ticker")])).toEqual(["SAN", "SAN:XNYS"]);
    }
  } finally {
    setCliColorEnabledOverride(null);
  }
});

/** A manual holding of `symbol`, one lot per [shares, avgCost]. */
function lots(symbol: string, ...held: Array<[shares: number, avgCost?: number]>): TickerRecord {
  return createTestTicker(symbol, `${symbol} Inc`, {
    portfolios: [MANUAL.id],
    positions: held.map(([shares, avgCost]) => ({ portfolio: MANUAL.id, shares, avgCost, currency: "USD", broker: "manual" })),
  });
}

test("a holding with a price but no cost is counted and only its P&L is unknown, while one with no price is left out", async () => {
  const held = [lots("MSFT", [3]), lots("AAPL", [10, 150]), lots("XYZ", [7, 10])];
  const result = await collectionHoldingsHeadless.load(args(MANUAL.id), context(held, { MSFT: 400, AAPL: 200 }));

  expect(result.errors).toEqual([
    "No market value for XYZ; totals and weights leave it out.",
    "No cost for MSFT, so its P&L is unknown; totals and weights still count it.",
  ]);
  expect(result.complete).toBe(false);
  // MSFT is in the total and the weights; only its P&L is missing.
  expect(result.rows.find((row) => row.symbol === "MSFT")).toMatchObject({ marketValue: 1_200, unrealizedPnl: null });
  expect(result.rows.find((row) => row.symbol === "MSFT")!.weight).toBeCloseTo((1_200 / 3_200) * 100, 8);
  expect(result.metadata).toMatchObject({ totals: { marketValue: 3_200, total: 3_200 } });
});

test("a ticker held in several lots weighs each lot by its own value and gives its target, drift and trade once, on a position line", async () => {
  const held = [lots("AAPL", [10, 150], [5, 170]), lots("NVDA", [20, 50])];
  const ctx = context(held, { AAPL: 200, NVDA: 100 }, { ...MANUAL, targetWeights: { AAPL: 35 } });
  const result = await collectionHoldingsHeadless.load(args(MANUAL.id), ctx);

  // The lots stay together, largest position first, instead of the smaller lot trailing the other ticker.
  expect(result.rows.map((row) => [row.symbol, row.shares])).toEqual([["AAPL", 10], ["AAPL", 5], ["NVDA", 20]]);
  // Of a 5,000 total, JSON keeps the position's figures on its first lot and marks the lots of one position.
  expect(result.rows[0]).toMatchObject({ weight: 60, targetWeight: 35, drift: 25, tradeValue: -1_250, lots: 2, lotWeight: 40 });
  expect(result.rows[1]).toMatchObject({ weight: null, targetWeight: null, tradeValue: null, lots: 2, lotWeight: 20 });
  expect(result.rows[2]).not.toHaveProperty("lots");

  setCliColorEnabledOverride(false);
  try {
    const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args(MANUAL.id), "PF").split("\n");
    // Each lot shows its own weight and no target, drift or trade; the position line under them carries the position's.
    expect(text.filter((line) => /^AAPL:NASDAQ /.test(line)).map((line) => line.replace(/\s+/g, " "))).toEqual([
      expect.stringMatching(/^AAPL:NASDAQ AAPL Inc NASDAQ 10 .* 40\.0% — — — — /),
      expect.stringMatching(/^AAPL:NASDAQ AAPL Inc NASDAQ 5 .* 20\.0% — — — — /),
      "AAPL:NASDAQ (2 lots) 15 3,000 60.0% 35.0% +25.0pp -6 -1,250",
    ]);
    // JSON and CSV keep one row per lot.
    expect(JSON.stringify(serializeHeadlessPaneResult(collectionHoldingsHeadless, result))).not.toContain("2 lots");
  } finally {
    setCliColorEnabledOverride(null);
  }
});

test("--close values a future at its exchange settlement, dated by its session, with the day's move from the settlement before", async () => {
  // The Monday after the settlement: a date in another year would carry its year.
  setSystemTime(new Date("2026-10-19T14:00:00Z"));
  // Short four platinum contracts of 50 oz, beside ten shares.
  const platinum = createTestTicker("PL=F", "Platinum Jan 27", { exchange: "NYM", assetCategory: "FUTURE", portfolios: [MANUAL.id],
    positions: [{ portfolio: MANUAL.id, shares: -4, avgCost: 1_620, currency: "USD", broker: "manual", multiplier: 50 }] });
  // fn PF reads a future's terms where the portfolio pane does, through their cache: Friday settled at 1,600.
  await loadFuturesContractTermsCached("PL=F", async (symbol) => ({
    symbol, root: "PL", name: "Platinum", contract: "PLF27", contractSymbol: "PLF27", deliveryMonth: "2027-01",
    spec: { unit: "USD / troy oz", size: "50 troy oz", pointValue: 50, tick: 0.1, tickValue: 5, settlement: "physical" },
    lastTrade: null, firstNotice: null, inDelivery: false, settlement: { price: 1_600, date: "2026-10-16" },
  }));
  const base = context([holding("AAPL", 10, 150, MANUAL.id), platinum], { AAPL: 200, "PL=F": 1_650 });
  const daily = [
    { date: new Date("2026-10-15T00:00:00Z"), close: 1_590 },
    { date: new Date("2026-10-16T00:00:00Z"), close: 1_600 },
  ];
  const ctx = { ...base, marketData: { ...base.marketData,
    getPriceHistoryForResolutionWithMetadata: async () => ({ points: daily, resolution: "1d" as const }) } } as HeadlessPaneContext;
  const closeArgs = args(MANUAL.id, { close: true } as unknown as Record<string, number>);
  const result = await collectionHoldingsHeadless.load(closeArgs, ctx);

  const future = result.rows.find((row) => row.symbol === "PL=F")!;
  // At the settlement, never the 1,650 Globex print: -4 x 50 oz x 1,600.
  expect(future).toMatchObject({ price: 1_600, marketValue: -320_000, unrealizedPnl: 4_000, valuationPrice: 1_600,
    valuationAsOf: "2026-10-16", valuationPriceKind: "settle", contractMultiplier: 50, contractSize: "50 oz" });
  expect(future.changePercent as number).toBeCloseTo((10 / 1_590) * 100, 8);
  // The day: the short loses the settlement's 10 an ounce on 200 oz; AAPL's test quote is flat.
  expect((result.metadata?.totals as { dayChange: number }).dayChange).toBeCloseTo(-2_000, 6);
  expect(result.rows.find((row) => row.symbol === "AAPL")).not.toHaveProperty("valuationPriceKind");
  expect(result.complete).toBe(true);
  setCliColorEnabledOverride(false);
  try {
    expect(renderHeadlessPaneText(collectionHoldingsHeadless, result, closeArgs, "PF")).toMatch(/PL=F:NYM .* Fri 16 Oct settle/);
  } finally {
    setCliColorEnabledOverride(null);
  }
});

test("fn PF --from lists the period's P&L largest first within --limit, with the FX line and the total over every position", async () => {
  setSystemTime(new Date("2026-11-05T13:00:00Z"));
  const closes: Record<string, [number, number]> = { AAPL: [347.73, 344.63], TSLA: [400, 380], "2382": [63.15, 63.3] };
  const hk = createTestTicker("2382", "Sunny Optical", { exchange: "HKEX", currency: "HKD", portfolios: [MANUAL.id],
    positions: [{ portfolio: MANUAL.id, shares: 1_000, currency: "HKD", broker: "manual" }] });
  const base = context([holding("AAPL", 50, 230, MANUAL.id), holding("TSLA", -20, 300, MANUAL.id), hk]);
  const ctx = {
    ...base,
    marketData: createTestDataProvider({
      getQuote: async (symbol) => createTestQuote({ symbol, price: closes[symbol]![1], currency: symbol === "2382" ? "HKD" : "USD" }),
      getDetailedPriceHistoryWithMetadata: async (symbol, _exchange, start, end, interval) => ({
        points: [["2026-10-23", closes[symbol]![0]], ["2026-10-30", closes[symbol]![1]]]
          .map(([date, close]) => ({ date: new Date(`${date}T00:00:00Z`), close: close as number }))
          .filter((point) => point.date >= start && point.date <= end),
        resolution: interval as ManualChartResolution,
      }),
    }),
    apiClient: { getCloudHistory: async (symbol: string, _exchange: string, params: { startDate?: string; endDate?: string }) => ({ status: "success",
      data: symbol === "HKD=X" ? [["2026-10-23", 7.8], ["2026-10-30", 7.75]].filter(([date]) => date! >= params.startDate! && date! <= params.endDate!)
        .map(([date, close]) => ({ date: `${date}T00:00:00.000Z`, close })) : [] }) },
  } as unknown as HeadlessPaneContext;
  const period = (options: Record<string, unknown>) => args(MANUAL.id, { from: "2026-10-26", to: "2026-10-30", ...options } as unknown as Record<string, number>);
  const result = await collectionHoldingsHeadless.load(period({ limit: 2 }), ctx);
  // The two largest at the start, in USD (AAPL's $17,387, 2382's HK$63,150 at 7.80, $8,096, over TSLA's $8,000 short),
  // then the FX line and the total, which count TSLA too.
  expect(result.rows.map((row) => row.symbol)).toEqual(["AAPL", "2382", "FX (HKD)", "TOTAL"]);
  const fx = 63_150 * (1 / 7.75 - 1 / 7.8);
  expect(result.rows.at(-1)!.pnl as number).toBeCloseTo(150 / 7.75 + 50 * (344.63 - 347.73) + -20 * (380 - 400) + fx, 6);
  expect(result.metadata?.notices).toContain("1 more position not shown; the FX line and the total include every position.");
  expect(result.columns?.find((column) => column.key === "pnl")?.header).toBe("P&L (USD)");
  setCliColorEnabledOverride(false);
  try {
    expect(renderHeadlessPaneText(collectionHoldingsHeadless, result, period({ limit: 2 }), "PF"))
      .toContain("P&L from the close of Fri 23 Oct to the close of Fri 30 Oct, on the holdings held now, in USD.");
  } finally {
    setCliColorEnabledOverride(null);
  }
  // --close already is what --from reads; a watchlist holds no positions.
  await expect(collectionHoldingsHeadless.load(period({ close: true }), ctx)).rejects.toThrow("leave out --close");
  await expect(collectionHoldingsHeadless.load({ ...period({}), rawArgument: "tech", argument: "tech" }, ctx)).rejects.toThrow("a watchlist holds no positions");
});

test("a pre-market quote without a known regular close supplies no regular-session change", async () => {
  const ctx = { ...context(), marketData: createTestDataProvider({ getQuote: async symbol => createTestQuote({ symbol, price: 101, marketState: "PRE", changePercent: 1 }) }) } as HeadlessPaneContext;
  const result = await collectionHoldingsHeadless.load(args("tech"), ctx);
  expect(result.rows[0]).toMatchObject({ changePercent: null, changeBasis: null });
});

test("a multi-month window labels its 20% return as Period %, separately from the 1% regular-session move", async () => {
  setSystemTime(new Date("2026-11-05T13:00:00Z"));
  const base = context([holding("AAPL", 10, 80, MANUAL.id)]);
  const ctx = { ...base, marketData: createTestDataProvider({
    getQuote: async () => createTestQuote({ symbol: "AAPL", price: 120, changePercent: 1, marketState: "REGULAR" }),
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => ({
      points: [{ date: new Date("2026-07-31T00:00:00Z"), close: 100 }, { date: new Date("2026-10-30T00:00:00Z"), close: 120 }],
      resolution: interval as ManualChartResolution,
    }),
  }) } as HeadlessPaneContext;
  const period = await collectionHoldingsHeadless.load(args(MANUAL.id, { from: "2026-08-01", to: "2026-10-30" } as never), ctx);
  const regular = await collectionHoldingsHeadless.load(args(MANUAL.id), ctx);
  expect(period.rows.find(row => row.symbol === "AAPL")?.changePercent).toBeCloseTo(20);
  expect(period.columns?.find(column => column.key === "changePercent")?.header).toBe("Period %");
  expect(period.columns?.find(column => column.key === "changePercent")?.header).not.toBe("Regular %");
  expect(regular.rows.find(row => row.symbol === "AAPL")?.changePercent).toBe(1);
  expect(regular.columns?.find(column => column.key === "changePercent")?.header).toBe("Regular %");
});
