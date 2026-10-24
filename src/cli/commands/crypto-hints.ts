import { isCryptoInstrumentType } from "../../tickers/search/ranking";
import { isCryptoVenuePerpetual } from "../../tickers/instrument-kind";
import type { Quote } from "../../types/financials";
import { isCryptoPairSymbol, MAJOR_COIN_NAMES } from "../../utils/crypto-pair";
import { isNotATickerMessage } from "../not-a-ticker";
import { groupByCompany } from "../../tickers/company-name";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";
import type { TickerRecord } from "../../types/ticker";

/** Where a crypto pair that will not load can still be read. `fn CRYP` takes no argument. */
export const CRYPTO_BOARD_HINT = "Crypto prices may be briefly unavailable; the CRYP function (gloom fn CRYP) shows the crypto board.";

// How the note names the coin, and what a listing's name has to say before the note applies.
const MAJOR_COINS = MAJOR_COIN_NAMES;

/**
 * A bare coin ticker usually resolves to a listed fund, not the coin. The note applies only when
 * the listing is not crypto and its own name says the coin (a "Bitcoin" trust), so a company that
 * happens to share the letters (Interlink Electronics on LINK) is left alone. Every command that
 * reads a bare symbol as a listing says it: quote, ticker, and the portfolio and watchlist adds.
 */
export function notTheCoinNote(symbol: string, quote: Pick<Quote, "name" | "instrumentType"> | null | undefined): string | null {
  const coin = MAJOR_COINS.get(symbol);
  const type = quote?.instrumentType?.trim();
  const name = quote?.name?.trim();
  if (!coin || !name || !type || isCryptoInstrumentType(type)) return null;
  if (!new RegExp(`\\b${coin}\\b`, "i").test(name)) return null;
  return `${symbol} is ${name}, not ${coin}. For ${coin} use ${symbol}-USD.`;
}

/** `notTheCoinNote` for a saved listing, by the name and asset category it was saved with. */
export function savedListingCoinNote(symbol: string, ticker: Pick<TickerRecord, "metadata">): string | null {
  return notTheCoinNote(symbol, { name: ticker.metadata.name, instrumentType: ticker.metadata.assetCategory });
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
 * The router words a failure as "<reason> for <symbol>"; drop the symbol so equal reasons group.
 * Any other line, such as a sentence the data service wrote, is kept as it reads.
 */
function failureReason(message: string, symbol: string): string {
  const line = (message.split("\n")[0] ?? "").trim();
  const bare = line.replace(/\.+$/, "");
  const suffix = ` for ${symbol}`;
  return bare.toLowerCase().endsWith(suffix.toLowerCase()) ? bare.slice(0, -suffix.length) : line;
}

/**
 * Text-mode notes under a quote table: one line per distinct failure reason (with the crypto board
 * pointer when a failed symbol is a crypto pair, unless nothing could be reached), then a line for each bare coin ticker that
 * resolved to something else. `--exchange` names the listing on purpose, so it gets no coin note.
 */
export function quoteNotes(results: QuoteNoteResult[], options: { exchange?: string } = {}): string[] {
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
  if (!options.exchange) {
    for (const result of results) {
      const note = notTheCoinNote(result.target.symbol, result.quote);
      if (note) notes.push(note);
    }
  }
  const perpetuals = results
    .filter((result) => result.quote && isCryptoVenuePerpetual(result.quote.instrumentType, result.quote.name))
    .map((result) => result.target.symbol);
  if (perpetuals.length > 0) {
    notes.push(`${perpetuals.join(", ")}: perpetual futures ${perpetuals.length === 1 ? "price" : "prices"} on crypto venues, 24/7; not the listed future, not spot.`);
  }
  return notes;
}
