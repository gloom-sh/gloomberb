import type { GuidancePayload, KpiGuidance, KpiObservation, KpiSeries, KpiUnit, KpisPayload } from "../../../api-client/company-kpis";
import type { DataTableColumn } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import type { CompositeChartXAxis } from "../../../components/chart/composite/types";
import { formatCompact, formatNumber } from "../../../utils/format";
import { freePreviewNote } from "../shared/free-preview";
import type { CompanyMode } from "./client";

export type CompanyRow = KpiObservation | KpiGuidance;
export const isGuidance = (row: CompanyRow): row is KpiGuidance => "issuedDate" in row;
export const basisLabel = (basis: string) => ({ reported: "Reported", adjusted: "Adjusted", constant_currency: "Constant currency", organic: "Organic" })[basis] ?? basis;
export const dimensionLabel = (dimensions: Record<string, string>) => Object.entries(dimensions).sort(([a], [b]) => {
  const rank = (key: string) => ["segment", "product", "geography", "region", "cohort"].includes(key) ? 0 : key === "comparison" ? 2 : 1;
  return rank(a) - rank(b) || a.localeCompare(b);
}).map(([key, value]) => `${key.replaceAll("_", " ")}: ${value.replaceAll("_", " ")}`).join(" · ");
/** Labels that name a part of the company, shown before the basis and the qualifiers. */
const PART_KEY = /segment|product|offering|business|brand|platform|market|geograph|region|division|cloud|franchise|program|channel|line|customer|entity|scope|type|category/;
/** Labels that say how a figure is measured, shown after the basis. */
const QUALIFIER_KEY = /exclud|includ|except|without|compar|dilution|window|funded|horizon/;
const FLAG_VALUE = /^(?:true|yes|y)$/i;
const FALSE_VALUE = /^(?:false|no|n)$/i;
const EXCLUDED_VALUE = /^(?:excluded|excludes|excluding|exclusive|ex)$/i;
const INCLUDED_VALUE = /^(?:included|includes|including|inclusive)$/i;
const plain = (text: string) => text.replaceAll("_", " ").replace(/\s+/g, " ").trim();
/** One label in plain words: "Data Center", "excl. fuel", "year over year", never its key. */
function labelWords(key: string, value: string): string | null {
  const said = plain(value);
  const subject = plain(key).replace(/\b(?:excluded|excludes|excluding|exclude|without|included|includes|including|include|ex)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (!said || FALSE_VALUE.test(said)) return null;
  if (EXCLUDED_VALUE.test(said) || (FLAG_VALUE.test(said) && /exclud|without|(?:^|_)ex(?:_|$)/i.test(key))) return subject ? `excl. ${subject}` : null;
  if (INCLUDED_VALUE.test(said) || (FLAG_VALUE.test(said) && /includ/i.test(key))) return subject ? `incl. ${subject}` : null;
  if (FLAG_VALUE.test(said)) return subject || null;
  if (/^(?:exclud|except|without)/i.test(key) && !/^(?:excl|exclud|except|without|ex\b)/i.test(said)) return `excl. ${said}`;
  if (/^includ/i.test(key) && !/^incl/i.test(said)) return `incl. ${said}`;
  return said;
}
const labelRank = (key: string) => QUALIFIER_KEY.test(key) ? 2 : PART_KEY.test(key) ? 0 : 1;
/** What a series' labels name, in plain words: its parts, then its qualifiers. Empty for the company's consolidated figure. */
export function scopeWords(dimensions: Record<string, string>, which: "parts" | "qualifiers" | "all" = "all"): string {
  return Object.entries(dimensions)
    .filter(([key]) => which === "all" || (which === "qualifiers") === (labelRank(key) === 2))
    .sort(([a], [b]) => labelRank(a) - labelRank(b) || a.localeCompare(b))
    .map(([key, value]) => labelWords(key, value)).filter((words): words is string => !!words)
    .filter((words, index, list) => list.indexOf(words) === index).join(" · ");
}
/** The labels that tell a row's series apart: the server's `seriesLabels`, else (a server before them) its stored labels. */
export const seriesLabels = (row: Pick<CompanyRow, "dimensions" | "seriesLabels">) => row.seriesLabels ?? row.dimensions;
/**
 * What tells a series apart from the metric's other series, in plain words:
 * its parts, a basis other than reported, then its qualifiers.
 * "Data Center", "Adjusted · diluted", "International · Constant currency".
 */
export function seriesDetail(row: Pick<CompanyRow, "basis" | "dimensions" | "seriesLabels">): string {
  const labels = seriesLabels(row);
  return [scopeWords(labels, "parts"), row.basis === "reported" ? "" : basisLabel(row.basis), scopeWords(labels, "qualifiers")].filter(Boolean).join(" · ");
}
/** A series named in plain words: "Revenue · Data Center", for a chart's series list and a detail title. */
export const seriesName = (row: Pick<CompanyRow, "metric" | "basis" | "dimensions" | "seriesLabels">) => [row.metric.name, seriesDetail(row)].filter(Boolean).join(" · ");
const KIND_ORDER = ["quarter", "half", "ytd", "year", "instant", "other"];
const BASIS_ORDER = ["reported", "adjusted", "constant_currency", "organic"];
/** Series in reading order: by metric, the consolidated figure before its parts, reported before other bases, a quarter before its year. */
export function seriesOrder(a: CompanyRow, b: CompanyRow): number {
  const rank = (list: string[], value: string) => { const index = list.indexOf(value); return index < 0 ? list.length : index; };
  const parts = (row: CompanyRow) => scopeWords(seriesLabels(row), "parts");
  return a.metric.name.localeCompare(b.metric.name) || Number(parts(a) !== "") - Number(parts(b) !== "") || parts(a).localeCompare(parts(b))
    || rank(BASIS_ORDER, a.basis) - rank(BASIS_ORDER, b.basis) || scopeWords(seriesLabels(a), "qualifiers").localeCompare(scopeWords(seriesLabels(b), "qualifiers"))
    || rank(KIND_ORDER, a.period.kind) - rank(KIND_ORDER, b.period.kind);
}
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
function unitSuffix(row: Pick<CompanyRow, "unit" | "currency" | "dimensions">): string {
  if (row.unit === "currency") return row.currency ? ` ${row.currency}` : "";
  if (row.unit === "currency_per_share") return ` ${row.currency ?? ""}/sh`.replace(" /", " ");
  if (row.unit === "currency_per_unit" || row.unit === "volume") return ` ${unitLabel(row)}`;
  return "";
}
/** Raised reads as good news, a cut as bad, a reiteration as no news, and a New guide as itself whichever way the service reached it. */
export const directionTone = (guide: Pick<KpiGuidance, "direction" | "previousId">) => guide.direction === "raised" ? "positive" as const : guide.direction === "cut" ? "negative" as const
  : guide.direction === "withdrawn" ? "warning" as const : directionLabel(guide) === "New" ? "text" as const : "muted" as const;
/** A change is good when it moves the way the metric's owner wants it to. */
export const changeTone = (row: KpiObservation, value: number | null) => value === null || value === 0 || row.metric.favorable === "neutral" ? "muted" as const
  : (value > 0) === (row.metric.favorable === "higher") ? "positive" as const : "negative" as const;
/**
 * What a guide did against the one before it for the same period, in plain
 * words. A guide with no earlier one to set it against is New, whether it is
 * the company's first or the first for its period. The service sets a guide it
 * cannot rank (a different hedge or conditions) beside its predecessor as not
 * comparable: that one Changed, with no word for up or down.
 */
export function directionLabel(guide: Pick<KpiGuidance, "direction" | "previousId">): string {
  switch (guide.direction) {
    case "raised": return "Raised";
    case "cut": return "Lowered";
    case "reiterated": return "Maintained";
    case "mixed": return "Mixed";
    case "withdrawn": return "Withdrawn";
    case "initiated": return "New";
    case "not_comparable": return guide.previousId ? "Changed" : "New";
  }
}
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
export const fiscalLabel = (row: Pick<CompanyRow, "period">) => row.period.fiscalYear === null ? row.period.label
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
/** Columns that say nothing while every row is the company's consolidated, as-reported figure. */
export const QUIET_COLUMNS = { basis: ["Reported"], scope: ["Consolidated"] };
/** The text of a table cell as the pane draws it; the report prints the same words. */
export function companyCellText(row: CompanyRow, column: string, observations: KpiObservation[]): string {
  const guide = isGuidance(row) ? row : null;
  if (column === "change") return guide ? directionLabel(guide) : changeText(observationChange(row as KpiObservation, observations));
  return column === "metric" ? row.metric.name : column === "period" ? fiscalLabel(row) : column === "value" ? `${guide ? rangeText(guide) : observationValue(row as KpiObservation)}${guide?.status === "withdrawn" || guide?.hedge === "qualitative" ? "" : unitSuffix(row)}`
    : column === "unit" ? unitLabel(row)
    : column === "basis" ? basisLabel(row.basis) : column === "scope" ? dimensionLabel(row.dimensions) || "Consolidated"
    : column === "issued" ? guide?.issuedDate ?? "--" : column === "actual" ? guide?.actual ? `${valueText(row, guide.actual.value)}${unitSuffix(row)}` : "--"
    : column === "outcome" ? guide ? outcomeLabel(guide) : "--" : column === "published" ? row.evidence[0]!.publishedAt.slice(0, 10)
    : column === "confidence" ? `${Math.round(row.confidence * 100)}%` : column === "revision" ? `${row.revision} ${row.current ? "current" : "superseded"}` : row.evidence[0]!.quote;
}
/**
 * The table's columns. `named` is the desktop's: the metric cell names the
 * series in plain words (seriesDetail), so no basis or scope column repeats it.
 */
export function companyColumns(guidance: boolean, evidence: boolean, history: boolean, trend = false, named = false): DataTableColumn[] {
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
      { id: "revision", label: "Revision", width: 12, align: "left" as const }, { id: "quote", label: "Evidence", width: 54, align: "left" as const }] : []),
  ];
  const order = evidence ? ["metric", "period", "quote", "published", "confidence", "revision", "value", "basis", "scope", "issued", "change"]
    : history ? ["metric", "period", "actual", "outcome", "value", "issued", "change", "basis", "scope"] : null;
  const shown = named ? columns.filter((column) => column.id !== "basis" && column.id !== "scope") : columns;
  return order ? shown.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : shown;
}

