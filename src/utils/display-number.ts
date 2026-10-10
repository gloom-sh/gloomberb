/**
 * Reading back a number a table or report drew ("+1.25%", "1.20B", "$1,234.50"),
 * so a CSV export can write the number a spreadsheet uses and name the unit
 * in its header instead of in every cell.
 */

/** What a cell draws for a missing value: a dash, a run of dashes, or the loading ellipsis. */
export const DISPLAY_PLACEHOLDER = /^(?:[-\u2013\u2014]{1,3}|\u2026|\.\.\.)$/;

/**
 * A number as a table draws it: sign, currency symbol, thousands commas,
 * decimals, a compact scale (12.3k, 1.20B) and a unit (%, x, bp, USD, or c
 * for the cents grain futures quote in).
 */
const DISPLAY_NUMBER = /^([+-]?)([A-Z]{0,3}[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u20ab\u0e3f])?(?=\.?\d)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?([kKMBT])?(%|x|c|\u00a2| ?bps?| [A-Z]{3})?$/;

const SCALE_DIGITS: Record<string, number> = { k: 3, K: 3, M: 6, B: 9, T: 12 };

export interface DisplayNumber {
  /** Plain decimal text: no sign for positives, no commas, no scale letter. */
  number: string;
  /** What the column header has to name once the cells are bare numbers. */
  unit: string;
  /** The place value of the last digit drawn: 0.01 for "1.25%", 10,000,000 for "1.20B". */
  step: number;
}

export const BLANK_DISPLAY = "blank";

/** Moves the decimal point right without going through a float, so 1.23B is exactly 1230000000. */
function scaleDecimal(integer: string, fraction: string, digits: number): string {
  const whole = `${integer}${fraction.padEnd(digits, "0").slice(0, digits)}`.replace(/^0+(?=\d)/, "") || "0";
  const rest = fraction.slice(digits);
  return rest ? `${whole}.${rest}` : whole;
}

export function parseDisplayNumber(text: string): DisplayNumber | typeof BLANK_DISPLAY | null {
  // A direction arrow beside a signed move repeats the sign.
  const trimmed = text.trim().replace(/\u2212/g, "-").replace(/\s*[\u2191\u2193]$/, "");
  if (!trimmed || DISPLAY_PLACEHOLDER.test(trimmed)) return BLANK_DISPLAY;
  const match = DISPLAY_NUMBER.exec(trimmed);
  if (!match) return null;
  const [, sign, currency = "", grouped, fraction = "", scale, unitText = ""] = match;
  const integer = grouped!.replace(/,/g, "") || "0";
  const digits = scale ? SCALE_DIGITS[scale]! : 0;
  const magnitude = digits ? scaleDecimal(integer, fraction, digits) : fraction ? `${integer}.${fraction}` : integer;
  const unit = unitText.trim().replace(/^bps$/, "bp").replace(/^\u00a2$/, "c");
  return {
    number: `${sign === "-" ? "-" : ""}${magnitude}`,
    unit: [currency, unit].filter(Boolean).join(" "),
    step: 10 ** (digits - fraction.length),
  };
}

/** Adds the unit the cells dropped, unless the label already names it. */
export function labelWithUnit(label: string, unit: string): string {
  if (!unit) return label;
  // A word unit has to stand alone: "Max" does not name x.
  const named = unit === "bp" ? /\bbps?\b/i.test(label)
    : /^[A-Za-z]+$/.test(unit) ? new RegExp(`\\b${unit}\\b`, "i").test(label)
      : label.includes(unit);
  return named ? label : `${label} (${unit})`;
}
