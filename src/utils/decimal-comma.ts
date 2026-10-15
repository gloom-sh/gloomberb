const DECIMAL_COMMA = /^([+-]?\d+),(\d+)$/;
/** `1,234` and `95,000` are far likelier a thousands comma than a decimal one. */
const THOUSANDS_COMMA = /^[+-]?\d{1,3},\d{3}$/;

/** What `4,5` typed where a number is read means, as a dotted number (`4.5`); null for any other text, and for a thousands comma. */
export function dottedDecimal(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  const match = THOUSANDS_COMMA.test(text) ? null : DECIMAL_COMMA.exec(text);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * The message for a value that is not a number. A decimal comma gets the dotted
 * number to type instead: "Coupon must be a number; use a dot: 4.5".
 */
export function numberErrorMessage(message: string, value: unknown): string {
  const dotted = dottedDecimal(value);
  return dotted == null ? message : `${message.replace(/\.$/, "")}; use a dot: ${dotted}`;
}

const DECIMAL_COMMA_RANGE = /^([+-]?\d+(?:,\d+)?)\s*(-|to|\.\.)\s*([+-]?\d+(?:,\d+)?)$/i;

/**
 * A range typed with decimal commas, `0,80-0,90`, as the dotted range to type
 * instead (`0.80-0.90`); null when neither end has a decimal comma.
 */
function dottedDecimalRange(value: unknown): string | null {
  const match = DECIMAL_COMMA_RANGE.exec(typeof value === "string" ? value.trim() : "");
  if (!match || !`${match[1]}${match[3]}`.includes(",")) return null;
  return `${match[1]!.replace(",", ".")}${match[2]}${match[3]!.replace(",", ".")}`;
}

/** `numberErrorMessage` for a range of two numbers: "... got "0,80-0,90"; use a dot: 0.80-0.90". */
export function rangeErrorMessage(message: string, value: unknown): string {
  const dotted = dottedDecimalRange(value);
  return dotted == null ? message : `${message.replace(/\.$/, "")}; use a dot: ${dotted}`;
}

/** What a number pasted from a sheet reads as. */
export type PastedNumber =
  | { kind: "number"; value: number }
  /** A comma and exactly three digits (`1,350`) could be thousands or a decimal comma, and nothing says which. */
  | { kind: "ambiguous"; thousands: number; decimal: number }
  | { kind: "invalid" };

const INVALID: PastedNumber = { kind: "invalid" };
/** Digits with the marks a sheet or a European keyboard puts between them: a dot, a comma, and the spaces that group thousands. */
const PASTED_NUMBER = /^([+-]?)(\d[\d.,\u00a0\u2009\u202f ]*\d)$/;
const SPACES = /[\u00a0\u2009\u202f]/g;

/**
 * Reads a number as a sheet or a European keyboard writes it: `1,350.5`,
 * `1.350,5` and `1 350,5` (a space or no-break space groups) are 1350.5, and
 * `1,350,000` and `1.350.000` are 1350000. The last mark is the decimal one
 * when the text shows it is not grouping; the marks before it group
 * thousands, in threes, all of one kind. A comma and exactly three digits
 * (`1,350`) could be either, so it is `ambiguous` and names both readings.
 * A plain dotted number is what it says, `1.350` is 1.35. Anything else that
 * is not a number is `invalid`.
 */
export function parsePastedNumber(value: unknown): PastedNumber {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return INVALID;
  const plain = Number(text);
  if (Number.isFinite(plain)) return { kind: "number", value: plain };
  const match = PASTED_NUMBER.exec(text);
  if (!match) return INVALID;
  const sign = match[1] === "-" ? -1 : 1;
  const body = match[2]!.replace(SPACES, " ");
  const marks = body.replace(/\d/g, "");
  const last = marks.at(-1)!;
  const at = body.lastIndexOf(last);
  const before = body.slice(0, at);
  const after = body.slice(at + 1);

  if (marks.length === 1 && last === "," && after.length === 3 && /^[1-9]\d{0,2}$/.test(before)) {
    return { kind: "ambiguous", thousands: sign * Number(`${before}${after}`), decimal: sign * Number(`${before}.${after}`) };
  }
  // The last mark is the decimal one unless it repeats an earlier mark (1.350.000) or is a space (1 350).
  const decimal = last !== " " && (marks.length === 1 || [...marks].some((mark) => mark !== last));
  const integer = decimal ? before : body;
  const grouping = new Set(integer.replace(/\d/g, ""));
  if (grouping.size > 1 || (decimal && grouping.has(last))) return INVALID;
  if (decimal && !/^\d+$/.test(after)) return INVALID;
  const [mark] = grouping;
  if (mark && !new RegExp(`^[1-9]\\d{0,2}(?:[${mark}]\\d{3})+$`).test(integer)) return INVALID;
  const number = Number(`${integer.replace(/\D/g, "")}${decimal ? `.${after}` : ""}`);
  return Number.isFinite(number) ? { kind: "number", value: sign * number } : INVALID;
}

/** What to tell someone whose number could be read two ways: both readings, and what to type for each. */
export function ambiguousNumberMessage(text: string, reading: { thousands: number; decimal: number }): string {
  return `${text.trim()} could be ${reading.thousands} (thousands) or ${reading.decimal} (decimal comma); type ${reading.thousands} or ${reading.decimal}`;
}

/** What a dot and exactly three digits after one to three (`81.000`, `81.250`) could mean. */
export interface ThousandsDotReadings {
  /** The number as written, the dot a decimal point: 81. */
  decimal: number;
  /** The dot as many locales write it, between thousands: 81000. */
  thousands: number;
}

const THOUSANDS_DOT = /^([+-]?)([1-9]\d{0,2})\.(\d{3})$/;

/** Both readings of `81.000`; null for any other text, which has one. */
export function thousandsDotReadings(value: unknown): ThousandsDotReadings | null {
  const match = THOUSANDS_DOT.exec(typeof value === "string" ? value.trim() : "");
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return { decimal: sign * Number(`${match[2]}.${match[3]}`), thousands: sign * Number(`${match[2]}${match[3]}`) };
}

/**
 * Whether a dot and three digits was meant as a thousands separator, beside a
 * price it must be near (the last price): the number as written is more than
 * 90% away from it, while the thousands reading lands within 10%. A plain
 * dotted number otherwise keeps its meaning, and without a reference it is
 * read as written.
 */
export function meantThousandsDot(readings: ThousandsDotReadings, reference: number | null | undefined): boolean {
  if (reference == null || !Number.isFinite(reference) || reference === 0) return false;
  const scale = Math.abs(reference);
  return Math.abs(readings.decimal - reference) * 10 > scale * 9 && Math.abs(readings.thousands - reference) * 10 <= scale;
}
