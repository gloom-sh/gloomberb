import { extractFundamentalSeries } from "../../../time-series/fundamentals";
import type { SecuritySeriesSource, TimeSeriesPoint } from "../../../time-series/types";
import { createValuationCurrencyContext } from "../../../time-series/valuation-currency";
import type { FinancialStatement, PricePoint, TickerFinancials } from "../../../types/financials";
import { areNearbyFinancialPeriodEnds } from "../../../utils/financial-statements";

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
/**
 * A figure stops pricing weeks this long after its period end. Sixteen months
 * covers a fiscal year plus its filing, so a year of unavailable quarterly
 * sums falls back on the last annual figure but never on one long overdue.
 */
const STALE_EPS_MS = 487 * DAY_MS;
/** Spacing between band multiples, finest first; the first that needs four lines or fewer wins. */
const MULTIPLE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const MAX_BANDS = 4, MIN_BANDS = 3;

/** One trailing-twelve-month EPS figure and when it became known. */
export interface EpsStep {
  /** ISO period end. */
  periodEnd: string;
  /** Four reported quarters summed, or a reported fiscal year. */
  basis: "ttm" | "annual";
  knownAt: Date;
  /** False when no publication date is on record and `knownAt` is the period end. */
  dated: boolean;
  /** Statement currency units; null when unavailable (a declared gap or an incomplete run of quarters). */
  eps: number | null;
  currency: string | null;
}

interface PeBandWeek {
  date: Date;
  close: number;
  /** Trailing EPS in force that week, in price units; null when none or not positive. */
  eps: number | null;
  pe: number | null;
}

export interface PeBandRow extends EpsStep {
  /** The close of the week the figure became known, in price units. */
  price: number | null;
  pe: number | null;
  /** Change from the figure a year earlier, when both are positive. */
  yoy: number | null;
}

export interface PeBandModel {
  symbol: string;
  /** Price currency. */
  currency: string | null;
  weeks: PeBandWeek[];
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
  /** Figures in the window dated by period end because no publication date is on record. */
  undated: number;
  /** Trailing sums in the window that are unavailable (a quarter's EPS is withheld or not reported). */
  unavailable: number;
  /** Blocks the pane: nothing can be priced. */
  error: string | null;
  /** The pane still draws, but without bands. */
  notice: string | null;
}

/**
 * A split restates EPS onto the new share count, and SEC history dates the
 * restated figure by the filing that evidenced the split. The earnings were
 * known at the original filing; the price history is split-adjusted the same
 * way, so the restated figure steps when it was first filed.
 */
function knownWhenFiled(row: FinancialStatement): FinancialStatement {
  const filed = row.epsBasis?.status === "split-adjusted" ? row.epsBasis.originalFiled : undefined;
  if (!filed || !Number.isFinite(Date.parse(filed))) return row;
  const current = row.fieldAvailability !== undefined ? row.fieldAvailability.eps : row.availableAt;
  if (current && Date.parse(current) <= Date.parse(filed)) return row;
  return { ...row, fieldAvailability: { ...row.fieldAvailability, eps: filed } };
}

function epsSeries(financials: TickerFinancials, period: "ttm" | "annual"): TimeSeriesPoint[] {
  const source: SecuritySeriesSource = { kind: "security", instrument: { symbol: "" }, fieldId: "fundamental.eps", period, timestampMode: "available-at" };
  return extractFundamentalSeries(financials, source);
}

/**
 * Trailing EPS through time, oldest first. Four reported quarters are summed
 * by the shared statement series, which keeps declared gaps and broken runs
 * of quarters unavailable. A reported fiscal year is itself a trailing
 * twelve-month figure; at a fiscal year end it replaces the quarterly sum.
 */
export function trailingEpsSteps(financials: TickerFinancials): EpsStep[] {
  const adjusted = { ...financials, quarterlyStatements: financials.quarterlyStatements.map(knownWhenFiled),
    annualStatements: financials.annualStatements.map(knownWhenFiled) };
  const toStep = (basis: EpsStep["basis"]) => (point: TimeSeriesPoint): EpsStep => ({
    periodEnd: point.observedAt.toISOString().slice(0, 10), basis, knownAt: point.date, dated: point.availableAt !== undefined,
    eps: point.value != null && Number.isFinite(point.value) ? point.value : null, currency: point.provenance?.currency ?? null,
  });
  const steps = epsSeries(adjusted, "annual").map(toStep("annual"));
  for (const step of epsSeries(adjusted, "ttm").map(toStep("ttm"))) {
    const index = steps.findIndex((other) => areNearbyFinancialPeriodEnds(other.periodEnd, step.periodEnd));
    if (index < 0) steps.push(step);
    else if (steps[index]!.eps == null && step.eps != null) steps[index] = step;
  }
  return steps.sort((a, b) => a.knownAt.getTime() - b.knownAt.getTime() || a.periodEnd.localeCompare(b.periodEnd));
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
  return step && time - Date.parse(step.periodEnd) <= STALE_EPS_MS ? step : null;
}

