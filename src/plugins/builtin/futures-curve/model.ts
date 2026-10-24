import type { FuturesCurveAsOfPayload, FuturesCurvePayload, FuturesContract } from "../../../api-client/futures-curve";
import type { CurvePalette, CurveSeries } from "../../../components/chart/curve/model";
import { spanDigits } from "../../../components/chart-table";
import { compositeAxisTicks } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { FUTURES_CONTRACTS, futuresBoardContractForTicker, futuresContractByCode, tickDecimals } from "../../../market-data/futures-board";
import { contractMonthLabel } from "../../../utils/contract-month";
import { formatPercentileRank } from "../../../utils/format";
import { cryptoPairCoin, isFuturesSymbol } from "../shared/crypto-pair";
import { parseReportTime } from "../../../utils/utc-time";
import { zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import { dateOptionError, dateOptionFormatsOr, readCalendarDate } from "../../../utils/calendar-date";
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
  ...FUTURES_CONTRACTS.map((row) => ({ value: row.code, label: rootLabel(row.code, row.name) })),
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

/**
 * A curve's window title, its root ("Curve · BZ"), so two curves open at once
 * are told apart in their windows and in the layout list.
 */
export function curveTitle(root: string): string {
  return `Curve · ${root}`;
}

/** The root a curve pane shows: its setting, else what it was opened with, else ES. */
export function paneCurveRoot(pane: { settings?: Record<string, unknown>; params?: Record<string, string> } | null | undefined): unknown {
  return pane?.settings?.root ?? pane?.params?.root ?? "ES";
}

/** What a root CTM does not list is told: the roots that work, with the FUT board's, VIX and CME crypto named by group. */
export function unsupportedCurveRootMessage(value: unknown): string {
  const typed = String(value).trim().toUpperCase().replace(/=F$/, "");
  const examples = ["ES", "CL", "GC", "ZN"].filter((root) => CURVE_ROOTS.some((row) => row.value === root));
  return `No futures curve for ${typed || "that root"}: CTM covers the FUT board's roots, VIX and CME crypto, such as ${examples.join(", ")}.`;
}

/**
 * Board roots whose bare code opens their curve from the ticker under the
 * cursor. Several are also listed securities (ES Eversource, NG NovaGold, PL
 * Planet Labs), but they followed the cursor before the board was checked
 * against listed securities and keep doing so. A root added after that (ZM is
 * Zoom, KE, LE, HE and ALI are tickers too) follows the cursor only as its
 * `=F` symbol or a code no security answers to (`bareCode`: ZL, OJ, LBR), the
 * rule FUT and COT apply, so a new board row defaults to the security.
 */
const CURSOR_BARE_ROOTS: ReadonlySet<string> = new Set(["ES", "CL", "BZ", "NG", "RB", "HO", "GC", "SI", "HG", "PL", "PA", "ZC", "ZS", "KC", "SB", "CC"]);

/**
 * The root for the ticker under the cursor, when CTM is opened without an
 * argument. The crypto roots are also US ticker symbols (Grayscale's mini
 * trusts are BTC and ETH), so a bare one is the equity's, never the future's:
 * only a futures symbol (BTC=F) or a coin pair (BTC-USD) names the crypto curve.
 * A typed argument is different: `CTM ZM` is soybean meal even though ZM is also Zoom.
 */
export function curveRootForTicker(ticker: unknown): string | null {
  if (typeof ticker !== "string") return null;
  const coin = cryptoPairCoin(ticker);
  if (coin) return CRYPTO_CURVE_ROOTS.some((row) => row.code === coin) ? coin : null;
  const root = normalizeCurveRoot(ticker);
  if (!root) return null;
  if (CRYPTO_CURVE_ROOTS.some((row) => row.code === root)) return isFuturesSymbol(ticker) ? root : null;
  const isBoardRoot = futuresContractByCode(root) != null;
  return isBoardRoot && !CURSOR_BARE_ROOTS.has(root) ? futuresBoardContractForTicker(ticker)?.code ?? null : root;
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
  const tick = futuresContractByCode(root)?.tick ?? CRYPTO_CURVE_ROOTS.find((row) => row.code === root)?.tick;
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

/** A price as a number at the root's display precision, for reports: 59.299805 reads 59.3, never float noise. */
export function curveRoundedPrice(value: number | null | undefined, root: string): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(curvePriceDecimals(root)));
}

