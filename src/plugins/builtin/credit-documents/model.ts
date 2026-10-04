import type { CreditDocumentsPayload, CreditFact, CreditHeadroom, CreditInstrument, CreditMaturityBucket, CreditScreenRow, CreditValue } from "../../../api-client/credit-documents";
import type { DataTableColumn, StatItem } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { getTableWidth } from "../../../components/ui/table-layout";
import type { ResolvedSeries } from "../../../time-series/types";
import { displayWidth } from "../../../utils/format";

export const CREDIT_TABS = [{ value: "capital", label: "Capital" }, { value: "covenants", label: "Covenants" }, { value: "maturities", label: "Maturities" }, { value: "screen", label: "Screen" }] as const;
export type CreditTab = typeof CREDIT_TABS[number]["value"];
export const creditTab = (value: unknown): CreditTab => CREDIT_TABS.find((tab) => tab.value === value)?.value ?? "capital";
/** `maintenance_covenant` and `adjustmentReason` both read as words. */
export const fieldLabel = (field: string) => field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/^./, (value) => value.toUpperCase());
/** The one placeholder for a value the documents do not support. */
export const NO_VALUE = "--";
export const sentence = (value: string) => value.replace(/^./, (first) => first.toUpperCase());
export const creditAmount = (value: number | null | undefined): string => value == null ? NO_VALUE : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
export const creditPercent = (value: number | null | undefined): string => value == null ? NO_VALUE : `${value.toFixed(1)}%`;
function creditValue(value: CreditValue): string {
  if (value === null) return "Not disclosed";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(creditValue).join("; ");
  if (typeof value === "object") return Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => `${fieldLabel(name)}: ${creditValue(item)}`).join(" · ");
  return String(value);
}
type Fields = { [key: string]: CreditValue };
const fields = (value: CreditValue | undefined): Fields | null => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const words = (value: CreditValue | undefined) => typeof value === "string" && value.trim() ? value.trim() : null;
const finite = (value: CreditValue | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
export const comparatorSymbol = (comparator: CreditValue | undefined, inclusive?: CreditValue) =>
  comparator === "maximum" ? inclusive === false ? "<" : "≤" : comparator === "minimum" ? inclusive === false ? ">" : "≥" : "";
const unitSuffix = (unit: string | null) => unit === "percent" || unit === "%" ? "%" : unit === "bps" ? "bp" : unit === "ratio" || unit === "times" ? "x" : "";

/** One line for a structured term, so a table cell reads as the term and not as its keys. */
function structuredSummary(fact: CreditFact): string | null {
  const value = fields(fact.value);
  if (!value) return null;
  const metric = words(value.metric);
  switch (fact.field) {
    case "maintenance_covenant": {
      const threshold = finite(value.threshold);
      return metric && threshold !== null ? [sentence(metric), comparatorSymbol(value.comparator, value.inclusive), `${threshold}${unitSuffix(fact.unit)}`].filter(Boolean).join(" ") : null;
    }
    case "reported_metric": {
      const reported = finite(value.value);
      return metric && reported !== null ? `${sentence(metric)} ${reported}${unitSuffix(fact.unit)}${words(value.periodEnd) ? ` at ${value.periodEnd}` : ""}` : null;
    }
    case "springing_maturity": return words(value.date) ? [value.date, words(value.condition)].filter(Boolean).join(" · ") : null;
    case "change_of_control": {
      const put = finite(value.putPercent);
      return [put === null ? null : `Put at ${put}%`, words(value.trigger)].filter(Boolean).join(" · ") || null;
    }
  }
  const low = finite(value.minimum), high = finite(value.maximum);
  return low !== null && high !== null ? [`${low}–${high}${unitSuffix(fact.unit)}`, words(value.condition)].filter(Boolean).join(" · ") : null;
}
export function factValue(fact: CreditFact): string {
  if (typeof fact.value === "number" && ["percent", "%"].includes(fact.unit ?? "")) return `${fact.value}%`;
  const summary = structuredSummary(fact);
  if (summary) return summary;
  const value = typeof fact.value === "number" && fact.currency ? creditAmount(fact.value) : typeof fact.value === "string" ? sentence(fact.value) : creditValue(fact.value);
  return [value, fact.currency ?? fact.unit].filter(Boolean).join(" ");
}

export interface CreditTermField { label: string; value: string; detail?: string }
/** A covenant rule as its parts; the definition and the reason it cannot be computed read as prose. */
export function covenantTerms(fact: CreditFact): { fields: CreditTermField[]; definition: string | null; reason: string | null } | null {
  const rule = fields(fact.value);
  if (fact.field !== "maintenance_covenant" || !rule) return null;
  const threshold = finite(rule.threshold);
  const steps = Array.isArray(rule.stepDowns) ? rule.stepDowns.flatMap((step) => {
    const entry = fields(step), date = words(entry?.date), level = finite(entry?.threshold);
    return date && level !== null ? [`${comparatorSymbol(rule.comparator, rule.inclusive)} ${covenantNumber(level, fact)} from ${date}`] : [];
  }) : [];
  const numerator = words(rule.numeratorMetric), denominator = words(rule.denominatorMetric);
  const rows: Array<CreditTermField | null> = [
    words(rule.metric) ? { label: "Metric", value: sentence(words(rule.metric)!) } : null,
    threshold === null ? null : { label: "Threshold", value: `${comparatorSymbol(rule.comparator, rule.inclusive)} ${covenantNumber(threshold, fact)}`.trim(),
      detail: [words(rule.comparator), rule.inclusive === false ? "strict" : null].filter(Boolean).join(", ") || undefined },
    numerator && denominator ? { label: "Ratio", value: `${sentence(numerator)} / ${denominator}` } : null,
    { label: "Test date", value: words(rule.testDate) ?? NO_VALUE, detail: words(rule.frequency) ?? undefined },
    words(rule.scope) ? { label: "Scope", value: sentence(words(rule.scope)!) } : null,
    steps.length ? { label: "Step-downs", value: steps.join("; ") } : null,
    typeof rule.springing === "boolean" ? { label: "Springing", value: rule.springing ? "Yes" : "No" } : null,
    rule.computable === false ? { label: "Headroom", value: "Not computable" } : null,
  ];
  const definition = words(rule.definition);
  return { fields: rows.filter((row): row is CreditTermField => !!row), definition: definition && sentence(definition), reason: rule.computable === false ? words(rule.adjustmentReason) : null };
}
/** Any other structured value, one labelled row per disclosed key. */
export function structuredFields(fact: CreditFact): CreditTermField[] | null {
  const value = fields(fact.value);
  return value ? Object.entries(value).filter(([, item]) => item !== null && !(Array.isArray(item) && !item.length))
    .map(([name, item]) => ({ label: fieldLabel(name), value: typeof item === "string" ? sentence(item) : creditValue(item) })) : null;
}

function instrumentFact(row: CreditInstrument, field: string): CreditFact | undefined {
  return row.facts.find((fact) => fact.field === field);
}
const CLOSED = new Set(["repaid", "redeemed", "terminated", "cancelled", "matured"]);
export const isClosed = (row: CreditInstrument) => !!row.lifecycle && CLOSED.has(row.lifecycle);
/** What is owed now: a revolver's drawn balance, otherwise outstanding principal. */
export const instrumentOutstanding = (row: CreditInstrument) => row.drawn ?? row.principal;
const creditCoupon = (row: CreditInstrument) => {
  const coupon = instrumentFact(row, "coupon"), margin = instrumentFact(row, "margin"), reference = instrumentFact(row, "reference_rate");
  return coupon ? factValue(coupon) : [reference ? creditValue(reference.value) : null, margin ? factValue(margin) : null].filter(Boolean).join(" + ") || NO_VALUE;
};
const rankText = (row: CreditInstrument) => {
  const fact = instrumentFact(row, "ranking") ?? instrumentFact(row, "security");
  return fact ? sentence(creditValue(fact.value)) : NO_VALUE;
};
/** Ranking and security are free text; only a plain "secured" or "unsecured" classifies a line. */
function securityClass(row: CreditInstrument): "secured" | "unsecured" | null {
  const text = ["ranking", "security"].map((field) => { const fact = instrumentFact(row, field); return fact ? creditValue(fact.value).toLowerCase() : ""; }).join(" ");
  return /\bunsecured\b/.test(text) ? "unsecured" : /\bsecured\b/.test(text) ? "secured" : null;
}
export const screenRowId = (row: CreditScreenRow) => `${row.symbol}:${row.instrumentId}:${row.kind}:${row.date ?? ""}:${row.reason}`;
/** Wall currencies, the one with the most instruments first so the wall opens on the issuer's main debt. */
export function creditCurrencies(data: CreditDocumentsPayload): string[] {
  const count = (currency: string) => sum(data.maturities.filter((row) => row.currency === currency).map((row) => row.instruments.length));
  return [...new Set(data.maturities.map((row) => row.currency))].sort((a, b) => count(b) - count(a) || a.localeCompare(b));
}
/** A native-currency wall: never add USD, EUR and JPY amounts together. */
export function creditMaturityRows(data: CreditDocumentsPayload, currency: string): CreditMaturityBucket[] {
  return data.maturities.filter((row) => row.currency === currency).sort((a, b) => a.year - b.year);
}
export function maturitySeries(rows: readonly CreditMaturityBucket[], currency: string, color: string): ResolvedSeries[] {
  if (!rows.length) return [];
  const points = [scalarPoint(new Date(Date.UTC(rows[0]!.year-1, 6, 1)), null), ...rows.map((row) => scalarPoint(new Date(Date.UTC(row.year, 0, 1)), row.principal)), scalarPoint(new Date(Date.UTC(rows.at(-1)!.year, 6, 1)), null)];
  return [{ ...staticSeries(points, { id: "credit-principal", label: `Principal due (${currency})`, color, style: "columns", calendarSpaced: true }), unit: currency, unitGroup: currency }];
}

/** Below this headroom a covenant is close enough to its limit to flag. */
const LOW_HEADROOM = 20;
export const headroomTone = (row: Pick<CreditHeadroom, "headroomPercent" | "status">): "negative" | "warning" | undefined =>
  row.headroomPercent == null ? undefined : row.status === "breach" || row.headroomPercent < 0 ? "negative" : row.headroomPercent < LOW_HEADROOM ? "warning" : undefined;
/** How much of the limit the reported metric uses: 1 sits on the threshold, above 1 is past it. */
export function covenantUsage(row: Pick<CreditHeadroom, "headroomPercent" | "comparator">): number | null {
  if (row.headroomPercent == null) return null;
  const headroom = row.headroomPercent / 100;
  return row.comparator === "maximum" ? 1 - headroom : headroom <= -1 ? Number.POSITIVE_INFINITY : 1 / (1 + headroom);
}

const YEAR_MS = 365.25 * 86_400_000;
/**
 * The capital structure in figures, measured at the disclosure date. Amounts are
 * added only within one currency, and a figure the documents cannot support is
 * left out. A preview holds part of the structure, so it has no totals.
 */
export function capitalFigures(data: CreditDocumentsPayload): StatItem[] {
  if (data.access === "preview") return [];
  const live = data.instruments.filter((row) => !isClosed(row));
  const held = live.flatMap((row) => { const amount = instrumentOutstanding(row); return amount != null && row.currency ? [{ row, amount, currency: row.currency }] : []; });
  if (!held.length) return [];
  const count = (currency: string) => held.filter((entry) => entry.currency === currency).length;
  const currencies = [...new Set(held.map((entry) => entry.currency))].sort((a, b) => count(b) - count(a) || a.localeCompare(b));
  const primary = currencies[0]!, several = currencies.length > 1;
  const inCurrency = (currency: string) => held.filter((entry) => entry.currency === currency);
  const main = inCurrency(primary), mainTotal = sum(main.map((entry) => entry.amount));
  const unit = (currency = primary) => several ? ` ${currency}` : "";
  const items: StatItem[] = [{ id: "outstanding", label: "Outstanding", value: `${creditAmount(mainTotal)} ${primary}`,
    detail: currencies.slice(1).map((currency) => `+${creditAmount(sum(inCurrency(currency).map((entry) => entry.amount)))} ${currency}`).join(" ") || undefined }];
  const reference = data.asOf ?? new Date().toISOString().slice(0, 10);
  const next = held.filter((entry) => entry.row.maturity && entry.row.maturity >= reference).sort((a, b) => a.row.maturity!.localeCompare(b.row.maturity!))[0];
  if (next) {
    const due = sum(held.filter((entry) => entry.row.maturity === next.row.maturity && entry.currency === next.currency).map((entry) => entry.amount));
    items.push({ id: "next-maturity", label: "Next maturity", value: next.row.maturity!, detail: `${creditAmount(due)}${unit(next.currency)}` });
  }
  const computed = data.covenants.filter((row) => row.headroomPercent != null && live.some((item) => item.id === row.instrumentId));
  if (computed.length) {
    const tightest = computed.reduce((low, row) => row.headroomPercent! < low.headroomPercent! ? row : low);
    items.push({ id: "min-headroom", label: "Min headroom", value: creditPercent(tightest.headroomPercent), tone: headroomTone(tightest), detail: tightest.status === "breach" ? "breach" : undefined });
  }
  const lines = main.filter((entry) => entry.row.commitment != null && entry.row.drawn != null && entry.row.commitment >= entry.row.drawn);
  if (lines.length) {
    const commitment = sum(lines.map((entry) => entry.row.commitment!));
    items.push({ id: "undrawn", label: "Undrawn", value: `${creditAmount(commitment - sum(lines.map((entry) => entry.row.drawn!)))}${unit()}`, detail: `of ${creditAmount(commitment)}` });
  }
  const dated = main.filter((entry) => entry.row.maturity && entry.amount > 0);
  if (dated.length) {
    const from = Date.parse(reference), weight = sum(dated.map((entry) => entry.amount));
    const years = sum(dated.map((entry) => entry.amount * Math.max(0, Date.parse(entry.row.maturity!) - from) / YEAR_MS)) / weight;
    const final = dated.map((entry) => entry.row.maturity!).sort().at(-1)!;
    items.push({ id: "avg-maturity", label: "Avg maturity", value: `${years.toFixed(1)}y`, detail: `${several ? `${primary} · ` : ""}final ${final.slice(0, 4)}` });
  }
  const classes = main.map((entry) => securityClass(entry.row));
  if (mainTotal > 0 && classes.every(Boolean)) {
    const secured = sum(main.filter((_, index) => classes[index] === "secured").map((entry) => entry.amount));
    items.push({ id: "secured", label: "Secured", value: `${Math.round(100 * secured / mainTotal)}%`, detail: secured ? `${creditAmount(secured)}${unit()}` : undefined });
  }
  const covenanted = new Set(data.covenants.map((row) => row.instrumentId).filter((id) => live.some((row) => row.id === id)));
  if (covenanted.size) items.push({ id: "covenanted", label: "Covenanted", value: `${covenanted.size} of ${live.length}` });
  const puts = data.changeOfControl.filter((row) => row.currency === primary && row.principal != null);
  if (puts.length) {
    const rates = new Set(puts.map((row) => row.putPercent));
    items.push({ id: "control-put", label: "CoC put", value: `${creditAmount(sum(puts.map((row) => row.principal!)))}${unit()}`, detail: rates.size === 1 && puts[0]!.putPercent != null ? `at ${puts[0]!.putPercent}%` : undefined });
  }
  return items;
}

type Column<Id extends string> = DataTableColumn & { id: Id };
/** The table's width with its gaps and padding, plus the vertical scrollbar's cell. */
const fits = (columns: readonly DataTableColumn[], width: number) => getTableWidth(columns) + 1 <= width;
/** Narrow panes drop whole columns, least important first, instead of scrolling sideways. */
function fitColumns<Id extends string>(columns: readonly Column<Id>[], width: number, dropOrder: readonly Id[]): Column<Id>[] {
  let shown = [...columns];
  for (const id of dropOrder) {
    if (fits(shown, width)) break;
    shown = shown.filter((column) => column.id !== id);
  }
  return shown;
}

type CapitalColumnId = "name" | "facility" | "coupon" | "maturity" | "principal" | "currency" | "ranking" | "control";
const CAPITAL_COLUMNS: Column<CapitalColumnId>[] = [
  { id: "name", label: "Instrument", width: 24, flexGrow: 1, align: "left" },
  { id: "facility", label: "Type", width: 12, align: "left" },
  { id: "coupon", label: "Coupon", width: 20, align: "left" },
  { id: "maturity", label: "Maturity", width: 10, align: "left" },
  { id: "principal", label: "Outstanding", width: 11, align: "right" },
  { id: "currency", label: "CCY", width: 3, align: "left" },
  { id: "ranking", label: "Rank", width: 26, align: "left" },
  { id: "control", label: "CoC put", width: 7, align: "right" },
];
/** Text columns take the width their values need, up to the column's own width. */
const FITTED_CAPITAL = new Set<CapitalColumnId>(["facility", "coupon", "ranking"]);
const SPARSE_CAPITAL = new Set<CapitalColumnId>(["ranking", "control"]);
export function capitalColumns(data: CreditDocumentsPayload, width: number): DataTableColumn[] {
  const rows = data.instruments;
  const disclosed = (id: CapitalColumnId) => rows.filter((row) => capitalCell(row, id, data) !== NO_VALUE).length;
  // A column nothing discloses is left out; ranking and puts need most instruments.
  const columns = CAPITAL_COLUMNS.filter((column) => column.id === "name" || column.id === "principal" || (SPARSE_CAPITAL.has(column.id) ? disclosed(column.id) * 2 > rows.length : disclosed(column.id) > 0))
    .map((column) => FITTED_CAPITAL.has(column.id) ? { ...column, width: Math.min(column.width, Math.max(4, ...rows.map((row) => displayWidth(capitalCell(row, column.id, data))))) } : column);
  // One currency is said by the figures; several keep their column at every width.
  const single = new Set(rows.map((row) => row.currency).filter(Boolean)).size <= 1;
  return fitColumns(columns, width, ["control", "ranking", ...(single ? ["currency" as const] : []), "facility", "coupon", "maturity"]);
}
export function capitalCell(row: CreditInstrument, column: string, data: CreditDocumentsPayload): string {
  const control = data.changeOfControl.find((entry) => entry.instrumentId === row.id);
  switch (column) {
    case "name": return isClosed(row) ? `${row.name} (${row.lifecycle})` : row.name;
    case "principal": {
      // A revolver reads as drawn of commitment; the strip carries the undrawn total.
      const outstanding = creditAmount(instrumentOutstanding(row));
      return row.commitment != null && row.commitment !== instrumentOutstanding(row) ? `${outstanding} of ${creditAmount(row.commitment)}` : outstanding;
    }
    case "currency": return row.currency ?? NO_VALUE;
    case "maturity": return row.maturity ?? NO_VALUE;
    case "coupon": return creditCoupon(row);
    case "facility": return row.facilityType ? fieldLabel(row.facilityType) : NO_VALUE;
    case "ranking": return rankText(row);
    case "control": return control ? (control.putPercent === null ? "Trigger" : `${control.putPercent}%`) : NO_VALUE;
    default: return "";
  }
}

type CovenantColumnId = "metric" | "threshold" | "current" | "headroom" | "usage" | "status" | "date" | "instrument";
const COVENANT_COLUMNS: Column<CovenantColumnId>[] = [
  { id: "metric", label: "Covenant", width: 20, flexGrow: 1, align: "left" },
  { id: "threshold", label: "Limit", width: 7, align: "right" },
  { id: "current", label: "Reported", width: 8, align: "right" },
  { id: "headroom", label: "Headroom", width: 8, align: "right" },
  { id: "usage", label: "Usage", width: 12, align: "left" },
  { id: "status", label: "Status", width: 12, align: "left" },
  { id: "date", label: "As of", width: 10, align: "left" },
  { id: "instrument", label: "Instrument", width: 22, align: "left" },
];
export const covenantColumns = (width: number): DataTableColumn[] => fitColumns(COVENANT_COLUMNS, width, ["instrument", "usage", "date", "current"]);

type MaturityColumnId = "year" | "principal" | "share" | "cumulative" | "instruments";
const MATURITY_COLUMNS: Column<MaturityColumnId>[] = [
  { id: "year", label: "Year", width: 6, align: "left" },
  { id: "principal", label: "Principal", width: 9, align: "right" },
  { id: "share", label: "Share", width: 6, align: "right" },
  { id: "cumulative", label: "Cumulative", width: 10, align: "right" },
  { id: "instruments", label: "Instrument", width: 24, flexGrow: 1, align: "left" },
];
/** A preview wall is partial, so shares of it would mislead. */
export const maturityColumns = (width: number, preview: boolean): DataTableColumn[] =>
  fitColumns(preview ? MATURITY_COLUMNS.filter((column) => column.id !== "share" && column.id !== "cumulative") : MATURITY_COLUMNS, width, ["cumulative", "share"]);
/** Each instrument's share of the currency's wall, and the running share in maturity order. */
export function maturityShares(rows: readonly CreditMaturityBucket[]): Map<string, { share: number; cumulative: number }> {
  const total = sum(rows.map((row) => row.principal));
  const shares = new Map<string, { share: number; cumulative: number }>();
  let running = 0;
  for (const row of rows) for (const instrument of row.instruments) {
    running += instrument.principal;
    if (total > 0) shares.set(`${row.year}:${instrument.id}`, { share: 100 * instrument.principal / total, cumulative: 100 * running / total });
  }
  return shares;
}

type ScreenColumnId = "symbol" | "kind" | "value" | "date" | "instrument" | "reason";
const SCREEN_COLUMNS: Column<ScreenColumnId>[] = [
  { id: "symbol", label: "Issuer", width: 8, align: "left" },
  { id: "kind", label: "Signal", width: 18, align: "left" },
  { id: "value", label: "Headroom", width: 8, align: "right" },
  { id: "date", label: "Date", width: 10, align: "left" },
  { id: "instrument", label: "Instrument", width: 26, align: "left" },
  { id: "reason", label: "Condition", width: 36, align: "left" },
];
/** The condition takes the spare width; without it, the instrument does. */
export const screenColumns = (width: number): DataTableColumn[] => {
  const columns = fitColumns(SCREEN_COLUMNS, width, ["reason", "date"]);
  const grow = columns.some((column) => column.id === "reason") ? "reason" : "instrument";
  return columns.map((column) => column.id === grow ? { ...column, flexGrow: 1 } : column);
};

type FactColumnId = "field" | "value" | "asOf" | "filed" | "status";
const FACT_COLUMNS: Column<FactColumnId>[] = [
  { id: "field", label: "Term", width: 22, align: "left" },
  { id: "value", label: "Disclosed value", width: 30, flexGrow: 1, align: "left" },
  { id: "asOf", label: "As of", width: 10, align: "left" },
  { id: "filed", label: "Filed", width: 10, align: "left" },
  { id: "status", label: "Revision", width: 10, align: "left" },
];
/** Current terms are all in effect, so only history needs the revision column. */
export const factColumns = (view: string, width: number): DataTableColumn[] => view === "history"
  ? fitColumns(FACT_COLUMNS, width, ["asOf"])
  : fitColumns(FACT_COLUMNS.filter((column) => column.id !== "status"), width, ["filed"]);
/** History that only repeats the current terms has no amendment to show. */
export const hasAmendments = (row: CreditInstrument) => (row.history ?? []).some((fact) => fact.status !== "active" || !row.facts.some((current) => current.id === fact.id));

export function maturityAxis(rows: readonly CreditMaturityBucket[]) {
  const start=Date.UTC((rows[0]?.year ?? 2000)-1,6,1), end=Date.UTC(rows.at(-1)?.year ?? 2000,6,1);
  return { ticks: rows.map((row) => ({label:String(row.year),ratio:(Date.UTC(row.year,0,1)-start)/(end-start)})), formatCursor:(ratio:number) => String(new Date(start+ratio*(end-start)).getUTCFullYear()) };
}

/** The source fact, not the magnitude, determines a covenant's unit. */
export function covenantNumber(value: number | null, fact: CreditFact | undefined): string {
  if (value === null) return NO_VALUE;
  if (fact?.currency) return `${creditAmount(value)} ${fact.currency}`;
  if (fact?.unit === "ratio" || fact?.unit === "times") return `${value}x`;
  if (fact?.unit === "percent" || fact?.unit === "%") return `${value}%`;
  return `${value}${fact?.unit ? ` ${fact.unit}` : ""}`;
}
