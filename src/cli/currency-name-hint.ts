import { currenciesNamed } from "../utils/currency-names";
import { dollarPairListing } from "../utils/currency-pair";

/** A currency a name typed in words stands for, and its pair against the dollar as a listing. */
export interface NamedCurrencyPair {
  /** The words as typed: `swiss franc`. */
  typed: string;
  code: string;
  /** USDCHF=X for the franc, EURUSD=X for the euro. */
  pair: string;
}

/**
 * The one currency words name (`swiss franc` is CHF, `yen` JPY) with its
 * pair against the dollar. Null for words that name none, several (`peso`)
 * or the dollar itself, which has no pair of its own.
 */
export function namedCurrencyPair(typed: string): NamedCurrencyPair | null {
  const words = typed.trim().replace(/\s+/g, " ");
  if (!words || /[^\p{L}\s.'-]/u.test(words)) return null;
  const named = currenciesNamed(words);
  const code = named.length === 1 ? named[0]!.code : null;
  return code && code !== "USD" ? { typed: words, code, pair: dollarPairListing(code) } : null;
}

/** "swiss franc is a currency (CHF), not a ticker.", then what to run: `gloom fx CHF` for its rate, `gloom history USDCHF=X` for its pair. */
function currencyStop(named: NamedCurrencyPair, command: string): { message: string; details: string } {
  return {
    message: `${named.typed} is a currency (${named.code}), not a ticker.`,
    details: `Its rate: gloom fx ${named.code}\nIts pair: gloom ${command} ${named.pair}`,
  };
}

/**
 * The stop for a symbol command given a currency's name in several words
 * (`history swiss franc`, `quote japanese yen`), which would otherwise read
 * each word as a symbol (SWISS, a Copenhagen listing). One word is a ticker
 * first (`history real` is The RealReal); `currencyNameMiss` names its
 * currency once it fails as one. Null for anything else.
 */
export function currencyNameStop(words: readonly string[], command: string): { message: string; details: string } | null {
  const typed = words.map((word) => word.trim()).filter(Boolean);
  if (typed.length === 0 || typed.some((word) => word.startsWith("-"))) return null;
  const phrase = typed.join(" ");
  if (!/\s/.test(phrase)) return null;
  const named = namedCurrencyPair(phrase);
  return named ? currencyStop(named, command) : null;
}

/** The stop for one word that failed as a symbol and names a currency (`history yen`), else null. */
export function currencyNameMiss(word: string, command: string): { message: string; details: string } | null {
  const named = namedCurrencyPair(word);
  return named ? currencyStop(named, command) : null;
}

/** The hint after "Not a ticker: YEN." for a word that names a currency: "Try `gloom fx JPY` for the yen's rate, or its pair USDJPY=X." */
export function currencyNameHint(typed: string): string | null {
  const named = namedCurrencyPair(typed);
  return named ? `Try \`gloom fx ${named.code}\` for the ${named.typed}'s rate, or its pair ${named.pair}.` : null;
}
