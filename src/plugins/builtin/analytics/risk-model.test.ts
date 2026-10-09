import { expect, test } from "bun:test";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import {
  buildPortfolioRisk,
  portfolioRiskRequests,
  portfolioRiskTickers,
  riskCoverageNotices,
  riskCoverageShortfall,
  riskCoverageText,
} from "./risk-model";
import {
  BEYOND_SIZE_REASON,
  fetchPortfolioRiskMarket,
  RISK_FACTOR_INSTRUMENTS,
  RISK_HISTORY_LIMIT,
  validateRiskHistory,
  type RiskMarketSnapshot,
} from "./risk-client";
import {
  BROKER_PORTFOLIO,
  brokerFixtureHoldings,
  brokerFixtureTickers,
  brokerRiskClient,
  riskHistory,
  riskQuote,
  now,
} from "./risk-test-data";
import { portfolioOptionGreeks } from "./risk-options";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
import { createTestTicker } from "../../../test-support/ticker";
const portfolio: Portfolio = {
  id: "local",
  name: "Test basket",
  currency: "USD",
};
function holding(symbol: string, quantity = 1): TickerRecord {
  return createTestTicker(symbol, symbol, {
    exchange: "ARCA",
    portfolios: ["local"],
    positions: [{ portfolio: "local", shares: quantity, broker: "manual" }],
  });
}
function market(staleQuotes: readonly string[] = []): RiskMarketSnapshot {
  return {
    histories: RISK_FACTOR_INSTRUMENTS.map((instrument) => {
      const history = riskHistory();
      history.providerMeta!.normalizedSymbol = instrument.symbol;
      history.providerMeta!.normalizedExchange = instrument.exchange;
      const quote = {
          ...riskQuote(instrument.symbol, instrument.exchange),
          ...(staleQuotes.includes(instrument.symbol) ? { stale: true } : {}),
        },
        valid = validateRiskHistory(history, instrument, quote, now);
      return { instrument, currency: "USD", quote, ...valid, error: null };
    }),
    yields: null,
    volatility: null,
    warnings: [],
    fetchedAt: now.toISOString(),
  };
}
async function brokerModel(holdings = brokerFixtureHoldings(), fx = false) {
  const tickers = brokerFixtureTickers(holdings);
  const client = brokerRiskClient(now, holdings, { fx });
  const market = await fetchPortfolioRiskMarket(
    portfolioRiskRequests(portfolioRiskTickers(tickers, BROKER_PORTFOLIO.id), BROKER_PORTFOLIO.id),
    client as never,
    now,
  );
  return { model: buildPortfolioRisk(BROKER_PORTFOLIO, tickers, market), client };
}
test("a broker account estimates on the holdings that qualify and lists every other with its reason", async () => {
  const { model, client } = await brokerModel();
  // Without daily FX closes a foreign listing is quoted for its value but never requests its own history.
  expect(client.calls.histories.filter((symbol) => /^(EUR|GBP|HKD|JPY|TWD)\d$/.test(symbol))).toEqual([]);
  expect(client.calls.rates.toSorted()).toEqual(["EUR", "GBP", "HKD", "JPY", "TWD"]);
  // 85 US listings worth $365,500 of $468,560: foreign listings at the load's rates, the rest at the broker's value.
  expect(model.coverage).toMatchObject({ holdings: 94, covered: 85, unvalued: 0, marketValue: 468_560, coveredValue: 365_500, sufficient: true });
  expect(model.coverage.share).toBeCloseTo(365_500 / 468_560, 10);
  expect(riskCoverageText(model.coverage)).toBe("covers 78% of market value \u00b7 9 holdings left out");
  expect(riskCoverageNotices(model.coverage)).toEqual([
    "EUR2 (4.3% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "TWD1 (4.0% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "EUR1 (3.5% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "GBP1 (2.7% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "HKD1 (2.2% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "JPY1 (2.2% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.",
    "UNQ1 (1.7% of market value) is excluded from the risk estimate: daily history unavailable.",
    "UNQ2 (1.1% of market value) is excluded from the risk estimate: daily history unavailable.",
    "UNQ3 (0.4% of market value) is excluded from the risk estimate: daily history unavailable.",
  ]);
  // Weights renormalize over the basket; nothing left out carries one.
  const weights = new Map(model.holdings.map((row) => [row.symbol, row.weight]));
  expect(weights.get("US85")).toBeCloseTo(8_500 / 365_500, 12);
  expect(weights.get("EUR2")).toBeNull();
  expect(model.holdings.reduce((sum, row) => sum + (row.weight ?? 0), 0)).toBeCloseTo(1, 12);
  expect(model.metrics.every((row) => row.value != null)).toBe(true);
  expect(model.factors.every((row) => row.value != null)).toBe(true);
  expect(model.rows.correlation).toHaveLength((85 * 84) / 2);
  expect(model.rows.holdings.find((row) => row.label === "TWD1")).toMatchObject({ value: null, leftOut: "Foreign holdings: daily FX closes unavailable" });
  expect(model.complete).toBe(false);

  // A left-out holding nothing values makes the share an upper bound.
  const unvalued = brokerFixtureHoldings().map((row) => (row.symbol === "UNQ3" ? { ...row, brokerValue: undefined } : row));
  const bound = (await brokerModel(unvalued)).model.coverage;
  expect(bound.unvalued).toBe(1);
  expect(riskCoverageText(bound)).toBe("covers at most 78% of market value \u00b7 9 holdings left out");
  expect(riskCoverageNotices(bound).at(-1)).toBe("UNQ3 (value unknown) is excluded from the risk estimate: daily history unavailable.");
});

test("foreign listings with daily FX closes enter the basket in USD and the footer says so", async () => {
  const { model, client } = await brokerModel(brokerFixtureHoldings(), true);
  // One FX history per currency, however many holdings convert with it.
  expect(client.calls.histories.filter((symbol) => symbol.endsWith("=X")).toSorted())
    .toEqual(["EURUSD=X", "GBPUSD=X", "HKD=X", "JPY=X", "TWD=X"]);
  // $365,500 of US listings plus $88,060 of foreign ones at the current rates.
  expect(model.coverage).toMatchObject({ covered: 91, converted: 6, coveredValue: 453_560, sufficient: true });
  expect(riskCoverageText(model.coverage)).toBe(
    "covers 96% of market value \u00b7 3 holdings left out \u00b7 6 holdings converted from local currency",
  );
  const jpy = model.holdings.find((row) => row.symbol === "JPY1")!;
  // 500 shares at 3,000 JPY, marked at the current rate of 0.0068 USD per yen.
  expect(jpy).toMatchObject({ convertedFrom: "JPY", currency: "USD", leftOut: null });
  expect(jpy.value).toBeCloseTo(10_200, 6);
  // Pence convert through GBP: 500 shares at 2,000p and 1.25 USD per pound.
  expect(model.holdings.find((row) => row.symbol === "GBP1")!.value).toBeCloseTo(12_500, 6);
  // Converted returns sit on the basket's calendar, so the estimates still have 60 matched sessions.
  expect(model.metrics.every((row) => row.value != null)).toBe(true);
  expect(model.rows.holdings.find((row) => row.label === "JPY1")?.detail).toContain("from JPY at daily FX");
  // Closes at another time than the US session read low against US holdings, and the pane says so.
  expect(model.notes).toContain(
    "Converted holdings are matched to the US close of the same date; where their market closes at another time, correlations and betas to US holdings read lower than they are.",
  );
});
test("past the size limit the largest holdings by value are modelled and the rest left out", async () => {
  // Listed smallest first, so the limit has to rank by value rather than keep the order.
  const holdings = Array.from({ length: RISK_HISTORY_LIMIT + 10 }, (_, index) => ({
    symbol: `H${String(index).padStart(3, "0")}`,
    exchange: "NASDAQ",
    currency: "USD",
    quantity: index + 1,
    price: 100,
  }));
  const { model, client } = await brokerModel(holdings);
  expect(new Set(client.calls.histories).size).toBe(RISK_HISTORY_LIMIT + RISK_FACTOR_INSTRUMENTS.length);
  expect(model.coverage.leftOut.map((row) => row.symbol)).toEqual(
    holdings.slice(0, 10).map((row) => row.symbol).reverse(),
  );
  expect(new Set(model.coverage.leftOut.map((row) => row.reason))).toEqual(new Set([BEYOND_SIZE_REASON]));
  // Quantities 11 to 160 of 1 to 160, all at $100.
  expect(model.coverage.share).toBeCloseTo(12_825 / 12_880, 12);
  expect(model.coverage.covered).toBe(RISK_HISTORY_LIMIT);
});
test("below half of market value the basket views estimate nothing and say why", async () => {
  // Ten US listings worth $5,500 against $103,060 left out.
  const holdings = brokerFixtureHoldings().filter((row) => row.currency !== "USD" || !/^US(?:[2-9]\d|1[1-9])$/.test(row.symbol));
  const { model } = await brokerModel(holdings);
  expect(model.coverage).toMatchObject({ covered: 10, coveredValue: 5_500, marketValue: 108_560, sufficient: false });
  expect(model.metrics.every((row) => row.value == null)).toBe(true);
  expect(model.factors.every((row) => row.value == null)).toBe(true);
  expect(model.rows.correlation).toEqual([]);
  expect(model.book).toBeNull();
  expect(model.holdings.every((row) => row.weight == null)).toBe(true);
  expect(riskCoverageShortfall(model.coverage)).toEqual({
    title: "Qualifying holdings cover 5% of market value; basket estimates need 50%.",
    message: "Most of what is left out: Foreign holdings: daily FX closes unavailable (81.1% of market value).",
  });
  expect(() =>
    buildPortfolioRisk(portfolio, [], market(), {
      version: 1,
      portfolioId: "someone-else",
      currency: "USD",
      source: "statement",
    }),
  ).toThrow("different portfolio");
});
test("factor proxies resolve on their own listing venue", () => {
  const snapshot = market();
  const momentum = snapshot.histories.find(
    (row) => row.instrument.symbol === "MTUM",
  )!;
  expect(momentum.instrument.exchange).toBe("BATS");
  momentum.returns = momentum.returns.map((row, index) => ({
    ...row,
    value: row.value * 1.5 + (index % 3) * 0.001,
  }));
  const model = buildPortfolioRisk(portfolio, [holding("SPY")], snapshot);
  const factor = model.factors.find((row) => row.id === "momentum")!;
  expect(factor.samples).toBe(60);
  expect(factor.value).not.toBeNull();
});
test("only held positions marked at a close raise the close-mark warning", () => {
  // Factor proxies with no current quote never weight a holding.
  const snapshot = market(["IWM", "IWD", "IWF", "MTUM", "IEF", "HYG"]);
  const warning = (model: ReturnType<typeof buildPortfolioRisk>) =>
    model.notes.filter((row) => row.includes("no current quote"));
  expect(
    warning(buildPortfolioRisk(portfolio, [holding("SPY")], snapshot)),
  ).toEqual([]);
  expect(
    warning(
      buildPortfolioRisk(portfolio, [holding("SPY"), holding("IWM")], snapshot),
    ),
  ).toEqual([
    "1 holding had no current quote; weighted at the latest completed close.",
  ]);
});
test("a short is left out of the basket with its reason and counts in the market value", () => {
  const model = buildPortfolioRisk(
    portfolio,
    [holding("SPY", 3), holding("IWM", -1)],
    market(),
  );
  expect(model.coverage.share).toBe(0.75);
  expect(model.coverage.leftOut).toEqual([
    { id: "ARCA:IWM", symbol: "IWM", reason: "Short positions: signed exposure history required", value: 110, share: 0.25 },
  ]);
  expect(model.holdings.map((row) => row.weight)).toEqual([1, null]);
  expect(model.book?.gross).toBe(330);
  expect(model.metrics[2]!.value).toBeCloseTo(0, 8);
});
test("a crypto holding is excluded by name with its reason, not folded into the equity basket", () => {
  const eth = createTestTicker("ETH-USD", "Ethereum USD", {
    exchange: "CCC",
    portfolios: ["local"],
    positions: [{ portfolio: "local", shares: 2, broker: "manual" }],
  });
  const model = buildPortfolioRisk(portfolio, [holding("SPY", 3), eth], market());
  expect(model.holdings.map((row) => [row.symbol, row.weight])).toEqual([["SPY", 1], ["ETH-USD", null]]);
  expect(riskCoverageNotices(model.coverage)).toEqual([
    "ETH-USD (value unknown) is excluded from the risk estimate: crypto is not covered by the equity basket.",
  ]);
});
test("imported option snapshots use signed dollar sensitivities, preserve scope and reject stale or mixed currencies", () => {
  const position = {
    symbol: "SPY",
    currency: "USD",
    spot: 100,
    rate: 0.04,
    dividendYield: 0.01,
    asOf: now.getTime() - 1000,
    legs: [
      {
        id: "call",
        side: "call" as const,
        quantity: 2,
        strike: 100,
        expiration: Date.parse("2026-12-18") / 1000,
        price: 5,
        volatility: 0.2,
        multiplier: 100,
      },
    ],
  };
  const evidence = parsePortfolioRiskEvidence(
    JSON.stringify({
      version: 1,
      portfolioId: "local",
      currency: "USD",
      source: "OSA dated input",
      options: { scope: "imported", positions: [position] },
    }),
    now,
  )!;
  const book = { ...evidence.options!, warnings: [], complete: true };
  const long = portfolioOptionGreeks(book, "USD", now.getTime());
  const short = portfolioOptionGreeks(
    {
      ...book,
      positions: [
        { ...position, legs: [{ ...position.legs[0]!, quantity: -2 }] },
      ],
    },
    "USD",
    now.getTime(),
  );
  expect(long.scope).toBe("imported");
  expect(long.total!.deltaDollars).toBeGreaterThan(0);
  expect(short.total!.deltaDollars).toBeCloseTo(-long.total!.deltaDollars, 8);
  expect(short.total!.gammaOnePercent).toBeCloseTo(
    -long.total!.gammaOnePercent,
    8,
  );
  expect(portfolioOptionGreeks(book, "EUR", now.getTime()).total).toBeNull();
  expect(
    portfolioOptionGreeks(book, "USD", now.getTime() + 5 * 86_400_000).total,
  ).toBeNull();
  expect(() =>
    parsePortfolioRiskEvidence(
      JSON.stringify({ ...evidence, currency: "EUR" }),
      now,
    ),
  ).toThrow("currency");
});

test("broker option matching requires one exact conId and source contract, preserving supplied multipliers", async () => {
  const { loadPortfolioOptionBook } = await import("./risk-options");
  const expiration = Date.parse("2026-12-18") / 1000;
  const quote = riskQuote("SPY");
  const ready = (data: any) => ({
    phase: "ready" as const,
    data,
    lastGoodData: data,
    source: "Cloud",
    fetchedAt: now.getTime(),
    staleAt: now.getTime() + 60_000,
    error: null,
    attempts: [],
  });
  const contract = {
    contractSymbol: "SPY261218C00100000",
    currency: "USD",
    expiration,
    strike: 100,
    lastPrice: 12,
    change: 0,
    percentChange: 0,
    bid: 11,
    ask: 13,
    impliedVolatility: 0.2,
    inTheMoney: true,
    lastTradeDate: now.getTime() / 1000,
  };
  const dependencies = {
    now: () => now.getTime(),
    loadQuote: async () => ready(quote),
    loadSnapshot: async () =>
      ready({
        quote,
        fundamentals: { dividendYield: 0.01 },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
      }),
    loadOptions: async () =>
      ready({
        underlyingSymbol: "SPY",
        expirationDates: [expiration],
        calls: [contract],
        puts: [],
        asOf: now.toISOString(),
      }),
    loadYieldCurve: async () => [
      { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
      { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" },
    ],
  };
  const ticker = holding("SPY261218C00100000", 2);
  ticker.metadata.assetCategory = "OPT";
  ticker.metadata.positions[0]!.brokerContractId = 123;
  ticker.metadata.positions[0]!.multiplier = 100;
  ticker.metadata.broker_contracts = [
    {
      brokerId: "test",
      conId: 123,
      symbol: "SPY",
      localSymbol: "SPY 261218C00100000",
      secType: "OPT",
      currency: "USD",
      right: "C",
      strike: 100,
      multiplier: "100",
      lastTradeDateOrContractMonth: "20261218",
    },
  ];
  const matched = await loadPortfolioOptionBook(
    [ticker],
    portfolio,
    dependencies,
  );
  expect(matched.complete).toBe(true);
  expect(matched.positions[0]!.legs[0]!.quantity).toBe(2);
  expect(matched.positions[0]!.legs[0]!.multiplier).toBe(100);
  ticker.metadata.broker_contracts[0]!.localSymbol = "SPY261218C00101000";
  const wrong = await loadPortfolioOptionBook(
    [ticker],
    portfolio,
    dependencies,
  );
  expect(wrong.complete).toBe(false);
  expect(wrong.positions).toHaveLength(0);
  ticker.metadata.broker_contracts[0]!.conId = 789;
  const ambiguous = await loadPortfolioOptionBook(
    [ticker],
    portfolio,
    dependencies,
  );
  expect(ambiguous.warnings[0]).toContain("Exact broker");
});
