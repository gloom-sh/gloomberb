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

test("activity totals require each reported contract's input without discarding independent metrics", () => {
  const chain: OptionsChain = {
    underlyingSymbol: "AAPL", expirationDates: [],
    calls: [contract(100, .25, 10, 20)], puts: [contract(100, .25, 0, 0)],
  };
  for (const invalid of [undefined, Number.NaN, Infinity, -1]) {
    const partial = { ...chain, calls: [{ ...chain.calls[0]!, openInterest: invalid }] };
    const summary = calculateOptionsSummary(partial, 100, []);
    expect(summary.expirationVolume).toBe(10);
    expect(summary.putCallVolumeRatio).toBe(0);
    expect(summary.putCallOpenInterestRatio).toBeNull();
    expect(summary.atmImpliedVolatility).toBe(.25);
  }
  const missingVolume = calculateOptionsSummary({ ...chain, puts: [{ ...chain.puts[0]!, volume: undefined }] }, 100, []);
  expect(missingVolume.expirationVolume).toBeNull();
  expect(missingVolume.putCallVolumeRatio).toBeNull();
  expect(missingVolume.putCallOpenInterestRatio).toBe(0);
  const zero = calculateOptionsSummary({ ...chain, calls: [{ ...chain.calls[0]!, volume: 0, openInterest: 0 }] }, 100, []);
  expect(zero.expirationVolume).toBe(0);
  expect(zero.putCallVolumeRatio).toBeNull();
  expect(zero.putCallOpenInterestRatio).toBeNull();
});


test("rejects bad observations inside the selected HV window instead of bridging them", () => {
  const good = priceHistory();
  const extended = [{ date: new Date(Date.UTC(2025, 11, 31)), close: 100 }, ...good];
  for (const bad of [{ high: 90, low: 110 }, { high: 99 }, { close: 0 }, { close: Number.NaN }]) {
    const points = extended.map((point, i) => i === 15 ? { ...point, ...bad } : point);
    expect(historicalVolatility30d(points)).toBeNull();
    const summary = calculateOptionsSummary({ underlyingSymbol: "AAPL", expirationDates: [], calls: [contract(100, .2, 100, 200)], puts: [] }, 100, points);
    expect(summary.historicalVolatilityUnavailableReason).toBeTruthy();
    expect(summary.impliedHistoricalRatio).toBeNull();
    expect(summary.atmImpliedVolatility).toBe(.2);
  }
  // An excluded earlier bad bar cannot contaminate a complete later window.
  expect(historicalVolatility30d([{ ...extended[0]!, high: 90, low: 110 }, ...good])).toBeCloseTo(historicalVolatility30d(good)!, 12);
});

test("deduplicates corrections before selecting 31 observations and retains immutable rejected source data", () => {
  const good = priceHistory();
  expect(historicalVolatility30d(good.slice(1).flatMap((point) => [point, point]))).toBeNull();
  const broken = { ...good[15]!, high: 90, low: 110 };
  const corrected = [...good.slice(0, 15), broken, ...good.slice(16), good[15]!];
  expect(historicalVolatility30d(corrected)).toBeCloseTo(historicalVolatility30d(good)!, 12);
  const chain = { underlyingSymbol: "AAPL", expirationDates: [], calls: [], puts: [] };
  const summary = calculateOptionsSummary(chain, 100, [...good, broken]);
  expect(summary.historicalVolatility30d).toBeNull();
  const diagnostic = summary.historicalVolatilityIntegrity!;
  expect(diagnostic.sourcePoints).toHaveLength(1);
  expect(diagnostic.sourcePoints[0]!.date).toBe(good[15]!.date.toISOString());
  broken.high = 120;
  expect(diagnostic.sourcePoints[0]!.high).toBe(90);
  expect(Object.isFrozen(diagnostic.sourcePoints)).toBe(true);
  expect(Object.isFrozen(diagnostic.sourcePoints[0])).toBe(true);
});

test("validates chronology without requiring full OHLC and handles finite extreme prices", () => {
  const good = priceHistory();
  expect(historicalVolatility30d([...good].reverse())).toBeCloseTo(historicalVolatility30d(good)!, 12);
  expect(historicalVolatility30d([...good, { date: new Date(Number.NaN), close: 100 }])).toBeNull();
  expect(historicalVolatility30d(good.map((point, i) => ({ ...point, close: i % 2 ? 1e300 : 1e-300 })))).toBeFinite();
  expect(historicalVolatility30d(good.map((point) => ({ ...point, close: 100 })))).toBe(0);
});

test("retains rejected-source diagnostics before enough history exists for HV30", () => {
  const chain = { underlyingSymbol: "AAPL", expirationDates: [], calls: [], puts: [] };
  const bad = { date: new Date("2026-09-22"), close: 100, high: 90, low: 110 };
  const summary = calculateOptionsSummary(chain, 100, [bad]);
  expect(summary.historicalVolatility30d).toBeNull();
  expect(summary.historicalVolatilityIntegrity!.sourcePoints).toHaveLength(1);
  expect(summary.historicalVolatilityUnavailableReason).toContain("inconsistent OHLC");
  bad.high = 120;
  expect(summary.historicalVolatilityIntegrity!.sourcePoints[0]!.high).toBe(90);
  const missing = calculateOptionsSummary(chain, 100, [{ date: bad.date, close: 0 }]);
  expect(missing.historicalVolatilityUnavailableReason).toContain("nonpositive close");
});
