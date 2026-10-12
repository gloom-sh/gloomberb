import type { SearchRequestContext, DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { canonicalExchange, isSharedExchangeCode, isUsListingExchange, parsePublicTickerKey, publicTickerKey, typedExchangeCode } from "../../utils/exchanges";
import { getListingSymbol, tickerHasListingSuffix } from "../../sources/listing-symbols";
import { parseOptionSymbol } from "../../utils/options";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { assetClassMarketSymbol, parseAssetClassQuery } from "./asset-classes";
import { bareFuturesCode, futuresContractByCode } from "../../market-data/futures-board";
import { searchContractKey, searchInstrumentKey } from "./identity";
import { tickerInstrumentLabel } from "../instrument-label";
import {
  answersOnlyByKeyword,
  buildSymbolAliases,
  classifyInstrumentKind,
  findExactTickerSearchMatch,
  getForexQuoteCurrency,
  isExplicitMarketSymbol,
  isCryptoInstrumentType,
  normalizeSearchText,
  normalizeTickerSymbol,
  rankTickerSearchItems,
  themeQueryWord,
} from "./ranking";
import type {
  ResolvedTickerSearch,
  TickerSearchCandidate,
} from "./types";
import {
  getSearchResultSymbol,
  isLowQualityTickerName,
} from "./result";

import { typedPerpetualListing } from "../perpetual-listing";
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

const MAX_NAMED_LISTINGS = 6;

/**
 * Search rows a symbol's listings are read from, by the command bar's `SAN:`
 * venue list and the CLI's venue list alike. A keystroke's ten stop short of a
 * symbol several companies use: CAR's ASX line is its eleventh.
 */
export const LISTING_SEARCH_LIMIT = 30;

export class AmbiguousTickerError extends Error {
  constructor(readonly query: string, readonly listings: readonly string[], readonly listingNames: Readonly<Record<string, string>> = {}) {
    // Every listing is a choice: a list cut short could leave out the one meant.
    const more = listings.length - MAX_NAMED_LISTINGS;
    const named = `${listings.slice(0, MAX_NAMED_LISTINGS).join(", ")}${more > 0 ? ` or one of ${more} more in search` : ""}`;
    super(`Multiple listings match ${query}. Choose an exchange in search or use ${named}.`);
    this.name = "AmbiguousTickerError";
  }
}

export class AmbiguousContractError extends AmbiguousTickerError {
  constructor(query: string, contracts: readonly string[]) {
    super(query, contracts);
    this.name = "AmbiguousContractError";
    this.message = `Multiple contracts match ${query}. Choose a contract in search.`;
  }
}

const OPTION_TYPES = new Set(["OPT", "OPTION", "OPTIONS"]);

const SHARE_CLASS_SUFFIXES = new Set(["A", "B", "C", "D", "K"]);

/**
 * Venue codes people type after a dot in place of the listing suffix:
 * TTALO.HEL or TTALO.XHEL for TTALO.HE. Only tried once the literal symbol
 * finds nothing, so class shares such as BRK.B never reach them.
 */
const DOTTED_VENUE_CODES = new Set([
  "HEL", "XHEL", "STO", "XSTO", "CPH", "XCSE", "OSL", "XOSL",
  "AMS", "XAMS", "PAR", "XPAR", "LON", "XLON", "ETR", "XETR",
]);

/** The listing-suffix and colon spellings of `SYM.<venue code>`, in that order. */
function dottedVenueQueries(symbol: string): string[] {
  const dot = symbol.lastIndexOf(".");
  if (dot <= 0) return [];
  const base = symbol.slice(0, dot);
  const venue = symbol.slice(dot + 1);
  if (!DOTTED_VENUE_CODES.has(venue)) return [];
  return [...new Set([getListingSymbol(base, venue), `${base}:${venue}`])];
}

interface TickerSearchCandidateOptions {
  includeOptionContracts?: boolean;
  providerRanks?: ReadonlyMap<string, number>;
  providerPopularity?: ReadonlyMap<string, number>;
}

/** The ticker typed, upper case; a perpetual's market id (`binance:BZUSDT`) as its listing (`BZUSDT:BINANCE`). */
export function normalizeTickerInput(activeTicker: string | null, arg?: string): string | null {
  const explicitTicker = arg ? (typedPerpetualListing(arg)?.key ?? arg).trim().toUpperCase() : "";
  if (explicitTicker) return explicitTicker;
  return activeTicker;
}

export function createLocalTickerSearchCandidates(
  tickers: Iterable<TickerRecord>,
  providerHints: ReadonlyMap<string, InstrumentSearchResult> = new Map(),
  options: TickerSearchCandidateOptions = {},
): TickerSearchCandidate[] {
  return Array.from(tickers).flatMap((ticker) => {
    const symbol = normalizeTickerSymbol(ticker.metadata.ticker);
    const savedExchange = canonicalExchange(ticker.metadata.exchange);
    // The same symbol on another venue can be another security (MSFT's BYMA
    // receipt, NVO on Warsaw); it must not type or route the saved listing.
    const venueHint = providerHints.get(symbol);
    const hint = venueHint && savedExchange && isOtherVenue(venueHint, savedExchange) ? undefined : venueHint;
    const exchangeLabel = ticker.metadata.exchange || hint?.exchange || hint?.primaryExchange;
    const hintPrimaryExchange = canonicalExchange(hint?.primaryExchange);
    const primaryExchangeLabel = !savedExchange || !hintPrimaryExchange || savedExchange === hintPrimaryExchange
      ? hint?.primaryExchange
      : undefined;
    const contractResults = (ticker.metadata.broker_contracts ?? [])
      .filter((brokerContract) => searchContractKey({ brokerContract, type: ticker.metadata.assetCategory || "" }))
      .map((brokerContract): InstrumentSearchResult => ({
        providerId: brokerContract.brokerId, brokerInstanceId: brokerContract.brokerInstanceId,
        symbol: ticker.metadata.ticker, name: tickerInstrumentLabel(ticker.metadata.ticker, brokerContract),
        exchange: brokerContract.exchange || "", primaryExchange: brokerContract.primaryExchange, currency: brokerContract.currency,
        type: brokerContract.secType || ticker.metadata.assetCategory || "", brokerContract,
      }));
    if (!contractResults.length && options.includeOptionContracts === false && isOptionTickerRecord(ticker)) return [];
    return (contractResults.length ? contractResults : [hint])
      .filter((result) => options.includeOptionContracts !== false || !result || !isOptionSearchResult(result))
      .map((result) => {
        const contractKey = result ? searchContractKey(result) : null;
        const instrumentType = contractKey ? result!.type : hint?.brokerContract?.secType || hint?.type || ticker.metadata.assetCategory;
        const venue = contractKey ? result!.exchange : exchangeLabel;
        return {
          id: `goto:${ticker.metadata.ticker}`,
          label: ticker.metadata.ticker,
          symbol,
          detail: contractKey ? result!.name : resolveLocalSearchName(ticker, hint),
          right: venue,
          exchangeLabel: venue,
          primaryExchangeLabel: contractKey ? result!.primaryExchange : primaryExchangeLabel,
          providerRank: options.providerRanks?.get(symbol)
            ?? options.providerRanks?.get(publicTickerKey(symbol, ticker.metadata.exchange)),
          popularity: options.providerPopularity?.get(symbol),
          category: "Saved",
          kind: "ticker",
          saved: true,
          instrumentClass: classifyInstrumentKind(instrumentType),
          instrumentType,
          searchAliases: buildSymbolAliases(symbol),
          ticker,
          result,
          ...(contractKey ? { contractKey, id: `goto:${ticker.metadata.ticker}:${contractKey}` } : {}),
        } as TickerSearchCandidate;
      });
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
    const currency = result.currency || getForexQuoteCurrency(symbol);
    if (currency && !result.currency) result = { ...result, currency };
    const listingKey = publicTickerKey(symbol, listingExchange(result));
    const savedTicker = localTickers.get(listingKey) ?? localTickers.get(symbol);
    const saved = !!savedTicker
      && publicTickerKey(savedTicker.metadata.ticker, savedTicker.metadata.exchange) === listingKey;
    return [{
      id: buildProviderCandidateId(result, symbol),
      contractKey: searchContractKey(result),
      label: symbol,
      symbol,
      detail: [result.name, result.brokerLabel, result.type].filter(Boolean).join(" | "),
      right: result.exchange || result.primaryExchange || result.type || undefined,
      exchangeLabel: result.exchange,
      primaryExchangeLabel: result.primaryExchange,
      providerRank,
      popularity: searchResultPopularity(result),
      category: saved ? "Saved" : "Other Listings",
      kind: "search",
      saved,
      instrumentClass: classifyInstrumentKind(result.brokerContract?.secType || result.type),
      instrumentType: result.brokerContract?.secType || result.type,
      searchAliases: buildSearchResultAliases(result),
      ...(searchResultKeywords(result) ? { searchKeywords: searchResultKeywords(result) } : {}),
      result,
    }];
  });
}

export async function searchTickerCandidates({
  query: rawQuery,
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
  const query = symbolSearchQuery(rawQuery);
  const assemble = (providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
    query,
    tickers,
    providerResults,
    localLimit,
    totalLimit,
    // A search that hides contracts still shows them when asked: "AAPL OPT".
    includeOptionContracts: includeOptionContracts || parseAssetClassQuery(query)?.code === "OPT",
  });
  return assemble(await searchProviderResults(
    dataProvider,
    query,
    searchContext,
    onPartial ? (results) => onPartial(assemble(results)) : undefined,
    true,
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
    providerPopularity: providerHints.popularity,
  };
  const localItems = rankTickerSearchItems(
    createLocalTickerSearchCandidates(tickers.values(), providerHints.results, candidateOptions),
    query,
  );
  const providerItems = createProviderTickerSearchCandidates(filteredProviderResults, tickers, candidateOptions);
  const ranked = rankTickerSearchItems([...localItems, ...providerItems], query);
  return limitTickerSearchCandidates(assignTickerSearchCategories(ranked, query), totalLimit, localLimit);
}

interface ResolveTickerSearchOptions {
  query?: string;
  activeTicker: string | null;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  searchContext?: SearchRequestContext;
}

/** `NET:` asks which NET. `NET:N` narrows that list. `NET:XNYS` already names one. An index (`^VIX:`) is asked the same way. */
const LISTING_PICKER_QUERY = /^[A-Z0-9^][A-Z0-9.\-]{0,20}:$/;
const LISTING_CHOICE_QUERY = /^([A-Z0-9^][A-Z0-9.\-]{0,20}):([A-Z0-9.\-]*)$/;

function isListingPickerQuery(query: string): boolean {
  return LISTING_PICKER_QUERY.test(query.trim().toUpperCase());
}

/** `NET:` and `NET:N` name a symbol plus the exchange prefix still being typed. */
export function listingChoiceQuery(query: string): { symbol: string; suffix: string } | null {
  const match = LISTING_CHOICE_QUERY.exec(query.trim().toUpperCase());
  if (!match?.[1]) return null;
  return { symbol: match[1], suffix: match[2] ?? "" };
}

/** Search text for a ticker query. A trailing colon searches the symbol it qualifies. */
export function symbolSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!isListingPickerQuery(trimmed)) return trimmed;
  return trimmed.slice(0, -1).toUpperCase();
}

