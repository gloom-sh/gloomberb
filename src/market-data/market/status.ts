import type { MarketState, Quote } from "../../types/financials";
import { blendHex, colors, priceColor, type ThemeColors } from "../../theme/colors";
import { isFiniteNumber } from "../../utils/guards";
import { canonicalExchange, isKnownExchangeCode } from "../../utils/exchanges";
import { quoteTradingDay } from "../quotes/day-range";
import { isQuoteBeforeLatestSession } from "../quotes/freshness";
import { delistingLabel, delistingStateLabel } from "../quotes/delisting";
import { preMarketOpenOn, regularSessionCloseOn, venueSessionOnOrBefore } from "./freshness";
import { futuresWeekendClosure } from "./futures-week";

const CLOSED_CHANGE_MUTING_RATIO = 0.55;
const US_SESSION_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const REGULAR_OPEN_SECONDS = (9 * 60 + 30) * 60;
// Standard SPY close. Use provider session bounds if early-close countdowns matter.
const REGULAR_CLOSE_SECONDS = 16 * 60 * 60;
const CLOSING_COUNTDOWN_WINDOW_SECONDS = 60 * 60;

export interface ActiveQuoteDisplay {
  price: number;
  change?: number;
  changePercent?: number;
}

/**
 * A session outside the exchange's regular hours: its own pre-market and
 * after-hours, and the overnight session a US listing trades in between on
 * an alternative venue while its exchange is closed.
 */
export type ExtendedSession = "PRE" | "POST" | "OVERNIGHT";

/** What reports call each extended session's line or column. */
export const EXTENDED_SESSION_LABELS: Record<ExtendedSession, string> = { PRE: "Pre-Market", POST: "After Hours", OVERNIGHT: "Overnight" };

/** The extended line's label under a quote's headline (a translation key), and its mark where a tile or card is narrow. */
const EXTENDED_SESSION_LINE_LABELS: Record<ExtendedSession, string> = { PRE: "Pre-Market", POST: "After-Hours", OVERNIGHT: "Overnight" };
export const EXTENDED_SESSION_MARKS: Record<ExtendedSession, string> = { PRE: "PM", POST: "AH", OVERNIGHT: "ON" };

export interface ExtendedSessionDisplay extends ActiveQuoteDisplay {
  session: ExtendedSession;
  /** The price is the midpoint of the session's bid and ask, nothing having traded in it; absent for a trade. */
  mark?: true;
}

/** The extended line's label: the session's, saying "mid" when its price is a bid and ask midpoint rather than a trade. */
export function extendedSessionLineLabel(display: ExtendedSessionDisplay, translate: (text: string) => string = (text) => text): string {
  const label = translate(EXTENDED_SESSION_LINE_LABELS[display.session]);
  return display.mark ? `${label} ${translate("mid")}` : label;
}

export function marketStateLabel(state: MarketState): string {
  switch (state) {
    case "PRE": return "PRE-MKT";
    case "REGULAR": return "OPEN";
    case "POST": return "AFTER-HRS";
    case "PREPRE":
    case "POSTPOST":
    case "CLOSED": return "CLOSED";
  }
}

/** What a quote's session reads as once its last print is older than its venue's latest completed session. */
const STALE_SESSION_LABEL = "STALE";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The books an extended session's bid and ask belong to, as `ticker` names them. */
const EXTENDED_BOOK_LABELS: Partial<Record<MarketState, string>> = { PRE: "pre-market book", POST: "after-hours book" };

/**
 * What a quote's bid and ask are when the regular session is not on: the
 * pre-market or after-hours book, or a closed market's last quote with the
 * day it is from (ITA's $202.00 against $208.74 around a $206.65 close is no
 * open book). Null in the regular session or without a known state, when the
 * book is the live one. `ticker` prints it after Bid / Ask; the overview's
 * header already names the session, so its quote book does not repeat it.
 */
