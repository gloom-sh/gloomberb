import type { CentralBankRatesPayload, CentralBankRow } from "../../../api-client/central-bank-rates";
import type { MarketBoardRow } from "../../../components/market-board";

export const policyRate = (value: number | null) => value == null ? "--" : `${Number(value.toFixed(3))}%`;
export const policyLevel = (row: CentralBankRow) => row.range ? `${Number(row.range.lower.toFixed(3))}-${Number(row.range.upper.toFixed(3))}%` : policyRate(row.value);
export const policyChange = (row: CentralBankRow) => row.changeBps == null ? "--"
  : `${row.changeBps > 0 ? "+" : ""}${Number(row.changeBps.toFixed(1))}bp ${row.direction === "hike" ? "↑" : row.direction === "cut" ? "↓" : ""}`.trim();
export function policyNotices(data: CentralBankRatesPayload): string[] {
  return data.rows.flatMap((row) => row.status === "stale" ? [`${row.label}: stale, latest observation ${row.asOf ?? "unknown"}${row.lagDays == null ? "" : ` (${row.lagDays} days old)`}.`]
    : row.status === "unavailable" ? [`${row.label}: ${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")}.`] : []);
}
export function policyHistory(row: CentralBankRow) {
  return row.history.filter((point) => (!row.percentile.windowStart || point.date >= row.percentile.windowStart)
    && (!row.percentile.windowEnd || point.date <= row.percentile.windowEnd));
}
export interface PolicyBoardRow extends MarketBoardRow { observation: CentralBankRow }
export function policyBoardRow(row: CentralBankRow): PolicyBoardRow {
  return { id: row.id, label: row.label, value: row.value, valueText: policyLevel(row),
    change: row.changeBps, changeText: policyChange(row), changeAsOf: row.lastChangeDate,
    percentile: row.percentile.value, asOf: row.asOf, status: row.status, observation: row,
    history: policyHistory(row).flatMap((point) => point.value == null ? [] : [{ date: new Date(point.date), close: point.value }]) };
}
