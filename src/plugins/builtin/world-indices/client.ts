import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { IndexEntry } from "./indices";

export interface WorldIndexQuoteResult {
  quotes: Map<string, Quote | null>;
  errors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadWorldIndexQuotes(
  entries: readonly IndexEntry[],
  provider: DataProvider,
): Promise<WorldIndexQuoteResult> {
  const quotes = new Map<string, Quote | null>();
  const errors: string[] = [];
  if (provider.getQuotesBatch) {
    const results = await provider.getQuotesBatch(
      entries.map((entry) => ({ symbol: entry.symbol, exchange: "" })),
    );
    const bySymbol = new Map(results.map((result) => [result.target.symbol, result]));
    for (const entry of entries) {
      const result = bySymbol.get(entry.symbol);
      quotes.set(entry.symbol, result?.quote ?? null);
      if (result?.error) errors.push(`${entry.symbol}: ${errorMessage(result.error)}`);
      else if (!result?.quote) errors.push(`${entry.symbol}: quote unavailable`);
    }
    return { quotes, errors };
  }

  await Promise.all(entries.map(async (entry) => {
    try {
      quotes.set(entry.symbol, await provider.getQuote(entry.symbol, ""));
    } catch (error) {
      quotes.set(entry.symbol, null);
      errors.push(`${entry.symbol}: ${errorMessage(error)}`);
    }
  }));
  return { quotes, errors };
}