export function quoteBookSessionLabel(quote: Quote): string | null {
  const state = quote.marketState;
  if (!state || state === "REGULAR") return null;
  const extended = EXTENDED_BOOK_LABELS[state];
  if (extended) return extended;
  const day = quoteTradingDay(quote);
  const date = day ? new Date(`${day}T00:00:00Z`) : null;
  return date && Number.isFinite(date.getTime())
    ? `last quote, ${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
    : "last quote";
}

/** `Thu close`: the weekday of the session whose close a quote still stands at. */
function closeLabel(date: string): string {
  return `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} close`;
}

/**
 * The market state a quote's venue is in now. A futures venue's weekend gap
 * closes every contract, so it outranks the state a quote stamped before the
 * Friday close (a stale print reading REGULAR on a Sunday); every other quote
 * keeps the state its source reported.
 */
function quoteMarketState(quote: Quote | null | undefined, now = Date.now()): MarketState | undefined {
  if (!quote?.marketState) return undefined;
  return futuresWeekendClosure(quote.listingExchangeName || quote.exchangeName, now) ? "CLOSED" : quote.marketState;
}

/**
 * A quote's market state as a status cell names it (marketStateLabel), STALE
 * for a print older than its venue's latest session, and the close it stands
 * at (`Thu close`) in a pre-market nothing has traded in yet. A listing that
 * no longer trades says so with its last session ("Delisted Oct 27, 2022"),
 * whatever state its last print carries.
 */
export function quoteMarketStateLabel(quote: Quote | null | undefined, now = Date.now()): string | null {
  if (quote?.delisting) return delistingLabel(quote.delisting);
  if (!quote?.marketState) return null;
  if (isQuoteBeforeLatestSession(quote, now)) return STALE_SESSION_LABEL;
  const awaiting = preMarketCloseAwaitingPrint(quote);
  return awaiting ? closeLabel(awaiting.date) : marketStateLabel(quoteMarketState(quote, now)!);
}

/** An extended session's column, named as marketStateLabel names its state. */
export function extendedSessionStateLabel(session: ExtendedSession): string {
  return session === "OVERNIGHT" ? "OVERNIGHT" : marketStateLabel(session);
}

export function marketStateCountdown(state: MarketState, now = Date.now()): string | null {
  if (state !== "PRE" && state !== "REGULAR") return null;

  const parts = US_SESSION_TIME.formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const currentSeconds = (value("hour") * 60 + value("minute")) * 60 + value("second");
  const remainingSeconds = (state === "PRE" ? REGULAR_OPEN_SECONDS : REGULAR_CLOSE_SECONDS) - currentSeconds;
  if (remainingSeconds <= 0 || (state === "REGULAR" && remainingSeconds > CLOSING_COUNTDOWN_WINDOW_SECONDS)) return null;

  if (remainingSeconds >= 60 * 60) {
    const roundedMinutes = Math.ceil(remainingSeconds / 60);
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (remainingSeconds >= 10 * 60) return `${Math.ceil(remainingSeconds / 60)}m`;

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function marketStateColor(state: MarketState, palette: ThemeColors = colors): string {
  switch (state) {
    case "REGULAR": return palette.positive;
    case "PRE":
    case "POST": return palette.textBright;
    case "PREPRE":
    case "POSTPOST":
    case "CLOSED": return palette.textDim;
  }
}

export function marketStateDot(state?: MarketState): string {
  switch (state) {
    case "REGULAR":
      return "\u25CF";
    case "PRE":
    case "POST":
      return "\u25D0";
    case "CLOSED":
    case "PREPRE":
    case "POSTPOST":
      return "\u25CB";
    default:
      return "\u25CC";
  }
}

function isClosedMarketState(state?: MarketState): boolean {
  return state === "CLOSED" || state === "PREPRE" || state === "POSTPOST";
}

/**
 * The overnight session's price, while the quote's price is one (Gloom Cloud
 * sends overnightPrice only then, beside the closed exchange's state),
 * measured from the completed regular close the headline shows.
 */
function overnightSessionDisplay(quote: Quote): ExtendedSessionDisplay | null {
  const price = quote.overnightPrice;
  if (!isClosedMarketState(quote.marketState) || !isPositive(price)) return null;
  const mark = quote.overnightPriceKind === "mark" ? { mark: true as const } : {};
  const close = completedRegularClose(quote);
  if (close != null) {
    const change = price - close;
    return { session: "OVERNIGHT", price, change, changePercent: (change / close) * 100, ...mark };
  }
  return { session: "OVERNIGHT", price, change: quote.overnightChange, changePercent: quote.overnightChangePercent, ...mark };
}

/**
 * A quote's session as a status cell names it: "Delisted Oct 27, 2022" (or
 * "Last traded ...") for a listing that no longer trades, STALE when its last
 * print is older than its venue's latest completed session (isQuoteBeforeLatestSession),
 * the overnight session while the quote is priced by it, the close it stands
 * at (`Thu close`) in a pre-market nothing has traded in yet, else its market
 * state (marketStateLabel). The exchange stays closed overnight, so the state
 * alone reads CLOSED.
 */
export function quoteSessionLabel(quote: Quote | null | undefined, now = Date.now()): string | null {
  return sessionLabel(quote, now, true);
}

/**
 * quoteSessionLabel as an export keeps it, one of a fixed set: the market
 * state (`PRE-MKT`) in a pre-market nothing has traded in yet, where the
 * status cell names the close (`Thu close`), and DELISTED or INACTIVE for a
 * listing that no longer trades, its date being the export's own field.
 */
export function quoteSessionStateLabel(quote: Quote | null | undefined, now = Date.now()): string | null {
  return sessionLabel(quote, now, false);
}

function sessionLabel(quote: Quote | null | undefined, now: number, standingClose: boolean): string | null {
  if (quote?.delisting) return standingClose ? delistingLabel(quote.delisting) : delistingStateLabel(quote.delisting);
  if (!quote?.marketState) return null;
  if (isQuoteBeforeLatestSession(quote, now)) return STALE_SESSION_LABEL;
  if (overnightSessionDisplay(quote)) return "OVERNIGHT";
  const awaiting = standingClose ? preMarketCloseAwaitingPrint(quote) : null;
  return awaiting ? closeLabel(awaiting.date) : marketStateLabel(quoteMarketState(quote, now)!);
}

/**
 * The color of quoteSessionLabel: STALE, and a listing that no longer trades,
 * in the warning color every stale mark uses, an extended session's while the
 * overnight session prices the quote, a closed session's for the close a
 * pre-market still stands at.
 */
export function quoteSessionColor(quote: Quote | null | undefined, palette: ThemeColors = colors, now = Date.now()): string {
  if (quote?.delisting) return palette.warning;
  if (!quote?.marketState) return palette.textDim;
  if (isQuoteBeforeLatestSession(quote, now)) return palette.warning;
  if (overnightSessionDisplay(quote)) return marketStateColor("POST", palette);
  return marketStateColor(preMarketCloseAwaitingPrint(quote) ? "CLOSED" : quoteMarketState(quote, now)!, palette);
}

/**
 * The market state a session dot pictures for a quote: none for one whose
 * last print is older than its venue's latest session, so it draws as a quote
 * with no known session rather than an open market.
 */
export function quoteDotMarketState(quote: Quote | null | undefined, now = Date.now()): MarketState | undefined {
  return quote && !quote.delisting && !isQuoteBeforeLatestSession(quote, now) ? quoteMarketState(quote, now) : undefined;
}

/** Closed prices are final snapshots, so they should not look live or directional. */
export function marketPriceColor(change: number | undefined, state?: MarketState): string {
  return change == null || isClosedMarketState(state) ? colors.textDim : priceColor(change);
}

/** Preserve a closed session's direction while visually distinguishing it from a live move. */
export function marketChangeColor(change: number | undefined, state?: MarketState): string {
  if (change == null) return colors.textDim;
  const directionalColor = priceColor(change);
  if (!isClosedMarketState(state) || change === 0) return directionalColor;
  return blendHex(directionalColor, colors.textDim, CLOSED_CHANGE_MUTING_RATIO);
}

/**
 * The venue's code as a listing key names it (EPA, JPX), from the app's one
 * venue list, so the code a pane shows is the one to type after the symbol.
 * A venue the list does not know keeps the name it came with.
 */
export function exchangeShortName(exchangeName?: string, fullExchangeName?: string): string {
  const name = exchangeName || fullExchangeName || "";
  return isKnownExchangeCode(name) ? canonicalExchange(name) : name;
}

/**
 * The live print against the daily reference, extended hours included: what
 * a position is worth now and its day P&L. A headline that shows an
 * extended-hours line beside it uses getRegularSessionDisplay instead.
 */
export function getActiveQuoteDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  // A pre-market price of 0 is no print.
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && isPositive(quote.preMarketPrice)) {
    return { price: quote.preMarketPrice, change: quote.preMarketChange, changePercent: quote.preMarketChangePercent };
  }
  const extendedPrice = (quote.marketState === "POST" || quote.marketState === "POSTPOST") ? quote.postMarketPrice : undefined;
  if (extendedPrice != null) {
    // Generic quote/day-P&L views use the daily reference, while the separate
    // extended-hours row uses the completed regular session as its reference.
    const previousClose = quote.previousClose;
    const change = previousClose != null && Number.isFinite(previousClose) && previousClose > 0
      ? extendedPrice - previousClose : undefined;
    return { price: extendedPrice, change,
      changePercent: change != null ? (change / previousClose!) * 100 : undefined };
  }
  return { price: quote.price, change: quote.change, changePercent: quote.changePercent };
}

function isPositive(value: number | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}

interface CompletedRegularSession {
  close: number;
  /** The close's move from the session before it, when the quote reports it with the close. */
  reported: { change: number; changePercent: number } | null;
  /** The session's exchange-local date when the quote reports it with the close; otherwise the quote's own day. */
  date?: string;
}

function reportedRegularMove(quote: Quote, close: number): CompletedRegularSession["reported"] {
  const change = quote.regularChange;
  if (!isFiniteNumber(change)) return null;
  const reference = close - change;
  const changePercent = isFiniteNumber(quote.regularChangePercent)
    ? quote.regularChangePercent
    : isPositive(reference) ? (change / reference) * 100 : null;
  return changePercent == null ? null : { change, changePercent };
}

/**
 * The session a quote's day belongs to: its trading day (quoteTradingDay), or
 * for a print stamped on a day its venue does not trade (a Saturday after
 * midnight New York, a holiday), the latest session before it. No session is
 * read into a non-trading day.
 */
function quoteSessionDay(quote: Quote): string | null {
  const day = quoteTradingDay(quote);
  if (!day) return null;
  return venueSessionOnOrBefore(quote.listingExchangeName || quote.exchangeName, day) ?? day;
}

/**
 * The regular session the quote's day follows, once it is over: after hours,
 * overnight, and through a weekend or holiday until the next pre-market, and
 * in the pre-market when the quote reports the last session's close and move,
 * which its own previous close can no longer give once the day has rolled.
 * Only a US listing with extended trading reports one. Without a reported
 * close, an after-hours print less its move from the close gives it. Null in
 * the regular session.
 */
function completedRegularSession(quote: Quote): CompletedRegularSession | null {
  const state = quote.marketState;
  if (state == null || state === "REGULAR") return null;
  const close = quote.regularClose;
  if (isPositive(close)) {
    const closeDate = quote.regularCloseSessionDate;
    const reported = reportedRegularMove(quote, close);
    if (state === "PRE") {
      // The quote's own day is today; the close must be an earlier one, with its move.
      const today = quoteTradingDay(quote);
      return reported && closeDate && today && closeDate < today ? { close, reported, date: closeDate } : null;
    }
    // A print after the close, a weekend print included, never headlines over that close.
    if (closeDate ? closeDate === quoteSessionDay(quote) : state === "POST") {
      return closeDate ? { close, reported, date: closeDate } : { close, reported };
    }
  }
  if (state === "POST" && isFiniteNumber(quote.postMarketPrice) && isFiniteNumber(quote.postMarketChange)) {
    const derived = quote.postMarketPrice - quote.postMarketChange;
    if (derived > 0) return { close: derived, reported: null };
  }
  return null;
}

function completedRegularClose(quote: Quote): number | null {
  return completedRegularSession(quote)?.close ?? null;
}

/**
 * Whether a pre-market quote's pre-market price is a trade: not missing or
 * 0, not the regular close carried forward, and, when the source projects
 * its last print into the pre-market fields (`projected`), not the quote's
 * own price.
 */
function hasPreMarketPrint(quote: Quote, close: number, projected: boolean): boolean {
  const price = quote.preMarketPrice;
  if (!isPositive(price) || price === close) return false;
  return !(projected && price === quote.price);
}

/**
 * The completed regular session a pre-market quote's headline still shows
 * while nothing has traded in the pre-market, its exchange-local date and
 * when it closed, so the quote reads as that close (`Thu close`, at 20:00
 * UTC), not as the pre-market or the after-hours print before it. Only when
 * the quote cannot hold a pre-market trade: never when the source says it
 * does (extendedSessionPrint true); when it says nothing has traded (false),
 * while its pre-market price is no trade (hasPreMarketPrint), its own price
 * included while that was last updated before the pre-market opened; when it
 * does not say, while there is no pre-market price other than the close and
 * its last update is from before the venue's pre-market opened today. Null in
 * any other session, and while the quote cannot say which close its headline
 * is or its venue's hours are unknown.
 */
function preMarketCloseAwaitingPrint(quote: Quote | null | undefined): { date: string; closedAt: number } | null {
  if (quote?.marketState !== "PRE" || quote.extendedSessionPrint === true) return null;
  const session = completedRegularSession(quote);
  const today = quoteTradingDay(quote);
  if (!session?.date || !today) return null;
  const exchange = quote.listingExchangeName || quote.exchangeName;
  const opened = preMarketOpenOn(exchange, today);
  // Last updated before today's pre-market opened: the price is carried from the last session.
  const carried = opened != null && Number.isFinite(quote.lastUpdated) && quote.lastUpdated < opened;
  const saysNoTrade = quote.extendedSessionPrint === false;
  if (!saysNoTrade && !carried) return null;
  if (hasPreMarketPrint(quote, session.close, saysNoTrade && carried)) return null;
  const closedAt = regularSessionCloseOn(exchange, session.date);
  return closedAt == null ? null : { date: session.date, closedAt };
}

/**
 * When the price a quote's headline shows was observed: the regular close a
 * pre-market with no trade yet still stands at (preMarketCloseAwaitingPrint),
 * otherwise the quote's last update. What an Updated cell and a report's
 * as-of date the quote by.
 */
export function quoteHeadlineTime(quote: Quote): number {
  return preMarketCloseAwaitingPrint(quote)?.closedAt ?? quote.lastUpdated;
}

/**
 * The day's headline: the regular session, which stops at its close. Once it
 * is over, and in the pre-market while the quote carries the last session's
 * close and move, the price is that close and the move is its own, so
 * extended trading never moves it; the extended print is
 * getExtendedSessionDisplay. A close without its reported move is measured
 * against the previous close. In the pre-market without that close and move
 * the headline is the live price against the previous close, as the
 * pre-market line is.
 */
export function getRegularSessionDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  // A listing that no longer trades: its last session's close, which moves no more.
  if (quote.delisting) return { price: quote.price };
  const session = completedRegularSession(quote);
  if (session == null) return { price: quote.price, change: quote.change, changePercent: quote.changePercent };
  const { close, reported } = session;
  if (reported) return { price: close, ...reported };
  const reference = isPositive(quote.previousClose)
    ? quote.previousClose
    : isFiniteNumber(quote.change) && isPositive(quote.price - quote.change) ? quote.price - quote.change : null;
  if (reference == null) return { price: close };
  const change = close - reference;
  return { price: close, change, changePercent: (change / reference) * 100 };
}

/**
 * The exchange-local session getRegularSessionDisplay's move belongs to: the
 * completed session's while the headline still shows its close (a pre-market
 * quote before anything trades, whose own session is the day ahead), the
 * quote's declared session otherwise. Null when the quote names neither.
 */
export function regularSessionDisplayDate(quote: Quote | null | undefined): string | null {
  if (!quote) return null;
  return completedRegularSession(quote)?.date ?? quote.changeSessionDate ?? null;
}

/**
 * getRegularSessionDisplay once the regular session is over (and in the
 * pre-market, while the quote carries the last session's close and move), null
 * while it is open. A table row headlines this when it has a column for the
 * extended move: the close and its move stay put, and the extended column is
 * the only figure that follows the extended print.
 */
export function getCompletedRegularSessionDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  return quote && completedRegularClose(quote) != null ? getRegularSessionDisplay(quote) : null;
}

/**
 * The price a daily, weekly or monthly bar takes from a quote: the regular
 * session's, never an extended print, so a closed market's last bar is the
 * close `history` and `portfolio show --close` give. While the session
 * trades, or when the quote does not say its session, the quote's price. Once
 * it is over, its close as the headline reads it, with that session's date
 * when the quote reports one (in the pre-market it is an earlier day's).
 * Null in the pre-market while the quote cannot say which close that is: a
 * pre-market print is no regular session's price, and today's bar has not
 * opened.
 */
export function getRegularSessionBarClose(quote: Quote | null | undefined): { price: number; sessionDate: string | null } | null {
  if (!quote) return null;
  const state = quote.marketState;
  if (state == null || state === "REGULAR") return { price: quote.price, sessionDate: null };
  const session = completedRegularSession(quote);
  if (session) return { price: session.close, sessionDate: session.date ?? null };
  if (state === "PRE" || (state === "PREPRE" && quote.preMarketPrice != null)) return null;
  return { price: quote.price, sessionDate: null };
}

/**
 * The pre-market or after-hours print, measured from the regular close before
 * it, while the quote has one: the pre-market until the open, the after-hours
 * session from the close, and its last print until the next pre-market. Null
 * when there is no extended print to show.
 */
export function getExtendedSessionDisplay(quote: Quote | null | undefined): ExtendedSessionDisplay | null {
  if (!quote || quote.delisting) return null;
  const overnight = overnightSessionDisplay(quote);
  if (overnight) return overnight;
  const state = quote.marketState;
  if (state === "PRE" || state === "PREPRE") {
    // Nothing has traded in the pre-market: its figures are the close carried forward, no print.
    if (state === "PRE" && preMarketCloseAwaitingPrint(quote)) return null;
    // A pre-market price of 0 is no print.
    if (isPositive(quote.preMarketPrice)) {
      // Against the close the headline shows, so the two cannot disagree about it.
      const close = state === "PRE" ? completedRegularClose(quote) : null;
      if (close != null) {
        const change = quote.preMarketPrice - close;
        return { session: "PRE", price: quote.preMarketPrice, change, changePercent: (change / close) * 100 };
      }
      return { session: "PRE", price: quote.preMarketPrice, change: quote.preMarketChange, changePercent: quote.preMarketChangePercent };
    }
    if (state === "PRE") return null;
  }
  const close = completedRegularClose(quote);
  if (close == null) {
    return state === "POST" && isFiniteNumber(quote.postMarketPrice)
      ? { session: "POST", price: quote.postMarketPrice, change: quote.postMarketChange, changePercent: quote.postMarketChangePercent }
      : null;
  }
  const price = state === "POST" ? quote.postMarketPrice ?? quote.price : quote.price;
  // Once the session is over, a last print at the close means nothing traded after it.
  if (!isPositive(price) || (state !== "POST" && price === close)) return null;
  const change = price - close;
  return { session: "POST", price, change, changePercent: (change / close) * 100 };
}

/**
 * A quote's headline and extended print as flat figures, for a report row or
 * an export: price, change and changePercent are the regular session's
 * (getRegularSessionDisplay), the extended fields the pre-market or
 * after-hours print measured from its close (getExtendedSessionDisplay), all
 * null when there is none.
 */
export function getQuoteSessionFields(quote: Quote | null | undefined) {
  const headline = getRegularSessionDisplay(quote);
  const extended = getExtendedSessionDisplay(quote);
  return {
    price: headline?.price ?? null,
    change: headline?.change ?? null,
    changePercent: headline?.changePercent ?? null,
    extendedSession: extended?.session ?? null,
    extendedPrice: extended?.price ?? null,
    extendedChange: extended?.change ?? null,
    extendedChangePercent: extended?.changePercent ?? null,
  };
}

/** The extended display only while its session is open: the pre-market, the after-hours or the overnight session. */
function getOpenExtendedSessionDisplay(quote: Quote | null | undefined): ExtendedSessionDisplay | null {
  if (!quote) return null;
  return quote.marketState === "PRE" || quote.marketState === "POST" ? getExtendedSessionDisplay(quote) : overnightSessionDisplay(quote);
}

/**
 * The regular session alone, for a board that never shows extended trading:
 * the live quote while the session trades, then the completed session's close
 * and its move (getCompletedRegularSessionDisplay). Null outside the session
 * when the quote cannot say which close that is, rather than an extended
 * print or a flat move standing in for one. A quote that does not say its
 * session is read as the regular one, as getRegularSessionDisplay does.
 */
export function getRegularSessionMoveDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  if (quote.marketState == null || quote.marketState === "REGULAR") {
    return { price: quote.price, change: quote.change, changePercent: quote.changePercent };
  }
  return getCompletedRegularSessionDisplay(quote);
}

/**
 * The move a board of tiles colors by: the open pre-market or after-hours
 * session's, from the regular close, otherwise the day's regular session.
 */
export function getSessionMoveDisplay(
  quote: Quote | null | undefined,
): (ActiveQuoteDisplay & { session?: ExtendedSession }) | null {
  return getOpenExtendedSessionDisplay(quote) ?? getRegularSessionDisplay(quote);
}

/**
 * getSessionMoveDisplay for a board that marks an extended move on each tile
 * (the heat map): while a quote says nothing has traded in the open session
 * yet (extendedSessionPrint false), its extended figures are the close
 * carried forward, not a flat print, so the regular session stands, as it
 * does while the overnight price is a bid and ask midpoint.
 */
export function getTradedSessionMoveDisplay(
  quote: Quote | null | undefined,
): (ActiveQuoteDisplay & { session?: ExtendedSession }) | null {
  return quote?.extendedSessionPrint === false || quote?.overnightPriceKind === "mark"
    ? getRegularSessionDisplay(quote)
    : getSessionMoveDisplay(quote);
}
