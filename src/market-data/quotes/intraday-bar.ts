import type { Quote, QuoteIntradayBar } from "../../types/financials";
import { isQuoteStaleForCurrentSession } from "./freshness";

/**
 * A price Gloom Cloud took from a currency pair's own intraday bar, the pair's
 * print having stopped behind it, and why a print that trails stands: as the
 * data service states them, read so a malformed field is dropped, not shown.
 */
export function readIntradayBar(value: unknown): QuoteIntradayBar | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { start, minutes } = value as Record<string, unknown>;
  return typeof start === "number" && Number.isFinite(start) && typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0
    ? { start, minutes }
    : undefined;
}

export function readStaleReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `the close of the 06:30–06:35 UTC 5-min bar, ...`: what a price taken from a bar is, and why it was. */
export function intradayBarText(bar: QuoteIntradayBar): string {
  const clock = (time: number) => new Date(time).toISOString().slice(11, 16);
  return `the close of the ${clock(bar.start)}–${clock(bar.start + bar.minutes * 60_000)} UTC ${bar.minutes}-min bar, as the pair's quotes had stopped behind it`;
}

/**
 * The lines a quote's row adds about its pair's bars (`quote USD/BRL`): the
 * bar its price is the close of, and, while it reads stale, why its print
 * stands. Empty for any other quote.
 */
export function quoteBarNotes(label: string, quote: Quote, now = Date.now()): string[] {
  return [
    ...quote.intradayBar ? [`${label}: the price is ${intradayBarText(quote.intradayBar)}.`] : [],
    ...quote.staleReason && isQuoteStaleForCurrentSession(quote, now) ? [`${label}: ${quote.staleReason}`] : [],
  ];
}
