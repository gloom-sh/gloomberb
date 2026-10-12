import { isCryptoPairSymbol } from "../utils/crypto-pair";
import { canonicalExchange, isKnownExchangeCode, parsePublicTickerKey } from "../utils/exchanges";

/**
 * A perpetual market as a listing: the contract's own symbol on its venue,
 * saved and quoted like any other listing (`BZUSDT:BINANCE`). Gloom Cloud
 * names the market by its canonical id (`binance:BZUSDT`); a Hyperliquid
 * builder dex market (`hyperliquid:xyz:BRENTOIL`) is `XYZ-BRENTOIL:HYPERLIQUID`,
 * its dex before a dash, since a listing's symbol holds no colon. The venue is
 * the exchange, so the same contract name on two venues is two listings.
 */

/** Venue id in a market id, by the exchange code its listings carry. */
const VENUE_BY_EXCHANGE: Readonly<Record<string, string>> = {
  HYPERLIQUID: "hyperliquid",
  BINANCE: "binance",
  BYBIT: "bybit",
  OKX: "okx",
  DERIBIT: "deribit",
  DYDX: "dydx",
};
const EXCHANGE_BY_VENUE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(VENUE_BY_EXCHANGE).map(([exchange, venue]) => [venue, exchange]),
);
const VENUE_NAMES: Readonly<Record<string, string>> = {
  HYPERLIQUID: "Hyperliquid",
  BINANCE: "Binance",
  BYBIT: "Bybit",
  OKX: "OKX",
  DERIBIT: "Deribit",
  DYDX: "dYdX",
};

/** The type a perpetual listing is saved and searched with. */
export const PERPETUAL_TYPE = "PERP";

/** Exchange codes of the perpetual venues, which trade around the clock. */
export const PERPETUAL_EXCHANGES: readonly string[] = Object.keys(VENUE_BY_EXCHANGE);

/** A venue symbol: letters (any script), digits, dash, underscore and dot; no colon or space. */
const VENUE_SYMBOL = /^[\p{L}\p{N}_.-]{1,64}$/u;

export interface PerpetualListing {
  /** The listing key it is saved and quoted under: `XYZ-BRENTOIL:HYPERLIQUID`. */
  key: string;
  /** The listing's symbol without the venue: `XYZ-BRENTOIL`. */
  symbol: string;
  /** The venue's exchange code: `HYPERLIQUID`. */
  exchange: string;
  /** Gloom Cloud's id for the market, as PERP takes it: `hyperliquid:xyz:BRENTOIL`. */
  marketId: string;
}

/** Whether an exchange code is a perpetual venue's. */
export function isPerpetualExchange(exchange: string | null | undefined): boolean {
  return canonicalExchange(exchange ?? "") in VENUE_BY_EXCHANGE;
}

/** "Binance" for BINANCE; null for a code that is not a perpetual venue. */
export function perpetualVenueName(exchange: string | null | undefined): string | null {
  return VENUE_NAMES[canonicalExchange(exchange ?? "")] ?? null;
}

/**
 * The listing of a Gloom Cloud market id (`binance:BZUSDT`,
 * `hyperliquid:default:BTC`, `hyperliquid:xyz:BRENTOIL`); null for anything else.
 */
export function perpetualListingOfMarket(marketId: string): PerpetualListing | null {
  const match = /^([a-z]+):(.+)$/i.exec(marketId.trim());
  if (!match) return null;
  const venue = match[1]!.toLowerCase();
  const exchange = EXCHANGE_BY_VENUE[venue];
  if (!exchange) return null;
  let rest = match[2]!;
  let symbol: string;
  if (venue === "hyperliquid") {
    const dex = /^([a-z0-9]+):(.+)$/i.exec(rest);
    const coin = dex ? dex[2]! : rest;
    const dexName = dex ? dex[1]!.toLowerCase() : "default";
    rest = `${dexName}:${coin}`;
    symbol = dexName === "default" ? coin.toUpperCase() : `${dexName}-${coin}`.toUpperCase();
  } else {
    symbol = rest.toUpperCase();
  }
  if (!VENUE_SYMBOL.test(symbol) || symbol.startsWith("-")) return null;
  return { key: `${symbol}:${exchange}`, symbol, exchange, marketId: `${venue}:${rest}` };
}

