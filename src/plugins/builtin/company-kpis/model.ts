import type { GuidancePayload, KpiGuidance, KpiObservation, KpiSeries, KpiUnit, KpisPayload } from "../../../api-client/company-kpis";
import type { DataTableColumn } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { CompositeChartXAxis } from "../../../components/chart/composite/types";
import { formatCompact, formatNumber } from "../../../utils/format";

export type CompanyRow = KpiObservation | KpiGuidance;
export const isGuidance = (row: CompanyRow): row is KpiGuidance => "issuedDate" in row;
export const basisLabel = (basis: string) => ({ reported: "Reported", adjusted: "Adjusted", constant_currency: "Constant currency", organic: "Organic" })[basis] ?? basis;
export const dimensionLabel = (dimensions: Record<string, string>) => Object.entries(dimensions).sort(([a], [b]) => {
  const rank = (key: string) => ["segment", "product", "geography", "region", "cohort"].includes(key) ? 0 : key === "comparison" ? 2 : 1;
  return rank(a) - rank(b) || a.localeCompare(b);
}).map(([key, value]) => `${key.replaceAll("_", " ")}: ${value.replaceAll("_", " ")}`).join(" · ");
export const unitLabel = (row: Pick<CompanyRow, "unit" | "currency" | "dimensions">) => ({
  currency: row.currency ?? "Currency", currency_per_share: `${row.currency ?? "Currency"}/share`, currency_per_unit: `${row.currency ?? "Currency"}/${row.dimensions.unit ?? "unit"}`,
  percent: "%", basis_points: "bp", count: "Count", ratio: "x", volume: row.dimensions.unit ?? "Volume",
})[row.unit];
function numberText(value: number | null | undefined, unit: KpiUnit, withUnit = true): string {
  if (value == null) return "--";
  const number = Math.abs(value) >= 10_000 ? formatCompact(value, { fixedDecimals: true }) : formatNumber(value, Number.isInteger(value) ? 0 : 2);
  return `${number}${!withUnit ? "" : unit === "percent" ? "%" : unit === "basis_points" ? "bp" : unit === "ratio" ? "x" : ""}`;
}
export const exactObservation = (row: KpiObservation) => !row.valueQualifier || row.valueQualifier === "exact";
export const observationValue = (row: KpiObservation, withUnit = true) => `${({ exact: "", approximately: "≈ ", at_least: "≥ ", at_most: "≤ ", greater_than: "> ", less_than: "< " })[row.valueQualifier ?? "exact"]}${numberText(row.value, row.unit, withUnit)}`;
export const valueText = (row: CompanyRow, value: number | null, withUnit = true) => numberText(value, row.unit, withUnit);
export const rangeText = (row: KpiGuidance, withUnit = true) => row.status === "withdrawn" ? "Withdrawn" : row.hedge === "qualitative" ? row.rangeText
  : row.point !== null ? `${({ approximately: "≈ ", at_least: "≥ ", at_most: "≤ ", greater_than: "> ", less_than: "< " } as Record<string, string>)[row.hedge] ?? ""}${valueText(row, row.point, withUnit)}`
  : row.low !== null && row.high !== null ? `${row.hedge === "approximately" ? "≈ " : ""}${valueText(row, row.low, withUnit)} – ${valueText(row, row.high, withUnit)}`
  : row.low !== null ? `${row.hedge === "greater_than" ? ">" : "≥"} ${valueText(row, row.low, withUnit)}`
  : row.high !== null ? `${row.hedge === "less_than" ? "<" : "≤"} ${valueText(row, row.high, withUnit)}` : row.rangeText;
/** The unit a value cell carries after its number; percent, bp and x are already in the number. */
export function unitSuffix(row: Pick<CompanyRow, "unit" | "currency" | "dimensions">): string {
  if (row.unit === "currency") return row.currency ? ` ${row.currency}` : "";
  if (row.unit === "currency_per_share") return ` ${row.currency ?? ""}/sh`.replace(" /", " ");
  if (row.unit === "currency_per_unit" || row.unit === "volume") return ` ${unitLabel(row)}`;
  return "";
}
/** Raised reads as good news, a cut as bad, a reiteration as no news. */
export const directionTone = (direction: KpiGuidance["direction"]) => direction === "raised" ? "positive" as const : direction === "cut" ? "negative" as const
  : direction === "withdrawn" ? "warning" as const : direction === "initiated" ? "text" as const : "muted" as const;