/** The unit the catalogue gives a root whose contract terms the server does not send: "EUR / MWh" for Dutch TTF gas. */
export function catalogueCurveUnit(root: string): string | null {
  return futuresContractByCode(root)?.unit ?? null;
}

/**
 * What a price counts: the exchange's unit ("USD / troy oz") where the root's
 * terms are known, the catalogue's where they are not, else the quote unit.
 */
export function curveUnitLabel(data: Pick<FuturesCurvePayload, "root" | "spec" | "quoteUnit" | "currency">): string | null {
  return data.spec?.unit ?? catalogueCurveUnit(data.root) ?? data.quoteUnit ?? data.currency ?? null;
}

/** A contract as traders write it: GCZ26.CMX is GCZ26; a VX symbol stays as Cboe lists it. */
export function curveContractCode(symbol: string): string {
  return symbol.replace(/\.[A-Z]+$/, "");
}

/**
 * The front spread named by the contracts it subtracts, "GCF27-GCZ26": the
 * next contract less the front one. The front is the first contract the
 * market trades, which can be past a delivery month nobody holds, so a bare
 * "M2-M1" would not say which rows it means.
 */
export function curveSpreadLabel(slope: Pick<FuturesCurvePayload["slope"], "frontSymbol" | "nextSymbol">): string {
  return slope.frontSymbol && slope.nextSymbol ? `${curveContractCode(slope.nextSymbol)}-${curveContractCode(slope.frontSymbol)}` : "M2-M1";
}

/** A leg that traded fewer lots than this in its session is too thin to call a curve's slope from. */
export const THIN_SPREAD_LOTS = 20;

/**
 * What the front spread subtracts, as its figure says it: "settle 10-22" for
 * two settlements of a session (the Settle column's date), "last 20:59" for
 * two last trades made together, dated when not the newest quote's day. Null
 * when the server does not say.
 */
export function curveSpreadBasis(slope: Pick<FuturesCurvePayload["slope"], "basis" | "asOf">, newest: string | null): string | null {
  if (!slope.basis || !slope.asOf) return null;
  if (slope.basis === "settle" || !slope.asOf.includes("T")) return `${slope.basis} ${slope.asOf.slice(5, 10)}`;
  const stamp = curveTimestamp(slope.asOf);
  return `last ${newest?.includes("T") && curveTimestamp(newest).slice(0, 10) === stamp.slice(0, 10) ? stamp.slice(11) : stamp.slice(5)}`;
}

/**
 * Why the front spread is thin, from its thin leg's row: "ALIX26 traded 4 lots"
 * or "ALIX26 last traded 2026-10-22". Null when it is not thin.
 */
export function thinSpreadReason(data: Pick<FuturesCurvePayload, "slope" | "contracts">): string | null {
  if (data.slope.state !== "thin") return null;
  const leg = data.contracts.find((row) => row.symbol === data.slope.thinSymbol);
  if (!leg) return null;
  const code = curveContractCode(leg.symbol);
  if (leg.volume != null && leg.volume < THIN_SPREAD_LOTS) return `${code} traded ${leg.volume} lot${leg.volume === 1 ? "" : "s"}`;
  return leg.asOf ? `${code} last traded ${leg.asOf.slice(0, 10)}` : `${code} has not traded`;
}