/** Cells a column gives up on a narrow pane, before any column is dropped: a date needs 10, a range about 19. */
const NARROW_WIDTHS: Record<string, number> = { value: 19, change: 11, issued: 10, actual: 12, outcome: 9, basis: 12, scope: 18 };
/** The metric keeps at least this much: a name such as "Revenue growth", and its series detail only when there is room. */
const METRIC_FLOOR = 14;

/**
 * The table's columns at a pane `width` in cells, so none is cut at the right edge.
 * A table that already fits is left as it is. Otherwise the columns take their
 * narrow widths, and the metric, which flexes, keeps what is left down to its
 * floor. Below that a column whose meaning is in the detail goes (Action in History,
 * where the outcome says it, then Issued), never one that names the row. A table that
 * cannot fit even so keeps its narrow widths and scrolls sideways, as it always has.
 */
export function fitCompanyColumns(columns: readonly DataTableColumn[], width: number, history = false): DataTableColumn[] {
  const room = width - 1;
  if (getTableWidth(columns) <= room) return [...columns];
  const narrow = (list: readonly DataTableColumn[]) => list.map((column) => column.id in NARROW_WIDTHS ? { ...column, width: Math.min(column.width, NARROW_WIDTHS[column.id]!) } : column);
  const attempt = (list: readonly DataTableColumn[]): DataTableColumn[] | null => {
    const tight = narrow(list);
    const metric = tight.find((column) => column.id === "metric");
    if (!metric) return getTableWidth(tight) <= room ? tight : null;
    const fitted = Math.min(metric.width, room - (getTableWidth(tight) - tableColumnWidth(metric)));
    return fitted >= METRIC_FLOOR ? tight.map((column) => column === metric ? { ...column, width: fitted } : column) : null;
  };
  let shown = [...columns];
  for (const drop of [null, ...(history ? ["change", "issued"] : ["issued"])]) {
    if (drop) shown = shown.filter((column) => column.id !== drop);
    const fitted = attempt(shown);
    if (fitted) return fitted;
  }
  return narrow(columns);
}

