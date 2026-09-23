import { formatMarketPriceWithCurrency } from "../../../market-data/market/format";
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

export function formatTickerBadgeChange(changePercent: number): string {
  const rounded = Math.round(changePercent * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  if (normalized === 0) return "0%";
  const abs = Math.abs(normalized);
  const body = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return `${normalized > 0 ? "+" : "-"}${body}%`;
}

export interface TickerBadgeTextOptions {
  symbol: string;
  status: TickerBadgeStatus;
  quote: Quote | null;
  liveQuote?: boolean;
  hovered?: boolean;
  /**
   * Text budget for the chip. A table column is narrow, and a clipped price is
   * worse than no price, so the badge drops back to whatever still fits.
   */
  maxTextWidth?: number;
}

/**
 * Candidates run richest first: the hovered price, then the day's change, then
 * the bare symbol, which always fits because the caller sized the column for it.
 */
function tickerBadgeTextCandidates({
  symbol,
  status,
  quote,
  liveQuote = true,
  hovered = false,
}: TickerBadgeTextOptions): string[] {
  const quoteForDisplay = liveQuote ? quote : null;
  const candidates: string[] = [];
  if (hovered && quoteForDisplay) {
    candidates.push(`${symbol} ${formatMarketPriceWithCurrency(quoteForDisplay.price, quoteForDisplay.currency, { minimumFractionDigits: 2 })}`);
  }
  if (liveQuote) {
    if (status === "ready" && quoteForDisplay) {
      candidates.push(`${symbol} ${formatTickerBadgeChange(quoteForDisplay.changePercent)}`);
    } else if (status === "loading") {
      candidates.push(`${symbol} \u2026`);
    }
  }
  candidates.push(symbol);
  return candidates;
}

export function getTickerBadgeText(options: TickerBadgeTextOptions): string {
  const candidates = tickerBadgeTextCandidates(options);
  const maxTextWidth = options.maxTextWidth;
  if (maxTextWidth == null) return candidates[0]!;
  return candidates.find((text) => displayWidth(text) <= maxTextWidth)
    ?? candidates[candidates.length - 1]!;
}

export function getTickerBadgeCellWidth(options: TickerBadgeTextOptions): number {
  return displayWidth(getTickerBadgeText(options)) + TICKER_BADGE_CHROME_WIDTH;
}

/** The widest day change a badge is laid out for (`-99.9%`). */
const RESERVED_BADGE_CHANGE_PERCENT = -99.9;

/**
 * Cell width that survives ticks: at least as wide as the badge with the widest
 * ordinary change, so text laid out around a live badge does not re-wrap when
 * the change gains a digit or a sign.
 */
export function getTickerBadgeReservedCellWidth(options: TickerBadgeTextOptions): number {
  const width = getTickerBadgeCellWidth(options);
  if (options.status !== "ready" || !options.quote || options.hovered) return width;
  return Math.max(width, getTickerBadgeCellWidth({
    ...options,
    quote: { ...options.quote, changePercent: RESERVED_BADGE_CHANGE_PERCENT },
  }));
}
