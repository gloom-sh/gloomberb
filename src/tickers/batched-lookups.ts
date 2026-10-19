import type { DataProvider, MarketDataRequestContext, QuoteBatchResult, SearchRequestContext } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { InstrumentSearchResult } from "../types/instrument";
import { logFailure } from "../utils/log-failure";
import { LISTING_SEARCH_LIMIT } from "./search";
import { PERPETUAL_TYPE } from "./perpetual-listing";

/**
 * The searches a list asks for in batches are asked at the listing picker's
 * size, whose rows are also the first rows of a plain search.
 */
const BATCHED_SEARCH_LIMIT = LISTING_SEARCH_LIMIT;
/** A plain search's size when its caller names none, as the sources read it. */
const DEFAULT_SEARCH_LIMIT = 10;
/** How long quote requests gather before they go out as one batch. */
const QUOTE_GATHER_MS = 10;
/** Quotes in one batch request, the most a signed-out batch may ask for. */
const QUOTE_BATCH_SIZE = 100;

/** What one symbol of a list asks the sources for: its searches and its ticker change lookup. */
export interface ListLookupPlan {
  /** The searches its lookup runs (`providerSearchQueries`); none for a symbol looked up some other way. */
  searches: string[];
  /** The symbol its change lookup asks for (`tickerChangeSymbol`), or null for one with none. */
  changes: string | null;
}

export interface BatchedLookups {
  /** The provider the lookups read through. */
  dataProvider: DataProvider;
  /** Whether a symbol's searches were all answered in a batch, so its lookup asks the sources for quotes alone. */
  answered(plan: ListLookupPlan): boolean;
}

const searchKey = (query: string) => query.trim().toUpperCase();

/**
 * The data provider a list of symbols is looked up through: the searches and
 * ticker changes every symbol's lookup will ask for go out first as a few
 * batched requests, and the quotes the lookups then ask for are gathered into
 * batch requests, so a pasted list of hundreds of symbols is a handful of
 * requests rather than several per symbol. Everything else, and anything a
 * batch left unanswered (a service without batches, a query it could not
 * search, a listing a batch has no quote for), is asked as before, one at a
 * time, so each lookup reads what it would have read alone.
 */
export async function batchedListLookups(
  dataProvider: DataProvider,
  plans: readonly ListLookupPlan[],
): Promise<BatchedLookups> {
  // Symbols that are all saved already are looked up with no source at all.
  if (!dataProvider) return { dataProvider, answered: () => false };
  const queries = [...new Set(plans.flatMap((plan) => plan.searches.map(searchKey)))];
  const changeSymbols = [...new Set(plans.flatMap((plan) => plan.changes ? [plan.changes] : []))];
  // The changes first: a request or so for the whole list, which the searches,
  // a unit of a signed-out caller's allowance each, cannot then crowd out.
  // A batch that fails leaves every symbol to be looked up on its own, as before.
  const changes = changeSymbols.length && dataProvider.getTickerChangesBatch
    ? await dataProvider.getTickerChangesBatch(changeSymbols).catch(logFailure("tickers.batched-lookups", "Batched ticker changes failed", null))
    : null;
  const searches = queries.length && dataProvider.searchBatch
    ? await dataProvider.searchBatch(queries, { limit: BATCHED_SEARCH_LIMIT }).catch(logFailure("tickers.batched-lookups", "Batched search failed", null))
    : null;
  const quotes = dataProvider.getQuotesBatch ? new QuoteGatherer(dataProvider) : null;
  if (!searches?.size && !changes?.size && !quotes) return { dataProvider, answered: () => false };

  // An empty answer is asked again on its own, so a fallback source still gets its turn.
  const searched = (query: string) => (searches?.get(searchKey(query))?.length ?? 0) > 0;
  const overrides: Partial<DataProvider> = {
    search: async (query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]> => {
      const limit = context?.limit ?? DEFAULT_SEARCH_LIMIT;
      const plain = !context?.brokerId && !context?.brokerInstanceId && context?.preferBroker !== false;
      const rows = plain && limit <= BATCHED_SEARCH_LIMIT ? searches?.get(searchKey(query)) : undefined;
      return rows?.length ? firstRows(rows, limit) : dataProvider.search(query, context);
    },
  };
  if (changes?.size && dataProvider.getTickerChanges) {
    overrides.getTickerChanges = async (symbol, options) => {
      const key = symbol.trim().toUpperCase();
      return changes.has(key) ? changes.get(key) ?? null : dataProvider.getTickerChanges!(symbol, options);
    };
  }
  if (quotes) {
    overrides.getQuote = (ticker, exchange, context) => plainContext(context)
      ? quotes.get(ticker, exchange ?? "")
      : dataProvider.getQuote(ticker, exchange, context);
  }
  return {
    dataProvider: withOverrides(dataProvider, overrides),
    answered: (plan) => plan.searches.length > 0 && plan.searches.every(searched),
  };
}

