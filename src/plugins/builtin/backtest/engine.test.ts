import { expect, test } from "bun:test";
import { runBacktest } from "./engine";
import { evaluateOperand, evaluateRule, parseRule, ruleWarmup, type BacktestBar, type Operand, type Rule } from "./rules";
import { BACKTEST_PRESETS } from "./presets";
import { toBacktestBars } from "./client";
import { backtestWindow, continuationNote, listDates, runHistoryBacktest } from "./window";

const day = (index: number) => new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
/** Weekdays only, from Wednesday 1 January 2020: exchange sessions. */
const sessionDay = (index: number) => new Date(Date.UTC(2020, 0, 1 + index + 2 * Math.floor((index + 2) / 5))).toISOString().slice(0, 10);
/** Consecutive calendar dates, a 24/7 series, unless `date` says otherwise. */
const bars = (closes: number[], open = (close: number) => close, date = day): BacktestBar[] =>
  closes.map((close, index) => ({ date: date(index), open: open(close), high: close, low: close, close }));

const operandText = (operand: Operand): string =>
  operand.kind === "number" ? String(operand.value)
    : operand.kind === "field" ? operand.field
      : `${operand.name}(${operand.args.join(",")})`;
const ruleText = (rule: Rule) =>
  rule.map((condition) => `${operandText(condition.left)} ${condition.comparator} ${operandText(condition.right)}`).join(" and ");

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
});

test("a signal on the final session does not trade", () => {
  const closes = [...Array.from({ length: 30 }, () => 10), 12];
  const result = runBacktest(bars(closes), parseRule("close > 10"), parseRule("close < 10"), { lookbackYears: null, costBps: 0 });
  expect(result.trades).toHaveLength(0);
  expect(result.strategy.totalReturnPct).toBe(0);
  expect(result.strategy.exposurePct).toBe(0);
});

test("rolling windows are one year of bars: 365 for a 24/7 series, 252 for exchange sessions", () => {
  // Steady rise: always-in matches buy-and-hold minus nothing; never-in loses every window.
  const closes = Array.from({ length: 400 }, (_, index) => 100 + index);
  const options = { lookbackYears: null, costBps: 0 };
  const never = runBacktest(bars(closes), parseRule("close < 0"), parseRule("close < 0"), options);
  expect(never.barsPerYear).toBe(365);
  expect(never.rollingWin.windows).toBe(400 - 365);
  expect(never.rollingWin.sharePct).toBe(0);
  expect(never.benchmark.totalReturnPct).toBeGreaterThan(0);
  expect(never.strategy.maxDrawdownPct).toBe(0);
  const sessions = runBacktest(bars(closes, undefined, sessionDay), parseRule("close < 0"), parseRule("close < 0"), options);
  expect(sessions.barsPerYear).toBe(252);
  expect(sessions.rollingWin.windows).toBe(400 - 252);
});

test("volatility and Sharpe annualize at the series' bars per year", () => {
  const closes = Array.from({ length: 120 }, (_, index) => 100 * Math.exp(0.01 * Math.sin(index / 3) + index * 0.001));
  const options = { lookbackYears: null, costBps: 0 };
  const rule = parseRule("close > 0");
  const crypto = runBacktest(bars(closes), rule, rule, options).benchmark;
  const exchange = runBacktest(bars(closes, undefined, sessionDay), rule, rule, options).benchmark;
  // Same returns, so only the annualization differs.
  expect(crypto.volatilityPct! / exchange.volatilityPct!).toBeCloseTo(Math.sqrt(365 / 252), 10);
  expect(crypto.sharpe! / exchange.sharpe!).toBeCloseTo(Math.sqrt(365 / 252), 10);
});

test("a forming session is left out unless asked for, and an end date repeats a run exactly", () => {
  const closes = Array.from({ length: 300 }, (_, index) => 100 + index * 0.3 + Math.sin(index / 9) * 6);
  const complete = bars(closes);
  const forming = { date: day(300), open: 190, high: 190, low: 150, close: 150, partial: true as const };
  const history = { bars: [...complete, forming], skippedDates: [], undatedSkipped: 0 };
  const left = backtestWindow(history);
  expect(left.bars.at(-1)!.date).toBe(day(299));
  expect(left.warnings).toEqual([`${day(300)} is still forming (partial) and left out: the test runs through ${day(299)}, the last complete session.`]);
  const kept = backtestWindow(history, { includePartial: true });
  expect(kept.bars.at(-1)).toBe(forming);
  expect(kept.warnings[0]).toContain(`${day(300)} is still forming (partial) and kept`);

  // The same end over a history that has since grown (and a later forming bar) gives the same run.
  const options = { lookbackYears: null, costBps: 5, end: day(280) };
  const rules = [parseRule("close > sma(50)"), parseRule("close < sma(50)")] as const;
  const before = runHistoryBacktest({ bars: complete.slice(0, 281), skippedDates: [], undatedSkipped: 0 }, ...rules, options);
  const after = runHistoryBacktest(history, ...rules, options);
  expect(after).toEqual(before);
  expect(after.end).toBe(day(280));
  expect(after.warnings).toEqual([]);
  expect(after.repeatable).toBe(true);
  // An end still to come runs to the newest complete session, and says the run changes until it has passed.
  const ahead = backtestWindow(history, { end: day(320) });
  expect(ahead.repeatable).toBe(false);
  expect(ahead.warnings.at(-1)).toBe(`The end date ${day(320)} is after the newest complete session, so the run ends at ${day(299)}`
    + ` and is not repeatable until ${day(320)} has passed.`);
  expect(() => backtestWindow(history, { end: "2019-01-01" })).toThrow("No daily sessions on or before 2019-01-01");
});

