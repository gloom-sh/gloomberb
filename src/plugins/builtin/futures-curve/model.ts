import type { FuturesCurveAsOfPayload, FuturesCurvePayload, FuturesContract } from "../../../api-client/futures-curve";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";
import { spanDigits } from "../../../components/chart-table";
import { compositeAxisTicks } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { FUTURES_CONTRACTS, tickDecimals } from "../futures/contracts";
import { formatPercentileRank } from "../../../utils/format";
import { cryptoPairCoin, isFuturesSymbol } from "../shared/crypto-pair";
import { parseReportTime } from "../../../utils/utc-time";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

/**
 * CME crypto futures have a curve but no FUT board row, so their name and tick
 * live here rather than in the catalogue the board lists. Outright ticks:
 * BTC $5, ETH $0.50, SOL $0.05, XRP $0.0005 (each $25 a contract).
 */
const CRYPTO_CURVE_ROOTS: readonly { code: string; name: string; tick: number }[] = [
  { code: "BTC", name: "Bitcoin", tick: 5 }, { code: "ETH", name: "Ether", tick: 0.5 },
  { code: "SOL", name: "Solana", tick: 0.05 }, { code: "XRP", name: "XRP", tick: 0.0005 },
];
const rootLabel = (code: string, name: string) => name === code ? code : `${code} ${name}`;

export const CURVE_ROOTS = [
  ...FUTURES_CONTRACTS.filter((row) => row.curve !== false).map((row) => ({ value: row.code, label: rootLabel(row.code, row.name) })),
  { value: "VX", label: "VX VIX Futures" },
  ...CRYPTO_CURVE_ROOTS.map((row) => ({ value: row.code, label: rootLabel(row.code, row.name) })),
];

/** A root typed as an argument, a stored pane setting or a request: every listed root, crypto included. */
export function normalizeCurveRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase().replace(/=F$/, "");
  const root = raw === "VIX" ? "VX" : raw;
  return CURVE_ROOTS.some((row) => row.value === root) ? root : null;
}

/** What a root nothing lists is told, with roots that work. */
export function unsupportedCurveRootMessage(value: unknown): string {
  const examples = ["ES", "CL", "GC", "ZN"].filter((root) => CURVE_ROOTS.some((row) => row.value === root));
  return `Unsupported futures root: ${String(value)}. Try ${examples.join(", ")}.`;
}

/**
 * The root for the ticker under the cursor, when CTM is opened without an
 * argument. The crypto roots are also US ticker symbols (Grayscale's mini
 * trusts are BTC and ETH), so a bare one is the equity's, never the future's:
 * only a futures symbol (BTC=F) or a coin pair (BTC-USD) names the crypto curve.
 */
export function curveRootForTicker(ticker: unknown): string | null {
  if (typeof ticker !== "string") return null;
  const coin = cryptoPairCoin(ticker);
  if (coin) return CRYPTO_CURVE_ROOTS.some((row) => row.code === coin) ? coin : null;
  const root = normalizeCurveRoot(ticker);
  return root && CRYPTO_CURVE_ROOTS.some((row) => row.code === root) && !isFuturesSymbol(ticker) ? null : root;
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
  const tick = FUTURES_CONTRACTS.find((row) => row.code === root)?.tick ?? CRYPTO_CURVE_ROOTS.find((row) => row.code === root)?.tick;
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
function charted<T extends { expiration: string }>(rows: readonly T[], horizon: string, now: number): T[] {
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

type CurveLookback = "1W" | "1M";
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

const BASIS_COLUMNS: Readonly<Record<string, "vsSpotPct" | "annualisedBasisPct">> = { vsSpot: "vsSpotPct", annBasis: "annualisedBasisPct" };

export function sortCurveContracts(rows: readonly FuturesContract[], id: string, direction: SortDirection,
  changes?: CurveContractChanges, basis?: CurveBasisRows): FuturesContract[] {
  const keys: Record<string, CurveSortKey> = { symbol: "symbol", expiry: "expiration", price: "price", change: "change", oi: "openInterest", volume: "volume", percentile: "percentile", asOf: "asOf" };
  const key = keys[id] ?? "expiration";
  const lookback = CHANGE_COLUMNS[id];
  const basisKey = BASIS_COLUMNS[id];
  const value = (row: FuturesContract) => lookback ? changes?.get(row.symbol)?.[lookback] ?? null
    : basisKey ? basis?.get(row.symbol)?.[basisKey] ?? null : row[key] ?? null;
  return [...rows].sort((a, b) => compareSortValues(value(a), value(b), direction));
}

const DAY_MS = 86_400_000;

/**
 * The quote each crypto root's basis is measured against: the terminal's USD
 * pair, the same quote every other pane shows, not the CME reference rate, so
 * a small gap to settlement is expected. A root missing here has no basis
 * columns; add its spot symbol to give it some.
 */
const BASIS_SPOT_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["BTC", "BTC-USD"], ["ETH", "ETH-USD"], ["SOL", "SOL-USD"], ["XRP", "XRP-USD"],
]);

