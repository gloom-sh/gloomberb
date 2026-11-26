import { regularSessionValuationPrice, regularSessionValuationTime } from "../../../market-data/quotes/regular-session-valuation";
import { priceScopedEarnings } from "../../../utils/statement-scope";
import { crossFxCloseOnOrBefore, dailyFxLeg, type FxCloses } from "../../../market-data/fx-closes";
import { knownWhenFiled } from "../../../time-series/fundamentals";
import { calendarBarStart } from "../../../time-series/chart-data";
import { dailyValuationHistory } from "../../../time-series/daily-valuation";
import { STALE_TRAILING_EPS_MS, trailingEpsSteps as sharedTrailingEpsSteps, type EpsStep } from "../../../time-series/filed-trailing-eps";
import { createValuationCurrencyContext } from "../../../time-series/valuation-currency";
import type { FinancialStatement, PricePoint, TickerFinancials } from "../../../types/financials";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { notTheShare } from "../../../utils/share-multiples";
import { datedByReport, type ReportDate } from "./report-dates";

export type { EpsStep };

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
/** Spacing between band multiples, finest first; the first that needs four lines or fewer wins. */
const MULTIPLE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const MAX_BANDS = 4, MIN_BANDS = 3;

interface PeBandWeek {
  date: Date;
  close: number;
  /** Trailing EPS in force that week, in price units; null when none or not positive. */
  eps: number | null;
  pe: number | null;
}

export interface PeBandRow extends EpsStep {
  /**
   * In price units: the first eligible close at or after a scoped figure's
   * publication, otherwise the last session on or before it (a weekly close
   * before daily coverage).
   */
  price: number | null;
  priceAt?: Date | null;
  pe: number | null;
  /** Change from the figure a year earlier in the same currency, when both are positive. */
  yoy: number | null;
  /** The daily FX close the figure was converted at, when it is in another currency than the price. */
  fx: FxClose | null;
}

/** Price currency per unit of the reporting currency. */
interface FxClose {
  date: string;
  rate: number;
}

/** EPS converted from the reporting currency at the period's daily FX close. */
interface EpsConversion {
  /** The statement currency of today's EPS. */
  currency: string;
  /** The rate that converts the trailing EPS currently in force. */
  latest: FxClose;
}

export interface PeBandModel {
  symbol: string;
  /** Price currency. */
  currency: string | null;
  /**
   * The weekly closes the percentile and range rank over, each dated by the
   * session it closed on where the daily closes cover its week (a bar is
   * dated by its first day, its close by its last).
   */
  weeks: PeBandWeek[];
  /**
   * What the chart draws: the weeks, and the close of each day a figure in
   * the table became known, so selecting its row puts the chart's cursor on
   * that day and the price the row reads.
   */
  points: PeBandWeek[];
  /** Newest first. */
  rows: PeBandRow[];
  multiples: number[];
  current: { price: number; eps: number | null; pe: number | null; percentile: number | null; step: EpsStep | null } | null;
  range: { min: number; median: number; max: number } | null;
  /** The weekly P/E readings the percentile and range rank over: the first one's date and how many. */
  sample: { start: Date; weeks: number } | null;
  /**
   * Band values above this are left off the chart, so the value axis fits the
   * price and the lines near it: one and a half times the highest close, or
   * the line just above today's P/E when that is higher.
   */
  bandCeiling: number | null;
  /** Figures in the window dated by period end because neither a publication date nor a report is on record. */
  undated: number;
  /** Trailing sums in the window that are unavailable (a quarter's EPS is withheld or not reported). */
  unavailable: number;
  /** Set when current EPS was converted to the listing currency. */
  conversion: EpsConversion | null;
  /** Blocks the pane: nothing can be priced. */
  error: string | null;
  /** The pane still draws, but without bands. */
  notice: string | null;
}

/**
 * Trailing EPS through time, oldest first, as the headline EPS (TTM) reads it
 * (time-series/filed-trailing-eps). A figure is known no later than the
 * company's report of that quarter, when `reports` has it, including one with
 * no publication date of its own.
 */
export function trailingEpsSteps(financials: TickerFinancials, reports: readonly ReportDate[] = []): EpsStep[] {
  return sharedTrailingEpsSteps(financials, (row: FinancialStatement) => datedByReport(knownWhenFiled(row), reports));
}

/**
 * Decimals that keep three significant digits of a per-share amount: two from
 * 1 up, more below it, so 0.0712 does not print as 0.07 and a YoY can be
 * recomputed from the figures shown.
 */
export function perShareDigits(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude >= 1 || magnitude === 0 || !Number.isFinite(magnitude) ? 2 : Math.min(6, Math.ceil(-Math.log10(magnitude)) + 2);
}

export const formatPerShare = (value: number) => value.toFixed(perShareDigits(value));

