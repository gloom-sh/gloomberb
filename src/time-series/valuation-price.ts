import type { PricePoint, Quote } from "../types/financials";
import { mergePriceHistoryIntegrity, pricePointIntegrity } from "../utils/price-history-integrity";

export type ValuationPriceIssue = ({
  kind: "quote";
  reason: "stale" | "invalid-price" | "invalid-timestamp";
  quote: Pick<Quote, "symbol" | "currency" | "price" | "lastUpdated" | "stale" | "providerId">;
} | {
  kind: "history";
  reason: "invalid-price";
  point: Omit<PricePoint, "date"> & { date: string };
}) & { affectedAt?: string };

export function valuationQuoteIssue(quote: Quote | undefined): ValuationPriceIssue | undefined {
  if (!quote) return undefined;
  const reason = quote.stale === true ? "stale"
    : !Number.isFinite(quote.price) || quote.price <= 0 ? "invalid-price"
      : !Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0
        || !Number.isFinite(new Date(quote.lastUpdated).getTime()) ? "invalid-timestamp" : null;
  if (!reason) return undefined;
  const { symbol, currency, price, lastUpdated, stale, providerId } = quote;
  return { kind: "quote", reason, quote: { symbol, currency, price, lastUpdated, stale, providerId },
    ...(Number.isFinite(lastUpdated) && lastUpdated > 0 && Number.isFinite(new Date(lastUpdated).getTime())
      ? { affectedAt: new Date(lastUpdated).toISOString() } : {}) };
}

/** Select the source observation before validating it; a rejected latest row
 * cannot silently borrow an older price. Conflicting rows at that same time
 * retain any reported OHLC contradiction until the source replaces them. */
export function valuationPriceAtOrBefore(history: readonly PricePoint[], date: string) {
  const target = Date.parse(date);
  if (!Number.isFinite(target)) return null;
  let latest = -Infinity;
  let points: PricePoint[] = [];
  for (const point of history) {
    // Persisted Date values arrive as strings. Missing dates must not become epoch zero.
    const time = point.date instanceof Date ? point.date.getTime()
      : typeof point.date === "string" ? Date.parse(point.date) : NaN;
    if (!Number.isFinite(time) || time > target || time < latest) continue;
    if (time > latest) { latest = time; points = []; }
    points.push(point);
  }
  if (!points.length) return null;
  const issues = points.flatMap((point) => {
    const integrity = pricePointIntegrity(point);
    return integrity ? [integrity] : [];
  });
  if (issues.length) return { price: null, integrity: mergePriceHistoryIntegrity(...issues) };
  const invalid = points.find((point) => !Number.isFinite(point.close) || point.close <= 0);
  if (invalid) return {
    price: null,
    issue: { kind: "history", reason: "invalid-price", point: Object.freeze({ ...invalid,
      date: new Date(invalid.date).toISOString(),
      ...(invalid.historySource ? { historySource: Object.freeze({ ...invalid.historySource }) } : {}),
    }) } satisfies ValuationPriceIssue,
  };
  return { price: points[0]!.close };
}

export function valuationPriceWarning(issues: readonly ValuationPriceIssue[]): string | undefined {
  const messages = issues.map((issue) => issue.kind === "history"
    ? "Historical valuation unavailable: source price is invalid."
    : issue.reason === "stale" ? "Current valuation unavailable: source quote is stale."
      : issue.reason === "invalid-price" ? "Current valuation unavailable: source quote price is invalid."
        : "Current valuation unavailable: source quote timestamp is unavailable.");
  return messages.length ? [...new Set(messages)].join(" ") : undefined;
}
