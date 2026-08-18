import type { MarketState, Quote } from "../../types/financials";
import { blendHex, colors, priceColor, type ThemeColors } from "../../theme/colors";

const CLOSED_CHANGE_MUTING_RATIO = 0.55;
const US_SESSION_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const REGULAR_OPEN_SECONDS = (9 * 60 + 30) * 60;
// ponytail: Standard SPY close; use provider session bounds if early-close countdowns matter.
const REGULAR_CLOSE_SECONDS = 16 * 60 * 60;
const CLOSING_COUNTDOWN_WINDOW_SECONDS = 60 * 60;

export interface ActiveQuoteDisplay {
  price: number;
  change: number;
  changePercent: number;
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
export function marketPriceColor(change: number, state?: MarketState): string {
  return isClosedMarketState(state) ? colors.textDim : priceColor(change);
}

/** Preserve a closed session's direction while visually distinguishing it from a live move. */
export function marketChangeColor(change: number, state?: MarketState): string {
  const directionalColor = priceColor(change);
  if (!isClosedMarketState(state) || change === 0) return directionalColor;
  return blendHex(directionalColor, colors.textDim, CLOSED_CHANGE_MUTING_RATIO);
}

/** Short exchange display name */
export function exchangeShortName(exchangeName?: string, fullExchangeName?: string): string {
  if (!exchangeName && !fullExchangeName) return "";
  const name = exchangeName || fullExchangeName || "";
  // Common Yahoo Finance exchange abbreviations
  const map: Record<string, string> = {
    NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ",
    NYQ: "NYSE", NYS: "NYSE",
    PCX: "AMEX", ASE: "AMEX",
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

export function getActiveQuoteDisplay(quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  if (!quote) return null;
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice != null) {
    return {
      price: quote.preMarketPrice,
      change: quote.preMarketChange ?? 0,
      changePercent: quote.preMarketChangePercent ?? 0,
    };
  }
  if ((quote.marketState === "POST" || quote.marketState === "POSTPOST") && quote.postMarketPrice != null) {
    return {
      price: quote.postMarketPrice,
      change: quote.postMarketChange ?? 0,
      changePercent: quote.postMarketChangePercent ?? 0,
    };
  }
  return {
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
  };
}
