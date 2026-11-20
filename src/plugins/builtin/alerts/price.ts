import { ambiguousNumberMessage, parsePastedNumber, type PastedNumber } from "../../../utils/decimal-comma";
import { isCurrencyCode } from "../../../utils/currency-pair";

const PRICE_SCALES = { k: 1e3, m: 1e6, b: 1e9 } as const;
/** A price typed with a scale after it: 81k, 1.5m. */
const SCALED_PRICE = /^([+-]?\d[\d.,]*)\s*([kmb])$/i;

/** What to type for an alert price, as the error for one that reads as none names it. */
const PRICE_FORMAT = "type 81000 or 81k";

const scaled = (value: number, scale: number) => Number((value * scale).toPrecision(15));

/** A dollar price's marks: `$757.75`, `US$ 1,000`, `757.75 USD`. */
const DOLLAR_LEAD = /^(?:US)?\$\s*/i;
const DOLLAR_TAIL = /\s*USD$/i;

/**
 * A price without the dollar marks it was typed with (`$757.75`, `US$ 1,000`,
 * `757.75 USD`), and whether it had one: a dollar price is written the US way,
 * so a comma in it groups thousands.
 */
function withoutDollarMark(text: string): { text: string; dollars: boolean } {
  const trimmed = text.trim();
  const bare = trimmed.replace(DOLLAR_LEAD, "").replace(DOLLAR_TAIL, "");
  return { text: bare, dollars: bare !== trimmed };
}

/** Whether a word is a dollar mark alone (`$`, `US$`, `USD`), as a shell splits `$ 757.75` or `757.75 USD`. */
export const isDollarMark = (word: string): boolean => /^(?:US\$|\$|USD)$/i.test(word.trim());

/**
 * A price as `parsePastedNumber` reads it, and `81k` is 81000: the scale
 * applies to either reading of a comma and three digits. A dollar price
 * (`$1,000`, `1,000 USD`) is written the US way, so its comma groups thousands
 * and it reads two ways no more.
 */
export function parseAlertPrice(text: string): PastedNumber {
  const { text: bare, dollars } = withoutDollarMark(text);
  const match = SCALED_PRICE.exec(bare);
  const scale = match ? PRICE_SCALES[match[2]!.toLowerCase() as keyof typeof PRICE_SCALES] : 1;
  const base = parsePastedNumber(match ? match[1] : bare);
  if (base.kind === "ambiguous" && dollars) return { kind: "number", value: scaled(base.thousands, scale) };
  if (!match) return base;
  if (base.kind === "number") return { kind: "number", value: scaled(base.value, scale) };
  if (base.kind === "ambiguous") return { kind: "ambiguous", thousands: scaled(base.thousands, scale), decimal: scaled(base.decimal, scale) };
  return base;
}

/**
 * An alert price as every way of adding an alert reads it (`parseAlertPrice`):
 * the number, or an error that names what to type. A comma before exactly
 * three digits (`81,000`) could be thousands or a decimal comma, so it throws
 * naming both readings rather than storing either; text that is no number
 * throws with an example.
 */
export function readAlertPrice(text: string): number {
  const price = parseAlertPrice(text);
  if (price.kind === "ambiguous") throw new Error(ambiguousNumberMessage(text, price));
  if (price.kind === "invalid") throw new Error(`Alert price must be a number, got "${text.trim()}"; ${PRICE_FORMAT}.`);
  return price.value;
}

/** A level in pence, as London lines trade: `70p`, `119.4p`. */
const PENCE_LEVEL = /^(\d[\d.,]*)\s*p$/i;

/** Whether a level is typed in pence (`70p`). */
export const isPenceLevel = (text: string): boolean => PENCE_LEVEL.test(text.trim());

const CURRENCY_LEVEL = /^(.*\d)\s+([A-Z]{3})$/i;

function currencySuffix(text: string): RegExpExecArray | null {
  const match = CURRENCY_LEVEL.exec(text);
  return match && isCurrencyCode(match[2]!.toUpperCase()) ? match : null;
}

export function hasAlertCurrency(text: string): boolean {
  return !!currencySuffix(text.trim()) || DOLLAR_LEAD.test(text.trim()) || DOLLAR_TAIL.test(text.trim());
}

/**
 * An alert level as typed: a price (`readAlertPrice`), or one in pence
 * (`70p`), kept in pounds as a London line's quote is (0.70) and marked so
 * the line it is set on can be held to pence.
 */
export function readAlertLevel(text: string): { price: number; pence?: true; currency?: string } {
  const typed = text.trim();
  const match = currencySuffix(typed);
  const currency = match?.[2]?.toUpperCase() ?? (hasAlertCurrency(typed) ? "USD" : undefined);
  if (currency) return { price: readAlertPrice(match && currency !== "USD" ? match[1]! : typed), currency };
  const pence = PENCE_LEVEL.exec(text.trim());
  if (!pence) return { price: readAlertPrice(text) };
  return { price: Number((readAlertPrice(pence[1]!) / 100).toPrecision(12)), pence: true };
}
