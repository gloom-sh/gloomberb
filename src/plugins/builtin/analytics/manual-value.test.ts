import { expect, test } from "bun:test";
import { createTestTicker } from "../../../test-support/ticker";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { fetchPortfolioRiskMarket } from "./risk-client";
import { buildPortfolioRisk, portfolioRiskRequests } from "./risk-model";
import { brokerRiskClient, now, sessionHistory } from "./risk-test-data";

const portfolio: Portfolio = { id: "manual", name: "Manual", currency: "USD", cash: { amount: 125, currency: "USD" } };
const holding = (symbol: string, shares: number, extra = {}) => createTestTicker(symbol, symbol, {
  exchange: "NASDAQ", currency: "USD", portfolios: [portfolio.id],
  positions: [{ portfolio: portfolio.id, shares, avgCost: 100, broker: "manual", dateAcquired: "2026-09-15", ...extra }],
});

async function estimate(tickers: TickerRecord[], options: { missing?: string; portfolio?: Portfolio } = {}) {
  const selected = options.portfolio ?? portfolio;
  const client = {
    ...brokerRiskClient(now, []),
    getCloudHistory: async (symbol: string, exchange: string) => {
      const response = sessionHistory(symbol, exchange);
      return { ...response, data: response.data!.filter((point) => symbol !== "SPLIT" || point.date.slice(0, 10) !== options.missing)
        .map((point) => {
          const splitDate = "2026-09-16";
          const rawClose = point.date.slice(0, 10) < splitDate ? 100 : 50;
          const close = point.date.slice(0, 10) < splitDate ? rawClose / 2 : rawClose;
          return { ...point, open: close, high: close, low: close, close };
        }) };
    },
  };
  const market = await fetchPortfolioRiskMarket(portfolioRiskRequests(tickers, portfolio.id, true), client as never, now);
  return { market, model: buildPortfolioRisk(selected, tickers, market) };
}

test("current shares use split-adjusted closes from acquisition, not cost or an invented flow; shorts and multipliers are signed", async () => {
  const tickers = [holding("SPLIT", 20), holding("SHORT", 2, { side: "short", multiplier: 10, dateAcquired: "2026-09-18" })];
  const { model } = await estimate(tickers);
  expect(model.performance).toBeNull();
  expect(model.performanceEstimate?.points).toEqual([
    { date: "2026-09-15", value: 1125 },
    { date: "2026-09-16", value: 1125 },
    { date: "2026-09-17", value: 1125 },
    { date: "2026-09-18", value: 125 },
    { date: "2026-09-21", value: 125 },
  ]);
  expect(model.rows.performance.map((row) => row.label)).toEqual(["Estimated value"]);
  expect(model.performanceEstimate?.complete).toBe(true);
});

test("a missing close is a gap, never zero, cost, a carried price or a partial total", async () => {
  const { model } = await estimate([holding("SPLIT", 20)], { missing: "2026-09-17" });
  expect(model.performanceEstimate?.points.find((point) => point.date === "2026-09-17")?.value).toBeNull();
  expect(model.performanceEstimate?.points.at(-1)?.value).toBe(1125);
  expect(model.performanceEstimate?.complete).toBe(false);
  expect(model.performanceEstimate?.warnings).toContain("Estimated value has gaps where daily closes or FX are missing.");
});

test("an undated position assumes ownership from the available history's start", async () => {
  const { model, market } = await estimate([holding("SPLIT", 20, { dateAcquired: undefined })]);
  expect(model.performanceEstimate?.points[0]).toEqual({ date: market.histories[0]!.closes![0]!.date, value: 1125 });
});

test("foreign closes use daily listing and account FX while cash stays flat in portfolio currency", async () => {
  const selected: Portfolio = { ...portfolio, currency: "EUR", cash: { amount: 125, currency: "USD" } };
  const ticker = holding("GBP1", 10);
  ticker.metadata.exchange = "LSE";
  ticker.metadata.currency = "GBp";
  const client = brokerRiskClient(now, [{ symbol: "GBP1", exchange: "LSE", currency: "GBp", quantity: 10, price: 2000 }], { fx: true });
  const market = await fetchPortfolioRiskMarket(portfolioRiskRequests([ticker], portfolio.id, true), client as never, now, undefined, "EUR", ["USD"]);
  const model = buildPortfolioRisk(selected, [ticker], market);
  const local = await client.getCloudHistory("GBP1", "LSE");
  const pound = await client.getCloudHistory("GBPUSD=X", "");
  for (const date of ["2026-09-15", "2026-09-21"]) {
    const close = local.data!.find((point) => point.date.slice(0, 10) === date)!.close;
    const rate = pound.data!.find((point) => point.date.slice(0, 10) === date)!.close;
    expect(model.performanceEstimate?.points.find((point) => point.date === date)?.value)
      .toBeCloseTo(10 * close / 100 * rate / market.accountFx!.closes[date]! + 125 / market.fxRates!.EUR!, 8);
  }
});

test("dated lots extend the daily request back to acquisition without extending the basket's return sample", async () => {
  const ticker = holding("SPLIT", 20, { dateAcquired: "2020-09-15" });
  const requested: string[] = [];
  const client = {
    ...brokerRiskClient(now, []),
    getCloudHistory: async (symbol: string, exchange: string, params: { startDate?: string }) => {
      requested.push(params.startDate!);
      const history = sessionHistory(symbol, exchange);
      return { ...history, data: [{ date: "2020-09-15T00:00:00.000Z", open: 50, high: 50, low: 50, close: 50 }, ...history.data!] };
    },
  };
  const market = await fetchPortfolioRiskMarket(portfolioRiskRequests([ticker], portfolio.id, true), client as never, now);
  expect(new Set(requested)).toEqual(new Set(["2020-09-15"]));
  const model = buildPortfolioRisk(portfolio, [ticker], market);
  expect(model.performanceEstimate?.points[0]).toEqual({ date: "2020-09-15", value: 1125 });
  expect(market.histories.every((history) => history.returns.every((point) => point.startDateKey >= "2025-03-01"))).toBe(true);
});

test("broker-linked accounts never substitute an estimate and imported real history always wins", async () => {
  const tickers = [holding("SPLIT", 20)];
  const { market } = await estimate(tickers);
  const linked = buildPortfolioRisk({ ...portfolio, brokerId: "broker", brokerAccountId: "account" }, tickers, market);
  expect(linked.performanceEstimate).toBeNull();
  expect(linked.rows.performance).toEqual([]);
  const evidence = { version: 1 as const, portfolioId: portfolio.id, currency: "USD", source: "Account statement", performance: {
    flowTiming: "end-of-day" as const, externalFlowsComplete: true as const,
    observations: [{ date: "2026-09-15", value: 1000, externalFlow: 0 }, { date: "2026-09-21", value: 2200, externalFlow: 1000 }],
  } };
  const real = buildPortfolioRisk(portfolio, tickers, market, evidence);
  expect(real.performanceEstimate).toBeNull();
  expect(real.performance?.twr).toBeCloseTo(0.2, 12);
  expect(real.rows.performance.map((row) => row.id)).toEqual(["twr", "mwr", "drawdown"]);
  const broker = buildPortfolioRisk({ ...portfolio, brokerId: "broker", brokerAccountId: "account" }, tickers, market, evidence);
  expect(broker.performance).toEqual(real.performance);
  expect(broker.rows.performance).toEqual(real.rows.performance);
  expect(broker.performanceEstimate).toBeNull();
});
