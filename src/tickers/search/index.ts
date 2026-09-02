import type { SearchRequestContext, DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { canonicalExchange } from "../../utils/exchanges";
import { parseOptionSymbol } from "../../utils/options";
import {
  buildSymbolAliases,
  classifyInstrumentKind,
  findExactTickerSearchMatch,
  normalizeSearchText,
  normalizeTickerSymbol,
  rankTickerSearchItems,
} from "./ranking";
import type {
  ResolvedTickerSearch,
  TickerSearchCandidate,
} from "./types";
import {
  getSearchResultSymbol,
  isLowQualityTickerName,
} from "./result";

export type {
  ResolvedTickerSearch,
  TickerSearchCandidate,
  TickerSearchInstrumentClass,
} from "./types";
export {
  findExactTickerSearchMatch,
  rankTickerSearchItems,
} from "./ranking";
export { upsertTickerFromSearchResult } from "./upsert";

const OPTION_TYPES = new Set(["OPT", "OPTION", "OPTIONS"]);

const SHARE_CLASS_SUFFIXES = new Set(["A", "B", "C", "D", "K"]);

interface TickerSearchCandidateOptions {
  includeOptionContracts?: boolean;
  providerRanks?: ReadonlyMap<string, number>;
}

export function normalizeTickerInput(activeTicker: string | null, arg?: string): string | null {
  const explicitTicker = arg?.trim().toUpperCase();
  if (explicitTicker) return explicitTicker;
  return activeTicker;
}

export function createLocalTickerSearchCandidates(
  tickers: Iterable<TickerRecord>,
  providerHints: ReadonlyMap<string, InstrumentSearchResult> = new Map(),
  options: TickerSearchCandidateOptions = {},
): TickerSearchCandidate[] {
  return Array.from(tickers).flatMap((ticker) => {
    if (options.includeOptionContracts === false && isOptionTickerRecord(ticker)) return [];
    const symbol = normalizeTickerSymbol(ticker.metadata.ticker);
    const hint = providerHints.get(symbol);
    const exchangeLabel = ticker.metadata.exchange || hint?.exchange || hint?.primaryExchange;
    const savedExchange = canonicalExchange(ticker.metadata.exchange);
    const hintPrimaryExchange = canonicalExchange(hint?.primaryExchange);
    const primaryExchangeLabel = !savedExchange || !hintPrimaryExchange || savedExchange === hintPrimaryExchange
      ? hint?.primaryExchange
      : undefined;
    return [{
      id: `goto:${ticker.metadata.ticker}`,
      label: ticker.metadata.ticker,
      symbol,
      detail: resolveLocalSearchName(ticker, hint),
      right: exchangeLabel,
      exchangeLabel,
      primaryExchangeLabel,
      providerRank: options.providerRanks?.get(symbol),
      category: "Saved",
      kind: "ticker",
      saved: true,
      instrumentClass: classifyInstrumentKind(hint?.brokerContract?.secType || hint?.type || ticker.metadata.assetCategory),
      searchAliases: buildSymbolAliases(symbol),
      ticker,
      result: hint,
    }];
  });
}

function createProviderTickerSearchCandidates(
  searchResults: InstrumentSearchResult[],
  localTickers: ReadonlyMap<string, TickerRecord>,
  options: TickerSearchCandidateOptions = {},
): TickerSearchCandidate[] {
  return searchResults.flatMap((result, providerRank) => {
    if (options.includeOptionContracts === false && isOptionSearchResult(result)) return [];
    const symbol = getSearchResultSymbol(result);
    const saved = localTickers.has(symbol);
    return [{
      id: buildProviderCandidateId(result, symbol),
      label: symbol,
      symbol,
      detail: [result.name, result.brokerLabel, result.type].filter(Boolean).join(" | "),
      right: result.exchange || result.primaryExchange || result.type || undefined,
      exchangeLabel: result.exchange,
      primaryExchangeLabel: result.primaryExchange,
      providerRank,
      category: saved ? "Saved" : "Other Listings",
      kind: "search",
      saved,
      instrumentClass: classifyInstrumentKind(result.brokerContract?.secType || result.type),
      searchAliases: buildSearchResultAliases(result),
      result,
    }];
  });
}

export async function searchTickerCandidates({
  query,
  tickers,
  dataProvider,
  searchContext,
  localLimit = 6,
  totalLimit = 8,
  includeOptionContracts = true,
  onPartial,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  searchContext?: SearchRequestContext;
  localLimit?: number;
  totalLimit?: number;
  includeOptionContracts?: boolean;
  /** Called when a slower, richer source improves results already returned. */
  onPartial?: (candidates: TickerSearchCandidate[]) => void;
}): Promise<TickerSearchCandidate[]> {
  const assemble = (providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
    query,
    tickers,
    providerResults,
    localLimit,
    totalLimit,
    includeOptionContracts,
  });
  return assemble(await searchProviderResults(
    dataProvider,
    query,
    searchContext,
    onPartial ? (results) => onPartial(assemble(results)) : undefined,
  ));
}

