import type { CatalystEvent } from "../../../api-client/catalysts";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";

export function enrollmentValue(event: CatalystEvent): number | null {
  const value = event.metadata?.enrollment;
  return event.type === "clinical" && typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function enrollmentBasis(event: CatalystEvent): string {
  const value = event.metadata?.enrollmentType;
  return typeof value === "string" && value.trim() ? value.toLowerCase() : "unreported basis";
}
/** Stored observation times only; absent enrollment remains a gap and estimates stay separate from actual counts. */
export function enrollmentSeries(history: readonly CatalystEvent[], colors: { textBright: string; warning: string; positive: string }): ResolvedSeries[] {
  const dated = [...history].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.revision - b.revision);
  const byDate = new Map<string, CatalystEvent>();
  for (const event of dated) byDate.set(event.observedAt, event);
  const rows = [...byDate.values()];
  if (rows.filter((event) => enrollmentValue(event) !== null).length < 2) return [];
  const bases = [...new Set(rows.filter((event) => enrollmentValue(event) !== null).map(enrollmentBasis))];
  return bases.map((basis) => ({
    ...staticSeries(rows.map((event) => ({ date: new Date(event.observedAt), observedAt: new Date(event.observedAt), value: enrollmentBasis(event) === basis ? enrollmentValue(event) : null })),
      { id: `enrollment:${basis}`, label: `${basis === "unreported basis" ? "Reported" : basis[0]!.toUpperCase() + basis.slice(1)} enrollment`, color: basis === "actual" ? colors.positive : basis === "estimated" ? colors.warning : colors.textBright, style: "step", calendarSpaced: true }),
    unit: "participants", unitGroup: "trial-enrollment", interpolation: "step-after" as const,
  }));
}
