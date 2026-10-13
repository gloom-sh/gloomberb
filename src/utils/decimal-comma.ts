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
