import { MISSING_VALUE } from "../../utils/format";
import type { Quote, QuoteDataSource } from "../../types/financials";
import { getLanguage, tf } from "../../i18n";
import { formatUtcDayTime, formatUtcWeekdayTime } from "../../utils/utc-time";
import { formatShortDate } from "../../utils/datetime-format";
import { formatDay } from "../../utils/day-format";
import { isRegularSessionTime, quoteFeedDelayMinutes } from "../market/freshness";
import { EXTENDED_SESSION_MARKS, extendedPrintTime, quoteBookSessionLabel, quoteHeadlineTime, quoteSessionStateLabel } from "../market/status";
import { venueSessionNow } from "../market/venue-session";
import { resolveExchangeTimeZone } from "../../utils/exchanges";
import { zonedDateKey } from "../../utils/zoned-date-time";
import { dailyNavDate, isQuoteStaleForCurrentSession } from "./freshness";
import { savedCopyAt } from "../../data/saved-copies";

/** The published NAV session date, independent of local time and receipt time. */
export function formatQuoteNavAsOf(quote: Quote | null | undefined, now = Date.now()): string | null {
  const date = quote && dailyNavDate(quote, now);
  if (!date) return null;
  const sourceDate = new Date(`${date}T00:00:00Z`);
  const otherYear = sourceDate.getUTCFullYear() !== new Date(now).getUTCFullYear();
  // English reads the day first, as every other date does; another language writes the day its own way.
  const language = getLanguage();
  const dateText = language === "en"
    ? formatShortDate(sourceDate, { utc: true, year: otherYear ? "numeric" : false })
    : new Intl.DateTimeFormat(language, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(otherYear ? { year: "numeric" as const } : {}),
    }).format(sourceDate);
  return tf("NAV · as of {date}", { date: dateText });
}

const WEEK_MS = 7 * 86_400_000;

/** How current a quote's feed is: `15 min delayed` (Gloom Cloud knows each venue's lag), `delayed`, `real-time`. */
function quoteFeedWord(quote: Quote): string | null {
  if (quote.dataSource === "live") return "real-time";
  if (quote.dataSource !== "delayed") return null;
  const minutes = quoteFeedDelayMinutes(quote);
  return minutes == null ? "delayed" : `${minutes} min delayed`;
}

/**
 * `08:09 UTC` on today's UTC date, `Thu 08:09 UTC` within the week, `Thu 29 Oct
 * 08:09 UTC` before it: when a card's price, or an extended print, was observed.
 */