export function projectPeBand(
  financials: TickerFinancials | null,
  history: readonly PricePoint[],
  options: { symbol: string; lookbackYears: number; now?: number },
): PeBandModel {
  const currency = financials?.quote?.currency ?? null;
  const empty: PeBandModel = { symbol: options.symbol, currency, weeks: [], rows: [], multiples: [], current: null, range: null, sample: null, bandCeiling: null,
    undated: 0, unavailable: 0, error: null, notice: null };
  if (!financials) return { ...empty, error: "Fundamentals unavailable." };
  const allSteps = trailingEpsSteps(financials);
  const latest = allSteps.findLast((step) => step.eps != null);
  if (!latest) return { ...empty, error: "No trailing EPS on record." };
  const units = createValuationCurrencyContext(financials);
  // Price units per statement unit: 1 for the same currency, 100 for a pence price against pound statements.
  const scale = (step: EpsStep) => {
    const factor = units.priceInStatementUnits({ date: step.periodEnd, currency: step.currency ?? undefined }, 1);
    return factor ? 1 / factor : null;
  };
  // ADRs and cross-listings report in one currency and trade in another; no FX rate is applied.
  if (scale(latest) == null) {
    return { ...empty, error: currency && latest.currency
      ? `EPS is reported in ${latest.currency} and the price is in ${currency}.` : "The price or EPS currency is unknown." };
  }
  const priced = (step: EpsStep | null) => {
    const factor = step?.eps != null ? scale(step) : null;
    return factor == null ? null : step!.eps! * factor;
  };

  const now = options.now ?? Date.now();
  const firstKnown = allSteps.find((step) => step.eps != null)!.knownAt.getTime();
  const start = Math.max(firstKnown, options.lookbackYears > 0 ? now - options.lookbackYears * YEAR_MS : firstKnown);
  // Cached history can carry ISO strings for dates.
  const sorted = history.map((point) => ({ date: new Date(point.date), close: point.close }))
    .filter((point) => Number.isFinite(point.date.getTime()) && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const weeks = sorted.filter((point) => point.date.getTime() >= start).map((point): PeBandWeek => {
    const eps = priced(stepAt(allSteps, point.date.getTime()));
    const positive = eps != null && eps > 0 ? eps : null;
    return { date: point.date, close: point.close, eps: positive, pe: positive ? point.close / positive : null };
  });

  const steps = allSteps.filter((step) => step.knownAt.getTime() >= start);
  const rows = steps.filter((step) => step.eps != null).map((step): PeBandRow => {
    const time = step.knownAt.getTime();
    const price = sorted.findLast((point) => point.date.getTime() <= time)?.close ?? null;
    const eps = priced(step);
    const prior = allSteps.find((other) => other.eps != null
      && Math.abs(Date.parse(step.periodEnd) - Date.parse(other.periodEnd) - 365 * DAY_MS) <= 20 * DAY_MS);
    return { ...step, price, pe: price != null && eps != null && eps > 0 ? price / eps : null,
      yoy: step.eps != null && prior?.eps != null && step.eps > 0 && prior.eps > 0 ? step.eps / prior.eps - 1 : null };
  }).reverse();

  const ranked = weeks.filter((week) => week.pe != null);
  const pes = ranked.map((week) => week.pe!);
  const ordered = [...pes].sort((a, b) => a - b);
  const quotePrice = financials.quote?.price;
  const price = quotePrice != null && Number.isFinite(quotePrice) && quotePrice > 0 ? quotePrice : sorted.at(-1)?.close ?? null;
  const currentStep = stepAt(allSteps, now);
  const currentEps = priced(currentStep);
  const currentPe = price != null && currentEps != null && currentEps > 0 ? price / currentEps : null;
  const multiples = chooseMultiples(pes, currentPe);
  const above = currentPe == null ? undefined : multiples.find((multiple) => multiple >= currentPe);
  const highestClose = weeks.reduce((max, week) => Math.max(max, week.close), 0);
  return {
    ...empty, weeks, rows, multiples,
    sample: ranked.length ? { start: ranked[0]!.date, weeks: ranked.length } : null,
    bandCeiling: highestClose > 0 ? Math.max(highestClose * 1.5, above != null && currentEps != null ? above * currentEps : 0) : null,
    current: price == null ? null : { price, eps: currentEps, pe: currentPe, step: currentStep,
      percentile: currentPe == null ? null : percentileRank(pes, currentPe) },
    range: ordered.length ? { min: ordered[0]!, median: quantile(ordered, 0.5), max: ordered.at(-1)! } : null,
    undated: steps.filter((step) => !step.dated && step.eps != null).length,
    unavailable: steps.filter((step) => step.eps == null).length,
    notice: pes.length ? null : "Trailing EPS was not positive in this window, so there is no P/E band.",
  };
}
