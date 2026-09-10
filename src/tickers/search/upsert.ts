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

export async function upsertTickerFromSearchResult(
  tickerRepository: AppTickerRepositoryPort,
  result: InstrumentSearchResult,
): Promise<{ ticker: TickerRecord; created: boolean }> {
  let symbol = getSearchResultSymbol(result);
  let ticker = await tickerRepository.loadTicker(symbol);
  const selectedExchange = canonicalExchange(
    result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange,
  );
  const savedExchange = canonicalExchange(ticker?.metadata.exchange);
  if (ticker && selectedExchange && savedExchange && selectedExchange !== savedExchange) {
    // Opening a second listing must never re-denominate existing positions.
    symbol = publicTickerKey(parsePublicTickerKey(symbol).symbol, selectedExchange);
    ticker = await tickerRepository.loadTicker(symbol);
  }
  const created = !ticker;

  if (!ticker) {
    const metadata: TickerMetadata = {
      ticker: symbol,
      exchange: result.exchange,
      currency: result.currency || result.brokerContract?.currency || "USD",
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
        contract.brokerId === result.brokerContract!.brokerId
        && contract.brokerInstanceId === result.brokerContract!.brokerInstanceId
        && contract.conId === result.brokerContract!.conId
        && contract.localSymbol === result.brokerContract!.localSymbol
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
