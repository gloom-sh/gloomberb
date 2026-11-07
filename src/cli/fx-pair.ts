import { currencyMinorDigits } from "../market-data/market/format";
import { parseTypedNumber, readConvertedAmount } from "../utils/decimal-comma";
import { currenciesNamed } from "../utils/currency-names";
import { currencyPairSpelling, fxFigureText, fxRateDigits, quotedFxPair } from "../utils/currency-pair";

/**
 * What `gloom fx` is asked for. A bare code is one unit of it in the base
 * currency (`NGN`: USD per 1 NGN). A pair is market convention, BASE/QUOTE:
 * `USD/NGN` is how many NGN one USD buys, and `ZAR/NGN` a cross of two codes
 * with neither in USD.
 */
export interface FxRequest {
  /** The currency one unit of which is priced: NGN in `NGN`, USD in `USD/NGN`. */
  currency: string;
  /** The currency the price is in: the base currency for a bare code, the quote of a pair. */
  baseCurrency: string;
  /** Each currency typed as its name (`yen`) and the code it was read as, said beside the answer. */
  readAs?: string[];
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

let knownCurrencies: ReadonlySet<string> | undefined;

/** An ISO 4217 code the runtime lists, or the offshore yuan it has none for. */
function isKnownCurrency(code: string): boolean {
  if (!knownCurrencies) {
    try {
      knownCurrencies = new Set([...Intl.supportedValuesOf("currency"), "CNH"]);
    } catch {
      knownCurrencies = new Set();
    }
  }
  return knownCurrencies.has(code);
}

/**
 * A currency typed as its name: the code a name that is one currency's reads
 * as, or the sentence listing the currencies a name several share (`peso`),
 * with `retry` the argument that asks for the first of them. Null for text
 * that names none.
 */
function readCurrencyName(typed: string, retry: (code: string) => string): { code: string } | { error: string } | null {
  const named = currenciesNamed(typed);
  if (named.length === 0) return null;
  if (named.length === 1) return { code: named[0]!.code };
  const choices = named.map(({ code, qualifier }) => (qualifier ? `${code} (${qualifier})` : code)).join(", ");
  return { error: `${typed} names several currencies: ${choices}. Write one as its code, such as fx ${retry(named[0]!.code)}.` };
}

/**
 * A pair written as `quote` takes one, without a slash: EURUSD, eur-usd,
 * EURUSD=X, EURUSD:CCY and JPY=X (USD/JPY). Null for anything else.
 */
function spelledPair(text: string): FxRequest | null {
  if (/^[A-Z]{3}$/.test(text)) return null;
  const spelling = currencyPairSpelling(text);
  const match = spelling ? /^([A-Z]{3})([A-Z]{3})=X$/.exec(spelling.symbol) : null;
  return match ? { currency: match[1]!, baseCurrency: match[2]! } : null;
}

/** Whether `fx` reads the argument as a pair spelled without its slash (`spelledPair`). */
function isSpelledFxPair(raw: string): boolean {
  return spelledPair(raw.trim().toUpperCase()) != null;
}

/** The request, or the sentence saying what is wrong with the argument. */
export function parseFxRequest(raw: string, baseCurrency: string): FxRequest | { error: string } {
  const typed = raw.trim().split("/").map((part) => part.trim());
  const text = raw.trim().toUpperCase();
  const parts = typed.map((part) => part.toUpperCase());
  if (parts.length > 2 || parts.some((part) => !part)) return { error: `"${raw}" is not a currency or a pair such as USD/NGN.` };
  // The pair spellings `quote` takes: EURUSD, eur-usd, EURUSD=X.
  const spelled = parts.length === 1 ? spelledPair(text) : null;
  if (spelled) return spelled;
  // A name (peso, yen, Swiss franc) is a currency's code. Three letters that are a code stay one: only a name that is no code reads as one.
  const readAs: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (isKnownCurrency(part)) continue;
    const named = readCurrencyName(typed[index]!, (code) => parts.map((other, at) => at === index ? code : other).join("/"));
    if (!named) continue;
    if ("error" in named) return named;
    readAs.push(`Read ${typed[index]} as ${named.code}.`);
    parts[index] = named.code;
  }
  const bad = parts.filter((part) => !CURRENCY_CODE.test(part));
  if (bad.length > 0) return { error: `${bad.join(" and ")} ${bad.length > 1 ? "are not currency codes" : "is not a currency code"}; use three letters such as NGN.` };
  const request = parts.length === 2
    ? { currency: parts[0]!, baseCurrency: parts[1]! }
    : { currency: parts[0]!, baseCurrency: baseCurrency.trim().toUpperCase() };
  return readAs.length > 0 ? { ...request, readAs } : request;
}

