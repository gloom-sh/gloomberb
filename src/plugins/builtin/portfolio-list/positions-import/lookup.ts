import type { AppTickerRepositoryPort } from "../../../../core/app-service-ports";
import type { ImportSymbolResolution } from "../../../../portfolio/positions-import/plan";
import { isProviderBusy } from "../../../../sources/provider-errors";
import { AmbiguousTickerError, resolveTickerSearch, upsertTickerFromSearchResult } from "../../../../tickers/search";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";
import { mapWithConcurrency } from "../../../../utils/concurrency";

/** Symbols looked up at once: a broker export is tens of rows, and search answers each in a request. */
const LOOKUP_CONCURRENCY = 4;

export interface PositionSymbolLookup {
  resolutions: Map<string, ImportSymbolResolution>;
  /** Listings the lookup found that are not saved yet, by key: the import saves them, a cancel drops them. */
  unsaved: Set<string>;
}

/**
 * A store that keeps the listings a lookup makes in memory, so a preview the
 * person cancels saves nothing. Reads fall through to the saved tickers.
 */
function stagedStore(base: AppTickerRepositoryPort, staged: Map<string, TickerRecord>): AppTickerRepositoryPort {
  return {
    loadTicker: async (symbol) => staged.get(symbol) ?? await base.loadTicker(symbol),
    loadAllTickers: async () => {
      const merged = new Map((await base.loadAllTickers()).map((ticker) => [ticker.metadata.ticker, ticker] as const));
      for (const [key, ticker] of staged) merged.set(key, ticker);
      return [...merged.values()];
    },
    saveTicker: async (ticker) => { staged.set(ticker.metadata.ticker, ticker); },
    createTicker: async (metadata) => {
      const ticker: TickerRecord = { metadata };
      staged.set(metadata.ticker, ticker);
      return ticker;
    },
    deleteTicker: async () => { throw new Error("A preview deletes no tickers."); },
  };
}

function lookupError(symbol: string, error: unknown): string {
  if (error instanceof AmbiguousTickerError) return `${symbol} names several listings; add the one you hold with the add row`;
  if (isProviderBusy(error)) return "search was busy; import the file again";
  return "ticker lookup failed";
}

/**
 * Each of a file's symbols as the listing the add row would take it to, or
 * why it has none. Nothing is saved: listings not saved yet are listed in
 * `unsaved` for the import to save.
 */
export async function lookUpPositionSymbols(
  symbols: readonly string[],
  { tickers, store, dataProvider }: {
    tickers: ReadonlyMap<string, TickerRecord>;
    store: AppTickerRepositoryPort;
    dataProvider: DataProvider;
  },
): Promise<PositionSymbolLookup> {
  const staged = new Map<string, TickerRecord>();
  const staging = stagedStore(store, staged);
  const settled = await mapWithConcurrency(symbols, LOOKUP_CONCURRENCY, async (symbol): Promise<ImportSymbolResolution> => {
    try {
      const resolved = await resolveTickerSearch({ query: symbol, activeTicker: null, tickers, dataProvider });
      if (!resolved) return { error: `No ticker match found for "${symbol}".` };
      if (resolved.kind === "local") return { ticker: resolved.ticker };
      return { ticker: (await upsertTickerFromSearchResult(staging, resolved.result)).ticker };
    } catch (error) {
      return { error: lookupError(symbol, error) };
    }
  });
  // Two of the file's symbols for one new listing (BRK.B, BRK-B) each made it: both take the record kept.
  const resolutions = new Map(symbols.map((symbol, index) => {
    const resolution = settled[index]!;
    const kept = "ticker" in resolution ? staged.get(resolution.ticker.metadata.ticker) : undefined;
    return [symbol, kept ? { ticker: kept } : resolution] as const;
  }));
  return { resolutions, unsaved: new Set(staged.keys()) };
}
