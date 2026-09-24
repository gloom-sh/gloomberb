import { expect, test } from "bun:test";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { buildPortfolioRisk } from "./risk-model";
import {
  RISK_FACTOR_INSTRUMENTS,
  validateRiskHistory,
  type RiskMarketSnapshot,
} from "./risk-client";
import { riskHistory, riskQuote, now } from "./risk-test-data";
import { portfolioOptionGreeks } from "./risk-options";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
const portfolio: Portfolio = {
  id: "local",
  name: "Test basket",
  currency: "USD",
};
function holding(symbol: string, quantity = 1): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "ARCA",
      name: symbol,
      currency: "USD",
      portfolios: ["local"],
      watchlists: [],
      positions: [{ portfolio: "local", shares: quantity, broker: "manual" }],
      tags: [],
      custom: {},
    },
  };
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
test("missing holdings block complete-book risk without renormalizing the surviving book", () => {
  const complete = buildPortfolioRisk(
    portfolio,
    [holding("SPY"), holding("IWM")],
    market(),
  );
  expect(complete.complete).toBe(true);
  expect(complete.holdings.map((row) => row.weight)).toEqual([0.5, 0.5]);
  expect(complete.metrics[2]!.value).toBeCloseTo(0, 8);
  const missing = buildPortfolioRisk(
    portfolio,
    [holding("SPY"), holding("MISSING")],
    market(),
  );
  expect(missing.complete).toBe(false);
  expect(missing.metrics.every((row) => row.value === null)).toBe(true);
  expect(missing.holdings.every((row) => row.weight === null)).toBe(true);
  const noHistory = market();
  noHistory.histories[1]!.returns = [];
  noHistory.histories[1]!.error = "History unavailable";
  const partial = buildPortfolioRisk(
    portfolio,
    [holding("SPY"), holding("IWM")],
    noHistory,
  );
  expect(partial.holdings[0]!.weight).toBe(0.5);
  expect(partial.complete).toBe(false);
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
    model.warnings.filter((row) => row.includes("no current quote"));
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
test("signed equity exposure remains in concentration while shorts block the unfinanced basket", () => {
  const model = buildPortfolioRisk(
    portfolio,
    [holding("SPY", 3), holding("IWM", -1)],
    market(),
  );
  expect(model.book?.net).toBe(220);
  expect(model.book?.gross).toBe(440);
  expect(model.holdings[1]!.weight).toBe(0.25);
  expect(model.complete).toBe(false);
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