/**
 * A listing (`BZUSDT:BINANCE`, or `BZUSDT` with exchange BINANCE) as a
 * perpetual market; null when its venue is not a perpetual venue.
 */
export function perpetualListing(symbol: string, exchange?: string | null): PerpetualListing | null {
  const parsed = parsePublicTickerKey(symbol);
  const venueCode = canonicalExchange(parsed.exchange ?? exchange ?? "");
  const venue = VENUE_BY_EXCHANGE[venueCode];
  if (!venue || !VENUE_SYMBOL.test(parsed.symbol) || parsed.symbol.startsWith("-")) return null;
  // A coin pair (BTC-USD, as BTC/USD on Binance is read) is the venue's spot market; contracts there have no dash
  // before their quote currency. Hyperliquid's dash is its dex.
  if (venue !== "hyperliquid" && isCryptoPairSymbol(parsed.symbol)) return null;
  const marketId = venue === "hyperliquid"
    ? (() => {
      const dash = parsed.symbol.indexOf("-");
      return dash > 0
        ? `hyperliquid:${parsed.symbol.slice(0, dash).toLowerCase()}:${parsed.symbol.slice(dash + 1)}`
        : `hyperliquid:default:${parsed.symbol}`;
    })()
    : `${venue}:${parsed.symbol}`;
  return { key: `${parsed.symbol}:${venueCode}`, symbol: parsed.symbol, exchange: venueCode, marketId };
}

/**
 * The market ids to ask for a listing, in order. Saved symbols are upper
 * case, and Hyperliquid writes its thousand-unit coins with a small k
 * (`kPEPE`), so a K coin there is also asked for that way.
 */
export function perpetualMarketIds(listing: PerpetualListing): string[] {
  const ids = [listing.marketId];
  const coin = /^hyperliquid:default:K([A-Z0-9]+)$/.exec(listing.marketId);
  if (coin) ids.push(`hyperliquid:default:k${coin[1]}`);
  return ids;
}

/**
 * A perpetual typed by its market id (`binance:BZUSDT`, `hyperliquid:xyz:BRENTOIL`)
 * or by the name Hyperliquid gives a builder dex market, its dex in lower case
 * (`xyz:BRENTOIL`), read as the listing every command takes. Null for anything
 * else, including a symbol on an exchange (`OKX:NYSE` is the symbol OKX on NYSE).
 */
export function typedPerpetualListing(typed: string): PerpetualListing | null {
  const trimmed = typed.trim().replace(/^\$/, "");
  const builder = /^([a-z][a-z0-9]{0,11}):([A-Z0-9]{1,32})$/.exec(trimmed);
  if (builder && !(builder[1]! in EXCHANGE_BY_VENUE) && !isKnownExchangeCode(builder[2]!)) {
    return perpetualListingOfMarket(`hyperliquid:${trimmed}`);
  }
  const match = /^([a-z]+):(.+)$/i.exec(trimmed);
  if (!match || !(match[1]!.toLowerCase() in EXCHANGE_BY_VENUE)) return null;
  // `OKX:NYSE` names an exchange after the colon: a listing, not a market id.
  if (!match[2]!.includes(":") && isKnownExchangeCode(match[2]!)) return null;
  return perpetualListingOfMarket(trimmed);
}

/**
 * The contract as its venue writes it, for a narrow ticker column: `BZUSDT`,
 * `BTC`, and a Hyperliquid builder dex market as `xyz:BRENTOIL`. The venue is
 * the listing's exchange.
 */
export function perpetualDisplaySymbol(listing: PerpetualListing): string {
  const builder = /^hyperliquid:([a-z0-9]+):(.+)$/.exec(listing.marketId);
  return builder && builder[1] !== "default" ? `${builder[1]}:${builder[2]}` : listing.symbol;
}