/** What `gloom fx` is asked for, with the amount to convert when one comes first. */
export interface FxArgs {
  request: FxRequest;
  /** The amount of `currency` to convert into `baseCurrency`; absent for a rate alone. */
  amount?: number;
  /** One currency after an amount names no target, so it converts to USD; the answer says so. */
  toUsdByDefault?: boolean;
}

/** Every form `fx` takes, for its usage line. */
export const FX_USAGE = "fx <currency> | fx <base>/<quote> | fx <amount> <from>/<to> | fx <amount> <from> <to> [--date <day>]";

/** A currency's name of several words (`hong kong dollar`, `100 swiss franc`) as the one argument it is. */
function joinNameWords(args: readonly string[]): readonly string[] {
  const amount = args.length > 2 && parseTypedNumber(args[0]).kind !== "invalid" ? 1 : 0;
  const name = args.slice(amount).join(" ");
  return args.length - amount > 1 && currenciesNamed(name).length > 0 ? [...args.slice(0, amount), name] : args;
}

/**
 * `fx` arguments: a currency or a pair (`EUR`, `USD/NGN`), or an amount and
 * what to convert it from and to (`1234.5 EUR/USD`, `1234,5 EUR USD`). The
 * amount is an amount of the first currency (`readConvertedAmount`):
 * `1.234,5` and `1,234.5` are 1234.5. A lone comma or dot before exactly three
 * digits (`1,234`, `1.234`) is refused naming both readings, as `alerts add`
 * refuses `1,234`.
 * An amount and one currency converts to USD (`toUsdByDefault`). The error
 * sentence otherwise.
 */
