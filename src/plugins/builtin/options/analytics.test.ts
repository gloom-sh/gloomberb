import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain, PricePoint } from "../../../types/financials";
import {
  calculateOptionGreeks,
  calculateOptionsSummary,
  historicalVolatility30d,
} from "./analytics";

function contract(
  strike: number,
  impliedVolatility: number,
  volume: number,
  openInterest: number,
): OptionContract {
  return {
    contractSymbol: String(strike),
    strike,
    currency: "USD",
    lastPrice: 1,
    change: 0,
    percentChange: 0,
    volume,
    openInterest,
    bid: 0.95,
    ask: 1.05,
    impliedVolatility,
    inTheMoney: false,
    expiration: Date.UTC(2027, 0, 15) / 1000,
    lastTradeDate: 0,
  };
}

function priceHistory(): PricePoint[] {
  const points: PricePoint[] = [{ date: new Date(Date.UTC(2026, 0, 1)), close: 100 }];
  for (let index = 0; index < 30; index += 1) {
    points.push({
      date: new Date(Date.UTC(2026, 0, index + 2)),
      close: points.at(-1)!.close * Math.exp(index % 2 === 0 ? 0.01 : -0.01),
    });
  }
  return points;
}

test("annualizes the latest 30 daily log returns, including persisted dates", () => {
  const expected = Math.sqrt((30 * 0.01 ** 2 / 29) * 252);
  expect(historicalVolatility30d(priceHistory())).toBeCloseTo(expected, 10);
  expect(historicalVolatility30d(priceHistory().map((point) => ({
    ...point,
    date: point.date.toISOString() as unknown as Date,
  })))).toBeCloseTo(expected, 10);
  expect(historicalVolatility30d(priceHistory().slice(1))).toBeNull();
});

test("summarizes the selected expiration without presenting it as whole-chain volume", () => {
  const chain: OptionsChain = {
    underlyingSymbol: "AAPL",
    expirationDates: [Date.UTC(2027, 0, 15) / 1000],
    calls: [contract(100, 0.2, 100, 200), contract(105, 0.3, 200, 400)],
    puts: [contract(100, 0.22, 150, 180), contract(105, 0.4, 300, 420)],
  };
  const summary = calculateOptionsSummary(chain, 101, priceHistory());

  expect(summary.atmImpliedVolatility).toBeCloseTo(0.21, 10);
  expect(summary.expirationVolume).toBe(750);
  expect(summary.putCallVolumeRatio).toBe(1.5);
  expect(summary.putCallOpenInterestRatio).toBe(1);
  expect(summary.impliedHistoricalRatio).toBeCloseTo(
    summary.atmImpliedVolatility! / summary.historicalVolatility30d!,
    10,
  );
});

test("derives call and put Greeks from the chain IV", () => {
  const option = contract(100, 0.25, 0, 0);
  const now = Date.UTC(2026, 11, 15);
  const call = calculateOptionGreeks(option, "call", 100, 0, now);
  const put = calculateOptionGreeks(option, "put", 100, 0, now);

  expect(call?.delta).toBeGreaterThan(0);
  expect(put?.delta).toBeLessThan(0);
  expect(call?.gamma).toBeCloseTo(put!.gamma, 10);
  expect(call?.vegaPerPoint).toBeCloseTo(put!.vegaPerPoint, 10);
});
