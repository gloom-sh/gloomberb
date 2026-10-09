import type { MarketState, Quote } from "../../types/financials";
import { blendHex, colors, priceColor, type ThemeColors } from "../../theme/colors";
import { isFiniteNumber } from "../../utils/guards";
import { quoteTradingDay } from "../quotes/day-range";

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

export type ExtendedSession = "PRE" | "POST";

export interface ExtendedSessionDisplay extends ActiveQuoteDisplay {
  session: ExtendedSession;
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

/** Short exchange display name */
export function exchangeShortName(exchangeName?: string, fullExchangeName?: string): string {
  if (!exchangeName && !fullExchangeName) return "";
  const name = exchangeName || fullExchangeName || "";
  // Common market data exchange abbreviations
  const map: Record<string, string> = {
    NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ",
    NYQ: "NYSE", NYS: "NYSE",
    PCX: "ARCA", NYSEArca: "ARCA", "NYSE Arca": "ARCA", ASE: "AMEX",
    HKG: "HKEX",
    TYO: "TYO",
    LSE: "LSE",
    ASX: "ASX",
    SGX: "SGX",
    KSC: "KRX", KOE: "KOSDAQ",
    TAI: "TWSE",
    SHH: "SSE", SHZ: "SZSE",
    PAR: "EURONEXT", AMS: "EURONEXT", BRU: "EURONEXT",
    GER: "XETRA",
    OSL: "OSE",
    BOM: "BSE", NSI: "NSE",
    SAO: "B3",
    JPX: "TYO",
  };
  return map[name] || name;
}

/**
 * The live print against the daily reference, extended hours included: what
 * a position is worth now and its day P&L. A headline that shows an
 * extended-hours line beside it uses getRegularSessionDisplay instead.
 */
export function getActiveQuoteDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice != null) {
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

/**
 * The official close of the regular session the quote's day belongs to, once
 * that session is over: after hours, overnight, and through a weekend or
 * holiday until the next pre-market. Only a US listing with extended trading
 * reports one. Without a reported close, an after-hours print less its move
 * from the close gives it. Null in the regular session and the pre-market.
 */
function completedRegularClose(quote: Quote): number | null {
  const state = quote.marketState;
  if (state == null || state === "REGULAR" || state === "PRE") return null;
  const close = quote.regularClose;
  if (isPositive(close)) {
    const closeDate = quote.regularCloseSessionDate;
    if (closeDate ? closeDate === quoteTradingDay(quote) : state === "POST") return close;
  }
  if (state === "POST" && isFiniteNumber(quote.postMarketPrice) && isFiniteNumber(quote.postMarketChange)) {
    const derived = quote.postMarketPrice - quote.postMarketChange;
    if (derived > 0) return derived;
  }
  return null;
}

/**
 * The day's headline: the regular session, which stops at its close. After
 * the close the price is that close and the move is the close against the
 * previous one, so extended trading never moves it; the extended print is
 * getExtendedSessionDisplay. In the pre-market the quote carries no earlier
 * close to measure the last session by, so the headline is the live price
 * against the previous close, as the pre-market line is.
 */
export function getRegularSessionDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  const close = completedRegularClose(quote);
  if (close == null) return { price: quote.price, change: quote.change, changePercent: quote.changePercent };
  const reference = isPositive(quote.previousClose)
    ? quote.previousClose
    : isFiniteNumber(quote.change) && isPositive(quote.price - quote.change) ? quote.price - quote.change : null;
  if (reference == null) return { price: close };
  const change = close - reference;
  return { price: close, change, changePercent: (change / reference) * 100 };
}

/**
 * getRegularSessionDisplay once the regular session is over, null while it is
 * open or in the pre-market. A table row headlines this when it has a column
 * for the extended move: the close and the day's move stay put, and the
 * extended column is the only figure that follows the extended print.
 */
export function getCompletedRegularSessionDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  return quote && completedRegularClose(quote) != null ? getRegularSessionDisplay(quote) : null;
}

/**
 * The pre-market or after-hours print, measured from the regular close before
 * it, while the quote has one: the pre-market until the open, the after-hours
 * session from the close, and its last print until the next pre-market. Null
 * when there is no extended print to show.
 */
export function getExtendedSessionDisplay(quote: Quote | null | undefined): ExtendedSessionDisplay | null {
  if (!quote) return null;
  const state = quote.marketState;
  if (state === "PRE" || state === "PREPRE") {
    if (isFiniteNumber(quote.preMarketPrice)) {
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

/** The extended display only while its session is open: the pre-market or the after-hours session. */
function getOpenExtendedSessionDisplay(quote: Quote | null | undefined): ExtendedSessionDisplay | null {
  return quote?.marketState === "PRE" || quote?.marketState === "POST" ? getExtendedSessionDisplay(quote) : null;
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