export function formatEpsFx(from: string, to: string, rate: number): string {
  return `${resolveCurrencyUnit(from).currency}/${resolveCurrencyUnit(to).currency} ${rate.toPrecision(5)}`;
}

export function epsFxCurrencies(financials: TickerFinancials, reports: readonly ReportDate[]): Map<string, string> {
  const target = resolveCurrencyUnit(financials.quote?.currency).currency;
  const starts = new Map<string, string>();
  if (financials.statementScope) return starts;
  if (target !== "USD" && !dailyFxLeg(target)) return starts;
  for (const step of trailingEpsSteps(financials, reports)) {
    const source = resolveCurrencyUnit(step.currency).currency;
    if (step.eps == null || source === target || (source !== "USD" && !dailyFxLeg(source))) continue;
    for (const currency of [source, target]) {
      if (currency !== "USD" && (!starts.has(currency) || step.periodEnd < starts.get(currency)!)) starts.set(currency, step.periodEnd);
    }
  }
  return starts;
}

function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/**
 * Round multiples around today's P/E and across the stock's own history. The
 * span runs from the 5th to the 95th percentile of the weekly P/E, stretched
 * to take in today's P/E and cut to between half and twice it, so a history
 * far from today (AMZN at 600x a decade ago, 20x now) cannot push every line
 * away from the price. The finest spacing (1x, 2x, 5x, 10x...) that needs
 * four lines or fewer wins, and the lines always include the round multiples
 * on either side of today's P/E. Without a current P/E the span is the
 * history's alone. Three lines at least, widened toward the side the lines
 * leave more of the span uncovered.
 */
export function chooseMultiples(pes: readonly number[], current?: number | null): number[] {
  const sorted = pes.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const today = current != null && Number.isFinite(current) && current > 0 ? current : null;
  let low = quantile(sorted, 0.05), high = quantile(sorted, 0.95);
  if (today) {
    low = Math.max(Math.min(low, today), today / 2);
    high = Math.min(Math.max(high, today), today * 2);
  }
  for (const step of MULTIPLE_STEPS) {
    let first = Math.max(1, Math.ceil(low / step)), last = Math.floor(high / step);
    if (today) {
      first = Math.max(1, Math.min(first, Math.floor(today / step)));
      last = Math.max(last, Math.ceil(today / step));
    }
    if (last - first + 1 > MAX_BANDS) continue;
    while (last - first + 1 < MIN_BANDS) {
      // An empty span (both bounds between two lines) takes the nearest line on each side.
      if (last < first) [first, last] = [last, first];
      if (first > 1 && first * step - low >= high - last * step) first -= 1;
      else last += 1;
    }
    return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step);
  }
  return [];
}