/** The warning a thin front spread carries: why, and that its sign is no slope call. */
export function thinSpreadNotice(data: Pick<FuturesCurvePayload, "slope" | "contracts">): string | null {
  const reason = thinSpreadReason(data);
  return reason ? `${curveSpreadLabel(data.slope)} is thin (${reason}): no contango or backwardation call` : null;
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

/**
 * The delivery month a trader names a contract by ("Nov 2026" for CLX26), not
 * its last trading day: crude's November contract expires in October, and a
 * "26-10-20" label also reads as a day-first date.
 */
export function curveContractMonth(symbol: string, expiration: string): string {
  const coded = /^[A-Z0-9]+?([FGHJKMNQUVXZ])(\d{2})\.[A-Z]+$/.exec(symbol);
  if (coded) return contractMonthLabel(Number(coded[2]), MONTH_CODES.indexOf(coded[1]!));
  return contractMonthLabel(Number(expiration.slice(0, 4)), Number(expiration.slice(5, 7)) - 1);
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

type CurveSortKey = "symbol" | "expiration" | "price" | "settlement" | "firstNotice" | "change" | "openInterest" | "volume" | "percentile" | "asOf";

const BASIS_COLUMNS: Readonly<Record<string, "vsSpotPct" | "annualisedBasisPct">> = { vsSpot: "vsSpotPct", annBasis: "annualisedBasisPct" };

export function sortCurveContracts(rows: readonly FuturesContract[], id: string, direction: SortDirection,
  changes?: CurveContractChanges, basis?: CurveBasisRows): FuturesContract[] {
  const keys: Record<string, CurveSortKey> = { symbol: "symbol", expiry: "expiration", price: "price", settle: "settlement", notice: "firstNotice",
    change: "change", oi: "openInterest", volume: "volume", percentile: "percentile", asOf: "asOf" };
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

/**
 * The listing codes the quote path reports for a spot, in plain words: a
 * reader is told what the price is, never handed a bare code.
 */
const SPOT_VENUE_LABELS: Readonly<Record<string, string>> = { CCC: "crypto composite price" };

/**
 * The latest spot quote, which the footer shows beside the curve, or why there
 * is none. `asOf` is the quote's own time, never the fetch's. The basis does
 * not read it: each contract is read against the spot in its own minute.
 */
export interface CurveSpot {
  symbol: string;
  price: number | null;
  /** UTC ISO instant of the quote. */
  asOf: string | null;
  status: "ok" | "stale" | "missing";
  reason: string | null;
  /** What the quote path reports the price is, in plain words (`crypto composite price`), when it reports it. */
  venue?: string;
  /** Whether the quote is real-time or held back, as the quote path reports it. */
  feed?: "real-time" | "delayed";
}

export interface SpotQuote {
  price: number;
  lastUpdated: number;
  stale?: boolean;
  dataSource?: string;
  listingExchangeName?: string;
  exchangeName?: string;
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
  // What the quote path says about the quote itself, kept beside the price so the footer can name it.
  const code = (quote.listingExchangeName || quote.exchangeName)?.trim();
  const venue = code ? SPOT_VENUE_LABELS[code.toUpperCase()] ?? code : undefined;
  const feed: CurveSpot["feed"] = quote.dataSource === "live" ? "real-time" : quote.dataSource === "delayed" ? "delayed" : undefined;
  const source = { ...venue ? { venue } : {}, ...feed ? { feed } : {} };
  const time = quote.lastUpdated;
  if (!Number.isFinite(time) || time <= 0) {
    return { symbol, price: quote.price, asOf: null, status: "stale", reason: `${symbol} quote has no time`, ...source };
  }
  const asOf = new Date(time).toISOString().replace(".000Z", "Z");
  const age = now - time;
  const limit = SPOT_STALE_MS + (quote.dataSource === "delayed" ? DELAYED_SPOT_MS : 0);
  if (age > limit) return { symbol, price: quote.price, asOf, status: "stale", reason: `${symbol} quote is ${quoteAge(age)} old`, ...source };
  if (quote.stale === true) return { symbol, price: quote.price, asOf, status: "stale", reason: `${symbol} quote is stale`, ...source };
  return { symbol, price: quote.price, asOf, status: "ok", reason: null, ...source };
}

const MINUTE_MS = 60_000;
const minuteOf = (time: number) => Math.floor(time / MINUTE_MS) * MINUTE_MS;
const isoMinute = (time: number) => new Date(time).toISOString().replace(":00.000Z", ":00Z");

/** The spot in one UTC minute: the close of the spot pair's one-minute bar that opened then. */
export interface SpotBar {
  /** Epoch milliseconds of the minute's start. */
  minute: number;
  price: number;
}

/** One-minute bars as the spot by minute, oldest first; a bar with no usable time or close is left out. */
export function spotBarsFromHistory(points: readonly { date: Date | string | number; close: number }[]): SpotBar[] {
  const byMinute = new Map<number, number>();
  for (const point of points) {
    const time = new Date(point.date).getTime();
    if (Number.isFinite(time) && positive(point.close)) byMinute.set(minuteOf(time), point.close);
  }
  return [...byMinute].sort((a, b) => a[0] - b[0]).map(([minute, price]) => ({ minute, price }));
}

/** The bar in `minute`, else the one nearest it; null when there are none. */
function nearestSpotBar(bars: readonly SpotBar[], minute: number): SpotBar | null {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const bar = bars[middle]!;
    if (bar.minute === minute) return bar;
    if (bar.minute < minute) low = middle + 1;
    else high = middle - 1;
  }
  const before = bars[high];
  const after = bars[low];
  if (!before) return after ?? null;
  if (!after) return before;
  return minute - before.minute <= after.minute - minute ? before : after;
}

/** How far a contract trades over (positive) or under spot, in percent. */
export function vsSpotPct(futures: number | null | undefined, spot: number | null | undefined): number | null {
  return positive(futures) && positive(spot) ? (futures / spot - 1) * 100 : null;
}

/**
 * CME's crypto futures stop trading at 4:00 p.m. London time on their last
 * trading day and settle to the CME CF reference rate published then, so a
 * contract's days to expiry run to that instant, not to a calendar date.
 */
const FINAL_SETTLEMENT = { timeZone: "Europe/London", hour: 16 } as const;

/** The instant a crypto contract expiring on `expiration` (YYYY-MM-DD) settles, or null for a date that cannot be read. */
function finalSettlementTime(expiration: string): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiration);
  if (!date) return null;
  const time = zonedWallClockToUtcMs(FINAL_SETTLEMENT.timeZone, Number(date[1]), Number(date[2]), Number(date[3]), FINAL_SETTLEMENT.hour, 0, 0);
  return Number.isFinite(time) ? time : null;
}

