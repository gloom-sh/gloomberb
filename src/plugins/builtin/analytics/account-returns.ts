import type { BrokerPortfolioPerformance } from "../../../types/trading";
import type { DatedReturn } from "./metrics";

const MIN_ACCOUNT_RETURNS = 10;
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
  // The statistics annualize daily returns; a weekly or monthly history would be misread.
  const gaps = returns
    .map((point) => (Date.parse(point.dateKey) - Date.parse(point.startDateKey)) / 86_400_000)
    .sort((left, right) => left - right);
  const medianGap = gaps[Math.floor(gaps.length / 2)] ?? Number.POSITIVE_INFINITY;
  return returns.length >= MIN_ACCOUNT_RETURNS && medianGap <= MAX_DAILY_GAP_DAYS ? returns : null;
}
