import type { FuturesCurveAsOfPayload, FuturesCurvePayload, FuturesContract } from "../../../api-client/futures-curve";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";
import { spanDigits } from "../../../components/chart-table";
import { compositeAxisTicks } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { FUTURES_CONTRACTS, tickDecimals } from "../futures/contracts";
import { formatPercentileRank } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

export const CURVE_ROOTS = [
  ...FUTURES_CONTRACTS.filter((row) => row.curve !== false).map((row) => ({ value: row.code, label: `${row.code} ${row.name}` })),
  { value: "VX", label: "VX VIX Futures" },
];

export function normalizeCurveRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase().replace(/=F$/, "");
  const root = raw === "VIX" ? "VX" : raw;
  return CURVE_ROOTS.some((row) => row.value === root) ? root : null;
}

/**
 * Treasury futures trade in fractions of a 32nd (ZT to 1/256, ZF 1/128, ZN
 * 1/64, ZB and UB 1/32), so the catalogue leaves their tick unset. A root
 * shows every price at the decimals its tick needs to stay exact (ZT 8, ZN 6),
 * so a column and the M2-M1 spread keep one width: 103.50000000 next to
 * 103.51562500, never 103.50 next to 103.515625.
 */
const RATE_TICKS: Readonly<Record<string, number>> = { ZT: 1 / 256, ZF: 1 / 128, ZN: 1 / 64, ZB: 1 / 32, UB: 1 / 32 };

function curvePriceDecimals(root: string): number {
  const rateTick = RATE_TICKS[root];
  if (rateTick != null) return tickDecimals(rateTick);
  if (root === "VX") return 4;
  const tick = FUTURES_CONTRACTS.find((row) => row.code === root)?.tick;
  return tick == null ? 5 : Math.max(2, tickDecimals(tick));
}

export function curvePrice(value: number | null, root: string): string {
  if (value == null) return "--";
  const text = value.toFixed(curvePriceDecimals(root));
  // A spread that rounds to zero is unsigned: 0.00, never -0.00.
  return /[1-9]/.test(text) ? text : text.replace("-", "");
}

/** A move in price, signed; one that rounds to zero stays unsigned. */
export function curveChangeText(value: number | null, root: string): string {
  const text = curvePrice(value, root);
  return value != null && value > 0 && /[1-9]/.test(text) ? `+${text}` : text;
}

/**
 * Axis gridlines sit on round values, so they need no tick precision: one
 * decimal count across the gutter, as many as the plotted range asks for and
 * enough to keep every tick within a percent of that range. A span of hundreds
 * of index points reads 7800, a VIX strip 18.5, a Treasury 1/64 grid 112.25.
 */