/** A change is good when it moves the way the metric's owner wants it to. */
export const changeTone = (row: KpiObservation, value: number | null) => value === null || value === 0 || row.metric.favorable === "neutral" ? "muted" as const
  : (value > 0) === (row.metric.favorable === "higher") ? "positive" as const : "negative" as const;
export const directionLabel = (direction: KpiGuidance["direction"]) => direction === "not_comparable" ? "Not comparable" : direction.charAt(0).toUpperCase() + direction.slice(1);
export const outcomeLabel = (row: KpiGuidance) => !row.actual ? "Pending" : row.actual.favorable === "in_line" ? "In range"
  : row.actual.favorable === "neutral" ? row.actual.outcome === "above" ? "Above" : row.actual.outcome === "below" ? "Below" : "In range"
  : row.actual.favorable === "beat" ? "Beat" : "Miss";
export const seriesLabel = (series: Pick<KpiSeries, "metric" | "basis" | "dimensions" | "unit" | "currency">) =>
  `${series.metric.name} · ${basisLabel(series.basis)} · ${unitLabel(series)}${Object.keys(series.dimensions).length ? ` · ${dimensionLabel(series.dimensions)}` : ""}`;
export const guideGroupKey = (row: KpiGuidance) => JSON.stringify([row.seriesKey, row.period.start, row.period.end, row.period.kind, row.period.fiscalYear, row.period.fiscalQuarter, row.period.end === null && (row.period.fiscalYear === null || row.period.kind !== "year" && row.period.fiscalQuarter === null) ? row.period.label.toLocaleLowerCase() : null]);
export function allObservations(data: KpisPayload): KpiObservation[] {
  return [...new Map([...data.series.flatMap((series) => series.observations), ...data.revisions].map((row) => [row.id, row])).values()];
}
export function allGuidance(data: GuidancePayload): KpiGuidance[] {
  return [...new Map([...data.guidance, ...data.history].map((row) => [row.id, row])).values()];
}
export function observationChange(row: KpiObservation, observations: KpiObservation[]): { value: number | null; unit: string } {
  const fiscalOrder = (item: KpiObservation) => item.period.fiscalYear !== null && (item.period.kind === "year" || item.period.fiscalQuarter !== null)
    ? item.period.fiscalYear * 4 + (item.period.fiscalQuarter ?? 0) : null;
  const previousPeriod = (other: KpiObservation) => other.period.end && row.period.end ? other.period.end < row.period.end
    : fiscalOrder(other) !== null && fiscalOrder(row) !== null && fiscalOrder(other)! < fiscalOrder(row)!;
  const prior = observations.filter((other) => other.id !== row.id && other.current && !other.conflict && !other.contested && exactObservation(other) && other.seriesKey === row.seriesKey
    && other.period.kind === row.period.kind && previousPeriod(other)).sort((a, b) => periodOrder(b).localeCompare(periodOrder(a)))[0];
  if (!prior || (row.conflict || row.contested) || !exactObservation(row)) return { value: null, unit: "" };
  if (row.unit === "percent") return { value: row.value - prior.value, unit: "pp" };
  if (row.unit === "basis_points") return { value: row.value - prior.value, unit: "bp" };
  if (prior.value === 0) return { value: null, unit: "%" };
  return { value: (row.value - prior.value) / Math.abs(prior.value) * 100, unit: "%" };
}
export const changeText = (change: { value: number | null; unit: string }) => change.value === null ? "--" : `${change.value > 0 ? "+" : ""}${formatNumber(change.value, 2)}${change.unit}`;
export const fiscalLabel = (row: CompanyRow) => row.period.fiscalYear === null ? row.period.label
  : row.period.kind === "year" ? `FY${row.period.fiscalYear}`
  : row.period.fiscalQuarter !== null ? `Q${row.period.fiscalQuarter} FY${row.period.fiscalYear}${row.period.kind === "ytd" ? " YTD" : ""}` : row.period.label;
export const periodOrder = (row: CompanyRow) => row.period.fiscalYear !== null
  ? `${row.period.fiscalYear}:${row.period.fiscalQuarter ?? 0}:${row.period.end ?? ""}` : row.period.end ?? row.period.label;