export function buildTickerSearchCandidates({
  query,
  tickers,
  providerResults,
  localLimit = 6,
  totalLimit = 8,
  includeOptionContracts = true,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  providerResults: InstrumentSearchResult[];
  localLimit?: number;
  totalLimit?: number;
  includeOptionContracts?: boolean;
}): TickerSearchCandidate[] {
  const filteredProviderResults = includeOptionContracts
    ? providerResults
    : providerResults.filter((result) => !isOptionSearchResult(result));
  const providerHints = buildProviderHints(filteredProviderResults, tickers);
  const candidateOptions = {
    includeOptionContracts,
    providerRanks: providerHints.ranks,
  };
  const localItems = rankTickerSearchItems(
    createLocalTickerSearchCandidates(tickers.values(), providerHints.results, candidateOptions),
    query,
  );
  const providerItems = createProviderTickerSearchCandidates(filteredProviderResults, tickers, candidateOptions);
  const ranked = rankTickerSearchItems([...localItems, ...providerItems], query);
  return limitTickerSearchCandidates(assignTickerSearchCategories(ranked), totalLimit, localLimit);
}

export async function resolveTickerSearch({
  query,
  activeTicker,
  tickers,
  dataProvider,
  searchContext,
}: {
  query?: string;
  activeTicker: string | null;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  searchContext?: SearchRequestContext;
}): Promise<ResolvedTickerSearch | null> {
  const symbol = normalizeTickerInput(activeTicker, query);
  if (!symbol) return null;

  const local = tickers.get(symbol)
    ?? findExactTickerSearchMatch(createLocalTickerSearchCandidates(tickers.values()), symbol)?.ticker
    ?? null;
  if (local) {
    return { kind: "local", symbol: local.metadata.ticker, ticker: local };
  }

  const providerItems = createProviderTickerSearchCandidates(
    await searchProviderResults(dataProvider, symbol, searchContext),
    tickers,
  );
  const exactMatch = findExactTickerSearchMatch(providerItems, symbol);
  if (!exactMatch?.result) return null;

  return {
    kind: "provider",
    symbol: exactMatch.symbol,
    result: exactMatch.result,
  };
}

function buildProviderHints(
  searchResults: InstrumentSearchResult[],
  localTickers: ReadonlyMap<string, TickerRecord>,
): {
  results: Map<string, InstrumentSearchResult>;
  ranks: Map<string, number>;
} {
  const results = new Map<string, InstrumentSearchResult>();
  const ranks = new Map<string, number>();
  for (const [rank, result] of searchResults.entries()) {
    const symbol = getSearchResultSymbol(result);
    if (!ranks.has(symbol)) ranks.set(symbol, rank);
    const existing = results.get(symbol);
    const preferredExchange = localTickers.get(symbol)?.metadata.exchange;
    if (
      !existing
      || getProviderHintScore(result, preferredExchange) > getProviderHintScore(existing, preferredExchange)
    ) {
      results.set(symbol, result);
    }
  }
  return { results, ranks };
}

async function searchProviderResults(
  dataProvider: DataProvider,
  query: string,
  searchContext?: SearchRequestContext,
  onPartial?: (results: InstrumentSearchResult[]) => void,
): Promise<InstrumentSearchResult[]> {
  // A Map rather than a list plus a seen set, because a later source can send
  // back a richer version of a symbol already recorded. Overwriting a key keeps
  // its original position, so an upgrade does not reorder the list.
  const byKey = new Map<string, InstrumentSearchResult>();
  const add = (results: InstrumentSearchResult[], upgrade = false) => {
    for (const result of results) {
      const key = buildProviderSearchResultKey(result);
      if (!upgrade && byKey.has(key)) continue;
      byKey.set(key, result);
    }
  };

  // The variants are independent lookups of the same words, so they run
  // together. Awaited in turn they multiplied every per-source timeout by the
  // number of spellings tried.
  await Promise.all(buildProviderSearchQueries(query).map(async (searchQuery) => {
    try {
      const results = await dataProvider.search(searchQuery, {
        ...searchContext,
        ...(onPartial
          ? {
            onPartial: (upgraded: InstrumentSearchResult[]) => {
              add(upgraded, true);
              onPartial([...byKey.values()]);
            },
          }
          : {}),
      });
      add(results);
    } catch {
      // One spelling failing must not lose the others.
    }
  }));

  return [...byKey.values()];
}

function buildProviderSearchQueries(query: string): string[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const symbolLike = /^[A-Za-z0-9.^=\-/]+$/.test(trimmedQuery);
  const queries = new Set<string>();

  if (!symbolLike) queries.add(trimmedQuery);
  for (const alias of buildSymbolAliases(trimmedQuery)) queries.add(alias);
  for (const alias of buildCompactShareClassAliases(trimmedQuery)) queries.add(alias);
  queries.add(trimmedQuery);
  return [...queries].slice(0, 4);
}

