import type { PerpBoardRow, PerpHistoryPayload } from "../../../api-client/perps";
import type { DataTableColumn } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { formatCompact } from "../../../utils/format";
export const PERP_TABS = ["board", "history", "rankings", "compare", "evidence"] as const;
export type PerpTab = typeof PERP_TABS[number];
export const ASSET_FILTERS = ["all", "stocks", "indices", "energy", "metals", "fx", "crypto"] as const;
export const label = (s: string) => s === "fx" ? "FX" : s.charAt(0).toUpperCase() + s.slice(1);
export const percent = (n: number | null | undefined, digits = 3) => n == null ? "--" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
export const price = (n: number | null | undefined) => n == null ? "--" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 });
export const compact = (n: number | null | undefined) => n == null ? "--" : formatCompact(n, { fixedDecimals: true });
export const time = (s: string | null | undefined) => s ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : "--";
export const marketLabel = (row: PerpBoardRow) => row.dex && row.dex !== "default" ? `${row.baseAsset} · ${row.dex.toUpperCase()}` : row.baseAsset;
export const fundingInterval = (row: Pick<PerpBoardRow, "fundingIntervalHours" | "fundingKind">) => row.fundingIntervalHours ? `${row.fundingIntervalHours}h${row.fundingKind === "last-paid" ? " paid" : ""}` : "--";
export type PerpSort = { column: string; direction: "asc" | "desc" };
export function boardRows(rows: PerpBoardRow[], asset: string, search: string, sort: PerpSort, includeDelisted = false) {
  const needle = search.trim().toLowerCase();
  const key = (row: PerpBoardRow): string | number | null => sort.column === "market" ? marketLabel(row) : sort.column === "interval" ? row.fundingIntervalHours : (row as unknown as Record<string, string | number | null>)[sort.column] ?? null;
  return rows.filter((row) => (asset === "all" || row.assetClass === asset) && (includeDelisted || !row.delisted)
    && (!needle || `${row.marketId} ${row.symbol} ${row.baseAsset} ${row.displayName} ${row.underlyingSymbol ?? ""}`.toLowerCase().includes(needle))).sort((a, b) => {
      const left = key(a), right = key(b); if (left === null) return right === null ? a.marketId.localeCompare(b.marketId) : 1; if (right === null) return -1;
      const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return comparison * (sort.direction === "asc" ? 1 : -1) || a.marketId.localeCompare(b.marketId);
    });
}
export const BOARD_COLUMNS: DataTableColumn[] = [
  { id: "market", label: "Market", width: 18, flexGrow: 1, align: "left" },
  { id: "markPrice", label: "Mark", width: 12, align: "right" },
  { id: "quoteCurrency", label: "CCY", width: 6, align: "left" },
  { id: "fundingRate", label: "Funding %", width: 11, align: "right" },
  { id: "interval", label: "Interval", width: 8, align: "left" },
  { id: "fundingRate8h", label: "8h %", width: 10, align: "right" },
  { id: "fundingApr", label: "APR %", width: 10, align: "right" },
  { id: "openInterestUsd", label: "OI USD", width: 11, align: "right" },
  { id: "oiChange24h", label: "OI Δ24h %", width: 11, align: "right" },
  { id: "premium", label: "Oracle prem %", width: 13, align: "right" },
  { id: "closedMarketPremium", label: "Closed prem %", width: 13, align: "right" },
  { id: "volume24hUsd", label: "Vol 24h USD", width: 12, align: "right" },
];
export const HISTORY_COLUMNS: DataTableColumn[] = [
  { id: "time", label: "Observed (UTC)", width: 19, flexGrow: 1, align: "left" },
  { id: "value", label: "Value", width: 17, align: "right" },
  { id: "change", label: "Change", width: 17, align: "right" },
  { id: "basis", label: "Basis", width: 24, align: "left" },
];
export type HistoryMetric = "funding" | "oi" | "premium" | "price";
export function historyRows(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric) {
  if (!data) return [];
  const points = metric === "funding" && data.funding.length ? data.funding.map((row) => ({ time: row.time, value: row.rate * 8 / row.intervalHours, basis: `Paid · ${row.intervalHours}h → 8h` }))
    : metric === "price" && data.candles.length ? data.candles.map((row) => ({ time: row.time, value: row.close, basis: "1h close" }))
      : data.rows.map((row) => ({ time: row.time,
        value: metric === "oi" ? row.openInterestUsd : metric === "premium" ? row.premium : metric === "price" ? row.markPrice
          : row.fundingRate !== null && row.fundingIntervalHours ? row.fundingRate * 8 / row.fundingIntervalHours : null,
        basis: `${row.resolution} snapshot${metric === "funding" && row.fundingIntervalHours ? ` · ${row.fundingIntervalHours}h → 8h` : ""}` }));
  return points.sort((a, b) => a.time.localeCompare(b.time)).map((row, i, all) => ({ ...row,
    change: i && row.value !== null && all[i - 1]!.value !== null ? row.value - all[i - 1]!.value! : null }));
}
const metricLabel = (metric: HistoryMetric) => ({ funding: "Funding 8h %", oi: "Open interest USD", premium: "Oracle premium %", price: "Price" })[metric];
export const historyValue = (n: number | null | undefined, metric: HistoryMetric) => metric === "oi" ? compact(n) : metric === "price" ? price(n) : percent(n, metric === "funding" ? 4 : 3);
export function historySeries(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric, name: string, color: string) {
  const rows = historyRows(data, metric);
  return [staticSeries(rows.map((row) => scalarPoint(new Date(row.time), row.value)), { id: `perp-${metric}`, label: `${name} · ${metricLabel(metric)}`, color, calendarSpaced: true })];
}

export const venueLabel = (row: PerpBoardRow) => ({ hyperliquid: "Hyperliquid", binance: "Binance", bybit: "Bybit", okx: "OKX", deribit: "Deribit", coinbase: "Coinbase International", kraken: "Kraken", dydx: "dYdX" })[row.venue] ?? row.venue;

/** Preserve funding, exposure and dislocation at a glance before adding detail. */
export function boardColumns(width: number, compare = false): DataTableColumn[] {
  const byId = new Map(BOARD_COLUMNS.map((column) => [column.id, column]));
  const column = (id: string, size?: number): DataTableColumn => ({ ...byId.get(id)!, ...(size ? { width: size } : {}) });
  const columns = [column("market", 14), ...(compare ? [{ id: "venue", label: "Venue", width: 12, align: "left" as const }] : []),
    column("markPrice", 11), column("quoteCurrency", 5), column("fundingRate8h", 10), column("openInterestUsd", 10), column("premium", 12)];
  const fits = (next: DataTableColumn[]) => [...columns, ...next].reduce((sum, item) => sum + item.width + 1, 2) <= width;
  for (const next of [
    [column("oiChange24h")],
    [column("closedMarketPremium")],
    [column("fundingRate"), column("interval")],
    [column("fundingApr")],
    ...(compare ? [[{ id: "contractType", label: "Contract / margin", width: 18, align: "left" as const }]] : []),
    [column("volume24hUsd")],
  ]) if (fits(next)) columns.push(...next);
  // Keep the established raw / interval / 8h / APR sequence when everything fits.
  return !compare && columns.length === BOARD_COLUMNS.length ? BOARD_COLUMNS : columns;
}
