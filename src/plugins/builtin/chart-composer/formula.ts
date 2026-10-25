import { currencyPairSpelling } from "../../../utils/currency-pair";
import { dashedCoinPair } from "../../../utils/crypto-pair";
import { GALLONS_PER_BARREL, isBarrelsPerTonne } from "../../../time-series/price-units";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import { parseSeriesExpression, resolveChartFieldAlias, type ParsedSeriesExpression } from "./series-expression";
import { getTimeSeriesField } from "../../../time-series/field-catalog";

/**
 * Series formulas: a sum of series each times a number, the whole optionally
 * in brackets over or times numbers and series.
 *
 *   42*HO=F - CL=F                       heating-oil crack, USD per barrel
 *   HO=F*42 - BZ=F                       a multiplier on either side
 *   (2*42*RB=F + 42*HO=F - 3*CL=F)/3     3:2:1 crack, per barrel of crude
 *   (42*HO=F - BZ=F)/EURUSD=X            the crack in EUR per barrel
 *   7.45*42*HO=F - 7.45*BZ=F             a gasoil-style crack per tonne
 *
 * A literal 42 on a series is the 42 gallons of a barrel: it makes a price per
 * gallon a price per barrel. A literal 7.45 or 8.45 is the barrels in a tonne
 * of gasoil or gasoline: it makes a price per barrel a price per tonne. Any
 * other number is a count and keeps the unit. A series the whole formula is
 * divided or multiplied by changes its unit as the arithmetic does: over
 * EURUSD=X (USD per EUR), dollars are euros.
 *
 * Grammar, no other precedence to learn:
 *   formula := sum | "(" sum ")" { ( "/" | "*" ) factor }
 *   sum     := [ "+" | "-" ] term { ( "+" | "-" ) term }
 *   term    := factor { ( "*" | "×" ) factor }     with exactly one series
 *   factor  := number | series
 */

interface FormulaLeg {
  series: ParsedSeriesExpression;
  /** What the leg's value is multiplied by, its sign included. */
  weight: number;
  /** The leg was multiplied by a literal 42: the gallons in a barrel. */
  perBarrel: boolean;
  /** The barrels in a tonne the leg was multiplied by (7.45 or 8.45), or null. */
  perTonne: number | null;
  /** The leg as written: `HO=F`. */
  text: string;
}

/** A series the whole formula is multiplied (power 1) or divided (-1) by. */
interface FormulaFactor {
  series: ParsedSeriesExpression;
  power: 1 | -1;
  /** The series as written: `EURUSD=X`. */
  text: string;
}

export interface ParsedFormula {
  legs: FormulaLeg[];
  /** What the whole sum is divided by; 1 when it is not. */
  divisor: number;
  /** The series the whole sum is then multiplied or divided by, in the order written. */
  factors: FormulaFactor[];
}

const EXAMPLE = "(2*42*RB=F + 42*HO=F - 3*CL=F)/3";
const SCALED_EXAMPLE = "(42*HO=F - BZ=F)/EURUSD=X";

type Token =
  | { kind: "number"; value: number; text: string }
  | { kind: "atom"; text: string }
  | { kind: "*" | "+" | "-" | "(" | ")" | "/"; text: string };

const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Whether text that is neither one series, a list nor a pair is written as a
 * formula, so its error explains the formula instead of an invalid series.
 */
export function looksLikeFormula(expression: string): boolean {
  return /[*×+()]/.test(expression) || /\s-\s|^\s*-/.test(expression);
}

const LISTING = /=[FX]$/i;

/**
 * A tight `-` subtracts after a futures or FX listing, a number or a bracket;
 * elsewhere it is part of a ticker (BRK-B). A listing may carry its exchange
 * or a field (HO=F:NYM-CL=F:NYM), unless the hyphen goes on to spell a field
 * (GC=F:gross-margin).
 */
function minusIsOperator(atom: string, previous: Token | undefined, rest: string): boolean {
  if (!atom) return !previous || previous.kind !== "atom";
  if (LISTING.test(atom) || NUMBER.test(atom)) return true;
  const parts = atom.split(":");
  if (parts.length < 2 || !LISTING.test(parts[0]!) || !parseSeriesExpression(atom)) return false;
  const words = rest.match(/^[^\s*×+()/:]*/)![0].split("-");
  return !words.some((_, index) => getTimeSeriesField(resolveChartFieldAlias(
    [parts.at(-1)!, ...words.slice(0, index + 1)].join("-"),
  )));
}