function buildCompactShareClassAliases(query: string): string[] {
  const normalized = normalizeTickerSymbol(query);
  if (!/^[A-Z]{4,5}$/.test(normalized)) return [];
  const shareClass = normalized.slice(-1);
  if (!SHARE_CLASS_SUFFIXES.has(shareClass)) return [];
  const base = normalized.slice(0, -1);
  if (base.length < 2) return [];
  return [`${base}-${shareClass}`, `${base}.${shareClass}`];
}

function buildProviderSearchResultKey(result: InstrumentSearchResult): string {
  return [
    normalizeTickerSymbol(result.symbol),
    normalizeSearchText(result.exchange || ""),
    normalizeSearchText(result.type || ""),
    normalizeSearchText(result.primaryExchange || ""),
    normalizeSearchText(result.currency || ""),
  ].join("|");
}

function buildProviderCandidateId(result: InstrumentSearchResult, symbol: string): string {
  return [
    "search",
    normalizeTickerSymbol(symbol),
    normalizeSearchText(result.exchange || result.primaryExchange || result.type || ""),
    normalizeSearchText(result.currency || ""),
    normalizeSearchText(result.providerId || ""),
  ].filter(Boolean).join(":");
}

function getProviderHintRichness(result: InstrumentSearchResult): number {
  let score = 0;
  if (result.name) score += Math.min(120, result.name.length);
  if (result.exchange) score += 60;
  if (result.primaryExchange) score += 40;
  if (result.currency) score += 20;
  return score;
}

function getProviderHintScore(result: InstrumentSearchResult, preferredExchange?: string): number {
  const canonicalPreferredExchange = canonicalExchange(preferredExchange);
  const matchesPreferredExchange = canonicalPreferredExchange
    && [
      result.exchange,
      result.primaryExchange,
      result.brokerContract?.exchange,
      result.brokerContract?.primaryExchange,
    ].some((exchange) => canonicalExchange(exchange) === canonicalPreferredExchange);
  return getProviderHintRichness(result) + (matchesPreferredExchange ? 10_000 : 0);
}

function assignTickerSearchCategories<T extends TickerSearchCandidate>(items: T[]): T[] {
  let assignedPrimaryListing = false;

  return items.map((item) => {
    if (item.saved || item.kind === "ticker") {
      if (item.instrumentClass !== "fund" && item.instrumentClass !== "derivative") {
        assignedPrimaryListing = true;
      }
      return { ...item, category: "Saved" };
    }
    if (item.instrumentClass === "fund" || item.instrumentClass === "derivative") {
      return { ...item, category: "Funds & Derivatives" };
    }
    if (!assignedPrimaryListing) {
      assignedPrimaryListing = true;
      return { ...item, category: "Primary Listing" };
    }
    return { ...item, category: "Other Listings" };
  }) as T[];
}

function limitTickerSearchCandidates<T extends TickerSearchCandidate>(
  items: T[],
  totalLimit: number,
  savedLimit: number,
): T[] {
  const limited: T[] = [];
  let savedCount = 0;

  for (const item of items) {
    if (limited.length >= totalLimit) break;
    if (item.category === "Saved") {
      if (savedCount >= savedLimit) continue;
      savedCount += 1;
    }
    limited.push(item);
  }

  return limited;
}

function resolveLocalSearchName(ticker: TickerRecord, hint?: InstrumentSearchResult): string {
  if (hint?.name && isLowQualityTickerName(ticker.metadata.name, ticker.metadata.ticker)) {
    return hint.name;
  }
  return ticker.metadata.name;
}

function isOptionTickerRecord(ticker: TickerRecord): boolean {
  return isOptionType(ticker.metadata.assetCategory)
    || parseOptionSymbol(ticker.metadata.ticker) != null
    || (ticker.metadata.broker_contracts ?? []).some(isOptionBrokerContract);
}

function isOptionSearchResult(result: InstrumentSearchResult): boolean {
  return isOptionType(result.type)
    || parseOptionSymbol(result.symbol) != null
    || isOptionBrokerContract(result.brokerContract);
}

function isOptionBrokerContract(contract: InstrumentSearchResult["brokerContract"]): boolean {
  if (!contract) return false;
  return isOptionType(contract.secType)
    || parseOptionSymbol(contract.localSymbol || "") != null
    || contract.right === "C"
    || contract.right === "P"
    || contract.strike != null;
}

function isOptionType(rawType?: string): boolean {
  return OPTION_TYPES.has(normalizeSearchText(rawType || ""));
}

function buildSearchResultAliases(result: InstrumentSearchResult): string[] {
  const aliases = new Set(buildSymbolAliases(result.symbol));
  const resolvedSymbol = getSearchResultSymbol(result);
  for (const alias of buildSymbolAliases(resolvedSymbol)) aliases.add(alias);
  if (result.brokerContract?.symbol) {
    for (const alias of buildSymbolAliases(result.brokerContract.symbol)) aliases.add(alias);
  }
  return [...aliases];
}
