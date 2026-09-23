import type { FuturesCurvePayload, FuturesContract } from "../../../api-client/futures-curve";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";
import { compositeAxisTicks } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { FUTURES_CONTRACTS, tickDecimals } from "../futures/contracts";

export const CURVE_ROOTS = [...FUTURES_CONTRACTS.map((row) => ({ value: row.code, label: `${row.code} ${row.name}` })), { value: "VX", label: "VX VIX Futures" }];

export function normalizeCurveRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase().replace(/=F$/, "");
  const root = raw === "VIX" ? "VX" : raw;
  return CURVE_ROOTS.some((row) => row.value === root) ? root : null;
}

/**
 * Treasury futures trade in fractions of a 32nd (ZT to 1/256, ZF 1/128, ZN
 * 1/64, ZB and UB 1/32): the decimals that hold every tick exactly. A fixed
 * five decimals put 105.265625 off the tick grid at 105.26563.
 */
const RATE_TICK_DECIMALS: Readonly<Record<string, number>> = { ZT: 8, ZF: 7, ZN: 6, ZB: 5, UB: 5 };
const trimZeros = (text: string, minimum: number) => {
  const [whole, fraction = ""] = text.split(".");
  const kept = fraction.replace(/0+$/, "").padEnd(minimum, "0");
  return kept ? `${whole}.${kept}` : whole!;
};

export function curvePrice(value: number | null, root: string): string {
  if (value == null) return "--";
  const rateDecimals = RATE_TICK_DECIMALS[root];
  if (rateDecimals != null) return trimZeros(value.toFixed(rateDecimals), 2);
  const tick = FUTURES_CONTRACTS.find((row) => row.code === root)?.tick;
  return value.toFixed(root === "VX" ? 4 : tick == null ? 5 : Math.max(2, tickDecimals(tick)));
}

/**
 * Axis gridlines sit on round values, so they need no tick precision: one
 * decimal count across the gutter, only as many as those values use.
 */
export function curveAxisPrice(value: number, domain: CompositeAxisDomain, root: string): string {
  if (RATE_TICK_DECIMALS[root] == null) return curvePrice(value, root);
  const decimals = Math.max(0, ...compositeAxisTicks(domain, String)
    .map((tick) => trimZeros(tick.value.toFixed(4), 0).split(".")[1]?.length ?? 0));
  return value.toFixed(decimals);
}

const MONTH_CODES = "FGHJKMNQUVXZ";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The delivery month a trader names a contract by ("Nov 26" for CLX26), not
 * its last trading day: crude's November contract expires in October, and a
 * "26-10-20" label also reads as a day-first date.
 */
export function curveContractMonth(symbol: string, expiration: string): string {
  const coded = /^[A-Z0-9]+?([FGHJKMNQUVXZ])(\d{2})\.[A-Z]+$/.exec(symbol);
  if (coded) return `${MONTH_NAMES[MONTH_CODES.indexOf(coded[1]!)]} ${coded[2]}`;
  return `${MONTH_NAMES[Number(expiration.slice(5, 7)) - 1] ?? expiration.slice(5, 7)} ${expiration.slice(2, 4)}`;
}

export function curveTimestamp(value: string | null): string {
  return value?.replace("T", " ").slice(0, 16) ?? "--";
}

/** The rank against the contract's own history; one observation ranks nothing. */
export function curveRank(value: number | null, samples: number): string {
  if (value == null || samples < 2) return "pctl unavailable";
  return `${value.toFixed(0)} pctl`;
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
    points: contracts.map((row) => ({ id: row.symbol, label: curveContractMonth(row.symbol, row.expiration), x: Date.parse(row.expiration), value: row.price, asOf: row.asOf })),
  }, ...data.ghosts.map((ghost) => {
    // The payload dates a ghost by its oldest point, which can be a contract beyond the charted horizon.
    const points = charted(ghost.points, horizon, now);
    const asOf = newestQuote(points);
    return {
      id: ghost.label, label: asOf ? ghost.label : `${ghost.label} unavailable`, asOf, color: palette?.ghosts[ghost.label], chartVisible: ghost.label !== "1Y",
      points: points.map((row) => ({ id: row.symbol, label: curveContractMonth(row.symbol, row.expiration), x: Date.parse(row.expiration), value: row.price, asOf: row.asOf })),
    };
  })];
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