export function resolveTickerSearch(options: ResolveTickerSearchOptions): Promise<ResolvedTickerSearch | null> {
  const requested = normalizeTickerInput(options.activeTicker, options.query);
  if (!requested) return Promise.resolve(null);
  // `NET:` lists NET's venues instead of settling on one.
  const pickListing = isListingPickerQuery(requested);
  const typed = symbolSearchQuery(requested);
  // A futures board code no security uses is its future (TTF is TTF=F), unless a saved ticker holds it.
  const future = pickListing || options.tickers.has(typed) ? null : bareFuturesCode(typed);
  const symbol = future?.symbol ?? typed;
  const literal = resolveTickerSymbol(symbol, options, pickListing ? requested : null);
  const alternatives = pickListing ? [] : dottedVenueQueries(symbol);
  // Most input has no venue code to retry: hand back the literal lookup
  // itself, so it settles no later than it did before the retry existed.
  if (alternatives.length === 0) return literal;
  return literal.then(async (resolved) => {
    for (const alternative of resolved ? [] : alternatives) {
      const match = await resolveTickerSymbol(alternative, options, null);
      if (match) return match;
    }
    return resolved;
  });
}

async function resolveTickerSymbol(
  symbol: string,
  { tickers, dataProvider, searchContext }: ResolveTickerSearchOptions,
  /** The `NET:` text that asked for every venue, or null to settle on one. */
  pickerQuery: string | null,
): Promise<ResolvedTickerSearch | null> {
  const local = tickers.get(symbol)
    ?? findExactTickerSearchMatch(createLocalTickerSearchCandidates(tickers.values()), symbol)?.ticker
    ?? null;
  if (local) {
    const contracts = new Map((local.metadata.broker_contracts ?? []).flatMap((brokerContract) => {
      const key = searchContractKey({ brokerContract, type: local.metadata.assetCategory || "" });
      return key ? [[key, brokerContract] as const] : [];
    }));
    if (contracts.size > 1) throw new AmbiguousContractError(symbol,
      [...contracts.values()].map((contract) => tickerInstrumentLabel(local.metadata.ticker, contract)));
  }
  // A saved symbol keeps its company. The colon still offers the others.
  const saved: ResolvedTickerSearch | null = local ? { kind: "local", symbol: local.metadata.ticker, ticker: local } : null;
  if (saved && !pickerQuery) return saved;

  const providerItems = createProviderTickerSearchCandidates(
    await searchProviderResults(dataProvider, symbol, searchContext),
    tickers,
  );
  const literalMatches = providerItems.filter((item) => normalizeTickerSymbol(item.symbol) === symbol);
  const matches = literalMatches.length ? literalMatches
    : providerItems.filter((item) => findExactTickerSearchMatch([item], symbol));
  let exactMatch = matches[0];
  if (!exactMatch?.result) return saved;

  const contracts = new Set(matches.map((item) => item.contractKey).filter(Boolean));
  if (contracts.size > 1 || (contracts.size && matches.some((item) => !item.contractKey))) {
    throw new AmbiguousContractError(symbol, matches.map((item) => tickerInstrumentLabel(item.symbol, item.result?.brokerContract)));
  }
  const listings = new Set(matches.map((item) => publicTickerKey(item.symbol, listingExchange(item.result!))));
  const ambiguity = (query: string) => new AmbiguousTickerError(query, [...listings], Object.fromEntries(matches.map((item) => [
    publicTickerKey(item.symbol, listingExchange(item.result!)), item.result!.name,
  ])));
  if (pickerQuery && listings.size > 1) throw ambiguity(pickerQuery);
  // A code that names several venues (TSE) the symbol trades on more than one of is a choice.
  if (!saved && isSharedExchangeCode(typedExchangeCode(symbol))
    && new Set(matches.map((item) => canonicalExchange(listingExchange(item.result!)))).size > 1) throw ambiguity(symbol);
  if (saved) return saved;
  if (listings.size > 1 && !parsePublicTickerKey(symbol).exchange && !tickerHasListingSuffix(symbol)) {
    // Search order is relevance, not a canonical listing identifier. Align bare
    // symbols with the quote source only when it supplies the exact identity.
    let verified: TickerSearchCandidate[] = [];
    try {
      const quote = await dataProvider.getQuote(symbol, "", {
        brokerId: searchContext?.brokerId,
        brokerInstanceId: searchContext?.brokerInstanceId,
      });
      const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
      const currency = resolveCurrencyUnit(quote.currency).currency;
      if (exchange && currency && Number.isFinite(quote.price) && quote.price !== 0
        && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0) {
        const sameSecurity = matches.filter((item) => {
          const result = item.result!;
          const candidateCurrency = resolveCurrencyUnit(result.currency).currency;
          return (!candidateCurrency || candidateCurrency === currency)
            && findExactTickerSearchMatch([{ label: quote.symbol, right: exchange, instrumentType: quote.instrumentType }], item.symbol)
            && (!isCryptoInstrumentType(result.type) || quote.price > 0);
        });
        verified = quotedListings(sameSecurity, exchange).map((item) => ({ ...item, result: { ...item.result!, currency } }));
      }
    } catch {
      // An unavailable quote cannot establish the default listing.
    }
    if (new Set(verified.map((item) => publicTickerKey(item.symbol, listingExchange(item.result!)))).size !== 1) {
      throw ambiguity(symbol);
    }
    exactMatch = verified[0]!;
    const chosen = publicTickerKey(exactMatch.symbol, listingExchange(exactMatch.result!));
    return { kind: "provider", symbol: exactMatch.symbol, result: exactMatch.result!, otherListings: [...listings].filter((key) => key !== chosen) };
  }

  return {
    kind: "provider",
    symbol: exactMatch.symbol,
    result: exactMatch.result!,
  };
}

