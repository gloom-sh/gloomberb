import type { PerpBoardRow, PerpHistoryPayload } from "../../../api-client/perps";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { formatCompact } from "../../../utils/format";
export const PERP_TABS = ["history", "evidence"] as const;
export type PerpTab = typeof PERP_TABS[number];
export const label = (s: string) => s === "fx" ? "FX" : s.charAt(0).toUpperCase() + s.slice(1);
export const percent = (n: number | null | undefined, digits = 3) => n == null ? "--" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
export const price = (n: number | null | undefined) => n == null ? "--" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 });
export const compact = (n: number | null | undefined) => n == null ? "--" : formatCompact(n, { fixedDecimals: true });
export const time = (s: string | null | undefined) => s ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : "--";
export const marketLabel = (row: PerpBoardRow) => row.dex && row.dex !== "default" ? `${row.baseAsset} · ${row.dex.toUpperCase()}` : row.baseAsset;
export const fundingInterval = (row: Pick<PerpBoardRow, "fundingIntervalHours" | "fundingKind">) => row.fundingIntervalHours ? `${row.fundingIntervalHours}h${row.fundingKind === "last-paid" ? " paid" : row.fundingKind === "continuous" ? " continuous" : ""}` : "--";
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
export const historyValue = (n: number | null | undefined, metric: HistoryMetric) => metric === "oi" ? compact(n) : metric === "price" ? price(n) : percent(n, metric === "funding" ? 4 : 3);
export function historySeries(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric, name: string, color: string) {
  const rows = historyRows(data, metric);
  return [staticSeries(rows.map((row) => scalarPoint(new Date(row.time), row.value)), { id: `perp-${metric}`, label: `${name} · ${historyCaption(data, metric)}`, color, calendarSpaced: true })];
}

export const venueLabel = (row: PerpBoardRow) => ({ hyperliquid: "Hyperliquid", binance: "Binance", bybit: "Bybit", okx: "OKX", deribit: "Deribit", coinbase: "Coinbase International", kraken: "Kraken", dydx: "dYdX" })[row.venue] ?? row.venue;


export function historyColumns(metric: HistoryMetric, currency: string, hasCandles = true): DataTableColumn[] {
  return [
    { id: "time", label: "Time (UTC)", width: 19, flexGrow: 1, align: "left" },
    { id: "value", label: metric === "funding" ? "Funding 8h %" : metric === "premium" ? "Oracle premium %" : metric === "oi" ? "OI USD" : `${hasCandles ? "Close" : "Mark"} ${currency}`, width: 17, align: "right" },
    { id: "change", label: metric === "funding" || metric === "premium" ? "Change pp" : `Change ${metric === "oi" ? "USD" : currency}`, width: 17, align: "right" },
    { id: "basis", label: "Observation basis", width: 25, align: "left" },
  ];
}
export const historyChange = (value: number | null | undefined, metric: HistoryMetric) => value == null ? "--" : metric === "funding" || metric === "premium" ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(metric === "funding" ? 4 : 3)}pp` : historyValue(value, metric);
export function historyCaption(data: PerpHistoryPayload | null | undefined, metric: HistoryMetric) {
  return metric === "funding" ? data?.funding.length ? "Paid funding / 8h" : "Observed funding / 8h"
    : metric === "price" && data?.candles.length ? "Hourly trade closes" : metric === "oi" ? "Collected open interest" : metric === "premium" ? "Collected oracle premium" : "Collected mark";
}

export function historyCell(row: ReturnType<typeof historyRows>[number], column: string, metric: HistoryMetric): DataTableCell {
  if (column === "time") return { text: time(row.time), value: row.time };
  if (column === "basis") return { text: row.basis };
  const value = column === "change" ? row.change : row.value;
  return { text: column === "change" ? historyChange(value, metric) : historyValue(value, metric),
    value: value === null ? null : value * (metric === "funding" || metric === "premium" ? 100 : 1) };
}