/** Days, fractional, from `from` to the contract's final settlement: 6.6 from Saturday 01:33 UTC to Friday 16:00 London. */
export function daysToExpiry(from: number, expiration: string): number | null {
  const settles = finalSettlementTime(expiration);
  return settles == null || !Number.isFinite(from) ? null : (settles - from) / DAY_MS;
}

/** The premium over spot as a yearly rate, on a 365-day year. Blank at or past final settlement, where it has no meaning. */
export function annualisedBasisPct(futures: number | null | undefined, spot: number | null | undefined, days: number | null): number | null {
  if (!positive(futures) || !positive(spot) || days == null || !Number.isFinite(days) || days <= 0) return null;
  return (futures / spot - 1) * 365 / days * 100;
}

export interface ContractBasis {
  vsSpotPct: number | null;
  annualisedBasisPct: number | null;
  /** The spot the last trade is read against: the close of the spot's bar in the trade's own minute. */
  spot: number | null;
  /** That bar's minute, as a UTC ISO instant. */
  spotTime: string | null;
  /** Fractional days from the last trade to the contract's final settlement. */
  daysToExpiry: number | null;
  /**
   * Why a priced, current contract has no basis: its last trade has no time
   * of day (`print` null), or no spot bar shares its minute, with the
   * nearest bar's minute (null when there are no bars at all). Null when
   * the contract has a basis or another rule blanks it.
   */
  unpaired: { print: number | null; spot: number | null } | null;
}