/**
 * The listings a bare symbol's own quote is on: those on the venue it names.
 * The US exchanges share one symbol namespace, so a quote on any of them is
 * the symbol's one US listing, whichever venue the feed labels it with (ET's
 * NYSE line comes back as NYSE American).
 */
function quotedListings(items: TickerSearchCandidate[], exchange: string): TickerSearchCandidate[] {
  const venue = (item: TickerSearchCandidate) => canonicalExchange(listingExchange(item.result!));
  const named = items.filter((item) => venue(item) === exchange);
  if (named.length > 0 || !isUsListingExchange(exchange)) return named;
  return items.filter((item) => isUsListingExchange(venue(item)));
}

function listingExchange(result: InstrumentSearchResult): string {
  return result.exchange === "SMART" ? result.primaryExchange || result.exchange
    : result.exchange || result.primaryExchange || "";
}

function buildProviderHints(
  searchResults: InstrumentSearchResult[],
  localTickers: ReadonlyMap<string, TickerRecord>,
): {
  results: Map<string, InstrumentSearchResult>;
  ranks: Map<string, number>;
  popularity: Map<string, number>;
} {
  const results = new Map<string, InstrumentSearchResult>();
  const ranks = new Map<string, number>();
  const popularity = new Map<string, number>();
  for (const [rank, result] of searchResults.entries()) {
    const symbol = getSearchResultSymbol(result);
    if (!ranks.has(symbol)) ranks.set(symbol, rank);
    // A saved second listing is keyed with its venue (SAP:XETR); it takes
    // that venue's place instead of the end of the issuer's listings.
    const listingKey = publicTickerKey(symbol, listingExchange(result));
    if (listingKey !== symbol && !ranks.has(listingKey)) ranks.set(listingKey, rank);
    const score = searchResultPopularity(result);
    if (score != null) popularity.set(symbol, Math.max(score, popularity.get(symbol) ?? score));
    const existing = results.get(symbol);
    const preferredExchange = localTickers.get(symbol)?.metadata.exchange;
    if (
      !existing
      || getProviderHintScore(result, preferredExchange) > getProviderHintScore(existing, preferredExchange)
    ) {
      results.set(symbol, result);
    }
  }
  return { results, ranks, popularity };
}

