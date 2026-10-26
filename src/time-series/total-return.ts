import type { CorporateActionsData } from "../types/financials";
import { cashInMajorUnits } from "../utils/dividend-cash";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { logFailure } from "../utils/log-failure";
import { dividendReferencePrice } from "../utils/trailing-dividend";
import { observationDate } from "./price-comparison";
import { CHART_RESOLUTION_STEP_MS, chartBarSizeStepMs } from "./resolution";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

/** One cash distribution per share: its ex-date (`YYYY-MM-DD`) and its amount in the listing's major currency unit. */
export interface CashDistribution {
  exDate: string;
  amount: number;
}

export interface TotalReturnOptions {
  /** The session day a bar belongs to, `YYYY-MM-DD`. */
  dayOf: (point: TimeSeriesPoint) => string;
  /**
   * A bar's price in the distributions' currency unit, or null when the two
   * currencies differ (nothing is converted).
   */
  cashPrice: (price: number) => number | null;
  /**
   * Bars longer than a session (weekly, monthly) are dated at their start, so a
   * distribution belongs to the bar that holds its ex-date, not the first one
   * dated on or after it.
   */
  holdingBar?: boolean;
}

export interface TotalReturnResult {
  points: TimeSeriesPoint[];
  /** Distributions reinvested inside the series; one before its first bar or after its last is not. */
  applied: number;
}

const FAR_FUTURE = "9999-12-31";

function scaled(value: number | null | undefined, factor: number): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * factor : value;
}

/**
 * A price series as its total return: every cash distribution is reinvested at
 * the close of its ex-date bar, so the series moves by (close + cash) over the
 * bar before. Each price is multiplied by the shares the cash has bought
 * since the series began, which leaves its first bar as it was; volume is
 * left alone. A distribution dated at or before the first bar precedes the
 * series, so nothing is reinvested for it.
 */
export function reinvestDistributions(
  points: readonly TimeSeriesPoint[],
  distributions: readonly CashDistribution[],
  { dayOf, cashPrice, holdingBar = false }: TotalReturnOptions,
): TotalReturnResult {
  const ordered = [...points].sort((left, right) => left.date.getTime() - right.date.getTime());
  const cash = distributions
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.exDate) && Number.isFinite(entry.amount) && entry.amount > 0)
    .sort((left, right) => left.exDate.localeCompare(right.exDate));
  const days = ordered.map(dayOf);
  let factor = 1;
  let applied = 0;
  let next = 0;
  const adjusted = ordered.map((point, index) => {
    const barDay = days[index]!;
    const before = holdingBar ? days[index + 1] ?? FAR_FUTURE : null;
    while (next < cash.length) {
      const entry = cash[next]!;
      if (before !== null ? entry.exDate >= before : entry.exDate > barDay) break;
      if (index === 0) { next += 1; continue; }
      const close = point.close ?? point.value;
      // A bar with no price leaves the cash for the next bar that has one.
      if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) break;
      // Cash in another currency than the price buys nothing: the series stays a price series.
      const price = cashPrice(close);
      if (price !== null && price > 0) {
        factor *= 1 + entry.amount / price;
        applied += 1;
      }
      next += 1;
    }
    if (factor === 1) return point;
    return {
      ...point,
      value: scaled(point.value, factor) ?? null,
      ...point.rawValue !== undefined ? { rawValue: scaled(point.rawValue, factor) ?? null } : {},
      ...point.open !== undefined ? { open: scaled(point.open, factor) } : {},
      ...point.high !== undefined ? { high: scaled(point.high, factor) } : {},
      ...point.low !== undefined ? { low: scaled(point.low, factor) } : {},
      ...point.close !== undefined ? { close: scaled(point.close, factor) } : {},
    };
  });
  return { points: adjusted, applied };
}

export interface TotalReturnOutcome {
  series: ResolvedSeries;
  /** Why the series stays a price series, when it does. */
  notice?: string;
}

const DAY_MS = 86_400_000;

/** Whether the bars are longer than a session, so a distribution belongs to the bar holding its ex-date. */
function barsLongerThanSession(series: Pick<ResolvedSeries, "barSize" | "historyResolution">): boolean {
  const step = series.barSize ? chartBarSizeStepMs(series.barSize)
    : series.historyResolution ? CHART_RESOLUTION_STEP_MS[series.historyResolution] : null;
  return step !== null && step > DAY_MS;
}

/**
 * A price series as its total return, from the cash history its listing pays.
 * The series says which basis it ended up on: `total` once its distributions
 * are reinvested (a listing that pays none is its price), `price` with the
 * reason when the history cannot be read, covers no distributions, or is in
 * another currency than the prices. Nothing is converted.
 */
export async function totalReturnSeries(
  series: ResolvedSeries,
  loadActions: () => Promise<CorporateActionsData | null>,
  priceCurrency: string | undefined,
): Promise<TotalReturnOutcome> {
  const priceOnly = (notice: string): TotalReturnOutcome => ({ series: { ...series, returnBasis: "price" }, notice });
  const actions = await loadActions().catch(logFailure("total-return", "Loading distribution history failed", null));
  if (!actions) return priceOnly("distribution history unavailable; showing the price return.");
  const cash = cashInMajorUnits(actions);
  const dividends = Array.isArray(cash.dividends) ? cash.dividends : [];
  if (cash.coverage?.dividends === "unavailable" || (cash.coverage?.dividends !== "available" && dividends.length === 0)) {
    return priceOnly("distribution history unavailable; showing the price return.");
  }
  const currency = resolveCurrencyUnit(cash.currency).currency;
  if (dividends.length > 0 && !currency) return priceOnly("distribution currency unknown; showing the price return.");
  if (dividends.length > 0 && !resolveCurrencyUnit(priceCurrency).currency) {
    return priceOnly("price currency unknown; showing the price return.");
  }
  if (dividends.length > 0 && dividendReferencePrice(1, priceCurrency, currency) === null) {
    return priceOnly(`distributions are in ${currency}, not the price currency; showing the price return.`);
  }
  const { points } = reinvestDistributions(series.points, dividends, {
    dayOf: (point) => observationDate(point.date.getTime(), series),
    cashPrice: (price) => dividendReferencePrice(price, priceCurrency, currency),
    holdingBar: barsLongerThanSession(series),
  });
  // "ECC Close" is its price: a label the chart wrote from the field says what the series is now.
  return { series: { ...series, points, returnBasis: "total", label: series.label.replace(/ (?:Close|Price|Open|High|Low)$/, " Total return") } };
}
