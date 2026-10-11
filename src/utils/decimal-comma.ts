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
