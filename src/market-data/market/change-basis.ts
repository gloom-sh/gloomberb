import { classifyInstrumentType, kindFromListingSyntax } from "../../tickers/instrument-kind";
import { isPerpetualExchange } from "../../tickers/perpetual-listing";
import type { Quote } from "../../types/financials";
import { canonicalExchange } from "../../utils/exchanges";
import { isFiniteNumber } from "../../utils/guards";
import { formatUtcDayTime } from "../../utils/utc-time";
import { fxPrintTradingDay } from "../../utils/fx-market-hours";
import { zonedDateKey } from "../../utils/zoned-date-time";
import { futuresChangeBasis, futuresSettleText, isFuturesInstrument } from "../futures-contract";
import { quoteTradingDay } from "../quotes/day-range";
import { hasPublishedSessionCalendar, previousPublishedSession } from "./freshness";
import { getActiveQuoteDisplay, getRegularSessionDisplay, regularSessionDisplayDate } from "./status";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a quote's day change is measured from, so every change line can say
 * it: the close of a dated session (a future's settlement or last trade), a
 * previous close the venue's calendar cannot date, a coin's previous UTC
 * day (its price at 00:00 UTC) or the last 24 hours.
 */
export type QuoteChangeBasis =
  | DatedChangeBasis
  | { kind: "previous close" }
  | { kind: "utc day" }
  | { kind: "24h" };

/** A move from a dated session's close, settlement or last trade. */
interface DatedChangeBasis {
  kind: "close" | "settle" | "last trade";
  /** The exchange-local date of the session the move is measured from. */
  date: string;
  /** The venue, when its calendar dated the close. */
  venue?: string;
  /** Days of the venue's trading week it was closed between that session and the move's (holidays). */
  closed?: readonly string[];
}

export interface QuoteChangeBasisOptions {
  /**
   * Which move: the regular session a headline shows (getRegularSessionDisplay,
   * the default), or the latest print a position's day is valued at
   * (getActiveQuoteDisplay), extended hours included.
   */
  session?: "regular" | "active";
  /** A future's contract terms, whose settlement names what its move is from. */
  terms?: Parameters<typeof futuresChangeBasis>[0];
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * The weekday before the one a move is dated to, Saturday and Sunday skipped:
 * a currency pair's week. A move dated on a weekend is Friday's, from Thursday.
 */
function weekdayBefore(date: string): string {
  let at = Date.parse(`${date}T00:00:00Z`);
  while (new Date(at).getUTCDay() % 6 === 0) at -= DAY_MS;
  at -= DAY_MS;
  while (new Date(at).getUTCDay() % 6 === 0) at -= DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

function quoteVenue(quote: Quote): string {
  return canonicalExchange(quote.listingExchangeName || quote.exchangeName);
}

/**
 * The venue whose calendar an index's sessions follow, where its quote names
 * the index's publisher or feed instead of a venue: the Hang Seng family's
 * HKSE trades HKEX's days, the Nikkei 225's OSAKA JPX's, and the US
 * publishers' the US equity calendar. An index quoted under a venue (KRX, NSE,
 * SSE) is that venue's already.
 */
const INDEX_CALENDAR_VENUES: Readonly<Record<string, string>> = {
  HKSE: "HKEX",
  OSAKA: "JPX",
  SNP: "NYSE",
  DJI: "NYSE",
  "NASDAQ GIDS": "NASDAQ",
  "CBOE INDICES": "CBOE",
  "CHICAGO OPTIONS": "CBOE",
};

/** The venue whose published calendar dates the quote's sessions. */
function calendarVenue(quote: Quote): string {
  const venue = quoteVenue(quote);
  const index = classifyInstrumentType(quote.instrumentType) === "index" || kindFromListingSyntax(quote.symbol) === "index";
  return (index && INDEX_CALENDAR_VENUES[venue]) || venue;
}

function isCurrencyPair(quote: Quote): boolean {
  return classifyInstrumentType(quote.instrumentType) === "currency"
    || kindFromListingSyntax(quote.symbol, quote.listingExchangeName || quote.exchangeName) === "currency";
}

/**
 * The trading day a quote describes (quoteTradingDay); for a currency pair,
 * whose venue has no clock, the FX trading day of its print, which turns at
 * 17:00 New York, so every pair on a board is dated alike. Null for a pair's
 * print made while FX is shut, which belongs to no trading day.
 */
function tradingDayOf(quote: Quote): string | null {
  const day = quoteTradingDay(quote);
  if (day || !isCurrencyPair(quote) || !Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return day;
  return fxPrintTradingDay(quote.lastUpdated);
}

/** A coin on the spot crypto venue: its day is the UTC day. */
function isSpotCoin(quote: Quote): boolean {
  return quoteVenue(quote) === "CCC";
}

/**
 * The index session before the one a move is dated to, from the regular
 * sessions an index quote carries (indexSession): the latest one on or before
 * `date` is the move's (a quote read on a Saturday has Friday's), and the one
 * before that is what it moves from.
 */
function previousIndexSession(quote: Quote, date: string): string | null {
  const session = quote.indexSession;
  if (!session?.timeZone) return null;
  const windows = [...session.regular, ...(session.current ? [session.current] : [])];
  const days = [...new Set(windows.map((window) => zonedDateKey(window.start, session.timeZone)))]
    .filter((day) => day <= date)
    .sort();
  return days.length >= 2 ? days.at(-2)! : null;
}

/**
 * The session before the one a move is dated to: from the venue's published
 * calendar, with the closures in between (an index's, the venue whose days it
 * follows); otherwise for an index from its own sessions; for a currency pair
 * the weekday before; for any other listing the day its own daily closes date
 * its previous close to (`previousCloseDate`, PreviousCloseDates). Null
 * when nothing dates it.
 */
function previousSession(quote: Quote, sessionDate: string): DatedChangeBasis | null {
  const venue = calendarVenue(quote);
  const published = previousPublishedSession(venue, sessionDate);
  if (published) return { kind: "close", date: published.date, venue, closed: published.closed };
  const index = previousIndexSession(quote, sessionDate);
  if (index) return { kind: "close", date: index };
  if (isCurrencyPair(quote)) return { kind: "close", date: weekdayBefore(sessionDate) };
  const dated = quote.previousCloseDate;
  if (dated && ISO_DATE.test(dated) && dated < sessionDate) return { kind: "close", date: dated };
  return null;
}

/**
 * Whether something other than the listing's own daily closes dates every
 * move of the quote: a future's terms, a coin's UTC day, a perpetual's 24
 * hours, a currency pair's weekday, or its venue's calendar for the year of
 * `now`. A few lookups, for a caller that runs on every tick before it asks
 * quoteChangeBasis.
 */
export function isChangeBasisDatedWithoutCloses(quote: Quote, now = Date.now()): boolean {
  if (isSpotCoin(quote) || isCurrencyPair(quote) || isFuturesInstrument(quote.symbol, quote.instrumentType)) return true;
  if (isPerpetualExchange(quote.listingExchangeName || quote.exchangeName)) return true;
  return hasPublishedSessionCalendar(calendarVenue(quote), new Date(now).toISOString().slice(0, 10));
}

/**
 * The exchange-local date of the session a quote's regular move is dated to,
 * the one `quoteChangeBasis` measures from the session before; null when
 * nothing dates it.
 */
export function changeBasisSessionDate(quote: Quote): string | null {
  const date = regularSessionDisplayDate(quote) ?? tradingDayOf(quote);
  return date && ISO_DATE.test(date) ? date : null;
}

/**
 * What the quote's move is measured from. A coin moves from its previous UTC
 * day's close, the price at 00:00 UTC, unless Gloom Cloud says it moves over
 * the last 24 hours; a perpetual always moves over 24 hours. A future's is the
 * settlement or trade its terms name, or the close of the trade date before
 * on its venue's holiday calendar (futuresChangeBasis). Anything else is
 * the close of the session before the move's, dated by the venue's calendar;
 * on a venue without one, by the listing's own daily closes once they were
 * read (PreviousCloseDates), and otherwise left undated, never guessed.
 * Null for a quote with no move: none reported, or a listing that no longer
 * trades.
 */
export function quoteChangeBasis(
  quote: Quote | null | undefined,
  { session = "regular", terms = null }: QuoteChangeBasisOptions = {},
): QuoteChangeBasis | null {
  if (!quote || quote.delisting || quote.changeBasis === "none") return null;
  const display = session === "active" ? getActiveQuoteDisplay(quote) : getRegularSessionDisplay(quote);
  if (!display || !isFiniteNumber(display.change)) return null;
  if (quote.changeBasis === "24h" || isPerpetualExchange(quote.listingExchangeName || quote.exchangeName)) return { kind: "24h" };
  if (isSpotCoin(quote)) return { kind: "utc day" };
  const sessionDate = (session === "active" ? quote.changeSessionDate : regularSessionDisplayDate(quote)) ?? tradingDayOf(quote);
  if (isFuturesInstrument(quote.symbol, quote.instrumentType)) {
    const basis = futuresChangeBasis(terms ?? { settlement: null }, { ...display, sessionDate }, quoteVenue(quote));
    return basis ? { kind: basis.kind, date: basis.session } : { kind: "previous close" };
  }
  if (!sessionDate || !ISO_DATE.test(sessionDate)) return { kind: "previous close" };
  return previousSession(quote, sessionDate) ?? { kind: "previous close" };
}

/**
 * A futures quote's Settle line, paired with its Change line: the settlement
 * is shown when it is of the session the move is measured from or a later one,
 * and reads `--` with that session when the terms have not caught up to it
 * (futuresSettleText), so the two lines never name different sessions.
 */
export function quoteSettleText(
  quote: Quote | null | undefined,
  terms: NonNullable<QuoteChangeBasisOptions["terms"]> & Parameters<typeof futuresSettleText>[0],
): string {
  const basis = quoteChangeBasis(quote, { terms });
  return futuresSettleText(terms, quote, basis && "date" in basis ? basis.date : null);
}

/**
 * The exchange-local date of `quote.previousClose`: the session before the
 * one the quote's change is declared for (changeSessionDate), the UTC day
 * before for a coin. Null when the quote has no previous close or nothing
 * dates it, and for a coin or perpetual measured over 24 hours.
 */
export function quotePreviousCloseDate(quote: Quote | null | undefined): string | null {
  if (!quote || !isFiniteNumber(quote.previousClose) || quote.changeBasis != null) return null;
  if (isPerpetualExchange(quote.listingExchangeName || quote.exchangeName)) return null;
  const sessionDate = quote.changeSessionDate ?? tradingDayOf(quote);
  if (!sessionDate || !ISO_DATE.test(sessionDate)) return null;
  if (isSpotCoin(quote)) return dayBefore(sessionDate);
  if (isFuturesInstrument(quote.symbol, quote.instrumentType)) {
    return futuresChangeBasis({ settlement: null }, { price: quote.price, change: 0, sessionDate }, quoteVenue(quote))?.session ?? null;
  }
  return previousSession(quote, sessionDate)?.date ?? null;
}

/** `Fri 16 Oct`, with the year when it is not `now`'s. */
function sessionDay(date: string, now: number): string {
  return formatUtcDayTime({ time: Date.parse(`${date}T00:00:00Z`), dateOnly: true }, now);
}

/**
 * The words a change line ends with, the same on every surface: "vs Fri 16
 * Oct close", "vs Fri 16 Oct settle", "vs prev close", "since 00:00 UTC",
 * "24h".
 */
export function changeBasisLabel(basis: QuoteChangeBasis, now = Date.now()): string {
  switch (basis.kind) {
    case "previous close":
      return "vs prev close";
    case "utc day":
      return "since 00:00 UTC";
    case "24h":
      return "24h";
    default:
      return `vs ${sessionDay(basis.date, now)} ${basis.kind}`;
  }
}

/**
 * The days a venue was closed since the close a move is measured from, when
 * there were any: "HKEX closed Mon 19 Oct, holiday"; three or more read as a
 * span, "TWSE closed Thu 12 Feb to Fri 20 Feb, holidays". Null otherwise.
 */
export function changeBasisNote(basis: QuoteChangeBasis | null | undefined, now = Date.now()): string | null {
  if (!basis || basis.kind !== "close" || !basis.venue || !basis.closed?.length) return null;
  const days = basis.closed.map((date) => sessionDay(date, now));
  const span = days.length === 1 ? days[0] : days.length === 2 ? `${days[0]} and ${days[1]}` : `${days[0]} to ${days.at(-1)}`;
  return `${basis.venue} closed ${span}, ${days.length === 1 ? "holiday" : "holidays"}`;
}

/** What several moves summed into one (a portfolio's day) are measured from, when they say. */
const MIXED_CHANGE_BASIS_LABEL = "vs mixed closes";

/**
 * The label of a total over moves measured from different closes: the one
 * label when they agree, "vs mixed closes" when they do not, so a total over
 * an HKEX and a US listing never names one date for both. Null without a
 * basis.
 */
export function combinedChangeBasisLabel(bases: Iterable<QuoteChangeBasis | null | undefined>, now = Date.now()): string | null {
  const labels = new Set<string>();
  for (const basis of bases) if (basis) labels.add(changeBasisLabel(basis, now));
  if (labels.size === 0) return null;
  return labels.size === 1 ? [...labels][0]! : MIXED_CHANGE_BASIS_LABEL;
}

/**
 * The basis as `--json` gives it beside a move: the kind, the dated session
 * (`date`), the venue's closures in between and the label and note a change
 * line shows.
 */
export function changeBasisJson(basis: QuoteChangeBasis | null, now = Date.now()) {
  if (!basis) return null;
  const note = changeBasisNote(basis, now);
  return {
    kind: basis.kind,
    date: "date" in basis ? basis.date : null,
    ...("closed" in basis && basis.closed?.length ? { closed: [...basis.closed] } : {}),
    label: changeBasisLabel(basis, now),
    ...(note ? { note } : {}),
  };
}
