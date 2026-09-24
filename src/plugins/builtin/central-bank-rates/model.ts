import type { CentralBankRatesPayload, CentralBankRow } from "../../../api-client/central-bank-rates";
import type { MarketBoardRow } from "../../../components/market-board";

// Two decimals like published policy rates, a third only for eighths such as a 3.875% midpoint.
const percentText = (value: number) => Math.abs(Number(value.toFixed(2)) - value) < 1e-9 ? value.toFixed(2) : `${Number(value.toFixed(3))}`;
export const policyRate = (value: number | null) => value == null ? "--" : `${percentText(value)}%`;
export const policyLevel = (row: CentralBankRow) => row.range ? `${percentText(row.range.lower)}-${percentText(row.range.upper)}%` : policyRate(row.value);
export const policyChange = (row: CentralBankRow) => row.changeBps == null ? "--"
  : `${row.changeBps > 0 ? "+" : ""}${Number(row.changeBps.toFixed(1))}bp ${row.direction === "hike" ? "↑" : row.direction === "cut" ? "↓" : ""}`.trim();
/** Members with no policy rate to publish, kept out of the board and the notices; docs/research-data.md explains them. */
export const hasNoPolicyRate = (row: CentralBankRow) => row.status === "unavailable"
  && (row.unavailableReason === "no-policy-rate" || row.unavailableReason === "no-unified-rate");
export function policyNotices(data: CentralBankRatesPayload): string[] {
  return data.rows.filter((row) => !hasNoPolicyRate(row)).flatMap((row) => row.status === "stale" ? [`${row.label}: stale, latest observation ${row.asOf ?? "unknown"}${row.lagDays == null ? "" : ` (${row.lagDays} days old)`}.`]
    : row.status === "unavailable" ? [`${row.label}: ${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")}.`] : []);
}
export function policyHistory(row: CentralBankRow) {
  return row.history.filter((point) => (!row.percentile.windowStart || point.date >= row.percentile.windowStart)
    && (!row.percentile.windowEnd || point.date <= row.percentile.windowEnd));
}
export interface PolicyBoardRow extends MarketBoardRow { observation: CentralBankRow }
export function policyBoardRow(row: CentralBankRow): PolicyBoardRow {
  return { id: row.id, label: row.label, labelDetail: row.instrument, value: row.value, valueText: policyLevel(row),
    change: row.changeBps, changeText: policyChange(row), changeAsOf: row.lastChangeDate,
    percentile: row.percentile.value, asOf: row.asOf, status: row.status, observation: row,
    history: policyHistory(row).flatMap((point) => point.value == null ? [] : [{ date: new Date(point.date), close: point.value }]) };
}