const NO_BASIS: ContractBasis = { vsSpotPct: null, annualisedBasisPct: null, spot: null, spotTime: null, daysToExpiry: null, unpaired: null };

/**
 * One contract's basis: its last trade against the spot in the same UTC
 * minute, so the two prices are never minutes apart, whichever is the newer
 * (a delayed spot trails the futures, a live one leads them). Blank while
 * the bars are unknown (`bars` null), for a contract whose own price is
 * missing or stale, for a trade with no time of day, and for one no spot bar
 * shares a minute with.
 */
export function contractBasis(row: Pick<FuturesContract, "price" | "stale" | "expiration" | "asOf">, bars: readonly SpotBar[] | null): ContractBasis {
  if (!bars || row.stale || !positive(row.price)) return NO_BASIS;
  const printed = parseReportTime(row.asOf);
  if (!printed || printed.dateOnly) return { ...NO_BASIS, unpaired: { print: null, spot: null } };
  const minute = minuteOf(printed.time);
  const bar = nearestSpotBar(bars, minute);
  if (!bar || bar.minute !== minute) return { ...NO_BASIS, unpaired: { print: printed.time, spot: bar?.minute ?? null } };
  const days = daysToExpiry(printed.time, row.expiration);
  return { vsSpotPct: vsSpotPct(row.price, bar.price), annualisedBasisPct: annualisedBasisPct(row.price, bar.price, days),
    spot: bar.price, spotTime: isoMinute(minute), daysToExpiry: days, unpaired: null };
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

export function curveBasisRows(rows: readonly FuturesContract[], bars: readonly SpotBar[] | null): CurveBasisRows {
  return new Map(rows.map((row) => [row.symbol, contractBasis(row, bars)]));
}

/** The contracts a known set of spot bars left blank for timing: no time of day, or no bar in their minute. */
export function unpairedContractCount(basis: Iterable<ContractBasis>): number {
  let count = 0;
  for (const row of basis) if (row.unpaired) count += 1;
  return count;
}

/** What the quote path reports of the spot itself, as the footer names it: `crypto composite price, real-time`. Null when it reports neither. */
export function curveSpotSource(spot: Pick<CurveSpot, "venue" | "feed">): string | null {
  const parts = [spot.venue, spot.feed].filter((part): part is string => !!part);
  return parts.length ? parts.join(", ") : null;
}

/** What Ann Basis is: Vs Spot is the same ratio before it is annualised. */
export const BASIS_FORMULA = "(Last / spot - 1) × 365 / days to expiry";
/** The two basis columns' convention in one line. */
export const BASIS_CONVENTION = `Ann Basis = ${BASIS_FORMULA}: simple actual/365, each last trade against spot in the same minute, `
  + "with days counted to final settlement at 16:00 London on the last trading day.";

/** A gap in whole minutes as a reader counts it: `5 min`, `3 h`, `2 days`. */
function gapText(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** The UTC minutes a blank names, the date only when the two fall on different days. */
function pairTimes(print: number, spot: number): string {
  const [printDate, printTime] = curveTimestamp(new Date(print).toISOString()).split(" ");
  const [spotDate, spotTime] = curveTimestamp(new Date(spot).toISOString()).split(" ");
  return printDate === spotDate ? `print ${printTime}, nearest spot ${spotTime} UTC` : `print ${printDate} ${printTime}, nearest spot ${spotDate} ${spotTime} UTC`;
}

/** Why one priced-or-not contract has no basis against known spot bars, in the order `contractBasis` decides it. */
function blankReason(row: Pick<FuturesContract, "price" | "stale">, basis: ContractBasis): string | null {
  if (basis.vsSpotPct != null) return null;
  if (!positive(row.price)) return "no price";
  if (row.stale) return "price over two sessions old";
  const unpaired = basis.unpaired;
  if (!unpaired) return null;
  if (unpaired.print == null) return "last trade has no time of day";
  if (unpaired.spot == null) return "no one-minute spot prices";
  const minutes = Math.round(Math.abs(minuteOf(unpaired.print) - unpaired.spot) / MINUTE_MS);
  return `spot and print ${gapText(minutes)} apart: ${pairTimes(unpaired.print, unpaired.spot)}`;
}

/**
 * The contracts whose basis cells are blank against known spot bars, grouped by cause and named, so a blank is
 * never unexplained: the far months of a curve print rarely, and a trade no spot bar shares a minute with is not read.
 */
export function blankBasisNote(rows: readonly Pick<FuturesContract, "symbol" | "price" | "stale">[], basis: CurveBasisRows): string | null {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const cell = basis.get(row.symbol);
    const reason = cell ? blankReason(row, cell) : null;
    if (reason) groups.set(reason, [...groups.get(reason) ?? [], curveContractCode(row.symbol)]);
  }
  return groups.size ? `Basis blank for ${[...groups].map(([reason, codes]) => `${codes.join(", ")} (${reason})`).join("; ")}.` : null;
}

/** Under this many days to expiry a few basis points of spot move the annualised rate by whole points: Vs Spot leads and the rate is greyed. */
const SHORT_DATED_DAYS = 7;
/** The noise the note sizes the swing against: ten basis points of spot, a CME trade's usual gap to a composite price in the same minute. */
const SPOT_NOISE_PCT = 0.1;

/** A contract whose annualised basis is shown inside `SHORT_DATED_DAYS` of final settlement, where spot noise swamps it. */
export function shortDatedBasis(basis: ContractBasis | null | undefined): boolean {
  return basis?.annualisedBasisPct != null && basis.daysToExpiry != null && basis.daysToExpiry < SHORT_DATED_DAYS;
}

/** The note for contracts showing an annualised basis inside `SHORT_DATED_DAYS`: what 10 bp of spot noise does to each. */
export function shortDatedBasisNote(rows: readonly Pick<FuturesContract, "symbol">[], basis: CurveBasisRows): string | null {
  const near = rows.flatMap((row) => {
    const cell = basis.get(row.symbol);
    if (!shortDatedBasis(cell)) return [];
    const days = cell!.daysToExpiry!;
    return [`${curveContractCode(row.symbol)} (${days.toFixed(1)} days) by ±${(SPOT_NOISE_PCT * 365 / days).toFixed(1)} points`];
  });
  return near.length ? `Ann Basis is noisy under ${SHORT_DATED_DAYS} days to expiry, so read Vs Spot there: 10 bp of spot noise moves ${near.join(", ")}.` : null;
}

/**
 * A past date for the as-of view: empty (or "latest") for the live curve, else
 * YYYY-MM-DD no later than today. `option` is how a command line types it
 * (`--date`), empty for the pane's field.
 */
export function curveAsOfDate(value: unknown, now = new Date(), option = ""): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.toLowerCase() === "latest") return "";
  const date = readCalendarDate(text);
  if (!date) throw new Error(dateOptionError(text, option, { now, subject: "an as-of date", formats: dateOptionFormatsOr("latest") }));
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
 * The curve with every contract expiring on its last trading day, the one
 * date its row, its chart point, its ghosts and the roll yield all count to.
 * A listed expiration can be a day the contract no longer trades: Brent's
 * December (BZZ26) stops on Oct 30, the last business day of the second month
 * before delivery, and is listed Nov 2. The roll yield is per year of the
 * front pair's spacing, so it is rescaled from the listed spacing to the
 * traded one; a curve already dated by its last trades is returned as it is.
 */
