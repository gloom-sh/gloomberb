import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord, TickerMetadata } from "../../types/ticker";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  classifyInstrumentKind,
} from "./ranking";
import {
  getSearchResultSymbol,
  shouldReplaceTickerName,
} from "./result";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import { scopedBrokerContractIdentityKey } from "../../utils/instrument-identity";
import { listingSuffixVenue } from "../../sources/listing-symbols";

/**
 * The key a result is saved under when its symbol is already saved for
 * another listing (`SAP:XETR` beside a saved SAP on NYSE), or null when the
 * symbol's own key serves. Opening a second listing must never re-denominate
 * existing positions.
 */
export function otherListingTickerKey(
  result: InstrumentSearchResult,
  symbol: string,
  saved: TickerRecord | null | undefined,
): string | null {
  const selectedExchange = canonicalExchange(
    result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange,
  );
  const savedExchange = canonicalExchange(saved?.metadata.exchange);
  if (!saved || !selectedExchange || !savedExchange || selectedExchange === savedExchange) return null;
  return publicTickerKey(parsePublicTickerKey(symbol).symbol, selectedExchange);
}

export async function upsertTickerFromSearchResult(
  tickerRepository: AppTickerRepositoryPort,
  result: InstrumentSearchResult,
  options: { tickerSymbol?: string } = {},
): Promise<{ ticker: TickerRecord; created: boolean }> {
  let symbol = options.tickerSymbol ?? getSearchResultSymbol(result);
  // A vendor's suffixed symbol (GARAN.IS) is saved as the listing it is (GARAN on BIST), under the key
  // GARAN:BIST is saved under, so one listing is one row. A key the caller names is kept as given.
  const venue = options.tickerSymbol || result.brokerContract ? null : listingSuffixVenue(symbol, listingVenue(result));
  if (venue) {
    symbol = venue.symbol;
    result = { ...result, symbol: venue.symbol, exchange: result.exchange || venue.exchange };
  }
  let ticker = await tickerRepository.loadTicker(symbol);
  const otherListingKey = otherListingTickerKey(result, symbol, ticker);
  if (otherListingKey) {
    symbol = otherListingKey;
    ticker = await tickerRepository.loadTicker(symbol);
  }
  const created = !ticker;

  if (!ticker) {
    const metadata: TickerMetadata = {
      ticker: symbol,
      exchange: result.exchange,
      // Unknown stays unknown (empty): a guessed USD outranked the portfolio's
      // and base currency, and valued a Helsinki holding as dollars. A later
      // search result that knows the currency fills it in.
      currency: result.currency || result.brokerContract?.currency || "",
      name: result.name || symbol,
      assetCategory: result.brokerContract?.secType || result.type || undefined,
      broker_contracts: result.brokerContract ? [result.brokerContract] : [],
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    };
    ticker = await tickerRepository.createTicker(metadata);
  } else {
    const changed = mergeTickerMetadataFromSearchResult(ticker.metadata, result);
    const existingContracts = ticker.metadata.broker_contracts ?? [];
    if (result.brokerContract) {
      const nextContracts = [...existingContracts];
      const hasContract = nextContracts.some((contract) =>
        scopedBrokerContractIdentityKey(contract) === scopedBrokerContractIdentityKey(result.brokerContract!)
      );
      if (!hasContract) {
        nextContracts.push(result.brokerContract);
        ticker.metadata.broker_contracts = nextContracts;
      }
    }
    if (changed || ticker.metadata.broker_contracts !== existingContracts) {
      await tickerRepository.saveTicker(ticker);
    }
  }

  return { ticker, created };
}

function listingVenue(result: InstrumentSearchResult): string | undefined {
  return result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange;
}

function mergeTickerMetadataFromSearchResult(metadata: TickerMetadata, result: InstrumentSearchResult): boolean {
  let changed = false;
  const nextName = result.name?.trim();
  const nextExchange = result.exchange?.trim();
  const nextCurrency = (result.currency || result.brokerContract?.currency || "").trim();
  const nextAssetCategory = (result.brokerContract?.secType || result.type || "").trim();

  if (nextName && shouldReplaceTickerName(metadata.name, metadata.ticker, nextName)) {
    metadata.name = nextName;
    changed = true;
  }
  if (nextExchange && !metadata.exchange) {
    metadata.exchange = nextExchange;
    changed = true;
  } else if (
    nextExchange
    && metadata.exchange
    && canonicalExchange(nextExchange) !== canonicalExchange(metadata.exchange)
  ) {
    metadata.exchange = nextExchange;
    if (nextName) metadata.name = nextName;
    if (nextCurrency) metadata.currency = nextCurrency;
    changed = true;
  }
  if (nextCurrency && !metadata.currency) {
    metadata.currency = nextCurrency;
    changed = true;
  }
  if (nextAssetCategory && shouldReplaceAssetCategory(metadata.assetCategory, nextAssetCategory)) {
    metadata.assetCategory = nextAssetCategory;
    changed = true;
  }

  return changed;
}

function shouldReplaceAssetCategory(currentCategory: string | undefined, nextCategory: string): boolean {
  if (!currentCategory?.trim()) return true;
  const currentClass = classifyInstrumentKind(currentCategory);
  const nextClass = classifyInstrumentKind(nextCategory);
  return currentClass === "equity" && nextClass !== "equity";
}