/** Companies to point an empty pane at, one that has data and one for when the pane is for the first. */
const EXAMPLE_COMPANIES: Record<CompanyMode, readonly string[]> = { guidance: ["WMT", "DAL"], kpis: ["AAPL", "NVDA"] };

/**
 * What an empty table says. A company with nothing on file for the function says so
 * plainly and names one that has some; a selection or tab that narrows what the company
 * has says what is missing from it. `cli` types `fn GUIDE WMT`, the app's command bar `GUIDE WMT`.
 */
export function companyEmptyState(mode: CompanyMode, symbol: string, view: { tab: string; hasRows: boolean }, surface: "cli" | "pane" = "pane"): { title: string; hint?: string } {
  if (view.hasRows) return { title: view.tab === "history" ? "Actuals have not been matched to these guidance periods yet." : "No disclosed observations for this selection yet." };
  const examples = EXAMPLE_COMPANIES[mode];
  const example = examples.find((candidate) => candidate !== symbol.trim().toUpperCase()) ?? examples[0]!;
  const command = `${mode === "kpis" ? "KPIS" : "GUIDE"} ${example}`;
  return { title: `No ${mode === "kpis" ? "KPIs" : "guidance"} on file for ${symbol}.`, hint: `Try ${surface === "cli" ? `\`fn ${command}\`` : command}.` };
}

/** What a missing KPI means, as KPIS states it among its limitations and EQS beside a KPI column with gaps. */
export const KPI_COVERAGE_NOTE = "Coverage follows available company disclosures; missing data is not zero.";

/**
 * Why Free shows no value of a metric, in the same words in `fn KPIS`, `fn GUIDE` and EQS: "Order backlog is not
 * among the 3 free KPI values; Gloom Pro shows all 63." With no free value at all, `where` says which free view
 * shows none; without a total (EQS counts no company's disclosures), Pro shows each company's metric.
 */
export function kpiFreeLimitNote({ metric, shown, total, guidance = false, where = "The free preview" }: {
  /** The metric's name: "Order backlog", "Backlog". */
  metric: string;
  /** How many values Free shows. */
  shown: number;
  /** How many Gloom Pro shows, when the response says. */
  total: number | null;
  guidance?: boolean;
  where?: string;
}): string {
  const count = (value: number) => value.toLocaleString("en-US");
  const noun = (value: number) => `${guidance ? "guidance figure" : "KPI value"}${value === 1 ? "" : "s"}`;
  const pro = total == null ? `Gloom Pro shows each company's ${metric}` : `Gloom Pro shows all ${count(total)}`;
  return shown === 0 ? `${where} shows no ${noun(0)}; ${pro}.`
    : `${metric} is not ${shown === 1 ? "the" : "among the"} ${count(shown)} free ${noun(shown)}; ${pro}.`;
}

/** The lock line of a free preview, in the same words in the pane and `fn KPIS` / `fn GUIDE`. */
export function companyPreviewNote(data: Pick<KpisPayload, "lockedRows" | "totalRows" | "coverage">, guidance: boolean): string {
  const count = (value: number) => value.toLocaleString("en-US");
  const rows = `${count(data.totalRows)} ${guidance ? "guidance figures" : "KPI values"}`;
  return freePreviewNote({ shows: data.lockedRows > 0 ? `${count(Math.max(0, data.totalRows - data.lockedRows))} of ${rows}` : rows,
    adds: data.lockedRows > 0 ? `the other ${count(data.lockedRows)}` : null, historyFrom: data.coverage.firstPeriod });
}