/**
 * After the formula's closing bracket every `/` divides, except inside a
 * currency or coin pair written with one: `(...)/EUR/USD` is over EUR/USD.
 */
function slashIsPairSpelling(atom: string, rest: string): boolean {
  const quote = rest.match(/^[^\s*×+()/]*/)![0];
  const symbol = `${atom}/${quote.split(":")[0]}`;
  return /^[A-Za-z]{3,}$/.test(atom) && !!quote && (!!currencyPairSpelling(symbol) || !!dashedCoinPair(symbol));
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let atom = "";
  let closed = false;
  const flush = () => {
    if (!atom) return;
    tokens.push(NUMBER.test(atom) ? { kind: "number", value: Number(atom), text: atom } : { kind: "atom", text: atom });
    atom = "";
  };
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
    if (/\s/.test(char)) {
      flush();
    } else if (char === "*" || char === "×" || char === "+" || char === "(" || char === ")") {
      flush();
      if (char === ")") closed = true;
      tokens.push({ kind: char === "×" ? "*" : char, text: char });
    } else if (char === "-" && (minusIsOperator(atom, tokens.at(-1), expression.slice(index + 1)) || /\s/.test(expression[index - 1] ?? " "))) {
      flush();
      tokens.push({ kind: "-", text: char });
    } else if (char === "/" && (!atom || (closed && !slashIsPairSpelling(atom, expression.slice(index + 1))))) {
      // A slash on its own divides; inside a word it is part of a pair (EUR/USD), until the brackets close.
      flush();
      tokens.push({ kind: "/", text: char });
    } else {
      atom += char;
    }
  }
  flush();
  return tokens;
}

function fail(message: string): never {
  throw new Error(message);
}

/** A leg's series, or why it cannot be one. */
function legSeries(text: string): ParsedSeriesExpression {
  const symbol = text.split(":")[0]!;
  if (symbol.includes("/") && !currencyPairSpelling(symbol) && !dashedCoinPair(symbol)) {
    fail(`"${text}" divides inside the formula. Divide the whole formula in brackets by a number or a series, as in ${SCALED_EXAMPLE}; chart a ratio of two series as A / B on its own.`);
  }
  return parseSeriesExpression(text)
    ?? fail(`"${text}" is not a series. Use SYMBOL, SYMBOL:field, FUT:code, UST:maturity, FRED:series, GEO:series or CAP:capability-id:series-id.`);
}

/**
 * The legs, multipliers and divisor of a series formula; null for text that
 * is not written as one. Text that is, but is not a formula Gloom can chart,
 * throws an error that says how to write it.
 */
