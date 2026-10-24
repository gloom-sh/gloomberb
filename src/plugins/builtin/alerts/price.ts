import { ambiguousNumberMessage, parsePastedNumber, type PastedNumber } from "../../../utils/decimal-comma";

const PRICE_SCALES = { k: 1e3, m: 1e6, b: 1e9 } as const;
/** A price typed with a scale after it: 81k, 1.5m. */
const SCALED_PRICE = /^([+-]?\d[\d.,]*)\s*([kmb])$/i;

/** What to type for an alert price, as the error for one that reads as none names it. */
const PRICE_FORMAT = "type 81000 or 81k";

const scaled = (value: number, scale: number) => Number((value * scale).toPrecision(15));

/** A price as `parsePastedNumber` reads it, and `81k` is 81000: the scale applies to either reading of a comma and three digits. */
export function parseAlertPrice(text: string): PastedNumber {
  const match = SCALED_PRICE.exec(text.trim());
  if (!match) return parsePastedNumber(text);
  const scale = PRICE_SCALES[match[2]!.toLowerCase() as keyof typeof PRICE_SCALES];
  const base = parsePastedNumber(match[1]);
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
