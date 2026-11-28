import type { AppTickerRepositoryPort } from "../../../../core/app-service-ports";
import { ListingArgError } from "../../../../cli/listing-arg";
import { StagedTickerRepository } from "../../../../cli/staged-tickers";
import { resolveTickersForCli } from "../../../../cli/ticker-resolution";
import type { ImportSymbolResolution } from "../../../../portfolio/positions-import/plan";
import { movedAwayChange, tickerChangeLine } from "../../../../tickers/ticker-changes";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";

export interface PositionSymbolLookup {
  resolutions: Map<string, ImportSymbolResolution>;
  /** Listings the lookup found that are not saved yet, by key: the import saves them, a cancel drops them. */
  unsaved: Set<string>;
}

/**
 * Resolve a current snapshot without saving previews or moving a position to
 * a successor ticker. Historical lookups can still resolve the old listing.
 */
export async function lookUpPositionSymbols(
  symbols: readonly string[],
  { tickers, store, dataProvider }: {
    tickers?: ReadonlyMap<string, TickerRecord>;
    store: AppTickerRepositoryPort;
    dataProvider: DataProvider;
  }, options?: Pick<NonNullable<Parameters<typeof resolveTickersForCli>[4]>, "onRetry" | "onProgress">,
): Promise<PositionSymbolLookup> {
  const staging = new StagedTickerRepository(store);
  const resolutions = new Map<string, ImportSymbolResolution>();
  const unsaved = new Set<string>();
  if (symbols.length === 0) return { resolutions, unsaved };
  for (const lookup of await resolveTickersForCli(symbols, staging, dataProvider, undefined, { ...options, currentSnapshot: true })) {
    if (lookup.error) {
      const details = lookup.error instanceof ListingArgError ? lookup.error.details : null;
      resolutions.set(lookup.input, { error: [lookup.error.message, details].filter(Boolean).join(" ").replace(/\s*\n\s*/g, " ") });
      continue;
    }
    const change = tickerChangeLine(lookup.change);
    if (lookup.listingEnd || movedAwayChange(lookup.change)) {
      resolutions.set(lookup.input, { error: [lookup.listingEnd, change].filter(Boolean).join(" ") });
      continue;
    }
    const key = lookup.ticker.metadata.ticker;
    const ticker = await staging.loadTicker(key) ?? lookup.ticker;
    if (tickers && !tickers.has(key)) unsaved.add(key);
    resolutions.set(lookup.input, { ticker, notes: change ? [change] : [] });
  }
  return { resolutions, unsaved };
}
