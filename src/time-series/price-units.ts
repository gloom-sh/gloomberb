/**
 * What a price counts, read from its unit: the currency it is in and the
 * quantity one unit of that currency buys ("USD / gallon"), as futures
 * contract terms word it, or as a catalog series writes it ("USD/gallon").
 */

/** Gallons in one US oil barrel: heating oil and gasoline quote per gallon, crude per barrel. */
export const GALLONS_PER_BARREL = 42;

const US_CENTS = /^us\s*cents?$/i;
const GALLON = /^(?:gallons?|gal)$/i;
const BARREL = /^(?:barrels?|bbl)$/i;

/**
 * The currency code a unit's leading factor names: `USD` for "USD", `USX`
 * (US cents, the quote currency of grains and livestock) for "US cents".
 * Null for anything else.
 */
export function unitCurrencyToken(factor: string): string | null {
  const token = factor.trim();
  if (US_CENTS.test(token)) return "USX";
  return /^[A-Za-z]{3}$/.test(token) ? token : null;
}

function unitParts(unit: string): { currency: string | null; per: string } | null {
  const slash = unit.indexOf("/");
  if (slash < 0 || unit.indexOf("/", slash + 1) >= 0) return null;
  const per = unit.slice(slash + 1).trim();
  if (!per) return null;
  return { currency: unitCurrencyToken(unit.slice(0, slash)), per };
}

/**
 * A futures contract's unit when it says what the quote's currency buys:
 * "USD / gallon" for a USD quote, "US cents / bushel" for a USX one. Null
 * where it does not (index points, % of par) or names another currency.
 */
export function contractPriceUnit(unit: string | null | undefined, currency: string | null | undefined): string | null {
  const parts = unit ? unitParts(unit) : null;
  if (!parts?.currency || !currency?.trim()) return null;
  return parts.currency.toUpperCase() === currency.trim().toUpperCase() ? unit!.trim() : null;
}

/** One name for a quantity however it is written: "gal" and "gallons" are a gallon, "bbl" a barrel. */
export function quantityIdentity(quantity: string): string {
  const token = quantity.trim().toLowerCase();
  return GALLON.test(token) ? "gallon" : BARREL.test(token) ? "barrel" : token.replace(/^shares$/, "share");
}

/** A price per gallon: "USD / gallon", "USD/gallon". */
export function isPerGallonUnit(unit: string): boolean {
  const parts = unitParts(unit);
  return !!parts?.currency && GALLON.test(parts.per);
}

/** A price per barrel: "USD / barrel", "USD/barrel". */
export function isPerBarrelUnit(unit: string): boolean {
  const parts = unitParts(unit);
  return !!parts?.currency && BARREL.test(parts.per);
}

/**
 * The per-barrel unit a per-gallon price takes once multiplied by 42, in the
 * same wording: "USD / gallon" is "USD / barrel", "USD/gallon" "USD/barrel".
 * Any other unit is returned as it is.
 */
export function perBarrelUnit(unit: string): string {
  return isPerGallonUnit(unit) ? unit.replace(/(\/\s*)\S.*$/, "$1barrel") : unit;
}
