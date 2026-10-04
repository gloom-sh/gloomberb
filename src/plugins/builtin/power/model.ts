import type { PowerAggregate, PowerBoard, PowerCoverage, PowerExposure, PowerHistoryPoint, PowerProject, PowerRates } from "../../../api-client/power";
import { staticSeries, type DataTableColumn } from "../../../components";

export const POWER_TABS = [{ value: "queue", label: "Queue" }, { value: "history", label: "History" }, { value: "outcomes", label: "Outcomes" },
  { value: "loads", label: "Loads" }, { value: "utilities", label: "Utilities" }, { value: "capacity", label: "Capacity" }, { value: "coverage", label: "Coverage" }] as const;
export type PowerTab = typeof POWER_TABS[number]["value"];
export const powerTab = (value: unknown): PowerTab => POWER_TABS.find((tab) => tab.value === value)?.value ?? "queue";
const REGISTERS: Record<string, string> = { "neso-tec": "GB transmission", "neso-embedded": "GB embedded", "neso-interconnector": "GB interconnectors" };
const REGIONS: Record<string, string> = { LBNL: "US project queues", "LBNL-ANNUAL": "US annual queues", EIA860: "US generation capacity", EIA861: "US utilities", EIA923: "US generation output" };
export const powerRegion = (value: string, sourceId?: string) => REGISTERS[sourceId ?? ""] ?? REGIONS[value] ?? value;
export const titleCase = (value: string) => value.replace(/(^|[ _-])\w/g, (match) => match.toUpperCase());
export const powerNumber = (n: number | null | undefined) => n == null ? "--" : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
export const powerPercent = (n: number | null) => n == null ? "--" : `${(n * 100).toFixed(1)}%`;
const tickerLabel = (row: { entities: PowerProject["entities"] }) => [...new Set(row.entities.flatMap((e) => e.tickers.map((t) => t.ticker)))].join(", ") || "--";
const historyKey = (p: PowerHistoryPoint) => JSON.stringify([p.sourceId, p.country, p.region, p.kind, p.fuel, p.status, p.historical, p.basis]);
/** Annual benchmarks use their stated period. Current queues use when we observed them, never a proposed completion date. */
export function historyDate(p: PowerHistoryPoint): Date {
  if (p.basis === "published" && p.period) {
    const period = /^\d{4}$/.test(p.period) ? `${p.period}-12-31` : p.period;
    if (Number.isFinite(Date.parse(period))) return new Date(period);
  }
  return new Date(p.observedAt);
}
export const historyId = (p: PowerHistoryPoint) => `${historyKey(p)}:${p.observedAt}:${p.period ?? ""}`;
export type HistoryRow = PowerHistoryPoint & { changeMw: number | null };
export function historyRows(points: readonly PowerHistoryPoint[]): HistoryRow[] {
  const previous = new Map<string, number | null>();
  return [...points].sort((a, b) => historyDate(a).getTime() - historyDate(b).getTime()).map((p) => {
    const key = historyKey(p); const last = previous.get(key); previous.set(key, p.unknownCapacity ? null : p.capacityMw);
    return { ...p, changeMw: last == null || p.unknownCapacity ? null : p.capacityMw - last };
  }).reverse();
}
export function historySeries(points: readonly PowerHistoryPoint[], selected: PowerHistoryPoint | undefined, color: string) {
  if (!selected) return [];
  const rows = points.filter((p) => historyKey(p) === historyKey(selected)).sort((a, b) => historyDate(a).getTime() - historyDate(b).getTime());
  if (new Set(rows.filter((p) => p.unknownCapacity === 0).map((p) => historyDate(p).getTime())).size < 3) return [];
  return [{ ...staticSeries(rows.map((p) => ({ date: historyDate(p), observedAt: new Date(p.observedAt), value: p.unknownCapacity ? null : p.capacityMw })),
    { id: historyKey(selected), label: `${powerRegion(selected.region, selected.sourceId)} ${titleCase(selected.fuel)} ${titleCase(selected.status)}`, color, style: "step", calendarSpaced: true }),
    unit: "MW", unitGroup: "power-mw", interpolation: "step-after" as const }];
}
const col = (id: string, label: string, width: number, numeric = false, flexGrow?: number): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flexGrow ? { flexGrow } : {}) });
export const PROJECT_COLUMNS = [col("name", "Project / area", 30, false, 1), col("capacityMw", "MW", 11, true), col("region", "Region", 13), col("fuel", "Fuel", 10), col("status", "Status", 11), col("scope", "Record scope", 18), col("ticker", "Ticker", 13), col("developer", "Developer / utility", 26), col("location", "Location", 24), col("proposedDate", "Proposed service", 17), col("asOf", "As of", 12)];
export const GENERATION_COLUMNS = [col("name", "Plant / generator", 30, false, 1), col("generationMwh", "Generation MWh", 18, true), col("period", "Period", 9), col("fuel", "Fuel", 11), col("region", "Region", 12), col("ticker", "Ticker", 12), col("developer", "Operator", 25), col("location", "Location", 20)];
export const UTILITY_COLUMNS = [col("name", "Utility", 30, false, 1), col("summerPeakDemandMw", "Summer peak MW", 17, true), col("winterPeakDemandMw", "Winter peak MW", 17, true), col("salesMwh", "Sales MWh", 17, true), col("revenueUsd", "Retail revenue USD", 20, true), col("generationMwh", "Generation MWh", 18, true), col("period", "Period", 9), col("ticker", "Ticker", 12), col("location", "Location", 20)];
export const HISTORY_COLUMNS = [col("date", "Observed / period", 20), col("region", "Region", 15, false, 1), col("fuel", "Fuel", 11), col("status", "Status", 12), col("capacityMw", "MW", 13, true), col("changeMw", "Change MW", 13, true), col("projects", "Records", 9, true), col("unknownCapacity", "Missing MW records", 19, true)];
export const RATE_COLUMNS = [col("region", "Region", 18, false, 1), col("cohort", "Entry cohort", 12), col("projects", "Projects", 10, true), col("completed", "Completed", 11, true), col("withdrawn", "Withdrawn", 11, true), col("active", "Active", 10, true), col("completionRate", "Complete %", 12, true), col("withdrawalRate", "Withdraw %", 12, true), col("unknown", "Other", 10, true)];
export const EXPOSURE_COLUMNS = [col("utility", "Utility / grid", 31, false, 1), col("region", "Region", 13), col("requestedMw", "Requested MW", 15, true), col("approvedMw", "Approved MW", 15, true), col("operatingMw", "Operating MW", 15, true), col("requests", "Records", 10, true), col("ticker", "Ticker", 13), col("unknownCapacity", "Missing MW records", 19, true)];
export const COVERAGE_COLUMNS = [col("region", "Region", 20, false, 1), col("country", "Country", 9), col("kind", "Dataset", 12), col("role", "Scope", 12), col("status", "State", 12), col("asOf", "As of", 12), col("observedAt", "Observed UTC", 19), col("records", "Records", 11, true)];
export type PowerRow = { id: string; label: string; cells: Record<string, string | number | null>; project?: PowerProject; history?: HistoryRow; rate?: PowerRates; exposure?: PowerExposure; coverage?: PowerCoverage; locked?: boolean };
export function projectRows(rows: readonly PowerProject[]): PowerRow[] {
  return rows.map((p) => ({ id: p.id, label: p.name, project: p, cells: { name: p.name, capacityMw: p.capacityMw, region: powerRegion(p.region, p.sourceId),
    fuel: titleCase(p.fuel), scope: p.metrics.aggregationLevel === "region" ? "Regional summary" : titleCase(String(p.metrics.aggregationLevel ?? "project").replaceAll("_", " ")), status: titleCase(p.status), ticker: tickerLabel(p), developer: p.developer ?? p.utility,
    generationMwh: typeof p.metrics.generationMwh === "number" ? p.metrics.generationMwh : null,
    summerPeakDemandMw: typeof p.metrics.summerPeakDemandMw === "number" ? p.metrics.summerPeakDemandMw : null,
    winterPeakDemandMw: typeof p.metrics.winterPeakDemandMw === "number" ? p.metrics.winterPeakDemandMw : null,
    salesMwh: typeof p.metrics.salesMwh === "number" ? p.metrics.salesMwh : null,
    revenueUsd: typeof p.metrics.revenueUsd === "number" ? p.metrics.revenueUsd : null, period: p.period,
    location: [p.county, p.state, p.country].filter(Boolean).join(", "), proposedDate: p.proposedDate, asOf: p.asOf } }));
}
export function otherRows(tab: PowerTab, board: PowerBoard, history: readonly PowerHistoryPoint[]): PowerRow[] {
  if (tab === "history") return historyRows(history).map((p) => ({ id: historyId(p), label: `${p.region} ${titleCase(p.fuel)} ${titleCase(p.status)}`, history: p,
    cells: { date: p.basis === "published" ? p.period : p.observedAt.slice(0, 16).replace("T", " "), region: powerRegion(p.region, p.sourceId), fuel: titleCase(p.fuel), status: titleCase(p.status),
      capacityMw: p.capacityMw, changeMw: p.changeMw, projects: p.projects, unknownCapacity: p.unknownCapacity } }));
  if (tab === "outcomes") return board.rates.map((r) => ({ id: JSON.stringify([r.sourceId, r.country, r.region, r.cohort]), label: `${r.region} · ${r.cohort}`, rate: r, coverage: board.coverage.find((c) => c.id === r.sourceId), cells: { region: powerRegion(r.region, r.sourceId), country: r.country, cohort: r.cohort, projects: r.projects, completed: r.completed, withdrawn: r.withdrawn, active: r.active, unknown: r.unknown, completionRate: r.completionRate, withdrawalRate: r.withdrawalRate } }));
  if (tab === "utilities") return board.exposure.map((r) => ({ id: JSON.stringify([r.sourceId, r.country, r.region, r.utility]), label: r.utility, exposure: r,
    cells: { utility: r.utility, country: r.country, region: r.region, requestedMw: r.requestedMw, approvedMw: r.approvedMw, operatingMw: r.operatingMw,
      requests: r.requests, unknownCapacity: r.unknownCapacity, ticker: tickerLabel(r) } }));
  return board.coverage.map((r) => ({ id: r.id, label: `${powerRegion(r.region)} ${titleCase(r.kind)}`, coverage: r,
    cells: { country: r.country, region: powerRegion(r.region, r.id), kind: titleCase(r.kind), role: titleCase(r.role), status: titleCase(r.status), asOf: r.asOf,
      observedAt: r.observedAt?.slice(0, 16).replace("T", " ") ?? null, records: r.records } }));
}
export function powerFigures(aggregates: readonly PowerAggregate[]) {
  const sum = (status?: string) => aggregates.filter((a) => !status || a.status === status).reduce((n, a) => n + a.capacityMw, 0);
  const unknown = aggregates.reduce((n, a) => n + a.unknownCapacity, 0);
  return [
    { id: "mw", label: "Reported MW", value: powerNumber(sum()) },
    { id: "active", label: "Active MW", value: powerNumber(sum("active")) },
    { id: "completed", label: "Completed MW", value: powerNumber(sum("completed")) },
    { id: "withdrawn", label: "Withdrawn MW", value: powerNumber(sum("withdrawn")) },
    ...(unknown ? [{ id: "unknown", label: "Missing MW", value: powerNumber(unknown), detail: "records" }] : []),
  ];
}
