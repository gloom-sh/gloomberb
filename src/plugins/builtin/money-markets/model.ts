import type { MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import type { CurveSeries } from "../../../components/chart/curve/model";

export const moneyMarketValue = (value: number | null, unit: MoneyMarketRow["unit"]) => value == null
  ? "--" : unit === "percent" ? `${value.toFixed(2)}%` : `$${value.toLocaleString("en-US", { minimumFractionDigits: Math.abs(value) < 10 ? 3 : 1, maximumFractionDigits: Math.abs(value) < 10 ? 3 : 1 })}B`;
export const moneyMarketChange = (value: number | null, unit: MoneyMarketRow["changeUnit"]) => value == null
  ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(unit === "usd-billions" && Math.abs(value) < 1 ? 3 : 1)}${unit === "basis-points" ? "bp" : "B"}`;
export function moneyMarketNotices(data: MoneyMarketsPayload): string[] {
  const notices = [...data.rows, data.netLiquidity].flatMap((row) => row.status === "unavailable"
    ? [`${row.label}: ${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")}.`]
    : row.status === "stale" ? [`${row.label}: stale, last observation ${row.asOf ?? "unknown"}.`] : []);
  if (data.billsCurve.status === "unavailable") notices.push("Bills curve: no common observation date across all four tenors.");
  else if (data.billsCurve.status === "stale") notices.push(`Bills curve: stale, last common observation ${data.billsCurve.asOf}.`);
  for (const ghost of data.billsCurve.comparisons) if (!ghost.points.length) notices.push(`Bills ${ghost.period}: no common observation within seven days before ${ghost.targetDate ?? "the comparison date"}.`);
  return notices;
}
export function moneyMarketCurves(data: MoneyMarketsPayload): CurveSeries[] {
  const curve = data.billsCurve;
  return [{ id: "today", label: "Latest", ...curve }, ...curve.comparisons.map((ghost) => ({ id: ghost.period, label: ghost.period, ...ghost }))]
    .filter((snapshot) => snapshot.points.length > 0)
    .map((snapshot) => ({ id: snapshot.id, label: snapshot.label, asOf: snapshot.asOf,
      points: snapshot.points.map((point) => ({ id: point.tenor, label: point.tenor, x: point.maturityYears, value: point.value, asOf: snapshot.asOf })),
    }));
}
export function moneyMarketRows(data: MoneyMarketsPayload, tab: string): MoneyMarketRow[] {
  return tab === "liquidity" ? [data.netLiquidity, ...data.rows.filter((row) => row.group === "liquidity")]
    : data.rows.filter((row) => row.group === (tab === "bills" ? "bills" : "rates"));
}

/** The backend buffer serves prior-year curve lookups, not the displayed rank window. */
export function moneyMarketHistory(row: MoneyMarketRow) {
  const { windowStart, windowEnd } = row.percentile;
  return row.history.filter((point) => (!windowStart || point.date >= windowStart) && (!windowEnd || point.date <= windowEnd));
}
