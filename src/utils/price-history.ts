import type { PricePoint, TickerFinancials } from "../types/financials";
import { canonicalExchange } from "./exchanges";
import { isRoundTheClockCoin } from "./crypto-pair";
import { isCurrencyPairListing, isFxMarketOpen, latestFxWeekClose, latestFxWeekOpen } from "./fx-market-hours";
import { hasPublishedSessionCalendar, historySourceWeekendDays, isMiddayBreakPrint, latestRegularSessionClose, latestRegularSessionOpen, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { zonedDateTimeParts } from "./zoned-date-time";
import { regularHistorySessionStaleness } from "../market-data/history-session";
import type { HistorySession } from "../types/price-history";
import { BAR_INTERVAL_UNIT_MS, parseBarInterval } from "../time-series/resolution";
import { parseOptionTicker } from "./options";

// A venue without session hours here (OTC Markets, Cboe Canada) has no
// session to hold: its copy is current while the latest bar is this recent.
const UNSCHEDULED_HISTORY_MAX_AGE_MS = 18 * 60 * 60 * 1000;
const MAX_SAME_SESSION_HISTORY_LAG_MS = 30 * 60 * 1000;
// Sources finish the closing auction and late prints some minutes after the
// bell, past the delayed feed's lag. A copy fetched later can still carry an
// unfinished bar when its source had not settled it; only the source can tell.
const SESSION_BAR_SETTLE_MS = 30 * 60 * 1000;
const DELAYED_HISTORY_ALLOWANCE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A series that never closes must reach the present without a break: no hole
// this long (or three bars, if larger) in the stretch before now that a
// current window is read over.
const ROUND_THE_CLOCK_RECENT_MS = 6 * 60 * 60 * 1000;
const ROUND_THE_CLOCK_GAP_MS = 2 * 60 * 60 * 1000;

interface PriceHistoryFreshnessOptions {
  exchange?: string;
  /**
   * The listing's symbol. A coin quoted in dollars (BTC-USD) trades around the
   * clock whether or not the exchange says CCC, and a currency pair (EURUSD=X)
   * on the FX week; without the symbol a bare pair is read as a US listing and
   * judged on the NYSE session.
   */
  symbol?: string;
  intervalMs?: number | null;
  session?: HistorySession;
  /**
   * When the copy was fetched. A copy fetched once its session had settled
   * holds that session however early its last bar: a thin listing need not
   * trade late. Without it, the bars must reach the close.
   */
  fetchedAt?: number;
}

/**
 * How old the newest bar of a current copy may be. Completed bars are
 * timestamped at their opening time, so before the next one is delivered the
 * newest may be almost two intervals plus the feed delay old; finer bars keep
 * a floor.
 */
function allowedBarLagMs(intervalMs: number | null): number {
  return Math.max(MAX_SAME_SESSION_HISTORY_LAG_MS, intervalMs != null ? 2 * intervalMs + DELAYED_HISTORY_ALLOWANCE_MS : 0);
}

export function priceHistoryIntervalMs(interval: string): number | null {
  const parsed = parseBarInterval(interval);
  return parsed ? parsed.count * BAR_INTERVAL_UNIT_MS[parsed.unit] : null;
}

function inferredHistoryIntervalMs(points: PricePoint[]): number | null {
  const times = [...new Set(points.slice(-20).map(getPricePointTimestamp))];
  const gaps = times.slice(1).map((time, index) => time - times[index]!);
  const shortest = Math.min(...gaps);
  if (shortest > 0 && shortest <= 60 * 60 * 1000) return shortest;
  // A generic range does not specify bar size. Multiple daily labels can
  // establish daily cadence; a single overnight gap between sparse intraday
  // observations cannot. One-hour drift allows daily exchange opens over DST.
  if (times.length >= 3 && shortest >= 20 * 60 * 60 * 1000) {
    const clockTimes = times.map((time) => time % DAY_MS);
    if (Math.max(...clockTimes) - Math.min(...clockTimes) <= 60 * 60 * 1000) return DAY_MS;
  }
  return null;
}

// Cached history carries ISO strings for dates, and every pass over a
// series (normalizing, sorting, charting) parses each one again; a sort
// comparator does it twice per comparison. Points are never edited in
// place, so the parse is kept per point.
const pointTimestamps = new WeakMap<PricePoint, number>();

export function getPricePointTimestamp(point: PricePoint): number {
  const value = point.date as Date | string | number | null | undefined;
  if (value instanceof Date) return value.getTime();
  if (value == null) return Number.NaN;
  const cached = pointTimestamps.get(point);
  if (cached !== undefined) return cached;
  const time = new Date(value).getTime();
  pointTimestamps.set(point, time);
  return time;
}

function hasFiniteClose(point: PricePoint): boolean {
  return Number.isFinite(point.close);
}

/** Observation dates and usable price coverage are independent. */
export function hasUsablePriceHistory(points: readonly PricePoint[]): boolean {
  return points.some((point) => Number.isFinite(getPricePointTimestamp(point)) && hasFiniteClose(point));
}

/** A usable alternate source may recover a gap; uncovered reported dates remain gaps. */
export function preservePriceHistoryGaps(points: PricePoint[], unavailable: readonly PricePoint[][]): PricePoint[] {
  const times = new Set(points.map(getPricePointTimestamp));
  const gaps: PricePoint[] = [];
  for (const history of unavailable) {
    for (const point of history) {
      const time = getPricePointTimestamp(point);
      if (!Number.isFinite(time) || hasFiniteClose(point) || times.has(time)) continue;
      times.add(time);
      gaps.push(point);
    }
  }
  return gaps.length ? normalizePriceHistory([...points, ...gaps]) : points;
}

function comparePricePointsByDate(left: PricePoint, right: PricePoint): number {
  const leftTime = getPricePointTimestamp(left);
  const rightTime = getPricePointTimestamp(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid) return leftTime - rightTime;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}

// The merged financials view is rebuilt on every quote tick and normalizes
// the same history array each time. Arrays are replaced, not edited, so the
// result is kept per input array.
const normalizedHistories = new WeakMap<PricePoint[], PricePoint[]>();

export function normalizePriceHistory(points: PricePoint[]): PricePoint[] {
  if (points.length === 0) return points;
  const cached = normalizedHistories.get(points);
  if (cached) return cached;
  const normalized = normalizePriceHistoryUncached(points);
  normalizedHistories.set(points, normalized);
  return normalized;
}

function normalizePriceHistoryUncached(points: PricePoint[]): PricePoint[] {
  const validPoints: PricePoint[] = [];
  let sawDistinctTimestamp = false;
  let firstTimestamp: number | null = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  let requiresSort = false;

  for (const point of points) {
    const time = getPricePointTimestamp(point);
    if (!Number.isFinite(time)) continue;
    // Keep dated unavailable closes so downstream returns/charts cannot join
    // their neighbors, including when the entire response is unavailable.

    if (firstTimestamp === null) {
      firstTimestamp = time;
    } else if (time !== firstTimestamp) {
      sawDistinctTimestamp = true;
    }

    if (time < previousTime) {
      requiresSort = true;
    }
    previousTime = time;
    validPoints.push(point);
  }

  if (validPoints.length === 0) return [];
  if (validPoints.length === 1) return validPoints;
  if (!sawDistinctTimestamp) return [];

  if (requiresSort) {
    return [...validPoints].sort(comparePricePointsByDate);
  }
  return validPoints.length === points.length ? points : validPoints;
}

/**
 * A round-the-clock series is current while its latest bar is within two bars
 * and the publishing allowance of now, with no hole in the last hours. Cloud
 * applies the same rule to the bars it serves.
 */
function isRoundTheClockHistoryBehind(
  points: PricePoint[], latestTime: number, now: number, intervalMs: number | null,
): boolean {
  const allowedLag = intervalMs != null ? 2 * intervalMs + DELAYED_HISTORY_ALLOWANCE_MS : MAX_SAME_SESSION_HISTORY_LAG_MS;
  if (now - latestTime > allowedLag) return true;
  const maxGap = Math.max(3 * (intervalMs ?? 0), ROUND_THE_CLOCK_GAP_MS);
  let later = latestTime;
  for (let index = points.length - 1; index >= 0 && later >= now - ROUND_THE_CLOCK_RECENT_MS; index--) {
    const point = points[index]!;
    if (!hasFiniteClose(point)) continue;
    const time = getPricePointTimestamp(point);
    if (!(time < later)) continue;
    if (later - time > maxGap) return true;
    later = time;
  }
  return false;
}

export function isPriceHistoryStaleForCurrentWindow(
  points: PricePoint[],
  now = Date.now(),
  options: PriceHistoryFreshnessOptions = {},
): boolean {
  const normalized = normalizePriceHistory(points);
  const latest = normalized.findLast(hasFiniteClose);
  if (!latest) return false;

  const coin = isRoundTheClockCoin(options.symbol, options.exchange);
  // A coin has no session to read its bars against.
  const session = !coin && options.session?.exchange === canonicalExchange(options.exchange)
    ? options.session : undefined;
  const sessionInterval = session ? priceHistoryIntervalMs(session.interval) : null;
  const intervalMs = options.intervalMs ?? sessionInterval ?? inferredHistoryIntervalMs(normalized);
  // Daily/weekly/monthly labels are period starts, not live observation times.
  // Their cache policy controls refresh; an intraday lag test is inapplicable.
  if (intervalMs != null && intervalMs >= DAY_MS) return false;
  // An option contract can go hours without a trade, so its last bar's age says nothing of
  // its source; judged on it, a contract quiet since the open had no chart at all.
  if (options.symbol && parseOptionTicker(options.symbol)) return false;

  const latestTime = getPricePointTimestamp(latest);
  if (!Number.isFinite(latestTime)) return false;
  // Before any exchange logic: a bare BTC-USD is not a US listing, and the
  // always-open venue's own rule lets a bar up to two hours old stand.
  if (coin) return isRoundTheClockHistoryBehind(normalized, latestTime, now, intervalMs);
  if (session && (options.intervalMs == null || options.intervalMs === sessionInterval)) {
    const regularStale = regularHistorySessionStaleness(latestTime, now, session);
    if (regularStale !== null) return regularStale;
  }
  const age = now - latestTime;
  const allowedLag = allowedBarLagMs(intervalMs);
  if (age <= allowedLag) return false;
  // A venue paused at midday (SSE/SZSE/BSE, TKO, ...) holds the morning's last
  // bar current through the break, as the quote freshness rule does. A bar is
  // labelled by its start, so an hourly bar ending at the break is judged by
  // when it ends.
  const latestBarEnd = intervalMs != null ? Math.min(latestTime + intervalMs, now) : latestTime;
  if (isMiddayBreakPrint(latestBarEnd, options.exchange, now, 0)) return false;
  const sessions = listingSessionsAt(now, options);
  if (!sessions) return age > UNSCHEDULED_HISTORY_MAX_AGE_MS;
  const fetchedAt = options.fetchedAt ?? Number.NEGATIVE_INFINITY;
  if (holdsLatestSession(latestTime, now, sessions, allowedLag, fetchedAt)) return false;
  // A venue whose chart source files another week (DFM's Sunday to Thursday)
  // may end on the last session that week has: current under either week.
  // Bars of a day that week lacks (a DFM Friday) answer to the venue's own.
  const exchange = listingSessionExchange(options.exchange);
  const sourceWeekendDays = historySourceWeekendDays(exchange);
  const timeZone = sessionCalendarTimeZone(exchange);
  const latestWeekday = timeZone ? zonedWeekday(latestTime, timeZone) : null;
  if (!sourceWeekendDays || latestWeekday == null || sourceWeekendDays.includes(latestWeekday)) return true;
  const sourceSessions = listingSessionsAt(now, options, sourceWeekendDays);
  return !sourceSessions || !holdsLatestSession(latestTime, now, sourceSessions, allowedLag, fetchedAt);
}

/** Bare symbols resolve to their US listing at the sources. */
function listingSessionExchange(exchange: string | undefined): string {
  return canonicalExchange(exchange) || "NYSE";
}

interface ListingSessions {
  /** The open of the session trading at the time asked, if one is. */
  liveOpen: number | null;
  /** The latest session closed at or before that time. */
  last: { open: number; close: number } | null;
}

/**
 * The sessions a listing's bars are read against at `time`, from the venue's
 * session tables; `weekendDays` replaces its days off. A currency pair's
 * session is the FX week, Sunday to Friday 17:00 New York, whatever venue it
 * is quoted on. Null for a venue without session hours.
 */
function listingSessionsAt(
  time: number,
  options: Pick<PriceHistoryFreshnessOptions, "exchange" | "symbol">,
  weekendDays?: readonly number[],
): ListingSessions | null {
  if (isCurrencyPairListing(options.symbol, options.exchange)) {
    const close = latestFxWeekClose(time);
    const open = close === null ? null : latestFxWeekOpen(close);
    return { liveOpen: isFxMarketOpen(time) ? latestFxWeekOpen(time) : null,
      last: close !== null && open !== null ? { open, close } : null };
  }
  const exchange = listingSessionExchange(options.exchange);
  const open = latestRegularSessionOpen(exchange, time, weekendDays);
  if (open === null) return null;
  const latest = latestRegularSessionClose(exchange, time, weekendDays);
  const last = latest
    ? { open: latestRegularSessionOpen(exchange, latest.close, weekendDays) ?? latest.close, close: latest.close }
    : null;
  return { liveOpen: !last || last.close < open ? open : null, last };
}

/**
 * Whether bars ending at `latestTime`, older than one bar's lag, hold the
 * listing's latest session. Between sessions that is the whole of the last
 * one. While one trades, bars older than the lag are behind it, and the whole
 * of the one before answers only until this one's first delayed bar is due.
 * A session is held whole by bars from its open that reach its close less
 * that lag, or by a copy fetched once it had settled. Weeknights, weekends
 * and holidays read alike: the session tables say which session is the last.
 */
function holdsLatestSession(
  latestTime: number, now: number, sessions: ListingSessions, allowedLag: number, fetchedAt: number,
): boolean {
  const { liveOpen, last } = sessions;
  if (liveOpen !== null && (latestTime >= liveOpen || now - liveOpen > allowedLag)) return false;
  return !!last && latestTime >= last.open
    && (latestTime >= last.close - allowedLag || fetchedAt >= last.close + SESSION_BAR_SETTLE_MS);
}

function zonedWeekday(time: number, timeZone: string): number {
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const CRYPTO_BAR_MAX_AGE_MS = 60 * 60 * 1000;
// A coin's UTC day is served whole this long after midnight: the delay on bars that are not live.
const CRYPTO_DAY_ROLL_MS = 15 * 60 * 1000;
// A copy missing a settled session is asked again at most this often, and less
// often as that close recedes, so a halted, delisted or late listing costs a
// handful of requests per session rather than one per request.
const BEHIND_RECHECK_MS = 60 * 60 * 1000;
const BEHIND_RECHECK_BACKOFF = 4;
// A copy fetched before that close is asked again at most this often when the
// re-check fails, answers nothing usable, or is rejected.
const UNSETTLED_RETRY_MS = 5 * 60 * 1000;

interface CalendarHistoryFetchOptions extends Pick<PriceHistoryFreshnessOptions, "exchange" | "intervalMs" | "symbol"> {
  /**
   * The latest check of this request, including a failed or empty one; the
   * fetch of the copy itself when absent.
   */
  checkedAt?: number;
}

/**
 * - current: holds every settled session it can.
 * - unsettled: fetched before the latest settled close, so it can hold that
 *   session in progress.
 * - pending: unsettled, and re-checked since that close without replacing it;
 *   the next re-check waits.
 * - behind: fetched after that close but without its bar; not due a re-check.
 * - recheck: behind, and due a re-check.
 */
export type CalendarHistoryFetchState = "current" | "unsettled" | "pending" | "behind" | "recheck";

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/** Daily labels at UTC midnight name that date; others read in the venue's zone. */
function barDate(time: number, timeZone: string): string {
  if (time % DAY_MS === 0) return new Date(time).toISOString().slice(0, 10);
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The venue date a daily bar at `time` names on `exchange`, read as calendarHistoryLastBarDate reads it. */
export function dailyBarDate(time: number, exchange: string): string {
  return barDate(time, sessionCalendarTimeZone(exchange) ?? "UTC");
}

/**
 * The venue date of the latest bar, read as calendarHistoryFetchState reads
 * it, so copies whose sources label a session differently compare equal.
 */
export function calendarHistoryLastBarDate(points: PricePoint[], exchange?: string, symbol?: string): string | null {
  const latest = normalizePriceHistory(points).findLast(hasFiniteClose);
  if (!latest) return null;
  const time = getPricePointTimestamp(latest);
  if (!Number.isFinite(time)) return null;
  // Bare symbols resolve to their US listing at the sources, a coin to its UTC date.
  if (isRoundTheClockCoin(symbol, exchange)) return barDate(time, "UTC");
  return barDate(time, sessionCalendarTimeZone(canonicalExchange(exchange) || "NYSE") ?? "UTC");
}

function unsettledState(settledAt: number, checkedAt: number | undefined, now: number): CalendarHistoryFetchState {
  return checkedAt !== undefined && checkedAt >= settledAt && now - checkedAt < UNSETTLED_RETRY_MS ? "pending" : "unsettled";
}

/** True when the session date falls in a later bar than the latest one. */
function isBarBeforeSession(latestTime: number, session: string, intervalMs: number, timeZone: string): boolean {
  const bar = barDate(latestTime, timeZone);
  if (intervalMs >= 28 * DAY_MS) {
    const month = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
    return month(session) >= month(bar) + Math.max(1, Math.round(intervalMs / (30 * DAY_MS)));
  }
  return dayNumber(session) >= dayNumber(bar) + Math.max(1, Math.round(intervalMs / DAY_MS));
}

/**
 * An intraday copy fetched before the venue's latest session settled holds
 * that session only as far as the fetch. Once the session is over, or the
 * next has begun, a copy whose last bar stops short of the close by more than
 * a current copy's bars may lag is refetched. A copy fetched after the
 * session settled holds all of it, however early its last bar: a thin listing
 * need not trade late. The sessions are those isPriceHistoryStaleForCurrentWindow
 * reads (listingSessionsAt): a currency pair's is the FX week. Coins never
 * close, and within the FX week neither do pairs:
 * isPriceHistoryStaleForCurrentWindow holds those copies to the present.
 */
function intradayHistoryFetchState(
  points: PricePoint[], fetchedAt: number, now: number, intervalMs: number, options: CalendarHistoryFetchOptions,
): CalendarHistoryFetchState {
  if (isRoundTheClockCoin(options.symbol, options.exchange)) return "current";
  const close = listingSessionsAt(now - SESSION_BAR_SETTLE_MS, options)?.last?.close ?? null;
  if (close === null || fetchedAt >= close + SESSION_BAR_SETTLE_MS) return "current";
  const latest = points.findLast(hasFiniteClose);
  const latestTime = latest ? getPricePointTimestamp(latest) : Number.NaN;
  if (!Number.isFinite(latestTime) || latestTime >= close - allowedBarLagMs(intervalMs)) return "current";
  return unsettledState(close + SESSION_BAR_SETTLE_MS, options.checkedAt, now);
}

/**
 * A daily or coarser series changes at every close, and gains a bar for the
 * day once a session opens. A copy fetched before the latest settled close is
 * outdated whatever its cache TTL, and so is one fetched before a session that
 * has opened since: it lacks today's bar, so a morning copy would answer for
 * yesterday all day. A copy fetched after the latest settled close but without
 * its bar is behind only where the venue's closures are published
 * (hasPublishedSessionCalendar): elsewhere, and for a bare symbol whose venue
 * is unknown, a local holiday would read as a missing session. A copy of a
 * 24/7 series goes out of date within the hour.
 */
export function calendarHistoryFetchState(
  points: PricePoint[],
  fetchedAt: number,
  now = Date.now(),
  options: CalendarHistoryFetchOptions = {},
): CalendarHistoryFetchState {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now) || fetchedAt >= now) return "current";
  const normalized = normalizePriceHistory(points);
  const intervalMs = options.intervalMs ?? inferredHistoryIntervalMs(normalized);
  if (intervalMs == null) return "current";
  if (intervalMs < DAY_MS) return intradayHistoryFetchState(normalized, fetchedAt, now, intervalMs, options);
  const exchange = canonicalExchange(options.exchange);
  if (isRoundTheClockCoin(options.symbol, options.exchange)) {
    // A coin's day closes at UTC midnight, and the service has it by the delay after:
    // a copy from before then holds that day as still forming.
    const roll = Math.floor((now - CRYPTO_DAY_ROLL_MS) / DAY_MS) * DAY_MS + CRYPTO_DAY_ROLL_MS;
    const settledAt = Math.min(fetchedAt + CRYPTO_BAR_MAX_AGE_MS, fetchedAt < roll ? roll : Number.POSITIVE_INFINITY);
    return now >= settledAt ? unsettledState(settledAt, options.checkedAt, now) : "current";
  }
  // Bare symbols resolve to their US listing at the sources.
  const session = latestRegularSessionClose(exchange || "NYSE", now - SESSION_BAR_SETTLE_MS);
  if (!session) return "current";
  if (fetchedAt < session.close + SESSION_BAR_SETTLE_MS) return unsettledState(session.close + SESSION_BAR_SETTLE_MS, options.checkedAt, now);
  const open = latestRegularSessionOpen(exchange || "NYSE", now);
  if (open !== null && open > session.close && fetchedAt < open) return unsettledState(open, options.checkedAt, now);
  if (!exchange || !hasPublishedSessionCalendar(exchange, session.date)) return "current";
  const latest = normalized.findLast(hasFiniteClose);
  if (!latest || !isBarBeforeSession(getPricePointTimestamp(latest), session.date, intervalMs, session.timeZone)) return "current";
  const lastCheck = options.checkedAt ?? fetchedAt;
  const pace = Math.max(BEHIND_RECHECK_MS, (now - session.close) / BEHIND_RECHECK_BACKOFF);
  return now - lastCheck >= pace ? "recheck" : "behind";
}

/**
 * The venue date of the latest regular session whose bar is final at `now`:
 * closed for the settle allowance, on the calendar calendarHistoryFetchState
 * reads. Null for a listing without a venue and for venues whose sessions are
 * unknown, round-the-clock ones included.
 */
export function latestSettledSessionDate(exchange: string | undefined, now = Date.now()): string | null {
  const venue = canonicalExchange(exchange);
  return venue ? latestRegularSessionClose(venue, now - SESSION_BAR_SETTLE_MS)?.date ?? null : null;
}

/**
 * True when the latest bar is from the venue's latest settled session or a
 * later one, read on the calendar calendarHistoryFetchState uses. A venue
 * whose sessions are unknown, round-the-clock ones included, proves nothing.
 */
export function reachesLatestSettledSession(
  points: PricePoint[],
  now = Date.now(),
  options: Pick<PriceHistoryFreshnessOptions, "exchange" | "intervalMs" | "symbol"> = {},
): boolean {
  const normalized = normalizePriceHistory(points);
  const latest = normalized.findLast(hasFiniteClose);
  const latestTime = latest ? getPricePointTimestamp(latest) : Number.NaN;
  if (!Number.isFinite(latestTime)) return false;
  if (isRoundTheClockCoin(options.symbol, options.exchange)) return false;
  // Bare symbols resolve to their US listing at the sources.
  const session = latestRegularSessionClose(canonicalExchange(options.exchange) || "NYSE", now - SESSION_BAR_SETTLE_MS);
  if (!session) return false;
  const intervalMs = options.intervalMs ?? inferredHistoryIntervalMs(normalized) ?? DAY_MS;
  return !isBarBeforeSession(latestTime, session.date, Math.max(intervalMs, DAY_MS), session.timeZone);
}

/** One price and no volume: 0, or missing where a coin's feed sends 0 for no data. */
function isPlaceholderBar(point: PricePoint): boolean {
  return !point.volume && Number.isFinite(point.close)
    && point.open === point.close && point.high === point.close && point.low === point.close;
}

const trimmedHistories = new WeakMap<PricePoint[], PricePoint[]>();
// An offer priced the day before trading, or a value carried forward to the
// opening auction, sits days at most before the first print.
const PLACEHOLDER_LEAD_MAX_MS = 7 * DAY_MS;

/**
 * Bars at the very start of a traded series with no volume and one price
 * (open = high = low = close) are placeholders, not trades: an offer price or
 * a carried-forward value before the first print. They are dropped only when
 * the next priced bar reports volume within days. Series that never report
 * volume (FX, most indices) and long-lived indices whose early decades carry
 * none keep every bar. Expects date order.
 */
export function dropLeadingPlaceholderBars(points: PricePoint[]): PricePoint[] {
  if (points.length === 0 || !isPlaceholderBar(points[0]!)) return points;
  const cached = trimmedHistories.get(points);
  if (cached) return cached;
  let start = 1;
  while (start < points.length && isPlaceholderBar(points[start]!)) start++;
  const firstPrint = points.slice(start).find((point) => Number.isFinite(point.close));
  const result = firstPrint && (firstPrint.volume ?? 0) > 0
    && getPricePointTimestamp(firstPrint) - getPricePointTimestamp(points[0]!) <= PLACEHOLDER_LEAD_MAX_MS
    ? points.slice(start) : points;
  trimmedHistories.set(points, result);
  return result;
}

export function normalizeTickerFinancialsPriceHistory(financials: TickerFinancials): TickerFinancials {
  const priceHistory = dropLeadingPlaceholderBars(normalizePriceHistory(financials.priceHistory ?? []));
  return priceHistory === financials.priceHistory
    ? financials
    : { ...financials, priceHistory };
}