export function withTradedExpirations(data: FuturesCurvePayload): FuturesCurvePayload {
  const traded = new Map(data.contracts.map((row) => [row.symbol, row.lastTrade ?? row.expiration]));
  if (data.contracts.every((row) => traded.get(row.symbol) === row.expiration)
    && data.ghosts.every((ghost) => ghost.points.every((point) => (traded.get(point.symbol) ?? point.expiration) === point.expiration))) return data;
  const expiry = (symbol: string, listed: string) => traded.get(symbol) ?? listed;
  const front = data.contracts.find((row) => row.symbol === data.slope.frontSymbol);
  const next = data.contracts.find((row) => row.symbol === data.slope.nextSymbol);
  const spacing = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
  const listedDays = front && next ? spacing(front.expiration, next.expiration) : 0;
  const tradedDays = front && next ? spacing(expiry(front.symbol, front.expiration), expiry(next.symbol, next.expiration)) : 0;
  const roll = data.slope.annualizedRollYield;
  return {
    ...data,
    contracts: data.contracts.map((row) => ({ ...row, expiration: expiry(row.symbol, row.expiration) })),
    ghosts: data.ghosts.map((ghost) => ({ ...ghost, points: ghost.points.map((point) => ({ ...point, expiration: expiry(point.symbol, point.expiration) })) })),
    slope: { ...data.slope, annualizedRollYield: roll != null && listedDays > 0 && tradedDays > 0 ? roll * listedDays / tradedDays : roll },
  };
}

