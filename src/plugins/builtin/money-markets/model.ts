import { MISSING_VALUE } from "../../../utils/format";
import type { MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import { formatPercentAxis, spanAxisFormatter } from "../../../components/chart-table";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";

/** A balance in billions to the million under $10B, to the hundred million above. */
const billionsDigits = (value: number) => Math.abs(value) < 10 ? 3 : 1;
export const moneyMarketValue = (value: number | null, unit: MoneyMarketRow["unit"]) => value == null
  ? MISSING_VALUE : unit === "percent" ? `${value.toFixed(2)}%` : `$${value.toLocaleString("en-US", { minimumFractionDigits: billionsDigits(value), maximumFractionDigits: billionsDigits(value) })}B`;
export const moneyMarketChange = (value: number | null, unit: MoneyMarketRow["changeUnit"]) => value == null
  ? MISSING_VALUE : `${value > 0 ? "+" : ""}${value.toFixed(unit === "usd-billions" && Math.abs(value) < 1 ? 3 : 1)}${unit === "basis-points" ? "bp" : "B"}`;
const formatBillionsAxis = spanAxisFormatter(
  (value, digits) => `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}B`,
  billionsDigits,
);

/** Axis labels in the board's units, with the decimals the plotted range needs; tags at the board's own. */
export function moneyMarketAxis(unit: MoneyMarketRow["unit"]): (value: number, domain: CompositeAxisDomain) => string {
  return unit === "percent" ? formatPercentAxis : formatBillionsAxis;
}

/** A move in a bill's discount yield, in basis points like the board's change column. */
export const moneyMarketRateChange = (value: number) => moneyMarketChange(value * 100, "basis-points");

/** The board's tabs: the US funding rates, bills and Fed liquidity, and Hong Kong's Exchange Fund Bill yields. */
export const MONEY_MARKET_TABS = [{ value: "rates", label: "Rates" }, { value: "bills", label: "Bills" }, { value: "liquidity", label: "Liquidity" },
  { value: "hk", label: "Hong Kong" }] as const;
export const isHongKongTab = (tab: unknown) => tab === "hk";

/** Why a row has no figure, or an old one. */
export function moneyMarketRowNotices(rows: readonly MoneyMarketRow[]): string[] {
  return rows.flatMap((row) => row.status === "unavailable"
    ? [`${row.label}: ${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")}.`]
    : row.status === "stale" ? [`${row.label}: stale, last observation ${row.asOf ?? "unknown"}.`] : []);
}

export function moneyMarketNotices(data: MoneyMarketsPayload): string[] {
  const notices = moneyMarketRowNotices([...data.rows, data.netLiquidity]);
  if (data.billsCurve.status === "unavailable") notices.push("Bills curve: no common observation date across all four tenors.");
  else if (data.billsCurve.status === "stale") notices.push(`Bills curve: stale, last common observation ${data.billsCurve.asOf}.`);
  for (const ghost of data.billsCurve.comparisons) if (!ghost.points.length) notices.push(`Bills ${ghost.period}: no common observation within seven days before ${ghost.targetDate ?? "the comparison date"}.`);
  return notices;
}
export function moneyMarketCurves(data: MoneyMarketsPayload, palette?: CurvePalette): CurveSeries[] {
  const curve = data.billsCurve;
  return [{ id: "today", label: "Latest", ...curve }, ...curve.comparisons.map((ghost) => ({ id: ghost.period, label: ghost.period, ...ghost }))]
    .filter((snapshot) => snapshot.points.length > 0)
    .map((snapshot) => ({ id: snapshot.id, label: snapshot.label, asOf: snapshot.asOf,
      chartVisible: snapshot.id !== "1Y", color: snapshot.id === "today" ? palette?.current : palette?.ghosts[snapshot.id],
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

/**
 * The rank window's fixings. FRED dates bank holidays with no value; no rate
 * was published those days, so charts run across them instead of breaking.
 */
export function moneyMarketObservations(row: MoneyMarketRow): Array<{ date: string; value: number }> {
  return moneyMarketHistory(row).flatMap((point) => point.value == null ? [] : [{ date: point.date, value: point.value }]);
}
