import { describe, expect, test } from "bun:test";
import { YahooFinanceClient } from "./yahoo-finance";
import { getYahooSymbolsToTry } from "./yahoo-finance/symbols";

describe("YahooFinanceClient exchange aliases", () => {
  test("FX rates keep the matching price observation time and reject another pair", async () => {
    const provider = new YahooFinanceClient() as any;
    const previous = Date.now() - 7_200_000;
    provider.fetchChart = async () => ({ meta: { symbol: "JPYUSD=X", currency: "USD", regularMarketPrice: 1 / 154, regularMarketTime: previous / 1000 }, history: [] });
    const snapshot = await provider.getExchangeRateSnapshot("JPY");
    expect(snapshot.rate).toBeCloseTo(1 / 154, 12);
    expect(snapshot.asOf).toBe(new Date(previous).toISOString());
    expect(Date.parse(snapshot.fetchedAt)).toBeGreaterThan(previous);
    expect(snapshot.stale).toBe(true);
    provider.fetchChart = async () => ({ meta: { symbol: "JPYUSD=X", currency: "USD", regularMarketPrice: 0.0065, regularMarketTime: previous / 1000 }, history: [{ date: new Date(previous), close: 0.006475719157606363 }] });
    expect((await provider.getExchangeRateSnapshot("JPY")).rate).toBe(0.006475719157606363);
    provider.fetchChart = async () => ({ meta: { symbol: "JPYUSD=X", currency: "USD" }, history: [{ date: new Date(previous), close: 1 / 155 }] });
    expect(await provider.getExchangeRateSnapshot("JPY")).toMatchObject({ rate: 1 / 155, asOf: new Date(previous).toISOString() });
    provider.fetchChart = async () => ({ meta: { symbol: "USDJPY=X", currency: "JPY", regularMarketPrice: 154 }, history: [] });
    await expect(provider.getExchangeRateSnapshot("JPY")).rejects.toThrow("pair mismatch");
    provider.fetchChart = async () => ({ meta: { regularMarketPrice: 1 / 154 }, history: [{ date: new Date(previous), close: 1 / 155 }] });
    // An unrelated old bar cannot supply the timestamp for an undated current price.
    expect((await provider.getExchangeRateSnapshot("JPY")).asOf).toBeUndefined();
  });

  test("maps detailed statement sub-lines from fundamentals timeseries", async () => {
    const provider = new YahooFinanceClient() as any;
    const point = (type: string, value: number) => ({
      meta: { type: [type] },
      [type]: [{ asOfDate: "2025-12-31", reportedValue: { raw: value } }],
    });

    provider.fetchChart = async () => ({
      meta: { currency: "USD", regularMarketPrice: 100, shortName: "AMD" },
      history: [{ date: new Date("2025-12-31T00:00:00Z"), close: 100 }],
    });
    provider.fetchAssetProfile = async () => undefined;
    provider.fetchQuoteSupplement = async () => ({});
    provider.fetchExtendedHoursData = async () => ({});
    provider.secClient.getFinancialStatements = async () => null;
    provider.fetchTimeseries = async () => [
      point("annualAccountsReceivable", 7_450_000_000),
      point("annualInventory", 4_880_000_000),
      point("annualStockBasedCompensation", 1_230_000_000),
      point("annualCashFlowFromContinuingOperatingActivities", 6_490_000_000),
      point("annualInterestPaidSupplementalData", 91_000_000),
      point("annualCurrentDeferredRevenue", 544_000_000),
      point("annualPurchaseOfPPE", -900_000_000),
      point("annualAdditionalPaidInCapital", 44_000_000_000),
      point("quarterlyAccountsPayable", 2_100_000_000),
      point("quarterlyOtherNonCashItems", 91_000_000),
      point("quarterlyCashFlowFromContinuingFinancingActivities", -328_000_000),
      point("quarterlyEndCashPosition", 5_540_000_000),
    ];

    const financials = await provider.getTickerFinancials("AMD", "NASDAQ");

    expect(financials.annualStatements[0]).toMatchObject({
      accountsReceivable: 7_450_000_000,
      inventory: 4_880_000_000,
      stockBasedCompensation: 1_230_000_000,
      cashFlowFromContinuingOperatingActivities: 6_490_000_000,
      interestPaidSupplementalData: 91_000_000,
      currentDeferredRevenue: 544_000_000,
      purchaseOfPPE: -900_000_000,
      additionalPaidInCapital: 44_000_000_000,
    });
    expect(financials.quarterlyStatements[0]).toMatchObject({
      accountsPayable: 2_100_000_000,
      otherNonCashItems: 91_000_000,
      cashFlowFromContinuingFinancingActivities: -328_000_000,
      endCashPosition: 5_540_000_000,
    });
  });

  test("supplements US Yahoo financials with deeper SEC statement history", async () => {
    const provider = new YahooFinanceClient() as any;
    const point = (type: string, date: string, value: number) => ({
      meta: { type: [type] },
      [type]: [{ asOfDate: date, reportedValue: { raw: value } }],
    });

    provider.fetchChart = async () => ({
      meta: { currency: "USD", regularMarketPrice: 100, shortName: "AMD" },
      history: [{ date: new Date("2025-12-31T00:00:00Z"), close: 100 }],
    });
    provider.fetchAssetProfile = async () => undefined;
    provider.fetchQuoteSupplement = async () => ({});
    provider.fetchExtendedHoursData = async () => ({});
    provider.fetchTimeseries = async () => [
      point("annualTotalRevenue", "2025-12-31", 200),
      point("quarterlyTotalRevenue", "2025-12-31", 60),
    ];
    provider.secClient.getFinancialStatements = async (ticker: string) => {
      expect(ticker).toBe("AMD");
      return {
        annualStatements: [
          { date: "2023-12-31", totalRevenue: 100 },
          { date: "2024-12-31", totalRevenue: 150 },
          { date: "2025-12-31", totalRevenue: 190, netIncome: 40 },
        ],
        quarterlyStatements: [
          { date: "2025-03-31", totalRevenue: 45 },
          { date: "2025-06-30", totalRevenue: 50 },
          { date: "2025-09-30", totalRevenue: 55 },
          { date: "2025-12-31", totalRevenue: 58, netIncome: 12 },
        ],
      };
    };

    const financials = await provider.getTickerFinancials("AMD", "NASDAQ");

    expect(financials.annualStatements.map((row: any) => [row.date, row.totalRevenue, row.netIncome])).toEqual([
      ["2023-12-31", 100, undefined],
      ["2024-12-31", 150, undefined],
      ["2025-12-31", 200, 40],
    ]);
    expect(financials.quarterlyStatements.map((row: any) => [row.date, row.totalRevenue, row.netIncome])).toEqual([
      ["2025-03-31", 45, undefined],
      ["2025-06-30", 50, undefined],
      ["2025-09-30", 55, undefined],
      ["2025-12-31", 60, 12],
    ]);
  });

  test("tries the Taipei Exchange suffix for TPEX tickers", () => {
    expect(getYahooSymbolsToTry("3105", "TPEX")).toEqual(["3105.TWO", "3105.TW"]);
  });

  test("prefers Frankfurt-style symbols for FWB2 listings", () => {
    expect(getYahooSymbolsToTry("HY9H", "FWB2")).toEqual(["HY9H.F", "HY9H.DE"]);
  });

  test("maps manual resolution requests to yahoo chart range plus interval", async () => {
    const provider = new YahooFinanceClient() as any;
    let requested = false;
    provider.fetchChart = async (symbol: string, range: string, interval: string) => {
      requested = true;
      expect({ symbol, range, interval }).toEqual({
        symbol: "AAPL",
        range: "1y",
        interval: "1wk",
      });
      return {
        meta: { currency: "USD" },
        history: [{ date: new Date("2026-03-30T00:00:00Z"), close: 200 }],
      };
    };

    const history = await provider.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1wk");

    expect(requested).toBe(true);
    expect(history[0]?.close).toBe(200);
  });

  test("maps IBKR option symbols to Yahoo option quote marks", async () => {
    const provider = new YahooFinanceClient() as any;
    const expiration = 1_821_139_200;
    let underlyingMarketState = "POST";
    provider.http.fetchJsonWithCrumb = async () => ({
      optionChain: {
        result: [{
          underlyingSymbol: "AMD",
          expirationDates: [expiration],
          quote: { marketState: underlyingMarketState },
          options: [{
            calls: [{
              contractSymbol: "AMD270917C00230000",
              strike: 230,
              currency: "USD",
              lastPrice: 251,
              change: 1.5,
              percentChange: 0.6,
              volume: 10,
              openInterest: 20,
              bid: 250.25,
              ask: 254.5,
              impliedVolatility: 0.4,
              inTheMoney: false,
              expiration,
              lastTradeDate: 1_800_000_000,
            }],
            puts: [],
          }],
        }],
      },
    });

    const requestedAt = Date.now();
    const quote = await provider.getQuote("AMD   270917C00230000");

    expect(quote).toMatchObject({
      symbol: "AMD   270917C00230000",
      price: 252.375,
      mark: 252.375,
      bid: 250.25,
      ask: 254.5,
      providerId: "yahoo",
      marketState: "CLOSED",
      sessionConfidence: "derived",
    });
    expect(quote.lastUpdated).toBeGreaterThanOrEqual(requestedAt);

    underlyingMarketState = "REGULAR";
    const regularQuote = await provider.getQuote("AMD   270917C00230000");
    expect(regularQuote).toMatchObject({
      marketState: "REGULAR",
      sessionConfidence: "derived",
    });
  });

  test("preserves analyst rating price targets from upgrade history", async () => {
    const provider = new YahooFinanceClient() as any;
    let requestUrl = "";
    provider.getSymbolsToTry = () => ["AMD"];
    provider.http.fetchJsonWithCrumb = async (url: string) => {
      requestUrl = url;
      return {
        quoteSummary: {
          result: [{
            price: { symbol: "AMD", currency: "USD", exchangeName: "NasdaqGS" },
            financialData: {},
            recommendationTrend: { trend: [] },
            earningsTrend: { trend: [] },
            upgradeDowngradeHistory: {
              history: [{
                epochGradeDate: 1778188318,
                firm: "Citigroup",
                toGrade: "Neutral",
                fromGrade: "Neutral",
                action: "main",
                priceTargetAction: "Raises",
                currentPriceTarget: 358,
                priorPriceTarget: 248,
              }],
            },
          }],
        },
      };
    };

    const research = await provider.getAnalystResearch("AMD", "NASDAQ");

    expect(requestUrl).toContain("upgradeDowngradeHistory");
    expect(research.ratings[0]).toMatchObject({
      date: "2026-05-07",
      firm: "Citigroup",
      action: "Raises",
      current: "Neutral",
      prior: "Neutral",
      currentPriceTarget: 358,
      priorPriceTarget: 248,
    });
  });

  test("maps Yahoo corporate actions into pane rows", async () => {
    const provider = new YahooFinanceClient() as any;
    const unix = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

    provider.getSymbolsToTry = () => ["USAU"];
    provider.fetchChart = async () => ({
      meta: { currency: "USD" },
      history: [{ date: new Date("2026-02-03T00:00:00Z"), close: 15 }],
      events: {
        dividends: {
          dividend: { date: unix("2026-02-03"), amount: 0.12 },
        },
        splits: {
          split: { date: unix("2026-01-02"), numerator: 2, denominator: 1, splitRatio: "2:1" },
        },
      },
    });
    provider.http.fetchJsonWithCrumb = async () => ({
      quoteSummary: {
        result: [{
          price: { symbol: "USAU", currency: "USD", shortName: "U.S. Gold Corp.", exchangeName: "NasdaqCM" },
          calendarEvents: {
            earnings: {
              earningsDate: [{ raw: unix("2026-03-16") }],
              earningsAverage: { raw: -0.185 },
            },
          },
          earningsHistory: {
            history: [{
              quarter: { raw: unix("2026-01-31") },
              epsActual: { raw: -0.35 },
              epsEstimate: { raw: -0.13 },
              epsDifference: { raw: -0.22 },
              surprisePercent: { raw: -1.6923 },
            }],
          },
        }],
      },
    });

    const actions = await provider.getCorporateActions("USAU", "NASDAQ");

    expect(actions).toMatchObject({
      providerId: "yahoo",
      symbol: "USAU",
      currency: "USD",
      dividends: [{ exDate: "2026-02-03", amount: 0.12 }],
      splits: [{ date: "2026-01-02", description: "2:1 split", ratio: 2, fromFactor: 1, toFactor: 2 }],
      earnings: [
        { date: "2026-03-16", time: "", epsEstimate: -0.185 },
        { date: "2026-01-31", epsActual: -0.35, epsEstimate: -0.13, difference: -0.22, surprisePercent: -169.23 },
      ],
    });
  });
});