/**
 * A batched answer cut to a search's size: its first `limit` listings, after
 * the perpetual markets that lead it, which a search adds beyond its size.
 */
function firstRows(rows: readonly InstrumentSearchResult[], limit: number): InstrumentSearchResult[] {
  return [...rows.filter((row) => row.type === PERPETUAL_TYPE), ...rows.filter((row) => row.type !== PERPETUAL_TYPE).slice(0, limit)];
}

/** A quote request that names no broker, contract or refresh (`{ brokerId: undefined }` included), which a batch answers alike. */
function plainContext(context: MarketDataRequestContext | undefined): boolean {
  return !context || Object.entries(context).every(([key, value]) => value == null || (key === "cacheMode" && value === "default"));
}

/** `provider` with some of its methods answered by `overrides`, every other one its own. */
function withOverrides(provider: DataProvider, overrides: Partial<DataProvider>): DataProvider {
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof DataProvider];
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const listingKey = (symbol: string, exchange: string | undefined) => `${symbol.toUpperCase()}|${(exchange ?? "").toUpperCase()}`;

interface PendingQuote {
  ticker: string;
  exchange: string;
  resolve(quote: Quote): void;
  reject(error: unknown): void;
}

/**
 * Quotes asked for one at a time, sent as batch requests: the asks of a few
 * milliseconds go out together. The batch asks a listing it has no quote for
 * on its own, so the answer, or the error saying why there is none, is the
 * one `getQuote` gives. Each listing is asked once.
 */
class QuoteGatherer {
  private readonly answers = new Map<string, Promise<Quote>>();
  private pending: PendingQuote[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dataProvider: DataProvider) {}

  get(ticker: string, exchange: string): Promise<Quote> {
    const key = listingKey(ticker, exchange);
    const known = this.answers.get(key);
    if (known) return known;
    const answer = new Promise<Quote>((resolve, reject) => {
      this.pending.push({ ticker, exchange, resolve, reject });
    });
    this.answers.set(key, answer);
    if (this.pending.length >= QUOTE_BATCH_SIZE) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), QUOTE_GATHER_MS);
    return answer;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending.splice(0, QUOTE_BATCH_SIZE);
    if (this.pending.length > 0) this.timer = setTimeout(() => this.flush(), 0);
    if (batch.length === 0) return;
    void this.send(batch);
  }

  private async send(batch: PendingQuote[]): Promise<void> {
    const targets = batch.map(({ ticker, exchange }) => ({ symbol: ticker, ...exchange ? { exchange } : {} }));
    const results: QuoteBatchResult[] = await this.dataProvider.getQuotesBatch!(targets)
      .catch(logFailure("tickers.batched-lookups", "Batched quotes failed", [] as QuoteBatchResult[]));
    // Each answer by the listing it names, never by its place: a source may answer in another order or leave some out.
    const byListing = new Map(results.map((entry) => [listingKey(entry.target.symbol, entry.target.exchange), entry] as const));
    await Promise.all(batch.map(async (ask, index) => {
      const result = results.find((entry) => entry.target === targets[index]) ?? byListing.get(listingKey(ask.ticker, ask.exchange));
      if (result?.quote) {
        ask.resolve(result.quote);
        return;
      }
      // Asked on its own already, and refused or not found: asking again would only be refused again.
      if (result?.error) {
        ask.reject(result.error);
        return;
      }
      try {
        ask.resolve(await this.dataProvider.getQuote(ask.ticker, ask.exchange));
      } catch (error) {
        ask.reject(error);
      }
    }));
  }
}
