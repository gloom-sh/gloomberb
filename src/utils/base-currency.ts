import { currenciesNamed } from "./currency-names";
import { isCurrencyCode } from "./currency-pair";
import { isIsoCurrencyCode } from "./crypto-pair";

/**
 * Signs people write for a currency, as they read them: C$ and US$ as
 * Canadians and Americans write them, S$, NZ$, R$. These settle a sign the
 * runtime gives another currency too (C$ is also the cordoba's). The runtime
 * adds CA$, A$, HK$, €, £, ₹ and the rest, so a sign several currencies use
 * ($, ¥) names all of them.
 */
const EXTRA_SIGNS: ReadonlyArray<readonly [sign: string, code: string]> = [
  ["US$", "USD"], ["U$S", "USD"], ["C$", "CAD"], ["CAN$", "CAD"], ["AU$", "AUD"], ["S$", "SGD"], ["SG$", "SGD"],
  ["NZ$", "NZD"], ["R$", "BRL"], ["NT$", "TWD"], ["RMB", "CNY"], ["Fr", "CHF"], ["SFr", "CHF"], ["zł", "PLN"],
  ["kr", "SEK"], ["kr", "NOK"], ["kr", "DKK"], ["kr", "ISK"], ["Kč", "CZK"], ["Ft", "HUF"], ["RM", "MYR"],
  ["£", "GBP"], ["¥", "JPY"], ["¥", "CNY"],
  ["$", "USD"], ["$", "CAD"], ["$", "AUD"], ["$", "NZD"], ["$", "HKD"], ["$", "SGD"], ["$", "MXN"],
];

/** The most traded currencies, first among those a shared sign ($, ¥, kr) names. */
const SIGN_ORDER = ["USD", "EUR", "JPY", "GBP", "CNY", "CAD", "AUD", "CHF", "HKD", "SGD", "NZD", "MXN", "SEK", "NOK", "DKK"];

let signIndex: ReadonlyMap<string, readonly string[]> | undefined;

function signKey(sign: string): string {
  return sign.normalize("NFC").replace(/\s+/g, "").toUpperCase();
}

function signs(): ReadonlyMap<string, readonly string[]> {
  if (signIndex) return signIndex;
  const built = new Map<string, string[]>();
  const curated = new Set(EXTRA_SIGNS.map(([sign]) => signKey(sign)));
  const add = (sign: string, code: string, extra = false) => {
    const key = signKey(sign);
    // A code is its own spelling, not a sign: CHF reads as the code.
    if (!key || key === code || (!extra && curated.has(key))) return;
    const codes = built.get(key) ?? [];
    if (!codes.includes(code)) codes.push(code);
    built.set(key, codes);
  };
  const codes = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [];
  for (const code of codes) {
    if (!isCurrencyCode(code)) continue;
    for (const currencyDisplay of ["symbol", "narrowSymbol"] as const) {
      try {
        const sign = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay })
          .formatToParts(0).find((part) => part.type === "currency")?.value;
        if (sign) add(sign, code);
      } catch {
        // Intentional ignore: a code the runtime lists but cannot format has no sign to read.
      }
    }
  }
  for (const [sign, code] of EXTRA_SIGNS) add(sign, code, true);
  const rank = (code: string) => {
    const at = SIGN_ORDER.indexOf(code);
    return at < 0 ? SIGN_ORDER.length : at;
  };
  for (const codesForSign of built.values()) codesForSign.sort((left, right) => rank(left) - rank(right));
  signIndex = built;
  return built;
}

/** The currencies a name (`Canadian dollar`, `yen`) or a sign (`CA$`, `C$`, `€`) stands for, most traded first. */
function currenciesForNameOrSign(typed: string): string[] {
  const named = currenciesNamed(typed).map(({ code }) => code);
  if (named.length > 0) return named;
  return [...signs().get(signKey(typed.trim())) ?? []];
}

/** What a typed base currency is: its ISO 4217 code, or why it is none and the codes it may have meant. */
export type BaseCurrencyReading =
  | { code: string }
  | { error: string; suggestions: string[] };

/**
 * A base currency as `config set baseCurrency` takes it: an ISO 4217 code in
 * any case (`cad` is CAD). A currency's name or sign (`Canadian dollar`,
 * `CA$`) is refused with the code it stands for, so the setting is always a
 * code the conversions can price; so is a code that is no currency (XAU, XYZ).
 */
export function readBaseCurrency(typed: string): BaseCurrencyReading {
  const text = typed.trim();
  const upper = text.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && isCurrencyCode(upper)) return { code: upper };
  if (/^[A-Z]{3}$/.test(upper) && isIsoCurrencyCode(upper)) {
    return { error: `${upper} is a metal, drawing-right or test code, not a currency.`, suggestions: [] };
  }
  const suggestions = text ? currenciesForNameOrSign(text) : [];
  const shown = text ? JSON.stringify(text) : "An empty value";
  if (suggestions.length === 1) return { error: `${shown} is not a currency code. Did you mean ${suggestions[0]}?`, suggestions };
  if (suggestions.length > 1) {
    return { error: `${shown} is not a currency code; it can be ${suggestions.slice(0, 6).join(", ")}.`, suggestions };
  }
  return { error: `${shown} is not an ISO 4217 currency code.`, suggestions };
}

/**
 * A base currency as it was saved, as the setting reads it now: a code in
 * capitals, and a name or sign an older version stored (`Canadian dollar`,
 * `CA$`, `cad`) as the one code it stands for. Anything else stays as saved,
 * for `doctor` and `config get` to flag, rather than turning into USD.
 */
export function normalizeStoredBaseCurrency(value: string): string {
  const reading = readBaseCurrency(value);
  if ("code" in reading) return reading.code;
  return reading.suggestions.length === 1 ? reading.suggestions[0]! : value.trim();
}
