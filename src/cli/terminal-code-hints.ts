import type { UnreadBloombergCode } from "../tickers/terminal-codes";
import { isCurrencyCode } from "../utils/currency-pair";
import { METAL_FRONT_MONTH, METAL_NAMES } from "./fx-quote-rate";
import { treasuryYieldHint, treasuryYieldTenor } from "./treasury-yields";

/**
 * The government yield curves the catalog charts (`CAP:bond-yield:<curve>-<tenor>`), by the
 * currency Bloomberg's generic bond codes name (GTJPY10Y) or the root of its benchmark index
 * (GJGB10, GDBR10, GUKG10, GCAN10YR), with the country the line names.
 */
const YIELD_CURVES: ReadonlyArray<{ curve: string; country: string; currencies: readonly string[]; index: RegExp }> = [
  { curve: "jp", country: "Japan's", currencies: ["JPY"], index: /^GJGB(\d{1,2})$/ },
  { curve: "de", country: "Germany's", currencies: ["DEM", "EUR"], index: /^GDBR(\d{1,2})$/ },
  { curve: "gb", country: "the UK's", currencies: ["GBP"], index: /^GUKG(\d{1,2})$/ },
  { curve: "ca", country: "Canada's", currencies: ["CAD"], index: /^GCAN(\d{1,2})YR$/ },
  { curve: "mx", country: "Mexico's", currencies: ["MXN"], index: /^GMXN(\d{1,2})YR$/ },
  { curve: "br", country: "Brazil's", currencies: ["BRL"], index: /^GEBR(\d{1,2})Y$/ },
];

/** Bloomberg's generic government bond code: GT, the currency, the tenor in years (GTJPY10Y, GTUSD2Y, GTDEM10YR). */
const GENERIC_BOND = /^GT([A-Z]{3})(\d{1,2})YR?$/;

/** The yield a Bloomberg bond code or benchmark index names, as the catalog series that charts it; null for any other. */
function yieldLine(code: string): string | null {
  const bond = GENERIC_BOND.exec(code);
  const [currency, years] = bond ? [bond[1]!, bond[2]!] : [null, null];
  if (currency === "USD") {
    const tenor = treasuryYieldTenor(`${Number(years)}y`);
    return tenor ? treasuryYieldHint(tenor) : null;
  }
  for (const { curve, country, currencies, index } of YIELD_CURVES) {
    const tenor = currency && currencies.includes(currency) ? years : index.exec(code)?.[1];
    if (tenor) return `${country} ${Number(tenor)}-year government yield: gloom fn G CAP:bond-yield:${curve}-${Number(tenor)}y.`;
  }
  return null;
}

/** "Spot gold is not quoted; GC=F is the front-month future.", for XAU, XAUUSD and XAUJPY. */
function metalLine(code: string): string | null {
  const metal = Object.keys(METAL_FRONT_MONTH).find((symbol) => code === symbol || (code.startsWith(symbol) && /^[A-Z]{3}$/.test(code.slice(3))));
  return metal ? `Spot ${METAL_NAMES[metal]!.toLowerCase()} is not quoted; ${METAL_FRONT_MONTH[metal]} is the front-month future.` : null;
}

/** The pair a currency code starts with (USDJPY of `USDJPY BGN`, `USDJPYV1M`), or null. */
function pairOf(code: string): { base: string; quote: string } | null {
  const pair = /^([A-Z]{3})([A-Z]{3})/.exec(code);
  if (!pair || pair[1] === pair[2] || !isCurrencyCode(pair[1]!) || !isCurrencyCode(pair[2]!)) return null;
  return { base: pair[1]!, quote: pair[2]! };
}

/**
 * Why a line written as a Bloomberg code that names nothing here
 * (`unreadBloombergCode`) is not quoted, and what has it instead: a
 * government bond's yield series, the Treasury yield an index is, the future
 * spot gold is priced from, a pair's spot rate beside its forwards and vols.
 * Starts with the line as typed, so a list's note names it once.
 */
export function unreadBloombergCodeMessage(read: UnreadBloombergCode): string {
  const { typed, code, yellowKey } = read;
  const root = code.split(" ")[0]!;
  if (yellowKey === "Govt" || yellowKey === "Index") {
    const tenor = /^USGG/.test(root) ? treasuryYieldTenor(root) : null;
    if (tenor) return `${typed} is Bloomberg's US ${tenor.label} Treasury yield, which has no quote here. ${treasuryYieldHint(tenor)}`;
    const line = yieldLine(root);
    if (yellowKey === "Govt") {
      return `${typed} is Bloomberg's code for a government bond, which is not quoted here. ${line
        ?? "Government yields: gloom catalog \"10Y government bond\"; US Treasuries: gloom fred DGS10."}`;
    }
    if (line) return `${typed} is Bloomberg's benchmark yield index, which has no quote here. ${line}`;
    return `${typed} is a Bloomberg index code no symbol here is read from. Try gloom search ${root}.`;
  }
  if (yellowKey === "Curncy") {
    const metal = metalLine(root);
    if (metal) return `${typed}: ${metal}`;
    const pair = pairOf(root);
    if (pair) {
      return `${typed} is not quoted here: Bloomberg's ${pair.base}/${pair.quote} forwards, option volatilities, risk reversals and pricing sources `
        + `are not carried. ${pair.base}/${pair.quote} spot: gloom quote ${pair.base}${pair.quote}=X.`;
    }
    return `${typed} is a Bloomberg currency code no symbol here is read from. Try gloom search ${root}.`;
  }
  return `${typed} is a Bloomberg commodity code no future here is rooted at. Try gloom search ${root.replace(/\d+$/, "")}.`;
}
