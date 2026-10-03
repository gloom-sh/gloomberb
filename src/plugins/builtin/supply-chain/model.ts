import type { SupplyRole, SupplyRow } from "../../../api-client/supply-chain";
import type { DataTableColumn } from "../../../components";
import { revenueAmount } from "../revenue-breakdown/model";

export const ROLE_COLORS: Record<SupplyRole, string> = { supplier: "#6ca9df", customer: "#68cbb0", partner: "#b49bd7", competitor: "#e0a66b", investee: "#dc91b0" };
export function counterpartyName(row: SupplyRow): string {
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
export interface FlowNode { id: string; label: string; row: SupplyRow | null; band: FlowBand; more: number; weight: number; }
/** Percentages from different filers and denominators are never summed. One latest edge per counterparty/role is drawn. */
export function flowBands(rows: SupplyRow[], limit: number, pages: Partial<Record<FlowBand, number>> = {}, focusId?: string): Record<FlowBand, FlowNode[]> {
  const grouped: Record<FlowBand, SupplyRow[]> = { suppliers: [], customers: [], related: [] };
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => b.asOf.localeCompare(a.asOf) || Number(b.pctOfRevenue !== null || b.usd !== null) - Number(a.pctOfRevenue !== null || a.usd !== null) || b.confidence - a.confidence)) {
    const key = `${row.counterparty.id}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped[row.role === "supplier" ? "suppliers" : row.role === "customer" ? "customers" : "related"].push(row);
  }
  return Object.fromEntries((Object.keys(grouped) as FlowBand[]).map((band) => {
    const values = sortRows(grouped[band], { column: "pct", direction: "desc" });
    const pageSize = Math.max(1, limit - 1), paged = values.length > limit;
    const start = paged ? ((pages[band] ?? 0) % Math.ceil(values.length / pageSize)) * pageSize : 0;
    const visible = values.slice(start, start + (paged ? pageSize : limit));
    // A band uses one compatible unit. Unknown relationships remain a thin ribbon.
    const percentageWeight = band === "customers" && visible.some((row) => row.pctBasis === "revenue" && row.pctScope === null && (!focusId || row.reportingEntity.id === focusId) && row.pctOfRevenue !== null);
    const max = Math.max(1, ...visible.map((row) => percentageWeight ? row.pctBasis === "revenue" && row.pctScope === null && (!focusId || row.reportingEntity.id === focusId) ? row.pctOfRevenue ?? 0 : 0 : row.usd ?? 0));
    const nodes: FlowNode[] = visible.map((row) => ({ id: row.id, label: counterpartyName(row), row, band, more: 0,
      weight: Math.max(0.035, (percentageWeight ? row.pctBasis === "revenue" && row.pctScope === null && (!focusId || row.reportingEntity.id === focusId) ? row.pctOfRevenue ?? 0 : 0 : row.usd ?? 0) / max) }));
    if (paged) nodes.push({ id: `more:${band}`, label: `+${values.length - visible.length} more`, row: null, band, more: values.length - visible.length, weight: 0 });
    return [band, nodes];
  })) as Record<FlowBand, FlowNode[]>;
}
