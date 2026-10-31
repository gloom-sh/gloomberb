import { isCryptoInstrumentType } from "../../tickers/search/ranking";
import { isCryptoVenuePerpetual } from "../../tickers/instrument-kind";
import type { Quote } from "../../types/financials";
import { isCryptoPairSymbol, TOP_COIN_NAMES } from "../../utils/crypto-pair";
import { isNotATickerMessage } from "../not-a-ticker";
import { groupByCompany } from "../../tickers/company-name";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";
import type { TickerRecord } from "../../types/ticker";

/** Where a crypto pair that will not load can still be read. `fn CRYP` takes no argument. */
export const CRYPTO_BOARD_HINT = "Crypto prices may be briefly unavailable; the CRYP function (gloom fn CRYP) shows the crypto board.";

// How the note names the coin, and which tickers it speaks for.
const MAJOR_COINS = TOP_COIN_NAMES;

/** What a coin note reads of a listing: its quote's, or what a saved listing keeps. */
interface CoinListing {
  name?: string | null;
  instrumentType?: string | null;
  /** The feed says the price is old. */
  stale?: boolean;
  /** The exchange removed the listing, or its last trade is all that is known. */
  delisting?: unknown;
}

/**
 * A bare coin ticker usually resolves to a listing that is not the coin. The note applies to a
 * top coin's symbol whenever the listing is not a crypto product, and says how sure it is:
 *
 * - "SOL is Emeren Group ..., not solana. For solana use SOL-USD." when the listing cannot be
 *   what was meant: its name says the coin (a "Bitcoin" trust), or it is stale or delisted
 *   (SOL's Emeren Group last traded months ago).
 * - "LINK is Interlink Electronics, Inc. Also a coin: LINK-USD." for a live company that
 *   happens to share the letters, which may well be the one meant.
 *
 * Every command that reads a bare symbol as a listing says it: quote, ticker, history, options,
 * news, charts, alerts, and the portfolio and watchlist adds.
 */
export function notTheCoinNote(symbol: string, listing: CoinListing | null | undefined): string | null {
  const coin = MAJOR_COINS.get(symbol);
  const type = listing?.instrumentType?.trim();
  const name = listing?.name?.trim();
  if (!coin || !name || !type || isCryptoInstrumentType(type)) return null;
  const cannotBeIt = listing?.stale === true || !!listing?.delisting || new RegExp(`\\b${coin}\\b`, "i").test(name);
  return cannotBeIt
    ? `${symbol} is ${name}, not ${coin}. For ${coin} use ${symbol}-USD.`
    : `${symbol} is ${name}${/[.!?]$/.test(name) ? "" : "."} Also a coin: ${symbol}-USD.`;
}

/**
 * `notTheCoinNote` for a saved listing, by the name and asset category it was saved with.
 * `ended` says the listing stopped trading, which the saved record does not keep.
 */
export function savedListingCoinNote(symbol: string, ticker: Pick<TickerRecord, "metadata">, { ended = false }: { ended?: boolean } = {}): string | null {
  return notTheCoinNote(symbol, { name: ticker.metadata.name, instrumentType: ticker.metadata.assetCategory, stale: ended });
}

/**
 * A bare coin ticker several companies list asks which listing; when none of them is the coin
 * (SOL: Solvay, Washington H. Soul Pattinson), the coin is where the user may have meant:
 * "SOL is Solvay SA or Washington H. Soul Pattinson and Company Limited, not solana. For
 * solana use SOL-USD." Null for any other symbol, or when a listing is a crypto pair.
 */
export function coinElsewhereNote(symbol: string, listings: ReadonlyArray<{ key: string; name: string }>): string | null {
  const coin = MAJOR_COINS.get(symbol);
  if (!coin || listings.some((listing) => isCryptoPairSymbol(listing.key))) return null;
  const names = groupByCompany(listings.filter((listing) => listing.name.trim()), (listing) => listing.name.trim())
    .map((group) => group[0]!.name.trim());
  if (names.length === 0) return null;
  const named = names.length === 1 ? names[0]!
    : names.length === 2 ? `${names[0]} or ${names[1]}`
    : `${names[0]}, ${names[1]} or another company`;
  return `${symbol} is ${named}, not ${coin}. For ${coin} use ${symbol}-USD.`;
}

interface QuoteNoteResult {
  target: { symbol: string };
  quote: Pick<Quote, "name" | "instrumentType"> | null;
  error: string | null;
}

/**
 * The router words a failure as "<reason> for <symbol>", alone or closing its
 * first sentence ("Gloom's data service did not answer for X. Try again in a
 * moment."); drop the symbol so equal reasons group. Any other line, such as a
 * sentence the data service wrote, is kept as it reads.
 */
function failureReason(message: string, symbol: string): string {
  const line = (message.split("\n")[0] ?? "").trim();
  const bare = line.replace(/\.+$/, "");
  const suffix = ` for ${symbol}`;
  if (bare.toLowerCase().endsWith(suffix.toLowerCase())) return bare.slice(0, -suffix.length);
  const at = line.toLowerCase().indexOf(`${suffix.toLowerCase()}. `);
  return at > 0 ? `${line.slice(0, at)}${line.slice(at + suffix.length)}` : line;
}

/**
 * Text-mode notes under a quote table: one line per distinct failure reason (with the crypto board
 * pointer when a failed symbol is a crypto pair, unless nothing could be reached), then the perpetual futures line.
 * A bare coin ticker read as another listing is said with the listing (`listingChoiceNotes`).
 */
export function quoteNotes(results: QuoteNoteResult[]): string[] {
  const failures = new Map<string, string[]>();
  for (const result of results) {
    if (!result.error || result.quote) continue;
    const reason = failureReason(result.error, result.target.symbol);
    const symbols = failures.get(reason) ?? [];
    if (!symbols.includes(result.target.symbol)) failures.set(reason, [...symbols, result.target.symbol]);
  }
  const notes = [...failures].map(([reason, symbols]) => (
    // "Not a ticker: APPLE." already names its symbol.
    isNotATickerMessage(reason)
      ? reason
      : `${symbols.join(", ")}: ${reason}${symbols.some(isCryptoPairSymbol) && reason !== DATA_SERVICE_UNREACHABLE_MESSAGE ? `${/[.!?]$/.test(reason) ? "" : "."} ${CRYPTO_BOARD_HINT}` : ""}`
  ));
  const perpetuals = results
    .filter((result) => result.quote && isCryptoVenuePerpetual(result.quote.instrumentType, result.quote.name))
    .map((result) => result.target.symbol);
  if (perpetuals.length > 0) {
    notes.push(`${perpetuals.join(", ")}: perpetual futures ${perpetuals.length === 1 ? "price" : "prices"} on crypto venues, 24/7; not the listed future, not spot.`);
  }
  return notes;
}
