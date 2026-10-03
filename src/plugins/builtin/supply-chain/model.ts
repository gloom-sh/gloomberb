import type { SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import type { DataTableColumn } from "../../../components";
import { revenueAmount } from "../revenue-breakdown/model";

export const ROLE_COLORS: Record<SupplyRole, string> = { supplier: "#6ca9df", customer: "#68cbb0", partner: "#b49bd7", competitor: "#e0a66b", investee: "#dc91b0" };
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
export const percentage = (row: SupplyRow) => row.pctOfRevenue === null ? "--" : `${Number(row.pctOfRevenue.toFixed(2))}% ${row.pctScope ? "scoped " : ""}${row.pctBasis ?? ""}`;
export const dollars = (row: SupplyRow) => row.usd === null ? "--" : `${row.usdBasis === "derived" ? "≈ " : ""}$${revenueAmount(row.usd)} ${row.usdBasis}`;
export const sourceLabel = (row: SupplyRow) => row.sourceKind === "xbrl" ? "XBRL" : row.sourceKind === "filing_text" ? row.form ?? "Filing" : row.sourceKind === "call" ? "Call" : row.sourceKind === "news" ? "News" : row.sourceKind === "web" ? "Web" : "Disclosure";
export const COLUMNS: DataTableColumn[] = [
  { id: "name", label: "Counterparty", width: 27, flexGrow: 1, align: "left" },
  { id: "ticker", label: "Ticker", width: 9, align: "left" },
  { id: "role", label: "Role", width: 11, align: "left" },
  { id: "direction", label: "Dir", width: 5, align: "left" },
  { id: "pct", label: "% (basis)", width: 19, align: "right" },
  { id: "usd", label: "$ (basis)", width: 20, align: "right" },
  { id: "fy", label: "FY", width: 11, align: "left" },
  { id: "source", label: "Source", width: 7, align: "left" },
  { id: "filed", label: "Filed", width: 11, align: "left" },
  { id: "confidence", label: "Confidence", width: 11, align: "right" },
];
export function cellText(row: SupplyRow, column: string): string {
  return column === "name" ? counterpartyName(row) : column === "ticker" ? row.counterparty.ticker ?? "--"
    : column === "role" ? roleLabel(row.role) : column === "direction" ? row.direction === "in" ? "In" : row.direction === "out" ? "Out" : "Both"
    : column === "pct" ? percentage(row) : column === "usd" ? dollars(row) : column === "fy" ? row.fiscalYear ?? row.period
    : column === "source" ? sourceLabel(row) : column === "filed" ? row.filedDate ?? "--" : `${Math.round(row.confidence * 100)}%`;
}
export type SupplySort = { column: string; direction: "asc" | "desc" };
export function sortRows(rows: SupplyRow[], sort: SupplySort): SupplyRow[] {
  const value = (row: SupplyRow): string | number | null => sort.column === "pct" ? row.pctOfRevenue : sort.column === "usd" ? row.usd
    : sort.column === "confidence" ? row.confidence : cellText(row, sort.column).toLowerCase();
  return [...rows].sort((a, b) => { const x = value(a), y = value(b); return x === null || y === null ? x === y ? 0 : x === null ? 1 : -1
    : x === y ? a.id.localeCompare(b.id) : (x < y ? -1 : 1) * (sort.direction === "asc" ? 1 : -1); });
}
export type FlowBand = "suppliers" | "customers" | "related";
export interface FlowNode { id: string; label: string; row: SupplyRow | null; band: FlowBand; more: number; weight: number | null; weightScope: string | null; weightBasis: "revenue" | "usd" | null; }
const revenueKey = (row: SupplyRow) => JSON.stringify([row.reportingEntity.id, row.period, row.pctScope]);
/** Percentages from different filers and denominators are never summed. One latest edge per counterparty/role is drawn. */
export function flowBands(rows: SupplyRow[], limit: number, pages: Partial<Record<FlowBand, number>> = {}, focusId?: string): Record<FlowBand, FlowNode[]> {
  const grouped: Record<FlowBand, SupplyRow[]> = { suppliers: [], customers: [], related: [] };
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => b.asOf.localeCompare(a.asOf) || Number(b.pctOfRevenue !== null || b.usd !== null) - Number(a.pctOfRevenue !== null || a.usd !== null) || b.confidence - a.confidence)) {
    if (row.counterparty.aggregate) continue;
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
    for (const row of values) if (band === "customers" && row.pctBasis === "revenue" && (row.pctOfRevenue ?? 0) > 0 && (!focusId || row.reportingEntity.id === focusId)) {
      const key = revenueKey(row);
      revenueGroups.set(key, [...(revenueGroups.get(key) ?? []), row]);
    }
    const revenueGroup = [...revenueGroups.values()].sort((a, b) => b.length - a.length || Number(a[0]!.pctScope !== null) - Number(b[0]!.pctScope !== null))[0];
    const scaleKey = revenueGroup ? revenueKey(revenueGroup[0]!) : null;
    const value = (row: SupplyRow) => scaleKey === null ? row.usd ?? 0
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
