import {
  formatMarketPrice,
  formatMarketPriceWithCurrency,
  liveQuoteFormatOptions,
} from "../../../market-data/market/format";
import { blendHex, colors, hoverText, type ThemeColors } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { displayWidth } from "../../../utils/format";

/**
 * `ambiguous` resolved to several listings, so there is nothing to wait for and
 * nothing to price: the badge shows the bare symbol and opening it asks which
 * listing was meant.
 */
export type TickerBadgeStatus = "loading" | "ready" | "ambiguous";

/** Padding inside the chip plus the gap that separates it from the next one. */
export const TICKER_BADGE_CHROME_WIDTH = 3;

/**
 * How far a price shortened to fit a chip may round off, as a share of the
 * price: $235 for $234.56 still reads as the price, $0.5 for $0.4512 does not.
 */
const MAX_FITTED_PRICE_ROUNDING = 0.01;

/**
 * A chip's fill and text. At rest its tone (the day's move, or the accent while
 * there is none) on a light wash of itself; under the pointer a deeper wash,
 * with text lit the way every hovered control's is.
 */
export function tickerBadgeColors(tone: string, hovered: boolean, palette: ThemeColors = colors): { fg: string; bg: string } {
  if (!hovered) return { fg: tone, bg: blendHex(palette.bg, tone, 0.18) };
  const bg = blendHex(palette.bg, tone, 0.42);
  return { fg: hoverText(bg, palette), bg };
}

/** One decimal on every tick, so a chip does not narrow when the move lands on a whole percent. */
export function formatTickerBadgeChange(changePercent: number): string {
  const body = Math.abs(changePercent).toFixed(1);
  if (!/[1-9]/.test(body)) return `${body}%`;
  return `${changePercent > 0 ? "+" : "-"}${body}%`;
}

/** A quote's last price as a badge shows it: its currency and its instrument's decimals. */
export function formatTickerBadgePrice(quote: Quote, maxWidth?: number): string {
  return formatMarketPriceWithCurrency(quote.price, quote.currency, {
    ...liveQuoteFormatOptions(quote, quote.currency),
    maxWidth,
  });
}

export interface TickerBadgeTextOptions {
  symbol: string;
  status: TickerBadgeStatus;
  quote: Quote | null;
  liveQuote?: boolean;
  /**
   * Text budget for the chip. A table column is narrow, and a clipped price is
   * worse than no price, so the badge drops back to whatever still fits.
   */
  maxTextWidth?: number;
}

/**
 * Candidates run richest first: the day's change, then the bare symbol, which
 * always fits because the caller sized the column for it.
 */
function tickerBadgeTextCandidates({
  symbol,
  status,
  quote,
  liveQuote = true,
}: TickerBadgeTextOptions): string[] {
  const candidates: string[] = [];
  if (liveQuote) {
    if (status === "ready" && quote && Number.isFinite(quote.changePercent)) {
      candidates.push(`${symbol} ${formatTickerBadgeChange(quote.changePercent)}`);
    } else if (status === "loading") {
      candidates.push(`${symbol} \u2026`);
    }
  }
  candidates.push(symbol);
  return candidates;
}

/** What a chip says at rest, which also sets its width under the pointer. */
export function getTickerBadgeText(options: TickerBadgeTextOptions): string {
  const candidates = tickerBadgeTextCandidates(options);
  const maxTextWidth = options.maxTextWidth;
  if (maxTextWidth == null) return candidates[0]!;
  return candidates.find((text) => displayWidth(text) <= maxTextWidth)
    ?? candidates[candidates.length - 1]!;
}

/** A shortened price that still names the price: no exponent or clipping mark, rounded off by little. */
function readsAsPrice(label: string, price: number): boolean {
  if (label.includes("\u2026") || /\de[+-]?\d/i.test(label)) return false;
  const value = Number(label.replace(/[^\d.-]/g, ""));
  return Number.isFinite(value) && Math.abs(value - price) <= Math.abs(price) * MAX_FITTED_PRICE_ROUNDING;
}

/**
 * What a chip says under the pointer: its price alone, in no more than the
 * width of its resting text, so hovering never moves the text or chips around
 * it. A price too long for the chip gives up its grouping and decimals, then
 * its currency; when even that does not read as the price, there is none, and
 * the chip keeps its resting text. Loading, ambiguous and unpriced chips have
 * no price to show.
 */
export function getTickerBadgeHoverText(options: TickerBadgeTextOptions): string | null {
  const { status, quote, liveQuote = true } = options;
  if (!liveQuote || status !== "ready" || !quote || !Number.isFinite(quote.price)) return null;
  const width = displayWidth(getTickerBadgeText(options));
  const full = formatTickerBadgePrice(quote);
  if (displayWidth(full) <= width) return full;
  const fitted = [
    formatTickerBadgePrice(quote, width),
    formatMarketPrice(quote.price, { ...liveQuoteFormatOptions(quote, quote.currency), currency: quote.currency, maxWidth: width }),
  ];
  return fitted.find((label) => displayWidth(label) <= width && readsAsPrice(label, quote.price)) ?? null;
}