/**
 * The trading date a print belongs to, as the server dates sessions: CME's
 * session for a date opens at 18:00 New York the evening before (22:00 or
 * 23:00 UTC), so a two-hour shift puts those evening trades on the next date
 * and leaves day-only venues as they are. A settlement's date is its session.
 */
function curveSessionDate(asOf: string): string {
  return asOf.length === 10 ? asOf : new Date(Date.parse(asOf) + 2 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The settlement session a live contract has not traded since: its Settle
 * column shows that session's settlement and its latest price is from that
 * session or before. Null when it has traded since, or shows no settlement. A
 * Cboe price is the settlement itself, so it has no trade to wait for.
 */
export function curveNoTradeSince(row: Pick<FuturesContract, "price" | "settlement" | "asOf">,
  data: Pick<FuturesCurvePayload, "source" | "settlementDate">): string | null {
  const session = data.settlementDate;
  if (data.source === "cboe" || !session || row.price == null || row.settlement == null || !row.asOf) return null;
  return curveSessionDate(row.asOf) <= session ? session : null;
}

/**
 * The live curve with every Change on the basis its table states: the last
 * trade less the settlement in the Settle column. The source's session change
 * is from the settlement before the contract's own last trade, so a back month
 * that last traded on the settlement's session read against the session
 * before it, beside front months read against the one shown. A contract with
 * no trade since the settlement (curveNoTradeSince), or no settlement shown,
 * has no change. A Cboe price is a settlement, and its change, from the
 * settlement before, is kept.
 */
export function withSettleChanges(data: FuturesCurvePayload): FuturesCurvePayload {
  if (data.source === "cboe") return data;
  return { ...data, contracts: data.contracts.map((row) => {
    const change = row.price != null && row.settlement != null && data.settlementDate && row.asOf && !curveNoTradeSince(row, data)
      ? row.price - row.settlement : null;
    return change === (row.change ?? null) ? row : { ...row, change };
  }) };
}

/**
 * The contracts whose Change is blank because they have not traded since the
 * settlement shown, named, in the words the basis notes use; a pane with no
 * room for the names counts them.
 */
export function noTradeChangeNote(rows: readonly Pick<FuturesContract, "symbol" | "price" | "settlement" | "asOf">[],
  data: Pick<FuturesCurvePayload, "source" | "settlementDate">, options: { count?: boolean } = {}): string | null {
  const untraded = rows.filter((row) => curveNoTradeSince(row, data) != null).map((row) => curveContractCode(row.symbol));
  if (!untraded.length) return null;
  const named = options.count ? `on ${untraded.length} contract${untraded.length === 1 ? "" : "s"}` : `for ${untraded.join(", ")}`;
  return `Change blank ${named} (no trade since ${data.settlementDate})${options.count ? "" : "."}`;
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
  // A contract expires on its last trading day, as on the live curve (withTradedExpirations).
  const expiration = (row: ArchivedRow) => row.lastTrade ?? row.expiration;
  const contracts: FuturesContract[] = curve.contracts.flatMap((row) => {
    if (!row.expiration) return [];
    const stale = archivedRowStale(row, curve);
    return [{
      symbol: row.symbol, label: row.label, expiration: expiration(row)!, price: row.price, change: null, asOf: rowDate(row, stale),
      currency: curve.currency ?? "USD", quoteUnit: curve.quoteUnit ?? curve.currency ?? "USD", volume: row.volume,
      openInterest: row.openInterest, delayMinutes: null, stale, percentile: null, samples: 0, historyStart: null, historyEnd: null,
      // Only a row the archive confirms is a settlement; an unconfirmed one is that session's last trade.
      settlement: !stale && row.settled === true ? row.price : null,
      lastTrade: row.lastTrade ?? row.expiration, firstNotice: row.firstNotice ?? null, inDelivery: row.inDelivery ?? false,
    }];
  }).sort((a, b) => a.expiration.localeCompare(b.expiration));
  const ghosts = (["1W", "1M"] as const).map((label) => {
    const past = lookbacks[label];
    return { label, requestedDate: curveLookbackDate(curve.date, label === "1W" ? 7 : 30), asOf: past?.asOf ?? null,
      points: past ? past.contracts.flatMap((row) => row.expiration
        ? [{ symbol: row.symbol, expiration: expiration(row)!, price: row.price, asOf: rowDate(row, archivedRowStale(row, past)) }] : []) : [] };
  });
  // The front pair on the curve's own session: settlements where the archive has them, else that session's
  // last trades. Carried prices, and a last trade beside a settlement, do not make a spread.
  const settled = contracts.filter((row) => row.settlement != null);
  const [front, next] = settled.length >= 2 ? settled : settled.length ? [] : contracts.filter((row) => !row.stale);
  const value = front && next ? next.price! - front.price! : null;
  // A leg that traded under THIN_SPREAD_LOTS lots that session gets no slope call, as on the live curve.
  const thin = [front, next].find((row) => row?.volume != null && row.volume < THIN_SPREAD_LOTS)?.symbol ?? null;
  const days = front && next ? (Date.parse(next.expiration) - Date.parse(front.expiration)) / DAY_MS : 0;
  const roll = front && next && front.price! > 0 && next.price! > 0 && days > 0 ? (front.price! / next.price! - 1) * 365 / days * 100 : null;
  return {
    root, name: curve.name, source: root === "VX" ? "cboe" : "gloom", currency: curve.currency, quoteUnit: curve.quoteUnit,
    asOf: curve.asOf, fetchedAt, status: !contracts.length ? "unavailable" : curve.gaps.length ? "partial" : "available", stale: false,
    catalogue: { method: "provider", complete: true, horizonEnd: null }, contracts, ghosts,
    slope: { frontSymbol: front?.symbol ?? null, nextSymbol: next?.symbol ?? null, value, annualizedRollYield: roll, percentile: null,
      rollPercentile: null, samples: 0, historyStart: null, historyEnd: null, asOf: front && next ? curve.asOf : null,
      basis: front && next ? settled.length >= 2 ? "settle" : "last" : null, thinSymbol: value == null ? null : thin,
      state: value == null ? "unavailable" : thin ? "thin" : Math.abs(value) < 1e-10 ? "flat" : value > 0 ? "contango" : "backwardation" },
    gaps: curve.gaps, spec: curve.spec ?? null, settlementDate: settled.length ? curve.asOf : null,
  };
}