export function parseFxArgs(words: readonly string[], baseCurrency: string): FxArgs | { error: string } {
  const args = joinNameWords(words);
  if (args.length === 1) {
    const request = parseFxRequest(args[0]!, baseCurrency);
    if (!("error" in request)) return { request };
    // A lone number is an amount with nothing to convert it from.
    return parseTypedNumber(args[0]).kind === "invalid"
      ? request
      : { error: `fx ${args[0]!.trim()} names no currency; convert an amount as fx ${args[0]!.trim()} EUR/USD.` };
  }
  if (args.length === 0 || args.length > 3) {
    return { error: `fx takes a currency, a pair, or an amount and a pair (fx 1234.5 EUR/USD); got ${args.length} arguments.` };
  }
  const typed = args.map((arg) => arg.trim());
  const [first, ...codes] = typed;
  if (parseTypedNumber(first).kind === "invalid") {
    // The amount typed after the pair (fx EUR/USD 100) belongs in front.
    if (parseTypedNumber(typed.at(-1)).kind === "number") {
      return { error: `Put the amount first: fx ${[typed.at(-1), ...typed.slice(0, -1)].join(" ")}.` };
    }
    // Two codes are one pair (fx NGN ZAR is NGN/ZAR), never two answers.
    const pair = typed.length === 2 && typed.every((arg) => /^[A-Za-z]{3}$/.test(arg)) ? typed.join("/").toUpperCase() : "EUR/USD";
    return { error: `fx takes one currency or pair; got ${typed.join(" ")}. Write a pair as ${pair}, or convert an amount as fx 1234.5 ${pair}.` };
  }
  const toUsdByDefault = codes.length === 1 && !codes[0]!.includes("/") && !isSpelledFxPair(codes[0]!);
  const request = parseFxRequest(codes.join("/"), "USD");
  if ("error" in request) return request;
  // 1,234 and 1.234 could each be either reading, whatever the currency.
  let amount: number;
  try {
    amount = readConvertedAmount(first, "The amount", request.currency);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { request, amount, ...(toUsdByDefault ? { toUsdByDefault } : {}) };
}

/**
 * An amount in its currency's minor units, grouped (1,234.50 EUR; 1,235 JPY).
 * One too small for them keeps six significant figures instead of reading 0.
 */
export function formatFxAmount(amount: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  const rounded = Number(amount.toFixed(digits));
  if (rounded === 0 && amount !== 0) return `${formatFxRate(amount)} ${currency}`;
  const text = amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${text} ${currency}`;
}

/** `1,234.50 EUR = 1,383.47 USD`: the amount and what it converts to at the rate. */
export function describeFxConversion(request: FxRequest, amount: number, rate: number): string {
  return `${formatFxAmount(amount, request.currency)} = ${formatFxAmount(amount * rate, request.baseCurrency)}`;
}

/**
 * The rate of `currency` in `baseCurrency` from each one's USD value (USD per
 * unit), the way every cross is built. NaN when a leg is missing or unusable.
 */
export function crossRate(currencyInUsd: number | null | undefined, baseInUsd: number | null | undefined): number {
  if (!isUsableRate(currencyInUsd) || !isUsableRate(baseInUsd)) return Number.NaN;
  return currencyInUsd / baseInUsd;
}

export function isUsableRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A rate to six significant digits, so a tiny one keeps its figures
 * (0.000752791) and float noise goes; from 1000 up, to the cent (1328.39).
 * Never in exponent notation, and without trailing zeros.
 */
export function formatFxRate(rate: number): string {
  if (!Number.isFinite(rate)) return String(rate);
  const size = Math.abs(rate);
  const decimals = size >= 1000 || size === 0 ? 2 : Math.min(15, Math.max(0, 5 - Math.floor(Math.log10(size))));
  const fixed = rate.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** The pair as markets quote it (USD/JPY for JPY/USD), its rate, and whether that is the direction asked for. */
function marketQuote(request: FxRequest, rate: number): { pair: string; rate: number; currency: string; direct: boolean } {
  const quoted = quotedFxPair(request.currency, request.baseCurrency, rate);
  return { pair: quoted.pair, rate: quoted.rate, currency: quoted.pair.slice(4), direct: quoted.pair === `${request.currency}/${request.baseCurrency}` };
}

/** A quote a rate is read from: its pair as markets write it and its figure as the source sent it (USD/JPY 157.848). */
export interface FxQuotedFigure {
  pair: string;
  figure: number;
}

/** The dollar pairs a cross is read from, each as sent: `via USD: USD/ZAR 16.13650, USD/NGN 1328.39`. */
export function describeFxLegs(legs: readonly FxQuotedFigure[]): string {
  return `via USD: ${legs.map(({ pair, figure }) => `${pair} ${fxFigureText(figure, pair.slice(4))}`).join(", ")}`;
}

/**
 * Both directions on one line: `1 NGN = 0.000752791 USD  (USD/NGN 1328.39)`.
 * The side that is the pair as markets quote it is that quote's figure as
 * sent, with at least the pair's decimals (EUR/USD 1.12650, USD/JPY
 * 157.848, IDR/JPY 0.0096120): the rate a conversion multiplies or divides
 * by, never a rounded one. The other side is its inverse to six significant
 * digits. A cross (no `quoted` figure of its own) shows the pair's decimals,
 * and the dollar pairs it is read from are named beside it (`describeFxLegs`).
 */
export function describeFxRate(request: FxRequest, rate: number, quoted?: FxQuotedFigure): string {
  const head = `1 ${request.currency} =`, pair = `${request.baseCurrency}/${request.currency}`;
  if (request.currency === request.baseCurrency || !isUsableRate(rate)) {
    return `${head} ${formatFxRate(rate)} ${request.baseCurrency}  (${pair} ${formatFxRate(1 / rate)})`;
  }
  const market = marketQuote(request, rate);
  const quotedText = quoted && quoted.pair === market.pair && isUsableRate(quoted.figure)
    ? fxFigureText(quoted.figure, market.currency)
    : market.rate.toFixed(fxRateDigits(market.currency, market.rate));
  const left = market.direct ? quotedText : formatFxRate(rate);
  const right = market.direct ? formatFxRate(1 / rate) : quotedText;
  return `${head} ${left} ${request.baseCurrency}  (${pair} ${right})`;
}
