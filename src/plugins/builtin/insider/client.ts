import type { DataProvider, SecFilingItem } from "../../../types/data-provider";
import { parseForm4Xml } from "./insider-data";
import type { ParsedInsiderFiling } from "./model";

export async function loadInsiderFilings(
  provider: DataProvider,
  symbol: string,
  count: number,
  exchange = "",
): Promise<SecFilingItem[]> {
  if (!provider.getSecFilings) throw new Error("Insider filing data unavailable");
  const filings = await provider.getSecFilings(symbol, count, exchange);
  return filings.filter((filing) => filing.form.trim() === "4");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Insider filing load was aborted.");
}

export async function loadParsedInsiderFilings(
  provider: DataProvider,
  symbol: string,
  options: { limit: number; exchange?: string; signal?: AbortSignal },
): Promise<ParsedInsiderFiling[]> {
  if (!provider.getSecFilingContent) throw new Error("Insider filing content unavailable");
  const filings = (await loadInsiderFilings(
    provider,
    symbol,
    20_000,
    options.exchange,
  )).slice(0, options.limit);

  const parsed: ParsedInsiderFiling[] = [];
  for (const filing of filings) {
    throwIfAborted(options.signal);
    try {
      const content = await provider.getSecFilingContent(filing);
      parsed.push({
        filing,
        transaction: content ? parseForm4Xml(content) : null,
        isLoading: false,
      });
    } catch {
      throwIfAborted(options.signal);
      parsed.push({ filing, transaction: null, isLoading: false });
    }
  }
  return parsed;
}
