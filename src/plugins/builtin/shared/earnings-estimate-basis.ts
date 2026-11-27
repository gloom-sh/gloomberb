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

function sameEarningsForecast(
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
