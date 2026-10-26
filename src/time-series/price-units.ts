import { currencyPairSpelling } from "../utils/currency-pair";

/**
 * What a price counts, read from its unit: the currency it is in and the
 * quantity one unit of that currency buys ("USD / gallon"), as futures
 * contract terms word it, or as a catalog series writes it ("USD/gallon").
 */

/** Gallons in one US oil barrel: heating oil and gasoline quote per gallon, crude per barrel. */
export const GALLONS_PER_BARREL = 42;

/**
 * Barrels in a metric tonne of a refined product, the conversions a formula
 * knows by their number: gasoil 7.45 bbl/t (ICE gasoil's own), gasoline 8.45.
 * Times one, a price per barrel is a price per tonne.
 */
const BARRELS_PER_TONNE = { gasoil: 7.45, gasoline: 8.45 } as const;

/** Whether a formula's multiplier is the barrels in a tonne of a product (7.45 or 8.45). */
export function isBarrelsPerTonne(value: number): boolean {
  return Object.values(BARRELS_PER_TONNE).includes(value as 7.45 | 8.45);
}

const US_CENTS = /^us\s*cents?$/i;
const GALLON = /^(?:gallons?|gal)$/i;
const BARREL = /^(?:barrels?|bbl)$/i;
const TONNE = /^(?:tonnes?|metric tons?|mt|t)$/i;

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

/** One name for a quantity however it is written: "gal" and "gallons" are a gallon, "bbl" a barrel, "t" a tonne. */
export function quantityIdentity(quantity: string): string {
  const token = quantity.trim().toLowerCase();
  return GALLON.test(token) ? "gallon" : BARREL.test(token) ? "barrel" : TONNE.test(token) ? "tonne"
    : token.replace(/^shares$/, "share");
}

/**
 * The physical quantities a price can count, each by one name: what sets a
 * price's scale, so a per-gallon and a per-barrel price never share an axis.
 * A share, a unit or a currency is none of them.
 */
const PHYSICAL_QUANTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [GALLON, "gallon"],
  [BARREL, "barrel"],
  [TONNE, "tonne"],
  [/^(?:dry\s+metric\s+tons?|dmtu?)$/i, "dry metric ton"],
  [/^(?:short\s+)?tons?$/i, "short ton"],
  [/^(?:bushels?|bu)$/i, "bushel"],
  [/^(?:pounds?|lbs?)$/i, "pound"],
  [/^(?:troy\s+)?(?:ounces?|oz)$/i, "troy ounce"],
  [/^(?:hundredweight|cwt)$/i, "hundredweight"],
  [/^(?:kilograms?|kg)$/i, "kilogram"],
  [/^mmbtu$/i, "MMBtu"],
  [/^therms?$/i, "therm"],
  [/^gj$/i, "GJ"],
  [/^mwh$/i, "MWh"],
  [/^kwh$/i, "kWh"],
  [/^(?:board\s+feet|mbf)$/i, "board feet"],
  [/^(?:litres?|liters?)$/i, "litre"],
  [/^(?:cubic\s+met(?:er|re)s?|m3)$/i, "cubic metre"],
];

/** The physical quantity a unit's denominator names ("barrel" for "bbl"), or null for a share, a unit or a currency. */
export function physicalQuantity(quantity: string): string | null {
  const token = quantity.trim();
  return PHYSICAL_QUANTITIES.find(([pattern]) => pattern.test(token))?.[1] ?? null;
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

/**
 * The per-tonne unit a per-barrel price takes once multiplied by the barrels
 * in a tonne (7.45 for gasoil), in the same wording: "USD / barrel" is
 * "USD / tonne". Any other unit is returned as it is.
 */
export function perTonneUnit(unit: string): string {
  return isPerBarrelUnit(unit) ? unit.replace(/(\/\s*)\S.*$/, "$1tonne") : unit;
}

/**
 * What a currency pair's price counts: the quote currency one unit of the
 * base buys, so EURUSD=X is USD / EUR and USDJPY=X JPY / USD. Null for a
 * listing that is not a pair, or whose quote is in another currency.
 */
export function currencyPairPriceUnit(symbol: string, exchange: string | undefined, currency: string | null | undefined): string | null {
  const pair = currencyPairSpelling(symbol, exchange);
  if (!pair || pair.ambiguous || !currency) return null;
  const base = pair.symbol.slice(0, 3);
  const quote = pair.symbol.slice(3, 6);
  return quote === currency.trim().toUpperCase() ? `${quote} / ${base}` : null;
}
