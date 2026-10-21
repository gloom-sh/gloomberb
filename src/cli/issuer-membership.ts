import type { AppConfig } from "../types/config";
import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";
import { savedListingName } from "./listing-arg";

/** A list holding the company: its name, and the other saved listing it holds the company as (null for the listing asked about). */
export interface ListMembership {
  name: string;
  /** RCI.B:TSX when the list holds Rogers as its Toronto line and the report is of RCI. */
  via: string | null;
}

export interface CompanyMemberships {
  portfolios: ListMembership[];
  watchlists: ListMembership[];
}

/**
 * A listing as Gloom Cloud writes an issuer's listings: the bare ticker on a
 * US venue or none (RCI), SYMBOL:EXCHANGE elsewhere (RCI.B:TSX), with a
 * share class's dash or slash as a dot (BRK-B is BRK.B).
 */
export function issuerListingKey(symbol: string, exchange?: string): string {
  const parsed = parsePublicTickerKey(symbol);
  const venue = parsed.exchange ?? canonicalExchange(exchange);
  const code = parsed.symbol.toUpperCase().replace(/[-/]/g, ".");
  return venue && !isUsListingExchange(venue) ? `${code}:${venue}` : code;
}

function names(config: AppConfig, ids: readonly string[], kind: "portfolios" | "watchlists"): Map<string, string> {
  const collections: ReadonlyArray<{ id: string; name: string }> = config[kind];
  return new Map(ids.flatMap((id) => {
    const name = collections.find((collection) => collection.id === id)?.name;
    return name ? [[id, name] as const] : [];
  }));
}

/**
 * The portfolios and watchlists that hold a company, whichever of its
 * listings they saved: the listing's own lists, then those holding another
 * of `issuerListings` (its keys as `issuerListingKey` writes them), each
 * once and saying which listing it holds. A restricted list holding RCI.B:TSX
 * holds Rogers, which also trades as RCI in New York. Without the company's
 * listings, only the listing's own lists.
 */
export function companyMemberships(
  config: AppConfig,
  own: TickerRecord | null,
  saved: readonly TickerRecord[],
  issuerListings: readonly string[] | null,
): CompanyMemberships {
  const listings = new Set(issuerListings ?? []);
  const ownKey = own ? savedListingName(own).key : null;
  const others = listings.size === 0 ? [] : saved.filter((ticker) =>
    savedListingName(ticker).key !== ownKey
    && listings.has(issuerListingKey(ticker.metadata.ticker, ticker.metadata.exchange)));
  const collect = (kind: "portfolios" | "watchlists"): ListMembership[] => {
    const held = new Map<string, ListMembership>();
    for (const [id, name] of names(config, own?.metadata[kind] ?? [], kind)) held.set(id, { name, via: null });
    for (const ticker of others) {
      for (const [id, name] of names(config, ticker.metadata[kind], kind)) {
        if (!held.has(id)) held.set(id, { name, via: savedListingName(ticker).key });
      }
    }
    return [...held.values()];
  };
  return { portfolios: collect("portfolios"), watchlists: collect("watchlists") };
}

/**
 * `companyMemberships` for a listing, asking Gloom Cloud for the company's
 * other listings only when another saved listing is in a list at all. A
 * failed lookup leaves the listing's own lists.
 */
export async function loadCompanyMemberships({
  config,
  own,
  symbol,
  exchange,
  loadTickers,
  dataProvider,
}: {
  config: AppConfig;
  own: TickerRecord | null;
  /** The listing the report is of, and its venue (RCI, NYSE). */
  symbol: string;
  exchange: string;
  loadTickers: () => Promise<TickerRecord[]>;
  dataProvider: Pick<DataProvider, "getIssuerListings">;
}): Promise<CompanyMemberships> {
  const ownKey = own ? savedListingName(own).key : null;
  const saved = await Promise.resolve().then(loadTickers)
    .catch(logFailure("cli.issuer-membership", "Reading saved listings failed", [] as TickerRecord[]));
  const listed = saved.filter((ticker) => savedListingName(ticker).key !== ownKey
    && (ticker.metadata.portfolios.length > 0 || ticker.metadata.watchlists.length > 0));
  if (listed.length === 0 || !dataProvider.getIssuerListings) return companyMemberships(config, own, [], null);
  const issuer = await dataProvider.getIssuerListings(symbol, exchange)
    .catch(logFailure("cli.issuer-membership", "Reading the company's listings failed", null));
  return companyMemberships(config, own, listed, issuer?.listings.map((listing) => issuerListingKey(listing.symbol, listing.exchange)) ?? null);
}
