import { CENTRAL_BANKS, centralBankNames } from "../../utils/central-banks";

/**
 * A question about rates, curves or the macro calendar, answered without AI
 * by the three functions a rates desk reads together: CBR for the policy
 * rates, GC for the curves and ECO for the releases and decisions to come,
 * each run for the markets the question names.
 */

/** The word GC's argument takes for each market it has a curve for (`GC jgb`); the other markets have none. */
export const GC_CURVE_WORDS: Readonly<Record<string, string>> = {
  US: "ust", EA: "euro", DE: "bund", GB: "gilt", JP: "jgb", CA: "canada", MX: "mexico", BR: "brazil",
};

/** A market's government bonds by name, which ask about its curve. */
const BOND_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["treasury", "US"], ["treasuries", "US"], ["ust", "US"], ["tips", "US"], ["gilt", "GB"], ["gilts", "GB"], ["bund", "DE"], ["bunds", "DE"],
  ["jgb", "JP"], ["jgbs", "JP"], ["acgb", "AU"], ["acgbs", "AU"], ["mbono", "MX"], ["mbonos", "MX"], ["cetes", "MX"],
];

/** What people call a market besides its central bank's names and the place the board names it by. */
const MARKET_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["america", "US"], ["american", "US"], ["u.s.", "US"], ["usa", "US"], ["eurozone", "EA"], ["euro zone", "EA"], ["britain", "GB"],
  ["british", "GB"], ["germany", "DE"], ["german", "DE"], ["japanese", "JP"], ["australian", "AU"], ["aussie", "AU"], ["canadian", "CA"],
  ["chinese", "CN"], ["indian", "IN"], ["korea", "KR"], ["korean", "KR"], ["brazilian", "BR"], ["mexican", "MX"], ["swiss", "CH"],
  ["norwegian", "NO"], ["swedish", "SE"], ["turkish", "TR"], ["türkiye", "TR"], ["kiwi", "NZ"],
  ...BOND_WORDS,
];

/** Abbreviations that are other words in lower case ("tell us"), read only as written. */
const CASED_MARKET_WORDS: ReadonlyArray<readonly [RegExp, string]> = [[/\bUS\b/, "US"], [/\bUK\b/, "GB"]];

const BANKS = CENTRAL_BANKS.map((bank) => ({
  id: bank.id, names: centralBankNames(bank).map((name) => name.toLowerCase()), place: bank.place.toLowerCase(),
}));

const RATES = /\b(?:policy rates?|rate decisions?|central banks?|interest rates?|cash rate|bank rate|base rate|key rate|rate (?:hikes?|cuts?)|(?:cut|cuts|hike|hikes|raise|raises|lower|lowers)(?: interest| policy)? rates|monetary policy)\b/;
/**
 * A hike or a cut is a policy rate's only where the question names a market
 * or its bank ("Will the ECB cut?"): "Did UAL raise or cut its guidance?" is
 * a company's.
 */
const RATE_MOVES = /\b(?:hike[sd]?|hiking|cuts?|easing|tightening)\b/;
/** A dividend or earnings yield is a stock's, not a bond's. */
const CURVE = /(?<!(?:dividend|earnings|fcf) )\b(?:yields?|curves?|bonds?|govvies|2s10s|5s30s|\d+-?(?:y|yr|year)s?|tenors?|steepen\w*|flatten\w*|invert\w*|inversion)\b/;
/** The macro calendar by what it lists: "this week" alone is any question's week ("Why did airline stocks fall this week?"). */
const CALENDAR = /\b(?:calendar|releases?|cpi|inflation|gdp|payrolls?|nfp|pmis?|meetings?|economic data|macro data)\b/;
/** Macro figures by name; not "release" or "meeting", which a company has too. */
const MACRO = /\b(?:cpi|ppi|pce|inflation|gdp|payrolls?|nfp|pmis?|unemployment|jobless|recession|economy|economic data|macro data)\b/;
/** A bond's yield or a curve: a dividend or earnings yield is a stock's, and a tenor alone ("over 5 years") any question's. */
const BONDS = /(?<!(?:dividend|earnings|fcf) )\b(?:yields?|curves?|bonds?|govvies|2s10s|5s30s)\b/;

