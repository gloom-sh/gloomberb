import type { CreditDocumentsPayload, CreditFact, CreditInstrument, CreditMaturityBucket, CreditScreenRow, CreditValue } from "../../../api-client/credit-documents";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";

export const CREDIT_TABS = [{ value: "capital", label: "Capital" }, { value: "covenants", label: "Covenants" }, { value: "maturities", label: "Maturities" }, { value: "screen", label: "Screen" }] as const;
export type CreditTab = typeof CREDIT_TABS[number]["value"];
export const creditTab = (value: unknown): CreditTab => CREDIT_TABS.find((tab) => tab.value === value)?.value ?? "capital";
export const fieldLabel = (field: string) => field.replace(/_/g, " ").replace(/^./, (value) => value.toUpperCase());
export const creditAmount = (value: number | null | undefined): string => value == null ? "--" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
export const creditPercent = (value: number | null | undefined): string => value == null ? "--" : `${value.toFixed(1)}%`;
export function creditValue(value: CreditValue): string {
  if (value === null) return "Not disclosed";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(creditValue).join("; ");
  if (typeof value === "object") return Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => `${fieldLabel(name)}: ${creditValue(item)}`).join(" · ");
  return String(value);
}
export function factValue(fact: CreditFact): string {
  if (typeof fact.value === "number" && ["percent", "%"].includes(fact.unit ?? "")) return `${fact.value}%`;
  const value = typeof fact.value === "number" && fact.currency ? creditAmount(fact.value) : creditValue(fact.value);
  return [value, fact.currency ?? fact.unit].filter(Boolean).join(" ");
}
function instrumentFact(row: CreditInstrument, field: string): CreditFact | undefined {
  return row.facts.find((fact) => fact.field === field);
}
const creditCoupon = (row: CreditInstrument) => {
  const coupon = instrumentFact(row, "coupon"), margin = instrumentFact(row, "margin"), reference = instrumentFact(row, "reference_rate");
  return coupon ? factValue(coupon) : [reference ? creditValue(reference.value) : null, margin ? factValue(margin) : null].filter(Boolean).join(" + ") || "--";
};
export const screenRowId = (row: CreditScreenRow) => `${row.symbol}:${row.instrumentId}:${row.kind}:${row.date ?? ""}:${row.reason}`;
export function creditCurrencies(data: CreditDocumentsPayload): string[] {
  return [...new Set(data.maturities.map((row) => row.currency))].sort();
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
export const CAPITAL_COLUMNS = [
  { id: "name", label: "Instrument", width: 32, flexGrow: 1, align: "left" as const },
  { id: "principal", label: "Outstanding", width: 12, align: "right" as const },
  { id: "currency", label: "CCY", width: 5, align: "left" as const },
  { id: "maturity", label: "Maturity", width: 12, align: "left" as const },
  { id: "coupon", label: "Coupon / margin", width: 20, align: "left" as const },
  { id: "facility", label: "Facility", width: 16, align: "left" as const },
  { id: "commitment", label: "Commitment", width: 12, align: "right" as const },
  { id: "drawn", label: "Drawn", width: 12, align: "right" as const },
  { id: "ranking", label: "Ranking", width: 20, align: "left" as const },
  { id: "control", label: "Control put", width: 11, align: "right" as const },
];
export const COVENANT_COLUMNS = [
  { id: "metric", label: "Covenant", width: 29, flexGrow: 1, align: "left" as const },
  { id: "headroom", label: "Headroom", width: 11, align: "right" as const },
  { id: "threshold", label: "Threshold", width: 12, align: "right" as const },
  { id: "current", label: "Reported", width: 11, align: "right" as const },
  { id: "status", label: "Status", width: 15, align: "left" as const },
  { id: "date", label: "Test date", width: 12, align: "left" as const },
  { id: "instrument", label: "Instrument", width: 30, align: "left" as const },
];
export const MATURITY_COLUMNS = [
  { id: "year", label: "Year", width: 8, align: "left" as const },
  { id: "principal", label: "Principal", width: 15, align: "right" as const },
  { id: "currency", label: "CCY", width: 6, align: "left" as const },
  { id: "instruments", label: "Instruments", width: 50, flexGrow: 1, align: "left" as const },
];
export const SCREEN_COLUMNS = [
  { id: "symbol", label: "Issuer", width: 12, align: "left" as const },
  { id: "kind", label: "Signal", width: 21, align: "left" as const },
  { id: "value", label: "Headroom", width: 11, align: "right" as const },
  { id: "date", label: "Date", width: 12, align: "left" as const },
  { id: "instrument", label: "Instrument", width: 30, flexGrow: 1, align: "left" as const },
  { id: "reason", label: "Condition", width: 45, align: "left" as const },
];
export function capitalCell(row: CreditInstrument, column: string, data: CreditDocumentsPayload): string {
  const control = data.changeOfControl.find((entry) => entry.instrumentId === row.id);
  switch (column) {
    case "name": return row.lifecycle && ["repaid","redeemed","terminated","cancelled","matured"].includes(row.lifecycle) ? `${row.name} (${row.lifecycle})` : row.name;
    case "principal": return creditAmount(row.drawn ?? row.principal);
    case "currency": return row.currency ?? "--";
    case "maturity": return row.maturity ?? "--";
    case "coupon": return creditCoupon(row);
    case "facility": return row.facilityType ? fieldLabel(row.facilityType) : "--";
    case "commitment": return creditAmount(row.commitment);
    case "drawn": return creditAmount(row.drawn);
    case "ranking": { const fact = instrumentFact(row, "ranking"); return fact ? creditValue(fact.value) : "--"; }
    case "control": return control ? (control.putPercent === null ? "Trigger" : creditPercent(control.putPercent)) : "--";
    default: return "";
  }
}

export function maturityAxis(rows: readonly CreditMaturityBucket[]) {
  const start=Date.UTC((rows[0]?.year ?? 2000)-1,6,1), end=Date.UTC(rows.at(-1)?.year ?? 2000,6,1);
  return { ticks: rows.map((row) => ({label:String(row.year),ratio:(Date.UTC(row.year,0,1)-start)/(end-start)})), formatCursor:(ratio:number) => String(new Date(start+ratio*(end-start)).getUTCFullYear()) };
}

/** The source fact, not the magnitude, determines a covenant's unit. */
export function covenantNumber(value: number | null, fact: CreditFact | undefined): string {
  if (value === null) return "--";
  if (fact?.currency) return `${creditAmount(value)} ${fact.currency}`;
  if (fact?.unit === "ratio" || fact?.unit === "times") return `${value}x`;
  if (fact?.unit === "percent" || fact?.unit === "%") return `${value}%`;
  return `${value}${fact?.unit ? ` ${fact.unit}` : ""}`;
}
