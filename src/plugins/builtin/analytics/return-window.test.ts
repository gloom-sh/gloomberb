import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { normalizePriceHistory } from "../../../utils/price-history";
import { buildChartKey } from "../../../market-data/selectors";
import { computeDatedBeta, computeWeightedPortfolioReturns, resolveDatedReturns } from "./metrics";
import { buildPortfolioChartTargets, buildPortfolioReturnSeries } from "./pane-model";

const datedReturns = (history: PricePoint[]) => resolveDatedReturns(history).returns;

const prices = (factor: number): PricePoint[] => {
  let close = 100;
  return Array.from({ length: 25 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 5, index + 1)),
    close: index === 0 ? close : (close *= 1 + factor * [0.01, -0.02, 0.03, -0.01][(index - 1) % 4]!),
  }));
};

test("fixed basket weights use common intervals after an IPO and beta matches both interval endpoints", () => {
  const market = datedReturns(prices(1));
  const basket = computeWeightedPortfolioReturns([
    { weight: 50, returns: datedReturns(prices(2)) },
    { weight: 50, returns: datedReturns(prices(0).slice(10)) },
  ]);
  expect(basket).toHaveLength(14);
  expect(basket[0]).toMatchObject({ startDateKey: "2026-06-11", dateKey: "2026-06-12" });
  expect(computeDatedBeta(basket, market)).toBeCloseTo(1, 10);
  const sparseMarket = datedReturns(prices(1).filter((_, index) => index % 2 === 0));
  expect(computeDatedBeta(basket, sparseMarket)).toBeNull();
  // Genuine multi-session samples are still comparable when both endpoints match.
  expect(computeDatedBeta(sparseMarket, sparseMarket)).toBeCloseTo(1, 10);
});

test("missing, zero and omitted closes cannot bridge the other holding's one-session interval", () => {
  const market = datedReturns(prices(1));
  for (const missing of [null, Number.NaN, 0, "omitted"] as const) {
    const raw = prices(2);
    if (missing === "omitted") raw.splice(12, 1);
    else raw[12] = { ...raw[12]!, close: missing as number };
    const history = normalizePriceHistory(raw);
    const basket = computeWeightedPortfolioReturns([
      { weight: 50, returns: datedReturns(history) },
      { weight: 50, returns: datedReturns(prices(0)) },
    ]);
    expect(basket).toHaveLength(22);
    expect(basket.some((point) => point.dateKey === "2026-06-13" || point.dateKey === "2026-06-14")).toBe(false);
    expect(computeDatedBeta(basket, market)).toBeCloseTo(1, 10);
    // Source correction restores both adjacent intervals; a zero return is usable.
    const corrected = computeWeightedPortfolioReturns([
      { weight: 50, returns: datedReturns(prices(2)) },
      { weight: 50, returns: datedReturns(prices(0)) },
    ]);
    expect(corrected).toHaveLength(24);
  }
  expect(datedReturns(prices(0)).every((point) => point.value === 0)).toBe(true);
});

test("an entirely missing nonzero holding blocks the basket while zero exposure does not", () => {
  const tickers = ["AAA", "BBB"].map((ticker): TickerRecord => ({ metadata: {
    ticker, exchange: "NYSE", currency: "USD", name: ticker, portfolios: ["main"], watchlists: [], custom: {}, tags: [],
    positions: [{ portfolio: "main", shares: 10, avgCost: 100, markPrice: 100, currency: "USD", broker: "manual" }],
  } }));
  const targets = buildPortfolioChartTargets(tickers);
  const input = {
    chartTargets: targets,
    chartEntries: new Map([[buildChartKey(targets[0]!.request!), { data: prices(1) }]]),
    financials: new Map(),
    columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map<string, number>(), now: 0 },
  };
  expect(buildPortfolioReturnSeries(input)).toMatchObject({ returns: null, coverage: 0.5, missingCount: 1 });
  tickers[1]!.metadata.positions[0]!.markPrice = 0;
  expect(buildPortfolioReturnSeries(input)).toMatchObject({ coverage: 1, missingCount: 0 });
  expect(buildPortfolioReturnSeries(input).returns).toHaveLength(24);
});
