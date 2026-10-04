import type { SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import { SERIES_COLORS } from "../../../time-series/resolve";
import { revenueAmount } from "../revenue-breakdown/model";
import { activeRelationship, corroborationLabel, evidenceDate, evidenceLabel, isUnconfirmed, trustTier } from "./trust";

/** One colour per role from the shared series palette, the same in the table, the flow and the evidence. */
export const ROLE_COLORS: Record<SupplyRole, string> = {
  supplier: SERIES_COLORS[0], customer: SERIES_COLORS[1], partner: SERIES_COLORS[3], competitor: SERIES_COLORS[5], investee: SERIES_COLORS[7],
};

/** A company, a customer the filer does not name, or a geographic or channel cohort that is not one company. */
export type CounterpartyKind = "company" | "undisclosed" | "group";
export const counterpartyKind = (row: SupplyRow): CounterpartyKind =>
  row.counterparty.aggregate ? "group" : row.counterparty.anonymous ? "undisclosed" : "company";

const GENERIC_WORDS = /\b(And|Of|The|Based|End|Customers?|Suppliers?|Vendors?|Channel|Partners?|Undisclosed|Other|Carriers?|Networks?|Cellular|Distributors?|Retailers?)\b/g;

/** The counterparty's name without the kind spelled into it; the kind travels as its own label. */
export function counterpartyLabel(row: SupplyRow): string {
  const kind = counterpartyKind(row);
  if (kind === "company") return row.counterparty.name;
  const name = counterpartyName(row).replace(/^Group: /, "").replace(/\s*\(undisclosed\)$/i, "");
  // Cohort labels arrive in title case from XBRL member names; generic words read lower case, names keep theirs.
  return name.replace(GENERIC_WORDS, (word) => word.toLowerCase()).replace(/^./, (first) => first.toUpperCase());
}
export const counterpartyKindLabel = (row: SupplyRow, short = false) => {
  const kind = counterpartyKind(row);
  if (short) return kind === "group" ? "group" : kind === "undisclosed" ? "undisclosed" : null;
  return kind === "group" ? `${row.role} group` : kind === "undisclosed" ? `undisclosed ${row.role}` : null;
};

/** A filer's segment or product scope in plain words: "Compute And Networking Segment" reads "Compute & Networking". */
export function scopeWords(scope: string): string {
  return scope.replace(/^Business segments?:\s*/i, "").replace(/\s+segment$/i, "").replace(/\s+and\s+/gi, " & ")
    .replace(/^non[\s-]?us$/i, "non-US").trim();
}

/**
 * A disclosed share and what it is a share of, in words. The denominator is
 * always the reporting company's: a supplier saying the focus company is 91%
 * of its revenue reads "of CRUS revenue", never as the focus company's.
 */
export function shareParts(row: SupplyRow, focusId?: string | null): { value: string; basis: string } | null {
  if (row.pctOfRevenue === null || row.pctBasis === null || trustTier(row) !== 1 || isUnconfirmed(row) || !activeRelationship(row)) return null;
  const reporter = focusId && row.reportingEntity.id !== focusId ? `${row.reportingEntity.ticker ?? row.reportingEntity.name} ` : "";
  const scope = row.pctScope ? scopeWords(row.pctScope) : "";
  const basis = row.pctBasis === "cost" ? "cost of sales" : row.pctBasis;
  // A scope that names its own denominator ("Vendor non-trade receivables") is a description, read in lower case.
  const scoped = scope && scope.toLowerCase().includes(basis) ? scope.replace(/^[A-Z](?=[a-z])/, (first) => first.toLowerCase()) : `${scope ? `${scope} ` : ""}${basis}`;
  const period = !reporter && !scope && row.pctBasis === "revenue" ? row.form === "10-Q" ? "quarterly " : row.form === "10-K" || row.form === "20-F" ? "FY " : "" : "";
  return { value: `${Number(row.pctOfRevenue.toFixed(1))}%`, basis: `of ${reporter}${period}${scoped}` };
}
export function counterpartyName(row: SupplyRow): string {
  if (row.counterparty.aggregate) return `Group: ${row.counterparty.name.replace(/^Undisclosed customer \((.+)\)$/i, "$1")}`;
  if (!row.counterparty.anonymous) return row.counterparty.name;
  const name = row.counterparty.name;
  const member = name.match(/^Undisclosed [^(]+\((.+)\)$/i)?.[1]
    ?? (name.toLowerCase().startsWith("undisclosed") ? null : name);
  if (/^undisclosed/i.test(member ?? "")) return member!;
  return member ? `${member.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s*\(undisclosed\)/gi, "")} (undisclosed)` : name;
}
export const roleLabel = (role: SupplyRole) => role[0]!.toUpperCase() + role.slice(1);
export const percentage = (row: SupplyRow) => row.pctOfRevenue === null || trustTier(row) !== 1 || isUnconfirmed(row) || !activeRelationship(row) ? "--" : `${Number(row.pctOfRevenue.toFixed(2))}% ${row.pctScope ? "scoped " : ""}${row.pctBasis ?? ""}`;
export const dollars = (row: SupplyRow) => row.usd === null ? "--" : `${row.usdBasis === "derived" ? "≈ " : ""}$${revenueAmount(row.usd)} ${row.usdBasis}`;
export const sourceLabel = (row: SupplyRow) => row.sourceKind === "xbrl" ? "XBRL" : row.sourceKind === "filing_text" ? row.form ?? "Filing" : row.sourceKind === "call" ? "Call" : row.sourceKind === "news" ? "News" : row.sourceKind === "press_release" ? "Release" : row.sourceKind === "web" ? "Web" : "Disclosure";
export function cellText(row: SupplyRow, column: string): string {
  return column === "name" ? counterpartyName(row) : column === "ticker" ? row.counterparty.ticker ?? "--"
    : column === "role" ? roleLabel(row.role) : column === "direction" ? row.direction === "in" ? "In" : row.direction === "out" ? "Out" : "Both"
    : column === "pct" ? percentage(row) : column === "usd" ? dollars(row) : column === "fy" ? row.fiscalYear ?? row.period
    : column === "publisher" ? row.evidence?.find((item) => item.status === "active")?.publisher ?? row.reportingEntity.name
    : column === "corroboration" ? corroborationLabel(row)
    : column === "evidence" ? evidenceLabel(row) : column === "source" ? sourceLabel(row) : column === "filed" ? evidenceDate(row) : `${Math.round(row.confidence * 100)}%`;
}
export type SupplySort = { column: string; direction: "asc" | "desc" };
export function sortRows(rows: SupplyRow[], sort: SupplySort): SupplyRow[] {
  const value = (row: SupplyRow): string | number | null => sort.column === "pct" ? row.pctOfRevenue : sort.column === "usd" ? row.usd
    : sort.column === "confidence" ? row.confidence : sort.column === "evidence" ? trustTier(row) : cellText(row, sort.column).toLowerCase();
  return [...rows].sort((a, b) => { const x = value(a), y = value(b); return x === null || y === null ? x === y ? 0 : x === null ? 1 : -1
    : x === y ? a.id.localeCompare(b.id) : (x < y ? -1 : 1) * (sort.direction === "asc" ? 1 : -1); });
}
/** Cohort concentrations beside the flow: never nodes or ribbons, one latest disclosure per group and role. */
export function flowGroups(rows: readonly SupplyRow[]): SupplyRow[] {
  const seen = new Set<string>();
  return [...rows].filter((row) => row.counterparty.aggregate && !isUnconfirmed(row) && activeRelationship(row)).sort((a, b) => b.asOf.localeCompare(a.asOf) || (b.pctOfRevenue ?? -1) - (a.pctOfRevenue ?? -1))
    .filter((row) => { const key = `${row.counterparty.id}:${row.role}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (b.pctOfRevenue ?? -1) - (a.pctOfRevenue ?? -1));
}

export type FlowBand = "suppliers" | "customers" | "related";
export interface FlowNode { id: string; label: string; row: SupplyRow | null; band: FlowBand; more: number; weight: number | null; weightScope: string | null; weightBasis: "revenue" | "usd" | null; }
const revenueKey = (row: SupplyRow) => JSON.stringify([row.reportingEntity.id, row.period, row.pctScope]);
/** Percentages from different filers and denominators are never summed. One latest edge per counterparty/role is drawn. */
export function flowBands(rows: SupplyRow[], limit: number, pages: Partial<Record<FlowBand, number>> = {}, focusId?: string): Record<FlowBand, FlowNode[]> {
  const grouped: Record<FlowBand, SupplyRow[]> = { suppliers: [], customers: [], related: [] };
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => trustTier(a) - trustTier(b) || b.asOf.localeCompare(a.asOf) || Number(b.pctOfRevenue !== null || b.usd !== null) - Number(a.pctOfRevenue !== null || a.usd !== null) || b.confidence - a.confidence)) {
    if (row.counterparty.aggregate || isUnconfirmed(row) || !activeRelationship(row)) continue;
    const key = `${row.counterparty.id}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[row.role === "supplier" ? "suppliers" : row.role === "customer" ? "customers" : "related"].push(row);
  }
  return Object.fromEntries((Object.keys(grouped) as FlowBand[]).map((band) => {
    const values = sortRows(grouped[band], { column: "pct", direction: "desc" });
    // One reporter, period and revenue scope form a compatible percentage scale.
    // Prefer the largest compatible group, then whole-company revenue on a tie.
    const revenueGroups = new Map<string, SupplyRow[]>();
    for (const row of values) if (trustTier(row) === 1 && band === "customers" && row.pctBasis === "revenue" && (row.pctOfRevenue ?? 0) > 0 && (!focusId || row.reportingEntity.id === focusId)) {
      const key = revenueKey(row);
      revenueGroups.set(key, [...(revenueGroups.get(key) ?? []), row]);
    }
    const revenueGroup = [...revenueGroups.values()].sort((a, b) => b.length - a.length || Number(a[0]!.pctScope !== null) - Number(b[0]!.pctScope !== null))[0];
    const scaleKey = revenueGroup ? revenueKey(revenueGroup[0]!) : null;
    const value = (row: SupplyRow) => trustTier(row) !== 1 ? 0 : scaleKey === null ? row.usd ?? 0
      : row.pctBasis === "revenue" && revenueKey(row) === scaleKey ? row.pctOfRevenue ?? 0 : 0;
    // Use the entire band: paging must not change an existing ribbon's width.
    const max = Math.max(0, ...values.map(value));
    const ordered = [...values].sort((a, b) => value(b) - value(a));
    const pageSize = Math.max(1, limit - 1), paged = values.length > limit;
    const start = paged ? ((pages[band] ?? 0) % Math.ceil(values.length / pageSize)) * pageSize : 0;
    const visible = ordered.slice(start, start + (paged ? pageSize : limit));
    const nodes: FlowNode[] = visible.map((row) => ({ id: row.id, label: counterpartyName(row), row, band, more: 0,
      weight: value(row) > 0 ? value(row) / max : null, weightScope: revenueGroup?.[0]?.pctScope ?? null, weightBasis: scaleKey ? "revenue" : max > 0 ? "usd" : null }));
    if (paged) nodes.push({ id: `more:${band}`, label: `+${values.length - visible.length} more`, row: null, band, more: values.length - visible.length, weight: null, weightScope: null, weightBasis: null });
    return [band, nodes];
  })) as Record<FlowBand, FlowNode[]>;
}
