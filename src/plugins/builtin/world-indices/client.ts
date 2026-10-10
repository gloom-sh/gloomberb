import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { IndexEntry } from "./indices";
import { errorMessage } from "../../../utils/errors";
import { isNoProviderMessage } from "../../../sources/provider-errors";

/** What a row says in place of figures the feed does not carry. */
export const NOT_IN_FEED = "not available from the feed";

/** Whether the feed has no quote for a symbol, as opposed to a quote that failed to load. */
export function isFeedGap(error: string | null | undefined): boolean {
  return !!error && isNoProviderMessage(error);
}

export interface WorldIndexQuoteResult {
  quotes: Map<string, Quote | null>;
  /** Failures to load: a timeout, an outage. A symbol the feed simply lacks is in `gaps`. */
  errors: string[];
  /** Symbols the feed has no quote for. They are a data gap, so their rows say so rather than carry an error. */
  gaps: Set<string>;
}

export async function loadWorldIndexQuotes(
  entries: readonly IndexEntry[],
  provider: DataProvider,
): Promise<WorldIndexQuoteResult> {
  const quotes = new Map<string, Quote | null>();
  const errors: string[] = [];
  const gaps = new Set<string>();
  const fail = (symbol: string, error: unknown) => {
    const message = errorMessage(error);
    if (isFeedGap(message)) gaps.add(symbol);
    else errors.push(`${symbol}: ${message}`);
  };
  if (provider.getQuotesBatch) {
    const results = await provider.getQuotesBatch(
      entries.map((entry) => ({ symbol: entry.symbol, exchange: "" })),
    );
    const bySymbol = new Map(results.map((result) => [result.target.symbol, result]));
    for (const entry of entries) {
      const result = bySymbol.get(entry.symbol);
      quotes.set(entry.symbol, result?.quote ?? null);
      if (result?.error) fail(entry.symbol, result.error);
      else if (!result?.quote) errors.push(`${entry.symbol}: quote unavailable`);
    }
    return { quotes, errors, gaps };
  }

  await Promise.all(entries.map(async (entry) => {
    try {
      quotes.set(entry.symbol, await provider.getQuote(entry.symbol, ""));
    } catch (error) {
      quotes.set(entry.symbol, null);
      fail(entry.symbol, error);
    }
  }));
  return { quotes, errors, gaps };
}