export function parseFormulaExpression(expression: string): ParsedFormula | null {
  const trimmed = expression.trim();
  if (!trimmed || !looksLikeFormula(trimmed)) return null;
  if (/[;,\n]/.test(trimmed)) {
    const formula = trimmed.split(/[;,\n]/).map((part) => part.trim()).find(looksLikeFormula) ?? trimmed;
    fail(`A formula charts on its own, not in a list: chart ${formula} by itself.`);
  }
  const tokens = tokenize(trimmed);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  let bracketed = false;
  if (peek()?.kind === "(") {
    bracketed = true;
    take();
  }
  const opens = tokens.filter((token) => token.kind === "(").length;
  const closes = tokens.filter((token) => token.kind === ")").length;
  if (opens !== closes) fail(`The brackets in "${trimmed}" do not pair up.`);
  if (opens > 1 || (opens === 1 && !bracketed)) {
    fail(`Brackets go around the whole formula only, then divide or multiply it: ${EXAMPLE}, ${SCALED_EXAMPLE}.`);
  }

  const legs: FormulaLeg[] = [];
  let sign = 1;
  let expectTerm = true;
  const leading = peek();
  if (leading?.kind === "+" || leading?.kind === "-") {
    sign = leading.kind === "-" ? -1 : 1;
    take();
  }
  while (position < tokens.length && peek()!.kind !== ")") {
    // One term: numbers and exactly one series, multiplied.
    let weight = sign;
    let perBarrel = false;
    let perTonne: number | null = null;
    const factors: Token[] = [];
    for (;;) {
      const factor = take();
      if (!factor || (factor.kind !== "number" && factor.kind !== "atom")) {
        const after = factors.at(-1)?.text ?? tokens[position - 2]?.text;
        fail(factor
          ? `Expected a number or a series${after ? ` after "${after}"` : ""}, not "${factor.text}".`
          : `The formula ends with "${tokens.at(-1)?.text}"; add the series it applies to.`);
      }
      factors.push(factor);
      if (factor.kind === "number") {
        if (factor.value === 0) fail("A multiplier of 0 removes its series; leave the term out instead.");
        if (factor.value === GALLONS_PER_BARREL && !perBarrel) perBarrel = true;
        else if (isBarrelsPerTonne(factor.value) && perTonne === null) perTonne = factor.value;
        weight *= factor.value;
      }
      if (peek()?.kind !== "*") break;
      take();
    }
    const series = factors.filter((factor) => factor.kind === "atom");
    const written = factors.map((factor) => factor.text).join("*");
    if (series.length === 0) {
      fail(`${written} is a number with no series: each term multiplies one series, such as 42*HO=F.`);
    }
    if (series.length > 1) {
      fail(`${written} multiplies two series. Each term is one series times numbers, such as 42*HO=F.`);
    }
    const text = series[0]!.text;
    const parsed = legSeries(text);
    if (legs.some((leg) => leg.text.toUpperCase() === text.toUpperCase())) {
      fail(`${text} appears twice. Write it once with its combined multiplier, such as 2*${text}.`);
    }
    legs.push({ series: parsed, weight, perBarrel, perTonne, text });
    expectTerm = false;

    const next = peek();
    if (!next || next.kind === ")") break;
    if (next.kind !== "+" && next.kind !== "-") {
      fail(next.kind === "/"
        ? `Divide the whole formula in brackets by a number or a series, as in ${SCALED_EXAMPLE}.`
        : `Expected + or - after ${written}, not "${next.text}".`);
    }
    take();
    sign = next.kind === "-" ? -1 : 1;
    expectTerm = true;
  }
  if (expectTerm) {
    fail(legs.length === 0 ? `"${trimmed}" has no series to chart.` : `The formula ends with "${tokens.at(-1)?.text}"; add the series it applies to.`);
  }

  let divisor = 1;
  const scaleFactors: FormulaFactor[] = [];
  if (bracketed) {
    if (take()?.kind !== ")") fail(`The brackets in "${trimmed}" do not pair up.`);
    while (peek()?.kind === "/" || peek()?.kind === "*") {
      const divides = take()!.kind === "/";
      const value = take();
      if (!value || (value.kind !== "number" && value.kind !== "atom")) {
        fail(`${divides ? "Divide" : "Multiply"} the whole formula by a number or a series, such as ${divides ? "/3 or /EURUSD=X" : "*7.45 or *EURUSD=X"}${value ? `, not ${value.text}` : ""}.`);
      }
      if (value.kind === "number") {
        if (value.value === 0) fail(divides ? "A formula cannot be divided by 0." : "A multiplier of 0 removes the formula; leave it out instead.");
        if (divides) {
          divisor *= value.value;
        } else {
          // A number times the whole sum multiplies each leg, converting its unit as it would there.
          for (const leg of legs) {
            if (value.value === GALLONS_PER_BARREL && !leg.perBarrel) leg.perBarrel = true;
            else if (isBarrelsPerTonne(value.value) && leg.perTonne === null) leg.perTonne = value.value;
            leg.weight *= value.value;
          }
        }
        continue;
      }
      const text = value.text;
      if ([...legs, ...scaleFactors].some((entry) => entry.text.toUpperCase() === text.toUpperCase())) {
        fail(`${text} appears twice in the formula. Use each series once.`);
      }
      scaleFactors.push({ series: legSeries(text), power: divides ? -1 : 1, text });
    }
  }
  const rest = tokens.slice(position);
  if (rest.length > 0) {
    fail(rest[0]!.kind === "/" || rest[0]!.kind === "*"
      ? `Divide or multiply the whole formula in brackets, as in ${EXAMPLE} or ${SCALED_EXAMPLE}.`
      : `Unexpected "${rest.map((token) => token.text).join(" ")}" after the formula.`);
  }
  if (legs.length + scaleFactors.length > MAX_CHART_COMPOSER_SERIES) {
    fail(`A formula takes up to ${MAX_CHART_COMPOSER_SERIES} series.`);
  }
  return { legs, divisor, factors: scaleFactors };
}