/** Positive closes in time order; cached history can carry ISO strings for dates. */
function closesOf(history: readonly PricePoint[]): Array<{ date: Date; close: number }> {
  return history.map((point) => ({ date: new Date(point.date), close: point.close }))
    .filter((point) => Number.isFinite(point.date.getTime()) && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function scopedBandHistory(history: readonly PricePoint[], step: EpsStep, exchange: string | undefined, now: number) {
  const daily = dailyValuationHistory(history, [{ observedAt: new Date(step.periodEnd), availableAt: step.knownAt.toISOString(), atPrice: price => price }], exchange, now)
    .flatMap(point => point.value === null ? [] : [{ date: point.date, close: point.value }]);
  const weeks = new Map(daily.map(point => [calendarBarStart(point.date.getTime(), "1wk", exchange), point]));
  return { daily, weeks: [...weeks.values()] };
}

/**
 * Weekly bars dated by the session their close is from. A bar is dated by
 * its week's first day, so DWSN's week of 9 Nov 2026 read 9 Nov with the
 * close of Friday the 13th. Where the daily closes cover a week, the bar
 * takes the date of the last daily close before the next bar; elsewhere it
 * keeps its own.
 */
function closingSessions<T extends { date: Date }>(weekly: readonly T[], daily: readonly { date: Date }[]): T[] {
  let at = 0;
  return weekly.map((bar, index) => {
    const from = bar.date.getTime();
    const until = weekly[index + 1]?.date.getTime() ?? Number.POSITIVE_INFINITY;
    while (at < daily.length && daily[at]!.date.getTime() < from) at += 1;
    let last: { date: Date } | null = null;
    while (at < daily.length && daily[at]!.date.getTime() < until) last = daily[at++]!;
    return last ? { ...bar, date: last.date } : bar;
  });
}

/** Percent of `values` at or below `value`. */
function percentileRank(values: readonly number[], value: number): number | null {
  return values.length ? 100 * values.filter((other) => other <= value).length / values.length : null;
}

/**
 * The figure in force at `time`: of those known by then, the one for the
 * latest period, unless it is overdue. An unavailable sum does not erase the
 * figure before it; that figure stays in force until it goes stale.
 */
export function stepAt(steps: readonly EpsStep[], time: number): EpsStep | null {
  let step: EpsStep | null = null;
  for (const candidate of steps) {
    if (candidate.eps == null || candidate.knownAt.getTime() > time) continue;
    if (!step || candidate.periodEnd > step.periodEnd) step = candidate;
  }
  return step && time - Date.parse(step.periodEnd) <= STALE_TRAILING_EPS_MS ? step : null;
}

export function projectPeBand(
  financials: TickerFinancials | null,
  history: readonly PricePoint[],
  options: {
    symbol: string; exchange?: string; lookbackYears: number; now?: number; reports?: readonly ReportDate[];
    /** Daily FX closes by currency, quoted in USD per unit. */
    fx?: ReadonlyMap<string, FxCloses>;
    /** Why a needed FX history is missing, said when it leaves today's EPS unconverted. */
    fxError?: string | null;
    /** Daily closes for the recent years they are served for (see `weeks` and `PeBandRow.price`). */
    daily?: readonly PricePoint[];
  },
): PeBandModel {
  const currency = financials?.quote?.currency ?? null;
  const empty: PeBandModel = { symbol: options.symbol, currency, weeks: [], points: [], rows: [], multiples: [], current: null, range: null, sample: null, bandCeiling: null,
    undated: 0, unavailable: 0, conversion: null, error: null, notice: null };
  if (!financials) return { ...empty, error: "Fundamentals unavailable." };
  // A warrant's, a right's, a unit's or an unratioed receipt's price over its company's EPS is no P/E at any date.
  const share = notTheShare(financials);
  if (share) return { ...empty, error: `No P/E: ${share}.` };
  const allSteps = trailingEpsSteps(financials, options.reports);
  const latest = allSteps.findLast((step) => step.eps != null);
  if (!latest) return { ...empty, error: "No trailing EPS on record." };
  const units = createValuationCurrencyContext(financials);
  // Price units per statement unit: 1 for the same currency, 100 for a pence price against pound statements.
  const unitScale = (step: EpsStep) => {
    const factor = units.priceInStatementUnits({ date: step.periodEnd, currency: step.currency ?? undefined }, 1);
    return factor ? 1 / factor : null;
  };
  const quoteUnit = resolveCurrencyUnit(currency);
  const priced = (step: EpsStep | null): { eps: number; fx: FxClose | null } | null => {
    if (step?.eps == null) return null;
    if (financials.statementScope) return step.currency === currency ? { eps: step.eps, fx: null } : null;
    const factor = unitScale(step);
    if (factor != null) return { eps: step.eps * factor, fx: null };
    const source = resolveCurrencyUnit(step.currency);
    const close = options.fx && crossFxCloseOnOrBefore(options.fx, source.currency, quoteUnit.currency, step.periodEnd);
    return close ? { eps: step.eps / source.divisor * close.rate * quoteUnit.divisor, fx: close } : null;
  };
  const pricedSteps = new Map(allSteps.map((step) => [step, priced(step)]));
  if (!pricedSteps.get(latest) && !allSteps.some((step) => pricedSteps.get(step))) {
    return { ...empty, error: !currency || !latest.currency ? "The price or EPS currency is unknown."
      : `EPS is reported in ${latest.currency} and the price is in ${currency}; ${options.fxError ?? `no FX close for ${latest.periodEnd}`}.` };
  }

  const now = options.now ?? Date.now();
  const canPrice = !financials.statementScope || (financials.fundamentals?.scopedEarnings?.priced === true && !financials.fundamentals.notMeaningful?.trailingPE);
  const stepForPrice = (time: number) => financials.statementScope
    ? (latest.knownAt.getTime() <= time && time <= now ? latest : null) : stepAt(allSteps, time);
  const firstKnown = allSteps.find((step) => step.eps != null)!.knownAt.getTime();
  const start = Math.max(firstKnown, options.lookbackYears > 0 ? now - options.lookbackYears * YEAR_MS : firstKnown);
  const scoped = financials.statementScope ? scopedBandHistory(options.daily?.length ? options.daily : financials.priceHistory,
    latest, financials.quote?.listingExchangeName || financials.quote?.exchangeName || options.exchange, now) : null;
  const sorted = scoped ? [] : closesOf(history);
  const daily = scoped?.daily ?? closesOf(options.daily ?? []);
  const dailyStart = daily[0]?.date.getTime() ?? Number.POSITIVE_INFINITY;
  /** A close as the chart reads it: with the EPS in force on its day, and the P/E they make. */
  const reading = (point: { date: Date; close: number }): PeBandWeek => {
    const step = stepForPrice(point.date.getTime());
    const eps = step ? pricedSteps.get(step)?.eps ?? null : null;
    const positive = eps != null && eps > 0 ? eps : null;
    return { date: point.date, close: point.close, eps: positive, pe: canPrice && positive ? point.close / positive : null };
  };
  const weeks = (scoped?.weeks ?? closingSessions(sorted, daily)).filter((point) => point.date.getTime() >= start).map(reading);

  /** Scoped EPS waits for a close; an ordinary row reads the close on or before its date. */
  const dayClose = (time: number) => scoped ? daily.find(point => point.date.getTime() >= time) ?? null
    : time >= dailyStart ? daily.findLast((point) => point.date.getTime() <= time) ?? null : null;
  const steps = allSteps.filter((step) => step.knownAt.getTime() >= start && (!financials.statementScope || step.knownAt.getTime() <= now));
  const rows = steps.filter((step) => step.eps != null).map((step): PeBandRow => {
    const time = step.knownAt.getTime();
    const bar = dayClose(time) ?? sorted.findLast((point) => point.date.getTime() <= time);
    const price = bar?.close ?? null;
    const converted = pricedSteps.get(step);
    const eps = converted?.eps ?? null;
    const prior = allSteps.find((other) => other.eps != null && other.currency === step.currency
      && Math.abs(Date.parse(step.periodEnd) - Date.parse(other.periodEnd) - 365 * DAY_MS) <= 20 * DAY_MS);
    return { ...step, price, ...(scoped ? { priceAt: bar?.date ?? null } : {}), pe: canPrice && price != null && eps != null && eps > 0 ? price / eps : null, fx: converted?.fx ?? null,
      yoy: step.eps != null && prior?.eps != null && step.eps > 0 && prior.eps > 0 ? step.eps / prior.eps - 1 : null };
  }).reverse();

  const ranked = weeks.filter((week) => week.pe != null);
  const pes = ranked.map((week) => week.pe!);
  const ordered = [...pes].sort((a, b) => a - b);
  // The regular session's price, as the quote headlines it: after the close, the close rather than an after-hours print.
  const price = regularSessionValuationPrice(financials.quote) ?? (financials.statementScope ? null : sorted.at(-1)?.close ?? null);
  // Today's figure reads like every week's: one whose newest quarter has no EPS keeps the last figure, dated in the
  // table, where the headline EPS (TTM) needs that quarter's own (filed-trailing-eps) and shows Gloom Cloud's, labelled.
  const priceTime = financials.statementScope ? regularSessionValuationTime(financials.quote)?.time : now;
  const currentStep = stepForPrice(priceTime ?? -Infinity);
  const currentConversion = currentStep ? pricedSteps.get(currentStep) : null;
  const currentEps = currentConversion?.eps ?? null;
  const latestFx = currentConversion?.fx;
  const currentPe = financials.statementScope && financials.fundamentals
    ? priceScopedEarnings(financials.fundamentals, price, financials.quote, priceTime, now).trailingPE ?? null
    : price != null && currentEps != null && currentEps > 0 ? price / currentEps : null;
  const multiples = chooseMultiples(pes, currentPe);
  const above = currentPe == null ? undefined : multiples.find((multiple) => multiple >= currentPe);
  const highestClose = weeks.reduce((max, week) => Math.max(max, week.close), 0);
  // Each dated row's day on the chart, the close it reads: its cursor lands there, not on the week around it.
  const rowDays = rows.flatMap((row) => {
    const close = row.dated ? dayClose(row.knownAt.getTime()) : null;
    return close && close.date.getTime() >= start ? [reading(close)] : [];
  });
  const byTime = new Map([...weeks, ...rowDays].map((point) => [point.date.getTime(), point]));
  const points = [...byTime.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    ...empty, weeks, points, rows, multiples,
    conversion: latestFx && currentStep?.currency ? { currency: currentStep.currency, latest: latestFx } : null,
    sample: ranked.length ? { start: ranked[0]!.date, weeks: ranked.length } : null,
    bandCeiling: highestClose > 0 ? Math.max(highestClose * 1.5, above != null && currentEps != null ? above * currentEps : 0) : null,
    current: price == null ? null : { price, eps: currentEps, pe: currentPe, step: currentStep,
      percentile: currentPe == null ? null : percentileRank(pes, currentPe) },
    range: ordered.length ? { min: ordered[0]!, median: quantile(ordered, 0.5), max: ordered.at(-1)! } : null,
    undated: steps.filter((step) => !step.dated && step.eps != null).length,
    unavailable: steps.filter((step) => step.eps == null).length,
    notice: currentStep && !currentConversion ? options.fxError ?? `No FX close for ${currentStep.periodEnd}.`
      : pes.length ? null : "Trailing EPS was not positive in this window, so there is no P/E band.",
  };
}
