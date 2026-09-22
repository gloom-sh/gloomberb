import { expect, test } from "bun:test";
import { runBacktest } from "./engine";
import { evaluateOperand, evaluateRule, parseRule, ruleText, ruleWarmup, type BacktestBar } from "./rules";
import { BACKTEST_PRESETS } from "./presets";

const day = (index: number) => new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
const bars = (closes: number[], open = (close: number) => close): BacktestBar[] =>
  closes.map((close, index) => ({ date: day(index), open: open(close), high: close, low: close, close }));

test("rules parse with defaults, bounds and AND, and every preset parses", () => {
  expect(ruleText(parseRule("SMA(50) crosses above sma(200) and rsi < 70"))).toBe("sma(50) crosses above sma(200) and rsi(14) < 70");
  expect(ruleText(parseRule("close above bb_upper()"))).toBe("close > bb_upper(20,2)");
  expect(() => parseRule("price > 3")).toThrow("Unknown operand");
  expect(() => parseRule("sma(0) > close")).toThrow("from 1 to 500");
  expect(() => parseRule("macd(26,12) > 0")).toThrow("fast must be shorter");
  expect(() => parseRule("3 > 2")).toThrow("at least one price");
  expect(ruleWarmup(parseRule("macd_signal(12,26,9) > 0"))).toBe(35);
  for (const preset of BACKTEST_PRESETS) {
    expect(() => parseRule(preset.entry)).not.toThrow();
    expect(() => parseRule(preset.exit)).not.toThrow();
  }
});

test("a cross needs the previous session on the other side; undefined values never match", () => {
  const series = bars([1, 2, 3, 2, 1, 2, 3]);
  expect(evaluateRule(parseRule("close crosses above 2"), series)).toEqual([false, false, true, false, false, false, true]);
  expect(evaluateRule(parseRule("close > sma(3)"), series).slice(0, 2)).toEqual([false, false]);
});

test("a breakout compares with prior sessions, not the bar itself", () => {
  const series = bars([10, 11, 12, 13]);
  expect(Array.from(evaluateOperand(parseRule("close > highest(2)")[0]!.right, series))).toEqual([NaN, NaN, 11, 12]);
  expect(evaluateRule(parseRule("close > highest(2)"), series)).toEqual([false, false, true, true]);
});

test("signals fill at the next open with costs, and a final open trade is marked, not sold", () => {
  // Opens sit 1 below closes so a same-bar fill would be visible in the prices.
  const closes = [...Array.from({ length: 25 }, () => 10), 12, 14, 9, 9, 13, 15];
  const series = bars(closes, (close) => close - 1);
  const result = runBacktest(series, parseRule("close > 10"), parseRule("close < 10"), { lookbackYears: null, costBps: 100 });
  const [first, second] = result.trades;
  // close 12 on session 25 -> buy at session 26 open (13) plus 1%.
  expect(first).toMatchObject({ entryDate: day(26), exitDate: day(28), open: false });
  expect(first!.entryPrice).toBeCloseTo(13 * 1.01, 10);
  // close 9 on session 27 -> sell at session 28 open (8) less 1%.
  expect(first!.exitPrice).toBeCloseTo(8 * 0.99, 10);
  expect(first!.returnPct).toBeCloseTo(((8 * 0.99) / (13 * 1.01) - 1) * 100, 10);
  expect(second).toMatchObject({ entryDate: day(30), exitDate: null, open: true });
  expect(result.strategy.closedTrades).toBe(1);
  expect(result.strategy.hitRatePct).toBe(0);
  // Buy-and-hold buys at the first fill after the start with the same cost.
  expect(result.equity.at(-1)!.benchmark).toBeCloseTo(15 / (9 * 1.01), 10);
  expect(result.warnings[0]).toContain("too few");
});

test("a signal on the final session does not trade", () => {
  const closes = [...Array.from({ length: 30 }, () => 10), 12];
  const result = runBacktest(bars(closes), parseRule("close > 10"), parseRule("close < 10"), { lookbackYears: null, costBps: 0 });
  expect(result.trades).toHaveLength(0);
  expect(result.strategy.totalReturnPct).toBe(0);
  expect(result.strategy.exposurePct).toBe(0);
});

test("rolling windows count sessions where the rule beat buy-and-hold", () => {
  // Steady rise: always-in matches buy-and-hold minus nothing; never-in loses every window.
  const closes = Array.from({ length: 400 }, (_, index) => 100 + index);
  const never = runBacktest(bars(closes), parseRule("close < 0"), parseRule("close < 0"), { lookbackYears: null, costBps: 0 });
  expect(never.rollingWin.windows).toBe(400 - 252);
  expect(never.rollingWin.sharePct).toBe(0);
  expect(never.benchmark.totalReturnPct).toBeGreaterThan(0);
  expect(never.strategy.maxDrawdownPct).toBe(0);
});
