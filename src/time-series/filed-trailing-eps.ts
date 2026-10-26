import type { Fundamentals, FinancialStatement, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { areNearbyFinancialPeriodEnds, statementFieldAvailability } from "../utils/financial-statements";
import { extractFundamentalSeries, knownWhenFiled } from "./fundamentals";
import type { SecuritySeriesSource, TimeSeriesPoint } from "./types";

const DAY_MS = 86_400_000;
/**
 * A figure stops pricing this long after its period end. Sixteen months
 * covers a fiscal year plus its filing, so a year of unavailable quarterly
 * sums falls back on the last annual figure but never on one long overdue.
 */
export const STALE_TRAILING_EPS_MS = 487 * DAY_MS;
/**
 * The latest period's trailing figure reads statements this far back at most:
 * its four quarters (some 270 days), and for a fiscal fourth quarter read from
 * its year, the three quarters before it. Older rows change nothing.
 */
const LATEST_WINDOW_MS = 760 * DAY_MS;

/** One trailing-twelve-month EPS figure and when it became known. */
export interface EpsStep {
  /** ISO period end. */
  periodEnd: string;
  /** Four reported quarters summed, or a reported fiscal year. */
  basis: "ttm" | "annual";
  knownAt: Date;
  /** False when no publication date or report is on record and `knownAt` is the period end. */
  dated: boolean;
  /** Statement currency units; null when unavailable (a declared gap or an incomplete run of quarters). */
  eps: number | null;
  currency: string | null;
}

function epsSeries(financials: TickerFinancials, period: "ttm" | "annual"): TimeSeriesPoint[] {
  const source: SecuritySeriesSource = { kind: "security", instrument: { symbol: "" }, fieldId: "fundamental.eps", period, timestampMode: "available-at" };
  return extractFundamentalSeries(financials, source);
}

/**
 * Trailing EPS through time, oldest first. Four reported quarters are summed
 * by the shared statement series, which keeps declared gaps and broken runs
 * of quarters unavailable and reads a fiscal fourth quarter with no EPS of its
 * own from its year. A reported fiscal year is itself a trailing twelve-month
 * figure; at a fiscal year end it replaces the quarterly sum. `known` dates
 * each row's figures (PEB dates them by the company's reports as well).
 */
export function trailingEpsSteps(
  financials: TickerFinancials,
  known: (row: FinancialStatement) => FinancialStatement = knownWhenFiled,
): EpsStep[] {
  const adjusted = { ...financials, quarterlyStatements: financials.quarterlyStatements.map(known),
    annualStatements: financials.annualStatements.map(known) };
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

/** The trailing EPS of the last period filed, with that period's end and the statements' currency. */
interface FiledTrailingEps {
  eps: number;
  periodEnd: string;
  currency: string;
}

type TrailingEpsInputs = Pick<TickerFinancials, "quote" | "fundamentals" | "annualStatements" | "quarterlyStatements" | "financialCurrency">;

const isReceipt = (financials: TrailingEpsInputs) => !!(
  financials.quote?.isDepositaryReceipt || financials.fundamentals?.isDepositaryReceipt
  || financials.fundamentals?.shareBasis === "depositary_receipt" || financials.quote?.adrRatio || financials.fundamentals?.adrRatio
);

type LatestStep = { periodEnd: string; eps: number; currency: string } | null;

/**
 * The last period's step by what it is read from: the router answers the same
 * rows many times, in new arrays. Bounded; the oldest entry leaves first.
 */
const latestSteps = new Map<string, LatestStep>();
const LATEST_STEPS_KEPT = 500;

/** What the trailing EPS series reads of a row. */
const rowKey = (row: FinancialStatement) => [
  row.date, row.currency ?? "", row.eps ?? "", statementFieldAvailability(row, "eps") ?? "", row.availableAt ?? "", row.dateSource ?? "",
  Object.keys(row.fieldAvailability ?? {}).length,
  row.unavailableFields?.join("+") ?? "", row.unavailableEarnings?.join("+") ?? "", row.epsBasis?.status ?? "", row.shareBasis ?? "",
].join("|");

/** The trailing EPS step for the last period on record, null when that period gives none. */
function latestStep(financials: TrailingEpsInputs): LatestStep {
  const rows = [...financials.quarterlyStatements, ...financials.annualStatements];
  const latest = rows.map((row) => row.date).filter((date) => Number.isFinite(Date.parse(date))).sort().at(-1);
  if (!latest) return null;
  const recent = (row: FinancialStatement) => Date.parse(latest) - Date.parse(row.date) <= LATEST_WINDOW_MS;
  const quarterlyStatements = financials.quarterlyStatements.filter(recent);
  const annualStatements = financials.annualStatements.filter(recent);
  const key = [financials.financialCurrency ?? "", quarterlyStatements.map(rowKey).join(";"), annualStatements.map(rowKey).join(";")].join("#");
  if (latestSteps.has(key)) return latestSteps.get(key)!;
  const found = trailingEpsSteps({ financialCurrency: financials.financialCurrency, priceHistory: [], quarterlyStatements, annualStatements })
    .find((candidate) => areNearbyFinancialPeriodEnds(candidate.periodEnd, latest));
  const step = found?.eps != null && found.currency ? { periodEnd: found.periodEnd, eps: found.eps, currency: found.currency } : null;
  if (latestSteps.size >= LATEST_STEPS_KEPT) latestSteps.delete(latestSteps.keys().next().value!);
  latestSteps.set(key, step);
  return step;
}

/**
 * The headline trailing EPS, as PEB and GE read the statements: the diluted
 * EPS of the last four filed quarters, or of the fiscal year when that is the
 * last period filed. Null when that period gives none (a quarter missing or
 * withheld, a split basis unresolved, two share bases), when it is overdue,
 * when its currency is not the price's, and for a depositary receipt, whose
 * statements are per ordinary share.
 */
function filedTrailingEps(financials: TrailingEpsInputs, now = Date.now()): FiledTrailingEps | null {
  const price = resolveCurrencyUnit(financials.quote?.currency);
  if (!financials.quote || price.divisor !== 1 || !/^[A-Z]{3}$/.test(price.currency) || isReceipt(financials)) return null;
  const step = latestStep(financials);
  if (!step || now - Date.parse(step.periodEnd) > STALE_TRAILING_EPS_MS) return null;
  const currency = resolveCurrencyUnit(step.currency);
  if (currency.currency !== price.currency || currency.divisor !== 1) return null;
  // The trailing block's amounts are in another currency: an EPS beside them in this one would be read as theirs.
  const block = financials.fundamentals?.financialCurrency?.trim();
  if (block && resolveCurrencyUnit(block).currency !== price.currency) return null;
  return { eps: step.eps, periodEnd: step.periodEnd, currency: price.currency };
}

const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The financials with their headline trailing EPS and P/E on the filed
 * quarters (filedTrailingEps): `fundamentals.eps` is that figure and
 * `trailingPE` the quote's price over it, so every view that moves the P/E to
 * the regular session price (atRegularSessionPrice, liveTrailingPE) reads the
 * multiple PEB and GE read. Without one, Gloom Cloud's trailing EPS and P/E
 * stand, marked `served`. A block with no trailing EPS either way is left as
 * it is.
 */
export function withFiledTrailingEps<T extends TrailingEpsInputs>(financials: T, now = Date.now()): T {
  const fundamentals = financials.fundamentals;
  if (!fundamentals) return financials;
  const filed = filedTrailingEps(financials, now);
  if (!filed) {
    const served = typeof fundamentals.eps === "number" && Number.isFinite(fundamentals.eps);
    if (!served || (fundamentals.trailingEpsSource === "served" && fundamentals.trailingEpsPeriodEnd === undefined)) return financials;
    const { trailingEpsPeriodEnd: _period, ...rest } = fundamentals;
    return { ...financials, fundamentals: { ...rest, trailingEpsSource: "served" } };
  }
  const { trailingPEConversion: _conversion, epsCurrency: _currency, trailingPE: _served, ...rest } = fundamentals;
  // filedTrailingEps reads a quote's currency, so there is a quote; its price is the one atRegularSessionPrice moves from.
  const price = financials.quote!.price;
  const next: Fundamentals = {
    ...rest,
    eps: filed.eps,
    // A loss leaves no multiple: priceEarningsOnEarnings reads the EPS as not meaningful.
    ...(positive(price) && filed.eps > 0 ? { trailingPE: price / filed.eps } : {}),
    trailingEpsSource: "filed-quarters",
    trailingEpsPeriodEnd: filed.periodEnd,
  };
  return { ...financials, fundamentals: next };
}