export function observationChart(rows: KpiObservation[], color: string) {
  const valid = rows.filter((row) => row.current && !row.conflict && !row.contested && exactObservation(row));
  const categorical = valid.some((row) => !row.period.end);
  const values = valid.filter((row) => !categorical || row.period.fiscalYear !== null && (row.period.kind === "year" || row.period.fiscalQuarter !== null))
    .sort((a, b) => periodOrder(a).localeCompare(periodOrder(b)));
  const dates = new Map<string, Date>();
  // These are positions in the plotting API, never calendar dates: both axis and cursor
  // are replaced with fiscal labels, and the captured/source observation retains end:null.
  values.forEach((row, index) => dates.set(row.id, categorical ? new Date(index * 30 * 86_400_000) : new Date(row.period.end!)));
  const first = values[0];
  const compatible = first && values.every((row) => row.seriesKey === first.seriesKey && row.period.kind === first.period.kind);
  const series = values.length >= 2 && compatible ? [staticSeries(values.map((row) => scalarPoint(dates.get(row.id)!, row.value)),
    { id: `${first.seriesKey}:${first.period.kind}`, label: `${first.metric.name} (${first.period.kind})`, color, calendarSpaced: true })] : [];
  const xAxis: CompositeChartXAxis | undefined = categorical ? {
    ticks: values.map((row, index) => ({ ratio: index / Math.max(1, values.length - 1), label: fiscalLabel(row) })),
    formatCursor: (ratio) => values[Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))))] ? fiscalLabel(values[Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))))]!) : "",
  } : undefined;
  return { series, dates, xAxis, ...(categorical && first ? { viewport: { start: dates.get(first.id)!, end: dates.get(values.at(-1)!.id)! } } : {}) };
}
export function guidanceSeries(rows: KpiGuidance[], selected: KpiGuidance | undefined, colors: { low: string; high: string; actual: string }) {
  if (!selected) return [];
  const compatible = rows.filter((row) => guideGroupKey(row) === guideGroupKey(selected) && row.status === "active")
    .sort((a, b) => a.issuedDate.localeCompare(b.issuedDate) || a.asOf.localeCompare(b.asOf));
  const timeline = [...new Map(compatible.map((row) => [row.issuedDate, row])).values()];
  if (timeline.length < 2) return [];
  const spec = [{ id: "low", label: "Guide low", color: colors.low }, { id: "high", label: "Guide high", color: colors.high }, { id: "point", label: "Point guide", color: colors.high }] as const;
  const series = spec.flatMap((field) => timeline.filter((row) => row[field.id] !== null).length < 2 ? [] : [staticSeries(timeline.map((row) => scalarPoint(new Date(row.issuedDate), row[field.id])), { ...field, calendarSpaced: true })]);
  const actual = selected.actual;
  if (actual && series.length) series.push(staticSeries(timeline.map((row) => scalarPoint(new Date(row.issuedDate), actual.value)), { id: "actual", label: "Later actual", color: colors.actual, calendarSpaced: true }));
  return series;
}
export function companyColumns(guidance: boolean, evidence: boolean, history: boolean, trend = false): DataTableColumn[] {
  const columns: DataTableColumn[] = [
    { id: "metric", label: "Metric", width: 27, flexGrow: 1, align: "left" },
    { id: "period", label: "Fiscal period", width: 14, align: "left" },
    { id: "value", label: guidance ? "Guide" : "Value", width: guidance ? 26 : 16, align: "right" },
    { id: "change", label: guidance ? "Action" : "Prior change", width: 13, align: "right" },
    ...(trend ? [{ id: "trend", label: "Trend", width: 16, align: "left" as const }] : []),
    ...(guidance ? [{ id: "issued", label: "Issued", width: 11, align: "left" as const },
      ...(history ? [{ id: "actual", label: "Actual", width: 16, align: "right" as const }, { id: "outcome", label: "Outcome", width: 10, align: "left" as const }] : [])] : []),
    { id: "basis", label: "Basis", width: 18, align: "left" },
    { id: "scope", label: "Scope", width: 24, align: "left" },
    ...(evidence ? [{ id: "published", label: "Published", width: 11, align: "left" as const }, { id: "confidence", label: "Confidence", width: 11, align: "right" as const },
      { id: "revision", label: "Revision", width: 12, align: "left" as const }, { id: "quote", label: "Evidence", width: 65, align: "left" as const }] : []),
  ];
  const order = evidence ? ["metric", "period", "quote", "published", "confidence", "revision", "value", "basis", "scope", "issued", "change"]
    : history ? ["metric", "period", "actual", "outcome", "value", "issued", "change", "basis", "scope"] : null;
  return order ? columns.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : columns;
}
