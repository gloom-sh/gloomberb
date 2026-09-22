import type { FuturesCurvePayload, FuturesContract } from "../../../api-client/futures-curve";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";
import { FUTURES_CONTRACTS, tickDecimals } from "../futures/contracts";

export const CURVE_ROOTS = [...FUTURES_CONTRACTS.map((row) => ({ value: row.code, label: `${row.code} ${row.name}` })), { value: "VX", label: "VX VIX Futures" }];

export function normalizeCurveRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase().replace(/=F$/, "");
  const root = raw === "VIX" ? "VX" : raw;
  return CURVE_ROOTS.some((row) => row.value === root) ? root : null;
}

export function curvePrice(value: number | null, root: string): string {
  const tick = FUTURES_CONTRACTS.find((row) => row.code === root)?.tick;
  const precision = root === "VX" ? 4 : tick == null ? 5 : Math.max(2, tickDecimals(tick));
  return value == null ? "--" : value.toFixed(precision);
}

export function curveTimestamp(value: string | null): string {
  return value?.replace("T", " ").slice(0, 16) ?? "--";
}

export function curveRank(value: number | null, samples: number, start: string | null, end: string | null): string {
  if (value == null || samples < 2) return "pctl unavailable";
  return `${value.toFixed(0)} pctl · ${samples} obs · ${start ?? "--"} to ${end ?? "--"}`;
}

export const CURVE_HORIZONS = [
  { value: "12", label: "12 months" }, { value: "24", label: "24 months" }, { value: "36", label: "36 months" }, { value: "all", label: "Every listed contract" },
] as const;
export const DEFAULT_CURVE_HORIZON = "36";

/** The payload's asOf is its oldest quote. The freshest quote is what "latest" means to a reader. */
export function newestQuote(contracts: readonly { asOf: string | null }[]): string | null {
  return contracts.reduce<string | null>((newest, row) => row.asOf && (!newest || row.asOf > newest) ? row.asOf : newest, null);
}

/**
 * Chart the contracts expiring within the horizon. A crude strip lists ten
 * years of months; drawn end to end, the liquid front two years collapse into
 * a sliver while contracts quoted years ago shape the curve. The table keeps
 * every contract.
 */
export function charted<T extends { expiration: string }>(rows: readonly T[], horizon: string, now: number): T[] {
  const months = Number(horizon);
  if (!Number.isFinite(months) || months <= 0) return [...rows];
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + months);
  return rows.filter((row) => Date.parse(row.expiration) <= end.getTime());
}

export function futuresCurveSeries(data: FuturesCurvePayload, palette?: CurvePalette, horizon = DEFAULT_CURVE_HORIZON, now = Date.now()): CurveSeries[] {
  const contracts = charted(data.contracts, horizon, now);
  return [{
    id: "current", label: data.source === "cboe" ? "Settlement" : "Latest", asOf: newestQuote(contracts), color: palette?.current,
    points: contracts.map((row) => ({ id: row.symbol, label: row.expiration.slice(2), x: Date.parse(row.expiration), value: row.price, asOf: row.asOf })),
  }, ...data.ghosts.map((ghost) => ({
    id: ghost.label, label: ghost.asOf ? ghost.label : `${ghost.label} unavailable`, asOf: ghost.asOf, color: palette?.ghosts[ghost.label], chartVisible: ghost.label !== "1Y",
    points: charted(ghost.points, horizon, now).map((row) => ({ id: row.symbol, label: row.expiration.slice(2), x: Date.parse(row.expiration), value: row.price, asOf: row.asOf })),
  }))];
}

export function sortCurveContracts(rows: readonly FuturesContract[], id: string, direction: "asc" | "desc"): FuturesContract[] {
  const keys: Record<string, keyof FuturesContract> = { symbol: "symbol", expiry: "expiration", price: "price", oi: "openInterest", volume: "volume", percentile: "percentile", asOf: "asOf" };
  const key = keys[id] ?? "expiration";
  return [...rows].sort((a, b) => {
    const left = a[key], right = b[key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return direction === "asc" ? order : -order;
  });
}