test("a run over a listing that no longer trades ends on its last session and says so", () => {
  // SVB Financial: sessions from 2021 to its last, 2023-03-09; Nasdaq removed it 2023-05-02.
  const sessions: BacktestBar[] = [];
  for (let time = Date.UTC(2021, 0, 4); time <= Date.UTC(2023, 2, 9); time += 86_400_000) {
    const date = new Date(time);
    if (date.getUTCDay() % 6 !== 0) sessions.push({ date: date.toISOString().slice(0, 10), open: 300, high: 300, low: 300, close: 300 + sessions.length % 40 });
  }
  const history = { symbol: "SIVB", bars: sessions, skippedDates: [], undatedSkipped: 0,
    delisting: { status: "delisted" as const, lastTradeDate: "2023-03-09", historyStart: "2021-01-04" } };
  const rules = [parseRule("close > sma(20)"), parseRule("close < sma(20)")] as const;
  const ended = "SIVB: Delisted Mar 9, 2023. The run ends on its last session, 2023-03-09, and a position still held"
    + " is valued at that close, not at anything holders received after it.";
  // Through the newest session, or to an end after it: no later session will come, so the run is repeatable now.
  for (const end of [null, "2023-12-31"]) {
    const run = runHistoryBacktest(history, ...rules, { lookbackYears: null, costBps: 5, end });
    expect([run.end, run.repeatable, run.warnings]).toEqual(["2023-03-09", true, [ended]]);
  }
  // 2021 to 2022 ends before the last session: an ordinary run, still naming the listing as delisted.
  const year = runHistoryBacktest(history, ...rules, { lookbackYears: null, costBps: 5, end: "2022-12-31" });
  expect([year.end, year.repeatable, year.warnings]).toEqual(["2022-12-30", true, ["SIVB: Delisted Mar 9, 2023."]]);
});

test("sessions served without a positive close are warned by date, a long list shortened", () => {
  const point = (index: number, close: number) => ({ date: new Date(`${day(index)}T00:00:00Z`), open: close, high: close, low: close, close });
  const served = toBacktestBars([
    point(0, 10), point(1, -37.63), point(2, 0), point(3, 12),
    { date: new Date(Number.NaN), close: 11 },
    // A day served twice keeps its usable bar and is not warned.
    point(3, -1),
  ]);
  expect(served.bars.map((bar) => bar.date)).toEqual([day(0), day(3)]);
  expect(served.skippedDates).toEqual([day(1), day(2)]);
  expect(backtestWindow(served).warnings).toEqual([
    `2 sessions without a positive close were left out: ${day(1)} and ${day(2)}.`,
    "1 price point without a date was left out.",
  ]);
  // A date past the end asked for is not this run's.
  expect(backtestWindow(served, { end: day(1) }).warnings[0]).toBe(`1 session without a positive close was left out: ${day(1)}.`);
  // Sessions the source left out for the same reason join them, only between
  // the first and last bar and where no bar is: CL=F's 2020-04-20.
  const sourced = toBacktestBars([point(0, 10), point(3, 12), point(5, 13)], [day(4), day(1), day(3), day(5), day(9), day(0)]);
  expect(sourced.skippedDates).toEqual([day(1), day(4)]);
  const many = Array.from({ length: 9 }, (_, index) => day(index));
  expect(listDates(many)).toBe(`${day(0)}, ${day(1)}, ${day(2)}, 4 more, ${day(7)} and ${day(8)}`);
});

test("a futures continuation is labelled as one, a dated contract or a stock is not", () => {
  expect(continuationNote("CL=F")).toStartWith("CL=F is a rolled front-month continuation, not one contract");
  expect(continuationNote("CL2F5R")).toStartWith("CL2F5R is a rolled continuation (2nd generic · 5 days before last trade · ratio adjusted)");
  expect(continuationNote("CLZ26.NYM")).toBeNull();
  expect(continuationNote("AAPL")).toBeNull();
});