/** Older servers and other providers send no popularity; ignore anything else malformed. */
function searchResultPopularity(result: InstrumentSearchResult): number | undefined {
  return typeof result.popularity === "number" && Number.isFinite(result.popularity) ? result.popularity : undefined;
}

async function searchProviderResults(
  dataProvider: DataProvider,
  rawQuery: string,
  searchContext?: SearchRequestContext,
  onPartial?: (results: InstrumentSearchResult[]) => void,
  /** Also look for the funds of a sector word, for a list of matches rather than one resolved symbol. */
  withThemeFunds = false,
): Promise<InstrumentSearchResult[]> {
  // "ES FUT" looks up ES, and ES=F as well: the catalogue answers a bare root
  // with stocks only. The ranking keeps the futures.
  const assetClass = parseAssetClassQuery(rawQuery);
  const query = assetClass?.symbolQuery ?? rawQuery;
  const marketSymbol = assetClass ? assetClassMarketSymbol(assetClass) : null;
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
  const searchQueries = buildProviderSearchQueries(query);
  if (marketSymbol && !searchQueries.includes(marketSymbol)) searchQueries.push(marketSymbol);
  // A futures board code also finds its future, which the catalogue files under
  // the continuous symbol only: NG finds NovaGold and NG=F.
  const boardFuture = assetClass ? null : futuresContractByCode(query)?.symbol;
  if (boardFuture && !searchQueries.includes(boardFuture)) searchQueries.push(boardFuture);
  await Promise.all(searchQueries.map(async (searchQuery) => {
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

  // Catalogues can omit exact market symbols or return a crypto pair from a
  // different venue. Verify the requested quote before accepting an alias.
  const requested = parsePublicTickerKey(normalizeTickerSymbol(query));
  const possibleCryptoPair = /^[A-Z0-9]{1,15}-[A-Z]{3,5}$/.test(requested.symbol);
  if ((isExplicitMarketSymbol(query) || possibleCryptoPair)
    && !findExactTickerSearchMatch([...byKey.values()].map((result) => ({
      label: getSearchResultSymbol(result), instrumentType: result.type, right: result.exchange,
    })), query)) {
    const { symbol, exchange } = requested;
    const marketType = /=F$/.test(symbol) ? "FUTURE"
      : /^(?:[A-Z]{3}(?:\/[A-Z]{3}|(?:[A-Z]{3})?=X))$/.test(symbol) ? "CURRENCY"
      : /^\^[A-Z0-9.-]+$/.test(symbol) ? "INDEX" : null;
    if (marketType || possibleCryptoPair) {
      try {
        const quote = await dataProvider.getQuote(symbol, exchange);
        const type = isCryptoInstrumentType(quote.instrumentType) ? quote.instrumentType : marketType;
        if (Number.isFinite(quote.price) && quote.price !== 0
          && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0
          && quote.currency?.trim()
          && type
          && (!isCryptoInstrumentType(type) || quote.price > 0)
          && (!exchange || canonicalExchange(quote.listingExchangeName || quote.exchangeName) === exchange)
          && (possibleCryptoPair ? normalizeTickerSymbol(quote.symbol) === symbol
            : findExactTickerSearchMatch([{ label: quote.symbol }], symbol))) {
          add([{
            providerId: quote.providerId || dataProvider.id,
            symbol,
            name: quote.name || symbol,
            exchange: exchange || quote.listingExchangeName || quote.exchangeName || "",
            currency: quote.currency,
            type,
          }]);
        }
      } catch {
        // An unverified symbol stays unresolved; never substitute a fuzzy equity.
      }
    }
  }

  // A sector word ("defense", which the server answers with rows tagged with it) lists its small companies by
  // name; the server orders "defense ETF" by size, which a name search does not. Those funds lead the list.
  const theme = withThemeFunds && !assetClass ? themeQueryWord([...byKey.values()], query) : null;
  if (theme) {
    try {
      const { onPartial: _ignored, ...context } = searchContext ?? {};
      const funds = await dataProvider.search(`${query.trim()} ETF`, context);
      const named = [...byKey];
      byKey.clear();
      add(funds);
      // A row both found keeps the funds' place and the name search's richer version of it (its theme).
      for (const [key, result] of named) byKey.set(key, result);
    } catch {
      // The funds are an addition: the name results stand without them.
    }
  }

  return [...byKey.values()];
}

function buildProviderSearchQueries(query: string): string[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const qualified = parsePublicTickerKey(trimmedQuery);
  if (qualified.exchange) return [trimmedQuery.toUpperCase(), qualified.symbol];
  if (tickerHasListingSuffix(trimmedQuery.toUpperCase())) return [trimmedQuery.toUpperCase()];

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
  return searchInstrumentKey(result);
}

function buildProviderCandidateId(result: InstrumentSearchResult, symbol: string): string {
  return [
    "search",
    normalizeTickerSymbol(symbol),
    normalizeSearchText(result.exchange || result.primaryExchange || result.type || ""),
    normalizeSearchText(result.currency || ""),
    normalizeSearchText(result.providerId || ""),
    searchContractKey(result),
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

function resultVenues(result: InstrumentSearchResult): string[] {
  return [
    result.exchange,
    result.primaryExchange,
    result.brokerContract?.exchange,
    result.brokerContract?.primaryExchange,
  ].map((exchange) => canonicalExchange(exchange)).filter(Boolean);
}

/** A result that names a listing venue, none of them the saved one. Broker
 * routing (SMART) names no venue. */
function isOtherVenue(result: InstrumentSearchResult, savedExchange: string): boolean {
  if (savedExchange === "SMART") return false;
  const venues = resultVenues(result).filter((exchange) => exchange !== "SMART");
  return venues.length > 0 && !venues.includes(savedExchange);
}

function getProviderHintScore(result: InstrumentSearchResult, preferredExchange?: string): number {
  const canonicalPreferredExchange = canonicalExchange(preferredExchange);
  const matchesPreferredExchange = !!canonicalPreferredExchange
    && resultVenues(result).includes(canonicalPreferredExchange);
  return getProviderHintRichness(result) + (matchesPreferredExchange ? 10_000 : 0);
}

/** Older servers send none; anything malformed is ignored. */
function searchResultKeywords(result: InstrumentSearchResult): string[] | undefined {
  const keywords = Array.isArray(result.searchKeywords)
    ? result.searchKeywords.filter((keyword): keyword is string => typeof keyword === "string" && !!keyword.trim())
    : [];
  return keywords.length > 0 ? keywords : undefined;
}

function assignTickerSearchCategories<T extends TickerSearchCandidate>(items: T[], query: string): T[] {
  let assignedPrimaryListing = false;

  return items.map((item) => {
    // A company the theme's funds hold is not another listing of the one searched for.
    if (!item.saved && item.kind === "search" && item.instrumentClass === "equity" && answersOnlyByKeyword(item, query)) {
      return { ...item, category: "Related" };
    }
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
  // Older servers send none. Anything else malformed is ignored.
  if (Array.isArray(result.searchAliases)) {
    for (const alias of result.searchAliases) {
      if (typeof alias === "string" && alias.trim()) aliases.add(alias.trim());
    }
  }
  return [...aliases];
}
