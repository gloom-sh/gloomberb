import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import { AmbiguousContractError, AmbiguousTickerError, LISTING_SEARCH_LIMIT, listingChoiceQuery, resolveTickerSearch } from "./search";
import {
  canonicalExchange,
  exchangeCodeVenues,
  isSharedExchangeCode,
  isUsListingExchange,
  parsePublicTickerKey,
  typedExchangeCode,
} from "../utils/exchanges";

export interface ListingStore {
  loadTicker(symbol: string): Promise<TickerRecord | null>;
  loadAllTickers(): Promise<TickerRecord[]>;
}

export interface ListingDeps {
  store: ListingStore;
  dataProvider: DataProvider;
}

export interface ListingVenue {
  /** Canonical code. */
  exchange: string;
  name: string;
}

/**
 * The venues a symbol trades on and the company on each, from the same
 * listing picker the command bar opens for `SAN:`. This is the one venue list
 * every command names; whether a venue it leaves out trades the symbol is the
 * listing's own quote's to say (`quotedOnVenue`).
 */
export async function listingVenues(symbol: string, { store, dataProvider }: ListingDeps): Promise<ListingVenue[]> {
  const query = `${symbol}:`;
  if (!listingChoiceQuery(query)) return [];
  const tickers = new Map((await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const));
  let venues: ListingVenue[];
  try {
    const resolved = await resolveTickerSearch({
      query, activeTicker: null, tickers, dataProvider, searchContext: { limit: LISTING_SEARCH_LIMIT },
    });
    const only = !resolved ? null
      : resolved.kind === "local" ? { exchange: resolved.ticker.metadata.exchange, name: resolved.ticker.metadata.name }
      : {
        exchange: resolved.result.exchange === "SMART" ? resolved.result.primaryExchange ?? "" : resolved.result.exchange || resolved.result.primaryExchange || "",
        name: resolved.result.name,
      };
    venues = only?.exchange ? [{ exchange: canonicalExchange(only.exchange), name: only.name }] : [];
  } catch (error) {
    // One listing settles the picker; several are its choices.
    if (!(error instanceof AmbiguousTickerError) || error instanceof AmbiguousContractError) return [];
    venues = error.listings.flatMap((listing) => {
      const exchange = parsePublicTickerKey(listing).exchange;
      return exchange ? [{ exchange, name: error.listingNames[listing] ?? "" }] : [];
    });
  }
  return venues.filter((venue, index) => venues.findIndex((other) => other.exchange === venue.exchange) === index);
}

/**
 * Whether the listing's own quote prices it on a venue abroad, as `quote
 * SYM:EXCH` reads it. Search can leave a venue out (CAR's ASX line); a quote
 * there settles that it trades. The US exchanges share one symbol, so a quote
 * named for any of them says only that the symbol has a US line: there,
 * search's venues stand.
 */
export async function quotedOnVenue(listing: { symbol: string; exchange: string }, { dataProvider }: Pick<ListingDeps, "dataProvider">): Promise<boolean> {
  if (isUsListingExchange(listing.exchange)) return false;
  try {
    const quote = await dataProvider.getQuote(`${listing.symbol}:${listing.exchange}`, listing.exchange);
    return Number.isFinite(quote.price) && quote.price !== 0
      && canonicalExchange(quote.listingExchangeName || quote.exchangeName) === listing.exchange;
  } catch {
    return false;
  }
}

/** What a typed code that names several venues (7203:TSE) was read as. */
export type SharedCodeReading =
  /** The one of the code's venues the symbol trades on. */
  | { kind: "venue"; exchange: string }
  /** The symbol trades on several of them (TSE, and DUAL in Toronto and Tokyo). */
  | { kind: "several"; venues: string[] }
  /** The symbol trades on none of them; `venues` are where it does. */
  | { kind: "none"; venues: ListingVenue[] }
  /** Neither search nor a quote knows the symbol. */
  | { kind: "unknown" };

/**
 * A listing typed with a code that names several venues (TSE: Tokyo or
 * Toronto, KRX: KOSPI or KOSDAQ, EURONEXT: Paris, Amsterdam and the others),
 * read as the one of them its symbol trades on: the venues the `7203:` picker
 * lists, else the one its own quote prices (search can leave a venue out).
 * This is the one reading of a typed shared code: commands, the command bar,
 * links and chat all ask it. Broker data that arrives with TSE is Toronto and
 * never comes here.
 */
export async function readSharedCode(symbol: string, code: string, deps: ListingDeps): Promise<SharedCodeReading> {
  const meanings = exchangeCodeVenues(code);
  const venues = await listingVenues(symbol, deps).catch(() => []);
  let traded = meanings.filter((venue) => venues.some((entry) => entry.exchange === venue));
  if (traded.length === 0) {
    const quoted = await Promise.all(meanings.map((exchange) => quotedOnVenue({ symbol, exchange }, deps)));
    traded = meanings.filter((_venue, index) => quoted[index]);
  }
  if (traded.length === 1) return { kind: "venue", exchange: traded[0]! };
  if (traded.length > 1) return { kind: "several", venues: traded };
  return venues.length > 0 ? { kind: "none", venues } : { kind: "unknown" };
}

/**
 * A typed listing key with a shared code read as the venue its symbol trades
 * on: 7203:TSE is 7203:JPX, 247540:KRX is 247540:KOSDAQ, SAN:EURONEXT is
 * SAN:EPA. A symbol on several of them is a choice (`AmbiguousTickerError`,
 * which opens the listing picker). Any other key, and one nothing could read,
 * comes back as typed.
 */
export async function settleTypedListingKey(typed: string, deps: ListingDeps): Promise<string> {
  const key = typed.trim().toUpperCase();
  const code = typedExchangeCode(key);
  if (!isSharedExchangeCode(code)) return typed;
  const { symbol } = parsePublicTickerKey(key);
  const reading = await readSharedCode(symbol, code, deps);
  if (reading.kind === "venue") return `${symbol}:${reading.exchange}`;
  if (reading.kind === "several") {
    throw new AmbiguousTickerError(key, reading.venues.map((exchange) => `${symbol}:${exchange}`));
  }
  return typed;
}