export function basisSpotSymbol(root: string): string | null {
  return BASIS_SPOT_SYMBOLS.get(root) ?? null;
}

/** Crypto trades around the clock, so a spot quote older than this no longer prices a live future. */
const SPOT_STALE_MS = 10 * 60_000;
/** A free account's quote is held back on purpose; that delay is not staleness, so it is allowed on top. */
const DELAYED_SPOT_MS = 15 * 60_000;

/** The spot a curve's basis uses, or why there is none. `asOf` is the quote's own time, never the fetch's. */
export interface CurveSpot {
  symbol: string;
  price: number | null;
  /** UTC ISO instant of the quote. */
  asOf: string | null;
  status: "ok" | "stale" | "missing";
  reason: string | null;
}

export interface SpotQuote {
  price: number;
  lastUpdated: number;
  stale?: boolean;
  dataSource?: string;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function quoteAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Judges one spot quote at `now`: usable, older than the rule allows, or absent. */
export function curveSpot(symbol: string, quote: SpotQuote | null | undefined, now: number): CurveSpot {
  if (!quote || !positive(quote.price)) return { symbol, price: null, asOf: null, status: "missing", reason: `no ${symbol} quote` };
  const time = quote.lastUpdated;
  if (!Number.isFinite(time) || time <= 0) {
    return { symbol, price: quote.price, asOf: null, status: "stale", reason: `${symbol} quote has no time` };
  }
  const asOf = new Date(time).toISOString().replace(".000Z", "Z");
  const age = now - time;
  const limit = SPOT_STALE_MS + (quote.dataSource === "delayed" ? DELAYED_SPOT_MS : 0);
  if (age > limit) return { symbol, price: quote.price, asOf, status: "stale", reason: `${symbol} quote is ${quoteAge(age)} old` };
  if (quote.stale === true) return { symbol, price: quote.price, asOf, status: "stale", reason: `${symbol} quote is stale` };
  return { symbol, price: quote.price, asOf, status: "ok", reason: null };
}

/** How far the contract trades over (positive) or under spot, in percent. */
export function vsSpotPct(futures: number | null | undefined, spot: number | null | undefined): number | null {
  return positive(futures) && positive(spot) ? (futures / spot - 1) * 100 : null;
}

/** Calendar days from the UTC date of the spot's timestamp to the contract's expiration date. */
export function daysToExpiry(spotTime: number, expiration: string): number | null {
  const expiry = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(spotTime) || !Number.isFinite(expiry)) return null;
  const spotDay = Date.parse(`${new Date(spotTime).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((expiry - spotDay) / DAY_MS);
}

/** The premium over spot as a yearly rate, on a 365-day year. Blank on or past expiry, where it has no meaning. */
export function annualisedBasisPct(futures: number | null | undefined, spot: number | null | undefined, days: number | null): number | null {
  if (!positive(futures) || !positive(spot) || days == null || !Number.isFinite(days) || days <= 0) return null;
  return (futures / spot - 1) * 365 / days * 100;
}

/** A contract that printed longer than this before the spot quote is too old to read against it. */
const CONTRACT_PRINT_MAX_AGE_MS = 60 * 60_000;

export interface ContractBasis {
  vsSpotPct: number | null;
  annualisedBasisPct: number | null;
  /** Priced and not flagged stale, but its last print is over an hour before spot: a thin month. */
  thin: boolean;
}

const NO_BASIS: ContractBasis = { vsSpotPct: null, annualisedBasisPct: null, thin: false };

/**
 * One contract's basis. Blank without a usable spot, and for a contract whose
 * own price is missing or stale: an old future against a live spot misleads.
 * So does a print more than an hour older than the spot (`thin`): the server's
 * stale flag allows two sessions, which a quote that moves all day outruns. A
 * date-only `asOf` is UTC midnight of that date, one that cannot be read
 * counts as old, and a print newer than the spot is never old (the spot of a
 * delayed feed trails the futures).
 */
export function contractBasis(row: Pick<FuturesContract, "price" | "stale" | "expiration" | "asOf">, spot: CurveSpot): ContractBasis {
  if (spot.status !== "ok" || spot.asOf == null || row.stale) return NO_BASIS;
  const vs = vsSpotPct(row.price, spot.price);
  if (vs == null) return NO_BASIS;
  const spotTime = Date.parse(spot.asOf);
  const printed = parseReportTime(row.asOf)?.time ?? null;
  if (printed == null || spotTime - printed > CONTRACT_PRINT_MAX_AGE_MS) return { ...NO_BASIS, thin: true };
  return { vsSpotPct: vs, annualisedBasisPct: annualisedBasisPct(row.price, spot.price, daysToExpiry(spotTime, row.expiration)), thin: false };
}

/** A basis in percent, signed; one that rounds to zero stays unsigned. */
export function curveBasisPercent(value: number | null, decimals: number): string {
  if (value == null) return "--";
  const text = Math.abs(value).toFixed(decimals);
  return /[1-9]/.test(text) ? `${value > 0 ? "+" : "-"}${text}%` : `${text}%`;
}

/** The footer's spot: `spot BTC-USD 67,250.10 · 07:25 UTC`, with the date when the quote is not from today. */
export function curveSpotLabel(spot: CurveSpot, root: string, now: number): string {
  const decimals = curvePriceDecimals(root);
  const price = spot.price == null ? "--" : spot.price.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const stamp = curveTimestamp(spot.asOf);
  const today = new Date(now).toISOString().slice(0, 10);
  return `spot ${spot.symbol} ${price} · ${spot.asOf?.startsWith(today) ? stamp.slice(11) : stamp} UTC`;
}

/** The basis columns' sort values, which live beside the contract rather than on it. */
export type CurveBasisRows = ReadonlyMap<string, ContractBasis>;

export function curveBasisRows(rows: readonly FuturesContract[], spot: CurveSpot | null): CurveBasisRows {
  return new Map(rows.map((row) => [row.symbol, spot ? contractBasis(row, spot) : NO_BASIS]));
}

/** The contracts a good spot left blank for their old print. */
export function thinContractCount(basis: Iterable<ContractBasis>): number {
  let count = 0;
  for (const row of basis) if (row.thin) count += 1;
  return count;
}

/** The footer warning that thin contracts have no basis: the pane's `!` notice, which keeps the footer row for the quote times. */
export function thinContractsNotice(count: number): string {
  return `Basis blank on ${count} thin contract${count === 1 ? "" : "s"} (last print over 1h before spot)`;
}

/** A past date for the as-of view: empty (or "latest") for the live curve, else YYYY-MM-DD no later than today. */
export function curveAsOfDate(value: unknown, now = new Date()): string {
  const date = typeof value === "string" ? value.trim() : "";
  if (!date || date.toLowerCase() === "latest") return "";
  const time = Date.parse(`${date}T00:00:00Z`);
  // A month or day out of range parses to NaN or rolls over; both are refused.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new Error("Use an as-of date in YYYY-MM-DD format, or latest.");
  }
  if (date > now.toISOString().slice(0, 10)) throw new Error("A futures curve cannot use a future date.");
  return date;
}

export function curveLookbackDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

type ArchivedRow = FuturesCurveAsOfPayload["contracts"][number];

/**
 * Whether a row's price is older than its curve's session. The archive marks
 * a row stale when it has no price made on the requested date, which on a
 * weekend, a holiday or today before the settlement is every row. The curve's
 * session is its newest row, so a row is stale when it is older than that or
 * carries an earlier price, which the archive dates before the row.
 */
function archivedRowStale(row: ArchivedRow, curve: FuturesCurveAsOfPayload): boolean {
  const session = curve.asOf;
  if (!session || session >= curve.date) return row.stale;
  return row.tradeDate < session || row.asOf.slice(0, 10) < row.tradeDate;
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
  const rowDate = (row: ArchivedRow, stale: boolean) => stale ? row.asOf.slice(0, 10) : row.tradeDate;
  const contracts: FuturesContract[] = curve.contracts.flatMap((row) => {
    if (!row.expiration) return [];
    const stale = archivedRowStale(row, curve);
    return [{
      symbol: row.symbol, label: row.label, expiration: row.expiration, price: row.price, change: null, asOf: rowDate(row, stale),
      currency: curve.currency ?? "USD", quoteUnit: curve.quoteUnit ?? curve.currency ?? "USD", volume: row.volume,
      openInterest: row.openInterest, delayMinutes: null, stale, percentile: null, samples: 0, historyStart: null, historyEnd: null,
    }];
  }).sort((a, b) => a.expiration.localeCompare(b.expiration));
  const ghosts = (["1W", "1M"] as const).map((label) => {
    const past = lookbacks[label];
    return { label, requestedDate: curveLookbackDate(curve.date, label === "1W" ? 7 : 30), asOf: past?.asOf ?? null,
      points: past ? past.contracts.flatMap((row) => row.expiration
        ? [{ symbol: row.symbol, expiration: row.expiration, price: row.price, asOf: rowDate(row, archivedRowStale(row, past)) }] : []) : [] };
  });
  // The front pair on the curve's own session; carried prices do not make a spread.
  const [front, next] = contracts.filter((row) => !row.stale);
  const value = front && next ? next.price! - front.price! : null;
  const days = front && next ? (Date.parse(next.expiration) - Date.parse(front.expiration)) / DAY_MS : 0;
  const roll = front && next && front.price! > 0 && next.price! > 0 && days > 0 ? (front.price! / next.price! - 1) * 365 / days * 100 : null;
  return {
    root, name: curve.name, source: root === "VX" ? "cboe" : "gloom", currency: curve.currency, quoteUnit: curve.quoteUnit,
    asOf: curve.asOf, fetchedAt, status: !contracts.length ? "unavailable" : curve.gaps.length ? "partial" : "available", stale: false,
    catalogue: { method: "provider", complete: true, horizonEnd: null }, contracts, ghosts,
    slope: { frontSymbol: front?.symbol ?? null, nextSymbol: next?.symbol ?? null, value, annualizedRollYield: roll, percentile: null,
      rollPercentile: null, samples: 0, historyStart: null, historyEnd: null, asOf: front && next ? curve.asOf : null,
      state: value == null ? "unavailable" : Math.abs(value) < 1e-10 ? "flat" : value > 0 ? "contango" : "backwardation" },
    gaps: curve.gaps,
  };
}