export function asOfClock(time: number, now = Date.now()): string {
  const iso = new Date(time).toISOString();
  if (iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return `${iso.slice(11, 16)} UTC`;
  return `${now - time < WEEK_MS ? formatUtcWeekdayTime(time) : formatUtcDayTime({ time, dateOnly: false }, now)} UTC`;
}

/** What a book the source sent without its time says in place of one. */
export const QUOTE_BOOK_UNDATED = "not dated";

/** The session a book was quoted in. */
type QuoteBookSession = "regular" | "pre-market" | "after-hours" | "lunch" | "closed";

/** A book as its time, session and feed are read once, for every way they are written. */
interface QuoteBookReading {
  /** How current the source of the bid and ask is, which is not always the price's; undefined when it does not say. */
  dataSource: QuoteDataSource | undefined;
  /** When it was quoted, never later than now; null for a book the source sent without its time. */
  time: number | null;
  /** Quoted in the regular session of the venue's current day: the one book a time alone dates. */
  current: boolean;
  /**
   * The session it was quoted in: by the venue's calendar at its time, or by
   * the quote's state now for an undated book and a venue with no calendar.
   * Null when neither says.
   */
  session: QuoteBookSession | null;
  /** The session in words; null only for an undated book whose state names none. */
  sessionWords: string | null;
}

/** The session a quote's state puts an undated book in, as quoteBookSessionLabel words it. */
function stateBookSession(quote: Quote): QuoteBookSession | null {
  const state = quote.marketState;
  if (!state || state === "REGULAR") return null;
  return state === "PRE" ? "pre-market" : state === "POST" ? "after-hours" : "closed";
}

/**
 * Reads the book on its own clock, never the trade's, and by its own source.
 * Null without a bid or an ask.
 */
function readQuoteBook(quote: Quote | null | undefined, now: number): QuoteBookReading | null {
  if (!quote || (quote.bid == null && quote.ask == null)) return null;
  const bookSource = quote.provenance?.fields?.bid ?? quote.provenance?.fields?.ask;
  const dataSource = bookSource ? bookSource.dataSource : quote.dataSource;
  const at = quote.bidAskTime;
  if (at == null || !Number.isFinite(at) || at <= 0) {
    return { dataSource, time: null, current: false, session: stateBookSession(quote), sessionWords: quoteBookSessionLabel(quote) };
  }
  const time = Math.min(at, now);
  const venue = [quote.listingExchangeName, quote.exchangeName].find((exchange) => resolveExchangeTimeZone(exchange));
  const zone = resolveExchangeTimeZone(venue) ?? "UTC";
  const phase = venueSessionNow(venue, time)?.phase;
  const regular = phase ? phase === "open" : isRegularSessionTime(venue, time) ?? quote.marketState === "REGULAR";
  if (regular) {
    return { dataSource, time, current: zonedDateKey(time, zone) === zonedDateKey(now, zone), session: "regular", sessionWords: "regular session" };
  }
  if (phase === "pre-market" || phase === "after-hours") return { dataSource, time, current: false, session: phase, sessionWords: phase };
  if (phase === "lunch") return { dataSource, time, current: false, session: "lunch", sessionWords: "midday break" };
  if (phase) return { dataSource, time, current: false, session: "closed", sessionWords: "last quote" };
  return { dataSource, time, current: false, session: stateBookSession(quote), sessionWords: quoteBookSessionLabel(quote) ?? "session unknown" };
}

/**
 * Date the book on its own clock, never the trade's. Only today's regular
 * session can omit the date and session. Missing time is explicit.
 *
 * `weekday: false` dates it as a table does (`26 Nov 00:59 UTC`, bookStamp),
 * for a place too narrow for `Thu 26 Nov 00:59 UTC`: the date stays, the
 * weekday that repeats it goes.
 */
export function quoteBookTimeParts(
  quote: Quote | null | undefined,
  now = Date.now(),
  { weekday = true }: { weekday?: boolean } = {},
): string[] {
  const book = readQuoteBook(quote, now);
  if (!book) return [];
  const feed = book.dataSource === "live" ? "real-time" : book.dataSource === "snapshot" ? "snapshot" : book.dataSource === "delayed" ? "delayed" : null;
  if (book.time == null) return [QUOTE_BOOK_UNDATED, book.sessionWords, feed].filter((part): part is string => part != null);
  if (book.current) return [asOfClock(book.time, now), ...(feed ? [feed] : [])];
  const dated = weekday ? formatUtcDayTime({ time: book.time, dateOnly: false }, now) : bookStamp(book.time, now);
  return [`${dated} UTC`, book.sessionWords!, ...(feed ? [feed] : [])];
}

export function formatQuoteBookTime(quote: Quote | null | undefined, now = Date.now()): string | null {
  return quoteBookTimeParts(quote, now).join(" · ") || null;
}

/** The mark of data from a delayed feed, as a quote's age carries it (`◷15s`). */
const DELAYED_MARK = "◷";
/** A book that is one observation of its source, not a feed. */
const SNAPSHOT_MARK = "snap";

/**
 * A book's session where it is not the regular one, as short as the app
 * already writes it: the marks LAST gives an extended print (PM, AH), and the
 * header's words for a venue's midday break and a closed market.
 */
const BOOK_SESSION_MARKS: Record<QuoteBookSession, string | null> = {
  regular: null,
  "pre-market": EXTENDED_SESSION_MARKS.PRE,
  "after-hours": EXTENDED_SESSION_MARKS.POST,
  lunch: "lunch",
  closed: "closed",
};

/** The widest formatQuoteBookCell writes: `snap closed 19 Sep 2025 00:30`. */
export const QUOTE_BOOK_CELL_MAX_WIDTH = 29;

/**
 * A book's UTC day and clock as every table writes a time beside its day (a
 * perps row's `26 Oct 06:52`): the day first, without its year when it is
 * this one's, with it when not (`19 Sep 2025 00:30`).
 */
function bookStamp(time: number, now: number): string {
  const iso = new Date(time).toISOString();
  const thisYear = iso.slice(0, 4) === new Date(now).toISOString().slice(0, 4);
  return `${formatDay(iso, thisYear ? "no-year" : "full")} ${iso.slice(11, 16)}`;
}

/**
 * The book's time for a table cell under a header that names the zone (BOOK
 * UTC), with everything formatQuoteBookTime says in words kept as a mark:
 *
 * - When: the calendar day and the clock on every row, today's included
 *   (`24 Nov 23:40`, bookStamp): a weekday alone names no date. `not dated` for
 *   a book the source sent without its time; `dated` says which.
 * - Session, before it, where it is not the regular one: `PM`, `AH`, `lunch`,
 *   or `closed` for a quote left while the market was shut. No mark is the
 *   regular session, or a venue whose hours are not known.
 * - Feed, first: `◷` for a delayed feed and `snap` for a snapshot, by the
 *   book's own source. No mark is a real-time book, or a source that does not say.
 *
 * `◷closed 21 Nov 01:30`, `AH 24 Nov 23:40`, `◷not dated`. Null without a bid or an ask.
 */
export function formatQuoteBookCell(quote: Quote | null | undefined, now = Date.now()): { text: string; dated: boolean } | null {
  const book = readQuoteBook(quote, now);
  if (!book) return null;
  const feed = book.dataSource === "delayed" ? DELAYED_MARK : book.dataSource === "snapshot" ? `${SNAPSHOT_MARK} ` : "";
  const session = book.session ? BOOK_SESSION_MARKS[book.session] : null;
  const when = book.time == null ? QUOTE_BOOK_UNDATED : bookStamp(book.time, now);
  return { text: `${feed}${session ? `${session} ` : ""}${when}`, dated: book.time != null };
}

/**
 * When a quote's pre-market, after-hours or overnight print was observed, as
 * a card dates a price (asOfClock): `Sat 00:34 UTC` beside the close it is
 * measured from, which formatQuoteSessionAsOf dates. Null without such a print.
 */
export function formatExtendedPrintAsOf(quote: Quote | null | undefined, now = Date.now()): string | null {
  const time = extendedPrintTime(quote);
  return time == null ? null : asOfClock(Math.min(time, now), now);
}

/**
 * What a quote card's price is as of: CLOSED while its market is, else how
 * current its feed is, and when the price was observed (quoteHeadlineTime,
 * as an export's as_of dates it): `CLOSED · 08:09 UTC` for Hong Kong's close
 * beside `CLOSED · Fri 21:00 UTC` for New York's, whose after-hours print
 * says its own time (formatExtendedPrintAsOf). Null for a fund priced by its
 * NAV (formatQuoteNavAsOf dates it), a listing that no longer trades and a
 * quote stale for its session, whose own status says so.
 */
export function formatQuoteSessionAsOf(quote: Quote | null | undefined, now = Date.now()): string | null {
  if (!quote || quote.delisting || !(quote.lastUpdated > 0) || dailyNavDate(quote, now)) return null;
  const clock = asOfClock(Math.min(quoteHeadlineTime(quote), now), now);
  if (savedCopyAt(quote) != null) return clock;
  if (isQuoteStaleForCurrentSession(quote, now)) return null;
  const session = quoteSessionStateLabel(quote, now);
  const state = session === "CLOSED" ? session : quoteFeedWord(quote) ?? session;
  return state ? `${state} · ${clock}` : clock;
}

function clampQuoteTimestamp(lastUpdated: number | undefined, now = Date.now()): number | null {
  if (typeof lastUpdated !== "number" || !Number.isFinite(lastUpdated) || lastUpdated <= 0) {
    return null;
  }
  return Math.min(lastUpdated, now);
}

export interface QuoteAgeFormatOptions {
  /** Whole seconds only, for a surface whose clock ticks once a second:
   * milliseconds from that clock would be up to a second out. */
  seconds?: boolean;
}

export function formatQuoteAge(lastUpdated: number | undefined, now = Date.now(), options: QuoteAgeFormatOptions = {}): string {
  const clamped = clampQuoteTimestamp(lastUpdated, now);
  if (clamped == null) return MISSING_VALUE;

  // A receipt or source time ahead of the clock is fresh, never negative.
  const ageMs = Math.max(0, now - clamped);
  if (ageMs < 1000) return options.seconds ? "0s" : `${Math.floor(ageMs)}ms`;

  const ageSeconds = ageMs / 1000;
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`;
  return `${Math.floor(ageSeconds / 86400)}d`;
}

export function resolveQuoteAgeTimestamp(
  quote: Pick<Quote, "lastUpdated" | "receivedAt"> | null | undefined,
  now = Date.now(),
): number | null {
  if (!quote) return null;
  const receivedAt = clampQuoteTimestamp(quote.receivedAt, now);
  return receivedAt ?? clampQuoteTimestamp(quote.lastUpdated, now);
}

export function formatQuoteAgeWithSource(
  quote: Pick<Quote, "lastUpdated" | "receivedAt" | "dataSource"> | null | undefined,
  now = Date.now(),
  options: QuoteAgeFormatOptions = {},
): string {
  if (!quote) return MISSING_VALUE;

  const timestamp = resolveQuoteAgeTimestamp(quote, now);
  const age = timestamp == null ? MISSING_VALUE : formatQuoteAge(timestamp, now, options);
  if (age === MISSING_VALUE) return age;

  const prefix = quote.dataSource === "delayed" ? DELAYED_MARK : "";
  return prefix ? `${prefix}${age}` : age;
}
