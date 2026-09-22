import { evaluateRule, ruleWarmup, type BacktestBar, type Rule } from "./rules";

const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

export interface BacktestOptions {
  /** Calendar years of evaluation after warmup; null uses every usable session. */
  lookbackYears: number | null;
  /** Cost per side in basis points, applied to each fill price. */
  costBps: number;
}
export interface BacktestTrade {
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  /** Net of costs; an open trade is marked at the last close before its exit cost. */
  returnPct: number;
  sessions: number;
  open: boolean;
}
export interface PerformanceStats {
  totalReturnPct: number;
  cagrPct: number | null;
  volatilityPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number;
}
export interface BacktestResult {
  start: string;
  end: string;
  sessions: number;
  equity: Array<{ date: string; strategy: number; benchmark: number; drawdownPct: number }>;
  trades: BacktestTrade[];
  strategy: PerformanceStats & {
    exposurePct: number;
    closedTrades: number;
    hitRatePct: number | null;
    avgWinPct: number | null;
    avgLossPct: number | null;
    profitFactor: number | null;
    avgSessions: number | null;
  };
  benchmark: PerformanceStats;
  /** Share of rolling 252-session windows in which the rule beat buy-and-hold. */
  rollingWin: { sharePct: number | null; windows: number };
  warnings: string[];
}

function stats(curve: readonly number[], start: string, end: string): PerformanceStats {
  const returns = curve.slice(1).map((value, index) => value / curve[index]! - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
    : Number.NaN;
  const deviation = Math.sqrt(variance);
  const years = (Date.parse(end) - Date.parse(start)) / (365.25 * DAY_MS);
  let peak = curve[0] ?? 1, drawdown = 0;
  for (const value of curve) {
    peak = Math.max(peak, value);
    drawdown = Math.min(drawdown, value / peak - 1);
  }
  const total = (curve.at(-1) ?? 1) / (curve[0] ?? 1) - 1;
  return {
    totalReturnPct: total * 100,
    cagrPct: years >= 0.5 && total > -1 ? ((1 + total) ** (1 / years) - 1) * 100 : null,
    volatilityPct: Number.isFinite(deviation) ? deviation * Math.sqrt(TRADING_DAYS) * 100 : null,
    sharpe: Number.isFinite(deviation) && deviation > 0 ? (mean / deviation) * Math.sqrt(TRADING_DAYS) : null,
    maxDrawdownPct: drawdown * 100,
  };
}

/**
 * Long-only, fully invested or flat. A rule true at a session's close fills at
 * the next session's open (or its close when no open is recorded), so no
 * signal trades on the bar that produced it. Cash earns nothing. Buy-and-hold
 * buys at the same first fill and pays the same entry cost.
 */
export function runBacktest(
  bars: readonly BacktestBar[],
  entry: Rule,
  exit: Rule,
  options: BacktestOptions,
): BacktestResult {
  const warmup = Math.max(ruleWarmup(entry), ruleWarmup(exit));
  const clean = bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
  if (clean.length < warmup + 22) {
    throw new Error(`Need at least ${warmup + 22} daily sessions for these rules; ${clean.length} are available.`);
  }
  const last = Date.parse(clean.at(-1)!.date);
  const cutoff = options.lookbackYears == null ? -Infinity : last - options.lookbackYears * 365.25 * DAY_MS;
  // Evaluation starts after warmup so the first signal uses defined indicators.
  const start = Math.max(warmup, clean.findIndex((bar) => Date.parse(bar.date) >= cutoff));
  if (clean.length - start < 22) throw new Error("The chosen lookback leaves fewer than 22 sessions after indicator warmup.");
  const enter = evaluateRule(entry, clean);
  const leave = evaluateRule(exit, clean);
  const cost = options.costBps / 10_000;
  const fill = (index: number) => {
    const bar = clean[index]!;
    return bar.open != null && Number.isFinite(bar.open) && bar.open > 0 ? bar.open : bar.close;
  };

  let cash = 1, shares = 0, entryIndex = -1, entryPrice = 0, inMarket = 0;
  const trades: BacktestTrade[] = [];
  const strategy: number[] = [], benchmark: number[] = [], dates: string[] = [];
  const benchmarkShares = 1 / (fill(Math.min(start + 1, clean.length - 1)) * (1 + cost));
  for (let index = start; index < clean.length; index += 1) {
    const bar = clean[index]!;
    // Fills for signals from the previous close happen at this session's open.
    if (index > start) {
      if (shares === 0 && enter[index - 1]) {
        entryPrice = fill(index) * (1 + cost);
        shares = cash / entryPrice;
        cash = 0;
        entryIndex = index;
      } else if (shares > 0 && leave[index - 1]) {
        const exitPrice = fill(index) * (1 - cost);
        cash = shares * exitPrice;
        trades.push({
          entryDate: clean[entryIndex]!.date, entryPrice, exitDate: bar.date, exitPrice,
          returnPct: (exitPrice / entryPrice - 1) * 100, sessions: index - entryIndex, open: false,
        });
        shares = 0;
      }
    }
    if (shares > 0) inMarket += 1;
    strategy.push(cash + shares * bar.close);
    benchmark.push(index === start ? 1 : benchmarkShares * bar.close);
    dates.push(bar.date);
  }
  if (shares > 0) {
    const mark = clean.at(-1)!.close * (1 - cost);
    trades.push({
      entryDate: clean[entryIndex]!.date, entryPrice, exitDate: null, exitPrice: null,
      returnPct: (mark / entryPrice - 1) * 100, sessions: clean.length - 1 - entryIndex, open: true,
    });
  }

  const startDate = dates[0]!, endDate = dates.at(-1)!;
  const closed = trades.filter((trade) => !trade.open);
  const wins = closed.filter((trade) => trade.returnPct > 0);
  const losses = closed.filter((trade) => trade.returnPct <= 0);
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const grossWin = wins.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.returnPct, 0);
  let peak = strategy[0]!;
  const equity = dates.map((date, index) => {
    peak = Math.max(peak, strategy[index]!);
    return { date, strategy: strategy[index]!, benchmark: benchmark[index]!, drawdownPct: (strategy[index]! / peak - 1) * 100 };
  });
  let beat = 0, windows = 0;
  for (let index = TRADING_DAYS; index < strategy.length; index += 1) {
    windows += 1;
    if (strategy[index]! / strategy[index - TRADING_DAYS]! > benchmark[index]! / benchmark[index - TRADING_DAYS]!) beat += 1;
  }
  const warnings = [
    ...(closed.length < 10 ? [`${closed.length} closed trade${closed.length === 1 ? "" : "s"}: too few to judge a hit rate.`] : []),
    ...(clean.length < bars.length ? [`${bars.length - clean.length} sessions without a positive close were skipped.`] : []),
  ];
  return {
    start: startDate, end: endDate, sessions: dates.length, equity, trades,
    strategy: {
      ...stats(strategy, startDate, endDate),
      exposurePct: (inMarket / dates.length) * 100,
      closedTrades: closed.length,
      hitRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
      avgWinPct: mean(wins.map((trade) => trade.returnPct)),
      avgLossPct: mean(losses.map((trade) => trade.returnPct)),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgSessions: mean(closed.map((trade) => trade.sessions)),
    },
    benchmark: stats(benchmark, startDate, endDate),
    rollingWin: { sharePct: windows >= 20 ? (beat / windows) * 100 : null, windows },
    warnings,
  };
}