export function curveAxisPrice(value: number, domain: CompositeAxisDomain, root: string): string {
  const cap = curvePriceDecimals(root);
  const tolerance = Math.abs(domain.max - domain.min) / 100;
  const needed = (tick: number) => {
    let decimals = 0;
    while (decimals < cap && Math.abs(Number(tick.toFixed(decimals)) - tick) > tolerance) decimals += 1;
    return decimals;
  };
  const ticks = compositeAxisTicks(domain, String).map((tick) => needed(tick.value));
  return value.toFixed(Math.min(cap, Math.max(spanDigits(domain), ...ticks)));
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
  return formatPercentileRank(value);
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

export function futuresCurveSeries(data: FuturesCurvePayload, palette?: CurvePalette, horizon = DEFAULT_CURVE_HORIZON, now = Date.now(),
  currentLabel = data.source === "cboe" ? "Settlement" : "Latest"): CurveSeries[] {
  const contracts = charted(data.contracts, horizon, now);
  return [{
    id: "current", label: currentLabel, asOf: newestQuote(contracts), color: palette?.current,
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

export type CurveLookback = "1W" | "1M";
export type CurveContractChanges = ReadonlyMap<string, Readonly<Record<CurveLookback, number | null>>>;

/**
 * How far each contract moved since the week- and month-back curves, by
 * symbol: the latest price less the price then. A leg missing either side
 * stays null rather than reading as no move.
 */
export function curveContractChanges(data: FuturesCurvePayload): CurveContractChanges {
  const past = new Map(data.ghosts.map((ghost) => [ghost.label, new Map(ghost.points.map((point) => [point.symbol, point.price]))]));
  return new Map(data.contracts.map((row) => {
    const change = (label: CurveLookback) => {
      const then = past.get(label)?.get(row.symbol);
      return row.price == null || then == null ? null : row.price - then;
    };
    return [row.symbol, { "1W": change("1W"), "1M": change("1M") }];
  }));
}

const CHANGE_COLUMNS: Readonly<Record<string, CurveLookback>> = { change1w: "1W", change1m: "1M" };

type CurveSortKey = "symbol" | "expiration" | "price" | "change" | "openInterest" | "volume" | "percentile" | "asOf";

export function sortCurveContracts(rows: readonly FuturesContract[], id: string, direction: SortDirection,
  changes?: CurveContractChanges): FuturesContract[] {
  const keys: Record<string, CurveSortKey> = { symbol: "symbol", expiry: "expiration", price: "price", change: "change", oi: "openInterest", volume: "volume", percentile: "percentile", asOf: "asOf" };
  const key = keys[id] ?? "expiration";
  const lookback = CHANGE_COLUMNS[id];
  const value = (row: FuturesContract) => lookback ? changes?.get(row.symbol)?.[lookback] ?? null : row[key] ?? null;
  return [...rows].sort((a, b) => compareSortValues(value(a), value(b), direction));
}

const DAY_MS = 86_400_000;

/** A past date for the as-of view: empty (or "latest") for the live curve, else YYYY-MM-DD no later than today. */
export function curveAsOfDate(value: unknown, now = new Date()): string {
  const date = typeof value === "string" ? value.trim() : "";
  if (!date || date.toLowerCase() === "latest") return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Use an as-of date in YYYY-MM-DD format, or latest.");
  }
  if (date > now.toISOString().slice(0, 10)) throw new Error("A futures curve cannot use a future date.");
  return date;
}

export function curveLookbackDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The archived curve on a past date in the live curve's shape, so the pane
 * draws it the same way. Its week- and month-back ghosts are the curves as
 * they stood then, contracts that have since expired included. A row is dated
 * by its session, or by the earlier session its carried price comes from.
 * Percentiles and session changes are not archived, so they stay unavailable.
 */
export function archivedFuturesCurve(root: string, curve: FuturesCurveAsOfPayload,
  lookbacks: { "1W": FuturesCurveAsOfPayload | null; "1M": FuturesCurveAsOfPayload | null }, fetchedAt: string): FuturesCurvePayload {
  const rowDate = (row: FuturesCurveAsOfPayload["contracts"][number]) => row.stale ? row.asOf.slice(0, 10) : row.tradeDate;
  const contracts: FuturesContract[] = curve.contracts.flatMap((row) => row.expiration ? [{
    symbol: row.symbol, label: row.label, expiration: row.expiration, price: row.price, change: null, asOf: rowDate(row),
    currency: curve.currency ?? "USD", quoteUnit: curve.quoteUnit ?? curve.currency ?? "USD", volume: row.volume,
    openInterest: row.openInterest, delayMinutes: null, stale: row.stale, percentile: null, samples: 0, historyStart: null, historyEnd: null,
  }] : []).sort((a, b) => a.expiration.localeCompare(b.expiration));
  const ghosts = (["1W", "1M"] as const).map((label) => {
    const past = lookbacks[label];
    return { label, requestedDate: curveLookbackDate(curve.date, label === "1W" ? 7 : 30), asOf: past?.asOf ?? null,
      points: (past?.contracts ?? []).flatMap((row) => row.expiration
        ? [{ symbol: row.symbol, expiration: row.expiration, price: row.price, asOf: rowDate(row) }] : []) };
  });
  // The front pair on the curve's own session; carried prices do not make a spread.
  const [front, next] = contracts.filter((row) => !row.stale);
  const value = front && next ? next.price! - front.price! : null;
  const days = front && next ? (Date.parse(next.expiration) - Date.parse(front.expiration)) / DAY_MS : 0;
  const roll = front && next && front.price! > 0 && next.price! > 0 && days > 0 ? (front.price! / next.price! - 1) * 365 / days * 100 : null;
  return {
    root, name: curve.name, source: root === "VX" ? "cboe" : "yahoo", currency: curve.currency, quoteUnit: curve.quoteUnit,
    asOf: curve.asOf, fetchedAt, status: !contracts.length ? "unavailable" : curve.gaps.length ? "partial" : "available", stale: false,
    catalogue: { method: "provider", complete: true, horizonEnd: null }, contracts, ghosts,
    slope: { frontSymbol: front?.symbol ?? null, nextSymbol: next?.symbol ?? null, value, annualizedRollYield: roll, percentile: null,
      rollPercentile: null, samples: 0, historyStart: null, historyEnd: null, asOf: front && next ? curve.asOf : null,
      state: value == null ? "unavailable" : Math.abs(value) < 1e-10 ? "flat" : value > 0 ? "contango" : "backwardation" },
    gaps: curve.gaps,
  };
}
