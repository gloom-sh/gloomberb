import { isCryptoInstrumentType } from "../../tickers/search/ranking";
import type { Quote } from "../../types/financials";
import { isCryptoPairSymbol } from "../../utils/crypto-pair";

/** Where a crypto pair that will not load can still be read. `fn CRYP` takes no argument. */
export const CRYPTO_BOARD_HINT = "Crypto prices may be briefly unavailable; the CRYP function (gloomberb fn CRYP) shows the crypto board.";

// The coins whose bare ticker is most often typed for the coin itself. The label is how the note
// names the coin and what a listing's name has to say before the note applies.
const MAJOR_COINS = new Map([
  ["BTC", "bitcoin"],
  ["ETH", "ethereum"],
  ["SOL", "solana"],
  ["XRP", "XRP"],
  ["DOGE", "dogecoin"],
  ["ADA", "cardano"],
  ["LTC", "litecoin"],
  ["BCH", "bitcoin cash"],
  ["AVAX", "avalanche"],
  ["DOT", "polkadot"],
  ["LINK", "chainlink"],
  ["BNB", "BNB"],
]);

/**
 * A bare coin ticker usually resolves to a listed fund, not the coin. The note applies only when
 * the listing is not crypto and its own name says the coin (a "Bitcoin" trust), so a company that
 * happens to share the letters (Interlink Electronics on LINK) is left alone.
 */
function notTheCoinNote(symbol: string, quote: Pick<Quote, "name" | "instrumentType"> | null | undefined): string | null {
  const coin = MAJOR_COINS.get(symbol);
  const type = quote?.instrumentType?.trim();
  const name = quote?.name?.trim();
  if (!coin || !name || !type || isCryptoInstrumentType(type)) return null;
  if (!new RegExp(`\\b${coin}\\b`, "i").test(name)) return null;
  return `${symbol} is ${name}, not ${coin}. For ${coin} use ${symbol}-USD.`;
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
 * pointer when a failed symbol is a crypto pair), then a line for each bare coin ticker that
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
    `${symbols.join(", ")}: ${reason}${symbols.some(isCryptoPairSymbol) ? `${/[.!?]$/.test(reason) ? "" : "."} ${CRYPTO_BOARD_HINT}` : ""}`
  ));
  if (!options.exchange) {
    for (const result of results) {
      const note = notTheCoinNote(result.target.symbol, result.quote);
      if (note) notes.push(note);
    }
  }
  return notes;
}