/** Where `name` first stands as a whole word or phrase in `text`; -1 when it does not. */
function wordAt(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").exec(text)?.index ?? -1;
}

/** The markets a question names, as the CBR board's codes (EA for the euro area), in the order it names them. */
export function questionMarkets(question: string): string[] {
  const text = question.toLowerCase();
  const first = new Map<string, number>();
  const add = (code: string, at: number) => {
    if (at >= 0 && at < (first.get(code) ?? Number.POSITIVE_INFINITY)) first.set(code, at);
  };
  for (const bank of BANKS) for (const name of [...bank.names, bank.place]) add(bank.id, wordAt(text, name));
  for (const [word, code] of MARKET_WORDS) add(code, wordAt(text, word));
  for (const [pattern, code] of CASED_MARKET_WORDS) add(code, pattern.exec(question)?.index ?? -1);
  return [...first].sort((left, right) => left[1] - right[1]).map(([code]) => code);
}

/** Whether a question asks about a policy rate, a central bank, government bonds or macro figures. */
function asksAboutRates(question: string, text: string): boolean {
  return RATES.test(text) || BANKS.some((bank) => bank.names.some((name) => wordAt(text, name) >= 0))
    || (RATE_MOVES.test(text) && questionMarkets(question).length > 0);
}

/**
 * Whether a question is the rates or macro desk's ("How has the RBNZ cash
 * rate moved?", "What did CPI do to bonds?"), where the words it writes in
 * capitals are banks, indices and indicators far more often than companies.
 */
export function asksAboutRatesOrMacro(question: string): boolean {
  const text = question.toLowerCase();
  return asksAboutRates(question, text) || BONDS.test(text) || BOND_WORDS.some(([word]) => wordAt(text, word) >= 0) || MACRO.test(text);
}

/** A function a rates question is answered with, and how to run it for the markets named. */
export interface RatesQuestionFunction {
  code: "CBR" | "GC" | "ECO";
  /** As `gloom fn` takes it after the code (`jgb`, `--tab world`, `JP,AU`); empty for none. */
  argument: string;
  /** As the command bar takes it after the code (`JGB`, `JP,AU`); empty for none. */
  input: string;
}

const RATES_FUNCTIONS = ["CBR", "GC", "ECO"] as const;

/**
 * CBR, GC and ECO for a question about policy rates, curves or the macro
 * calendar ("BoJ and RBA policy rates and JGB yields"), the ones it asks
 * about first; empty for any other question. A question about rates or
 * curves gets all three, run for the markets it names: GC on the one curve
 * named (`jgb`), else its world tab; ECO on the countries named (`JP,AU`).
 * A question about the calendar alone gets ECO, for the catalog to add to.
 */
export function ratesQuestionFunctions(question: string): RatesQuestionFunction[] {
  const text = question.toLowerCase();
  const markets = questionMarkets(question);
  const rates = asksAboutRates(question, text);
  const curve = CURVE.test(text) || BOND_WORDS.some(([word]) => wordAt(text, word) >= 0);
  const calendar = CALENDAR.test(text);
  const asked = RATES_FUNCTIONS.filter((code) => code === "CBR" ? rates : code === "GC" ? curve : calendar);
  if (asked.length === 0) return [];
  const codes = rates || curve ? [...asked, ...RATES_FUNCTIONS.filter((code) => !asked.includes(code))] : asked;
  const curves = markets.flatMap((code) => GC_CURVE_WORDS[code] ? [GC_CURVE_WORDS[code]] : []);
  // ECO lists the euro area's own releases as EU.
  const countries = markets.map((code) => code === "EA" ? "EU" : code).join(",");
  return codes.map((code): RatesQuestionFunction => {
    if (code === "GC") return curves.length === 1 ? { code, argument: curves[0]!, input: curves[0]!.toUpperCase() } : { code, argument: "--tab world", input: "" };
    if (code === "ECO") return { code, argument: countries, input: countries };
    return { code, argument: "", input: "" };
  });
}
