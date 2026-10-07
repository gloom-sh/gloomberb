import type { TickerRecord } from "../../../types/ticker";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { tickerHasListingSuffix, listingSuffixConflictsWithExchange, listingSuffixExchange } from "../../../sources/listing-symbols";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";
import { searchContractKey } from "../../../tickers/search/identity";
import type { CollectionKind } from "./tickers";

export class AmbiguousCollectionTickerError extends Error {
  constructor(symbols: string[], kind: CollectionKind) {
    super(`Multiple saved records own this ${kind} listing: ${symbols.join(", ")}.`);
    this.name = "AmbiguousCollectionTickerError";
  }
}

function listingIdentity(ticker: TickerRecord): string | null {
  const metadata = ticker.metadata;
  // A shared root symbol and exchange cannot identify an option, future or bond.
  const instrumentKind = classifyInstrumentKind(metadata.assetCategory);
  if ((metadata.assetCategory?.trim() && instrumentKind !== "equity" && instrumentKind !== "fund")
    || (metadata.broker_contracts ?? []).some((brokerContract) => searchContractKey({ brokerContract, type: metadata.assetCategory || "" }))) return null;
  const parsed = parsePublicTickerKey(metadata.ticker);
  let exchange = parsed.exchange ?? canonicalExchange(metadata.exchange);
  if (exchange === "SMART") {
    const venues = new Set((metadata.broker_contracts ?? []).map((contract) => canonicalExchange(contract.primaryExchange)).filter(Boolean));
    if (venues.size !== 1) return null;
    exchange = [...venues][0]!;
  }
  let symbol = parsed.symbol;
  if (tickerHasListingSuffix(symbol)) {
    if (exchange && listingSuffixConflictsWithExchange(symbol, exchange)) return null;
    exchange ||= listingSuffixExchange(symbol) ?? "";
    symbol = symbol.slice(0, symbol.lastIndexOf("."));
  }
  const currency = resolveCurrencyUnit(metadata.currency).currency;
  return exchange && currency ? `${symbol}:${exchange}:${currency}` : null;
}

function ownsCollection(ticker: TickerRecord, kind: CollectionKind, collectionId?: string | null): boolean {
  const memberships = kind === "portfolio" ? ticker.metadata.portfolios : ticker.metadata.watchlists;
  return (collectionId ? memberships.includes(collectionId) : memberships.length > 0)
    || (kind === "portfolio" && ticker.metadata.positions.some((position) => !collectionId || position.portfolio === collectionId));
}

/** Research aliases must not hide or duplicate the saved record that owns a holding. */
export function resolveCollectionTicker(
  ticker: TickerRecord,
  tickers: ReadonlyMap<string, TickerRecord>,
  kind: CollectionKind,
  collectionId?: string | null,
): TickerRecord {
  ticker = tickers.get(ticker.metadata.ticker) ?? ticker;
  const identity = listingIdentity(ticker);
  if (!identity) return ticker;
  const equivalent = [...new Map([...tickers, [ticker.metadata.ticker, ticker]]).values()]
    .filter((candidate) => listingIdentity(candidate) === identity);
  const owners = equivalent.filter((candidate) => ownsCollection(candidate, kind, collectionId));
  if (owners.length > 1) throw new AmbiguousCollectionTickerError(owners.map((owner) => owner.metadata.ticker), kind);
  if (owners.length === 1) return owners[0]!;
  // Reuse a unique saved owner when adding this listing to another collection.
  // If existing records own different collections, the requested empty record
  // can join a new collection without changing either existing owner.
  const otherOwners = collectionId ? equivalent.filter((candidate) => ownsCollection(candidate, kind)) : [];
  return otherOwners.length === 1 ? otherOwners[0]! : ticker;
}
