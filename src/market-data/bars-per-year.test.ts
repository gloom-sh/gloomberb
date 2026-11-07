import { expect, test } from "bun:test";
import { projectRealizedVolatility } from "../plugins/builtin/realized-vol/model";
import { barsPerYear, barsPerYearLabel, currencyPairInstrument } from "./bars-per-year";
import { realizedVolatilityResult } from "./realized-volatility";

const days = (from: string, count: number, skip: (weekday: number) => boolean = () => false) => {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, index) => start + index * 86_400_000).filter((time) => !skip(new Date(time).getUTCDay()));
};

test("weekend observations make a series 24/7; an exchange calendar, however shifted, stays at 252 sessions", () => {
  expect(barsPerYear(days("2025-01-01", 60))).toBe(365);
  expect(barsPerYear(days("2025-01-01", 60, (weekday) => weekday === 0 || weekday === 6))).toBe(252);
  // Sunday to Thursday, and bars stamped late on the previous evening, have a Sunday but no Saturday.
  expect(barsPerYear(days("2025-01-01", 60, (weekday) => weekday === 5 || weekday === 6))).toBe(252);
  // One stray weekend print in a long exchange history does not change the convention.
  const sessions = days("2023-01-02", 520, (weekday) => weekday === 0 || weekday === 6);
  expect(barsPerYear([...sessions, Date.parse("2024-06-01")])).toBe(252);
  expect(barsPerYear(["2025-01-03", new Date("2025-01-04"), Date.parse("2025-01-05")])).toBe(365);
  expect(barsPerYearLabel(365)).toBe("365 bars/yr");
});

test("a currency pair is 260 bars a year by what it is, however short the range loaded; a currency future and a stock stay at 252", () => {
  // Five weeks of USDJPY=X's weekdays: too short to tell a pair from an exchange by its dates.
  const month = days("2026-10-01", 35, (weekday) => weekday === 0 || weekday === 6);
  expect(barsPerYear(month, currencyPairInstrument("USDJPY=X"))).toBe(260);
  expect(barsPerYear(month, currencyPairInstrument("EUR.USD", "CCY"))).toBe(260);
  expect(barsPerYear(month, currencyPairInstrument("6J=F"))).toBe(252);
  expect(barsPerYear(month, currencyPairInstrument("SPY"))).toBe(252);
  expect(barsPerYear(month)).toBe(252);
  // HVT's own estimate on that month is annualised at the pair's year: √(260/252) over an exchange's.
  const closes = month.map((time, index) => ({ date: new Date(time), close: 150 * (1 + 0.004 * Math.sin(index * 1.7)) }));
  const pair = realizedVolatilityResult(closes, 20, "close-to-close", currencyPairInstrument("USDJPY=X")).value!;
  const exchange = realizedVolatilityResult(closes, 20, "close-to-close").value!;
  expect(pair / exchange).toBeCloseTo(Math.sqrt(260 / 252), 12);
  expect(projectRealizedVolatility(closes, { symbol: "USDJPY=X", windows: [20] }).barsPerYear).toBe(260);
  expect(projectRealizedVolatility(closes, { symbol: "6J=F", windows: [20] }).barsPerYear).toBe(252);
});
