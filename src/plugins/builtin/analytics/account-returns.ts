import { colors } from "../../../theme/colors";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import { formatNumber } from "../../../utils/format";
import type { PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import { formatReturn } from "./display";
import { alignedAssetReturns, computeDatedBeta, computeSharpeRatio, type DatedReturn } from "./metrics";
import type { AnalyticsMetricRow } from "./view";

const MIN_ACCOUNT_RETURNS = 10;
const TRADING_DAYS = 252;
/** Weekends and holidays stretch a daily series to three or four calendar days at most. */
const MAX_DAILY_GAP_DAYS = 4;

/**
 * The account's own daily returns, from the broker's time-weighted history.
 * Unlike the basket of current holdings, these include financing, FX, options,
 * shorts, fees and the trades actually made, so leveraged and foreign accounts
 * are measured as they are. A money-weighted series mixes in deposit timing and
 * is not used.
 */
export function accountDailyReturns(performance: BrokerPortfolioPerformance | null): DatedReturn[] | null {
  if (!performance || performance.measure === "MWR") return null;
  const points = [...performance.points]
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date))
    .sort((left, right) => left.date.localeCompare(right.date));
  const returns: DatedReturn[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const value = Number.isFinite(point.dailyReturn)
      ? point.dailyReturn!
      : Number.isFinite(point.cumulativeReturn) && Number.isFinite(previous.cumulativeReturn) && previous.cumulativeReturn! > -1
        ? (1 + point.cumulativeReturn!) / (1 + previous.cumulativeReturn!) - 1
        : Number.NaN;
    if (Number.isFinite(value)) returns.push({ startDateKey: previous.date, dateKey: point.date, value });
  }
  // The statistics below annualize daily returns; a weekly or monthly history would be misread.
  const gaps = returns
    .map((point) => (Date.parse(point.dateKey) - Date.parse(point.startDateKey)) / 86_400_000)
    .sort((left, right) => left - right);
  const medianGap = gaps[Math.floor(gaps.length / 2)] ?? Number.POSITIVE_INFINITY;
  return returns.length >= MIN_ACCOUNT_RETURNS && medianGap <= MAX_DAILY_GAP_DAYS ? returns : null;
}

export function annualizedVolatility(returns: DatedReturn[]): number | null {
  if (returns.length < MIN_ACCOUNT_RETURNS) return null;
  const values = returns.map((point) => point.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

/** Largest peak-to-trough fall of the compounded series, as a negative fraction. */
export function maxDrawdown(returns: DatedReturn[]): number | null {
  if (returns.length < MIN_ACCOUNT_RETURNS) return null;
  let level = 1;
  let peak = 1;
  let worst = 0;
  for (const point of returns) {
    level *= 1 + point.value;
    peak = Math.max(peak, level);
    worst = Math.min(worst, level / peak - 1);
  }
  return worst;
}

function compactDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC",
  }).replaceAll(" ", "");
}

function sampleWindow(sample: DatedReturn[]): string | undefined {
  return sample.length
    ? `${compactDate(sample[0]!.startDateKey)}–${compactDate(sample.at(-1)!.dateKey)} ·${sample.length}`
    : undefined;
}

/** Risk rows measured on the account's own returns rather than estimated from holdings. */
export function buildAccountRiskRows({
  returns,
  benchmarkReturns,
  benchmarkIntegrity = null,
}: {
  returns: DatedReturn[];
  benchmarkReturns: DatedReturn[];
  benchmarkIntegrity?: PriceHistoryIntegrity | null;
}): AnalyticsMetricRow[] {
  const window = sampleWindow(returns);
  const betaSample = alignedAssetReturns(returns, benchmarkReturns);
  const sharpe = computeSharpeRatio(returns.map((point) => point.value));
  const beta = benchmarkIntegrity ? null : computeDatedBeta(returns, benchmarkReturns);
  const volatility = annualizedVolatility(returns);
  const drawdown = maxDrawdown(returns);
  const detail = window ? `Account · ${window}` : "Account";
  return [
    { id: "sharpe", label: "Sharpe", value: formatNumber(sharpe ?? undefined, 2), detail },
    {
      id: "beta",
      label: "Beta (SPY)",
      value: beta == null ? "—" : formatNumber(beta, 2),
      detail: benchmarkIntegrity
        ? "SPY benchmark: inconsistent OHLC history"
        : beta == null ? "Insufficient overlap with SPY" : `Account · ${sampleWindow(betaSample)}`,
    },
    { id: "volatility", label: "Volatility", value: volatility == null ? "—" : formatReturn(volatility).replace("+", ""), detail },
    { id: "max-drawdown", label: "Max drawdown", value: drawdown == null ? "—" : drawdown === 0 ? "0.00%" : formatReturn(drawdown), detail },
  ].map((row) => ({ ...row, color: colors.textMuted }));
}
