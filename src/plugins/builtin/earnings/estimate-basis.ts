import type { EarningsEstimateBasis, EarningsEstimateField, EarningsEvent } from "../../../types/data-provider";

export const EARNINGS_ESTIMATE_FIELDS: readonly EarningsEstimateField[] = [
  "epsEstimate", "epsLow", "epsHigh", "epsYearAgo", "epsGrowth", "epsAnalysts",
  "epsTrend7dAgo", "epsTrend30dAgo", "epsRevisionUp7d", "epsRevisionUp30d", "epsRevisionDown7d", "epsRevisionDown30d",
  "revenueEstimate", "revenueLow", "revenueHigh", "revenueYearAgo", "revenueGrowth", "revenueAnalysts",
];
const MONETARY_COMPARISONS = new Set<EarningsEstimateField>([
  "epsLow", "epsHigh", "epsYearAgo", "epsTrend7dAgo", "epsTrend30dAgo",
  "revenueLow", "revenueHigh", "revenueYearAgo",
]);
const RANGE_PEERS: Partial<Record<EarningsEstimateField, EarningsEstimateField>> = {
  epsLow: "epsHigh", epsHigh: "epsLow",
  revenueLow: "revenueHigh", revenueHigh: "revenueLow",
};

function finiteValue(event: EarningsEvent, field: EarningsEstimateField): number | null {
  const value = event[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sameEarningsForecast(
  left: EarningsEstimateBasis | undefined,
  right: EarningsEstimateBasis | undefined,
): boolean {
  if (!left || !right || left.source !== right.source) return false;
  if (left.source === "calendarEvents") return true;
  return !!left.period && !!left.periodEndDate
    && left.period === right.period && left.periodEndDate === right.periodEndDate;
}

/** Do not present a trend-only range/count/growth as describing a calendar fallback. */
export function coherentEarningsValue(event: EarningsEvent, field: EarningsEstimateField): number | null {
  const value = finiteValue(event, field);
  if (value == null || field === "epsEstimate" || field === "revenueEstimate") return value;
  const average = field.startsWith("eps") ? "epsEstimate" : "revenueEstimate";
  const basis = event.estimateBasis?.[field];
  if (finiteValue(event, average) == null) {
    const peer = RANGE_PEERS[field];
    const peerBasis = peer ? event.estimateBasis?.[peer] : undefined;
    if (peer && finiteValue(event, peer) != null
      && (!sameEarningsForecast(basis, peerBasis) || (basis?.currency ?? null) !== (peerBasis?.currency ?? null))) return null;
    return value;
  }
  const averageBasis = event.estimateBasis?.[average];
  if (!sameEarningsForecast(basis, averageBasis)) return null;
  if (MONETARY_COMPARISONS.has(field) && (basis?.currency ?? null) !== (averageBasis?.currency ?? null)) return null;
  return value;
}

export function earningsEpsChange30d(event: EarningsEvent): number | null {
  const current = finiteValue(event, "epsEstimate");
  const prior = finiteValue(event, "epsTrend30dAgo");
  const currentBasis = event.estimateBasis?.epsEstimate;
  const priorBasis = event.estimateBasis?.epsTrend30dAgo;
  if (current == null || prior == null || !sameEarningsForecast(currentBasis, priorBasis)
    || !currentBasis?.period || !currentBasis.periodEndDate
    || !currentBasis.currency || !/^[A-Z]{3}$/.test(currentBasis.currency) || currentBasis.currency === "XXX"
    || currentBasis.currency !== priorBasis?.currency) return null;
  return current - prior;
}

/** A single fiscal-end column must not assign one field's period to other available estimates. */
export function earningsForecastPeriod(event: EarningsEvent): { period: string; periodEndDate: string } | null {
  const bases = EARNINGS_ESTIMATE_FIELDS
    .filter(field => coherentEarningsValue(event, field) != null)
    .map(field => event.estimateBasis?.[field]);
  const first = bases[0];
  if (!first?.period || !first.periodEndDate || bases.some(basis => !sameEarningsForecast(first, basis))) return null;
  return { period: first.period, periodEndDate: first.periodEndDate };
}

/** Source-selected values after normalization; literal provider amounts remain in estimateBasis. */
export function earningsSourceEstimates(event: EarningsEvent): Record<string, number | null> {
  return Object.fromEntries(EARNINGS_ESTIMATE_FIELDS.map(field => [field, finiteValue(event, field)]));
}
