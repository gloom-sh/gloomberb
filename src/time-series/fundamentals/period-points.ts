// Turns a statement into a dated series point, and keeps one point per financial period.
import type { FinancialStatement } from "../../types/financials";
import { areNearbyFinancialPeriodEnds } from "../../utils/financial-statements";
import { statementPeriodLabel, ttmPeriodLabel } from "../../utils/fiscal-period";
import { hasStatementGap } from "../../utils/statement-gaps";
import type { SecuritySeriesSource, TimeSeriesPoint } from "../types";
import { validDate } from "./statement";
import { metricAvailability } from "./statement-fields";

export function pointForStatement(
  statement: FinancialStatement,
  metric: string,
  value: number | null,
  period: "annual" | "quarterly" | "ttm",
  timestampMode: SecuritySeriesSource["timestampMode"],
  derived: boolean,
  /** The month the issuer's fiscal year ends; null names the period by its end date. */
  yearEndMonth: number | null,
): TimeSeriesPoint | null {
  const observedAt = validDate(statement.date);
  if (!observedAt) return null;
  // A missing metric is known to be unavailable with its statement. It has
  // no metric-specific publication date to substitute for that boundary.
  const availableAtString = metricAvailability(statement, metric)
    ?? (value === null ? statement.availableAt : undefined);
  const availableAt = validDate(availableAtString);
  const date = timestampMode !== "period-end" && availableAt ? availableAt : observedAt;
  return {
    date,
    observedAt,
    availableAt: availableAt ?? undefined,
    value,
    // Providers do not supply a reliable issuer fiscal-year/quarter identity.
    // Calendar-month numbering would mislabel non-calendar fiscal years.
    periodLabel: `${period === "annual" ? "Year" : period === "ttm" ? "TTM" : "Quarter"} ended ${statement.date}`,
    // The period as FA's columns name it (`Q3 FY26`, a filled half `H1 FY26`), which the legend prints beside the value.
    fiscalPeriod: period === "ttm" ? ttmPeriodLabel(statement.date, yearEndMonth) : statementPeriodLabel(statement, period, yearEndMonth),
    provenance: {
      quality: derived || (metric === "eps" && statement.epsBasis?.factor !== undefined && statement.epsBasis.factor !== 1) ? "derived" : "reported",
      ...((metric === "eps" || metric === "trailingPE") && statement.epsBasis ? { secEpsBasis: statement.epsBasis } : {}),
      ...((metric === "eps" || metric === "trailingPE") && hasStatementGap(statement, "eps")
        ? { unavailableEarnings: ["eps" as const] } : {}),
      currency: statement.currency,
    },
  };
}

function preferredPeriodPoint(
  existing: TimeSeriesPoint,
  candidate: TimeSeriesPoint,
): TimeSeriesPoint {
  if (existing.provenance?.quality !== candidate.provenance?.quality) {
    return candidate.provenance?.quality === "reported" ? candidate : existing;
  }
  const existingAvailableAt = existing.availableAt?.getTime();
  const candidateAvailableAt = candidate.availableAt?.getTime();
  const existingHasAvailability = Number.isFinite(existingAvailableAt);
  const candidateHasAvailability = Number.isFinite(candidateAvailableAt);
  if (existingHasAvailability !== candidateHasAvailability) {
    return candidateHasAvailability ? candidate : existing;
  }
  if (
    existingHasAvailability
    && candidateHasAvailability
    && candidateAvailableAt! !== existingAvailableAt!
  ) {
    const preferLater = !Object.is(existing.value, candidate.value);
    const candidateWins = preferLater
      ? candidateAvailableAt! > existingAvailableAt!
      : candidateAvailableAt! < existingAvailableAt!;
    return candidateWins ? candidate : existing;
  }
  return candidate.observedAt.getTime() < existing.observedAt.getTime()
    ? candidate
    : existing;
}

/**
 * Provider snapshots can contain both an issuer fiscal-period row and a
 * calendar-normalized row for the same observation. Their period ends and
 * display timestamps differ slightly, so timestamp-only deduplication renders
 * paired bars. A financial period is the observation identity; publication
 * time only decides when that observation became available.
 */
export function dedupeFundamentalPeriods(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  const groups: TimeSeriesPoint[][] = [];
  const sorted = [...points].sort((left, right) => (
    left.observedAt.getTime() - right.observedAt.getTime()
  ));
  for (const point of sorted) {
    const lastGroup = groups.at(-1);
    if (lastGroup && areNearbyFinancialPeriodEnds(lastGroup[0]!.observedAt, point.observedAt)
      && (lastGroup[0]!.observedAt.getTime() === point.observedAt.getTime()
        || ![point, ...lastGroup].some(item => item.provenance?.unavailableEarnings?.length))) {
      lastGroup.push(point);
    } else groups.push([point]);
  }
  return groups
    .map((group) => group.slice(1).reduce(preferredPeriodPoint, group[0]!))
    .sort((left, right) => (
      left.date.getTime() - right.date.getTime()
      || left.observedAt.getTime() - right.observedAt.getTime()
    ));
}
