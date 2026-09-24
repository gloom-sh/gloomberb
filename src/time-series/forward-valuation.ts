import type {
  ConsensusEpsEstimate,
  ConsensusEpsSnapshot,
  EpsEstimateHistory,
  FinancialStatement,
  TickerFinancials,
} from "../types/financials";
import type { ValuationCurrencyContext } from "./valuation-currency";
import { valuationPriceAtOrBefore } from "./valuation-price";
import type { TimeSeriesPoint } from "./types";

/**
 * Forward multiples over time. No source serves the consensus as it stood on
 * an arbitrary past day, so the history is assembled from three legs:
 *
 * 1. At each report date, the next four quarters' pre-report consensus. Each
 *    value is the consensus at that quarter's own report, so the sum is a
 *    final-vintage NTM figure, not what analysts believed on the day.
 * 2. Snapshots the cloud recorded day by day: the current and next fiscal year
 *    consensus, blended by the months left in the current year. These are
 *    point-in-time and take over from the day recording started.
 * 3. Today's consensus, blended the same way, as the current point.
 *
 * The realized variant divides the same report-date prices by the four
 * quarters that were actually earned afterwards. It is hindsight, kept apart
 * from the forward series so neither is mistaken for the other.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const NTM_QUARTERS = 4;

export const FORWARD_PE_BASIS_NOTICE =
  "Forward P/E history: at each report date, price over the next four quarters' pre-report consensus (final vintage, not the consensus on that day). Later points use the cloud's daily consensus observations and today's consensus, blending current and next fiscal year by months remaining.";

export const REALIZED_NTM_PE_BASIS_NOTICE =
  "Realized NTM P/E: price at each report date over the EPS actually reported in the following four quarters. Hindsight, not a forward multiple.";

/** Methodology, true for every such chart: kept in metadata, never a pane warning. */
export const FORWARD_VALUATION_BASIS_NOTICES: ReadonlySet<string> = new Set([
  FORWARD_PE_BASIS_NOTICE,
  REALIZED_NTM_PE_BASIS_NOTICE,
]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isoDay(value: string): string {
  return value.slice(0, 10);
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function reportedRows(history: EpsEstimateHistory) {
  return [...history.reported]
    .filter((row) => validDate(row.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** Fiscal-year blend: weight of the current year is the fraction of it still ahead. */
function blendedNextTwelveMonthsEps(
  asOf: string,
  currentYear: { periodEnd?: string; eps?: number } | undefined,
  nextYear: { eps?: number } | undefined,
): number | null {
  const current = currentYear?.eps;
  const next = nextYear?.eps;
  const end = validDate(currentYear?.periodEnd);
  const at = validDate(asOf);
  if (!finite(next)) return null;
  if (!finite(current) || !end || !at) return next > 0 ? next : null;
  const remaining = Math.min(1, Math.max(0, (end.getTime() - at.getTime()) / (365.25 * DAY_MS)));
  const blended = current * remaining + next * (1 - remaining);
  return blended > 0 ? blended : null;
}

function consensusByPeriod(rows: readonly ConsensusEpsEstimate[]) {
  const map = new Map<string, ConsensusEpsEstimate>();
  for (const row of rows) map.set(row.period, row);
  return map;
}

/** Snapshots grouped by observation day, one entry per period. */
function snapshotsByDay(rows: readonly ConsensusEpsSnapshot[]) {
  const days = new Map<string, Map<string, ConsensusEpsSnapshot>>();
  for (const row of rows) {
    if (!validDate(row.observedOn)) continue;
    const day = isoDay(row.observedOn);
    const periods = days.get(day) ?? new Map<string, ConsensusEpsSnapshot>();
    periods.set(row.period, row);
    days.set(day, periods);
  }
  return days;
}

interface PricedPoint {
  date: string;
  price: number;
  providerId?: string;
}

function pricedDate(
  financials: TickerFinancials,
  currencies: ValuationCurrencyContext,
  estimateCurrency: string | undefined,
  date: string,
): PricedPoint | null {
  const priced = valuationPriceAtOrBefore(financials.priceHistory, date);
  if (!priced || priced.price === null) return null;
  // Estimates carry their own currency; the price must share it before division.
  const basis = { date, currency: estimateCurrency ?? financials.financialCurrency } as FinancialStatement;
  const comparable = currencies.priceInStatementUnits(basis, priced.price);
  if (comparable === null || comparable <= 0) return null;
  return { date, price: comparable, providerId: financials.quote?.providerId };
}

function point(
  priced: PricedPoint,
  value: number,
  periodLabel: string,
  quality: NonNullable<TimeSeriesPoint["provenance"]>["quality"],
): TimeSeriesPoint {
  const date = new Date(priced.date);
  return {
    date,
    observedAt: date,
    availableAt: date,
    value,
    periodLabel,
    provenance: { providerId: priced.providerId, quality },
  };
}

function reportDatePoints(
  financials: TickerFinancials,
  history: EpsEstimateHistory,
  currencies: ValuationCurrencyContext,
  pick: (row: EpsEstimateHistory["reported"][number]) => number | undefined,
  label: (date: string) => string,
): TimeSeriesPoint[] {
  const rows = reportedRows(history);
  const points: TimeSeriesPoint[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const window = rows.slice(index + 1, index + 1 + NTM_QUARTERS);
    if (window.length < NTM_QUARTERS) break;
    const values = window.map(pick);
    if (!values.every(finite)) continue;
    const sum = (values as number[]).reduce((total, value) => total + value, 0);
    if (sum <= 0) continue;
    const priced = pricedDate(financials, currencies, history.currency, rows[index]!.date);
    if (!priced) continue;
    points.push(point(priced, priced.price / sum, label(rows[index]!.date), "derived"));
  }
  return points;
}

function snapshotPoints(
  financials: TickerFinancials,
  history: EpsEstimateHistory,
  currencies: ValuationCurrencyContext,
  after: string | null,
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (const [day, periods] of snapshotsByDay(history.snapshots)) {
    if (after && day <= after) continue;
    const currentYear = periods.get("current year");
    const nextYear = periods.get("next year");
    const eps = blendedNextTwelveMonthsEps(
      day,
      currentYear ? { periodEnd: currentYear.periodEnd, eps: currentYear.epsAverage } : undefined,
      nextYear ? { eps: nextYear.epsAverage } : undefined,
    );
    if (eps === null) continue;
    const priced = pricedDate(financials, currencies, history.currency, day);
    if (!priced) continue;
    points.push(point(priced, priced.price / eps, `Consensus observed ${day}`, "derived"));
  }
  return points.sort((left, right) => left.date.getTime() - right.date.getTime());
}

function currentConsensusPoint(
  financials: TickerFinancials,
  history: EpsEstimateHistory,
  currencies: ValuationCurrencyContext,
): TimeSeriesPoint | null {
  const quote = financials.quote;
  const quoteTime = quote?.lastUpdated;
  const quoteDate = validDate(finite(quoteTime) && quoteTime > 0 ? new Date(quoteTime).toISOString() : undefined);
  if (!quoteDate || !finite(quote?.price) || quote.price <= 0) return null;
  const periods = consensusByPeriod(history.consensus);
  const currentYear = periods.get("current year");
  const nextYear = periods.get("next year");
  const eps = blendedNextTwelveMonthsEps(
    quoteDate.toISOString(),
    currentYear ? { periodEnd: currentYear.date, eps: currentYear.average } : undefined,
    nextYear ? { eps: nextYear.average } : undefined,
  );
  if (eps === null) return null;
  const basis = { date: quoteDate.toISOString(), currency: history.currency ?? financials.financialCurrency } as FinancialStatement;
  const price = currencies.priceInStatementUnits(basis, quote.price);
  if (price === null || price <= 0) return null;
  return {
    date: quoteDate,
    observedAt: quoteDate,
    availableAt: quoteDate,
    value: price / eps,
    periodLabel: "Current",
    provenance: { providerId: quote.providerId, quality: "estimated" },
  };
}

/** Price over next-twelve-months consensus EPS, one point per report date, then per observation day. */
export function forwardPeHistory(
  financials: TickerFinancials,
  currencies: ValuationCurrencyContext,
): TimeSeriesPoint[] {
  const history = financials.epsEstimates;
  if (!history) return [];
  const historical = reportDatePoints(
    financials,
    history,
    currencies,
    (row) => row.epsEstimate,
    (date) => `NTM consensus after report ${date}`,
  );
  const lastHistorical = historical.at(-1)?.date.toISOString().slice(0, 10) ?? null;
  const observed = snapshotPoints(financials, history, currencies, lastHistorical);
  const current = currentConsensusPoint(financials, history, currencies);
  const points = [...historical, ...observed];
  const lastDate = points.at(-1)?.date.getTime() ?? -Infinity;
  if (current && current.date.getTime() > lastDate) points.push(current);
  return points;
}

/** Price at each report date over the EPS reported in the following four quarters. */
export function realizedNtmPeHistory(
  financials: TickerFinancials,
  currencies: ValuationCurrencyContext,
): TimeSeriesPoint[] {
  const history = financials.epsEstimates;
  if (!history) return [];
  return reportDatePoints(
    financials,
    history,
    currencies,
    (row) => row.epsActual,
    (date) => `Next four reported quarters after ${date}`,
  );
}
