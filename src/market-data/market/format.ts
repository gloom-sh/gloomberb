import type { PriceBasis } from "../../types/instrument";
import type { Quote } from "../../types/financials";
import { resolvePriceBasis } from "./price-basis";
import { formatCompact, formatCurrency } from "../../utils/format";

export type AssetDisplayKind = "cash" | "crypto" | "equity" | "contract" | "other";

export interface AssetDisplayContext {
  isCashBalance?: boolean;
  assetCategory?: string;
  contractSecType?: string;
  multiplier?: number;
  priceBasis?: PriceBasis | null;
  quantityCurrency?: string;
}

export interface MarketFormatOptions extends AssetDisplayContext {
  maxWidth?: number;
  minimumFractionDigits?: number;
  precisionOffset?: number;
  priceRange?: number;
  fixedFractionDigits?: number;
  /** Source units per displayed currency unit; a price quoted in pence keeps its pence decimals in pounds. */
  quotedUnitDivisor?: number;
  /** A price that holds still for the session, such as the previous close. With
   * `fixedFractionDigits`, the kind's decimal ceiling is read at this price
   * instead of at the value, so a live price keeps its decimals as it moves. */
  referencePrice?: number;
}

/** Current price fields use the quote's source metadata; stored cost/mark
 * conventions and independent history must not supply its missing basis. */
export function quoteFormatOptions(
  quote: Pick<Quote, "instrumentType" | "priceBasis" | "providerPriceDivisor"> | null | undefined,
  fallbackAssetCategory?: string,
  metadataInstrumentType?: string,
): MarketFormatOptions {
  // Separate metadata may identify a bond whose convention is unknown. It must
  // never turn a saved bond into a monetary quote or supply a par declaration.
  const fallback = metadataInstrumentType?.trim().toUpperCase() === "BOND" ? "BOND" : fallbackAssetCategory;
  const divisor = quote?.providerPriceDivisor;
  return {
    assetCategory: quote?.instrumentType?.trim() || fallback,
    priceBasis: quote?.priceBasis,
    ...(divisor != null && Number.isFinite(divisor) && divisor > 1 ? { quotedUnitDivisor: divisor } : {}),
  };
}

/** Decimals a sub-unit quote adds in the major unit: two for pence shown in pounds. */
function quotedUnitFractionDigits(divisor: number | undefined): number {
  return divisor != null && Number.isFinite(divisor) && divisor > 1 ? Math.min(3, Math.round(Math.log10(divisor))) : 0;
}

const CASH_TYPES = new Set(["CASH", "FX", "FOREX", "CCY", "CURRENCY", "CURRENCYPAIR"]);
const CRYPTO_TYPES = new Set(["CRYPTO", "CRYPTOCURRENCY", "DIGITALCURRENCY", "COIN", "TOKEN"]);
const EQUITY_TYPES = new Set(["STK", "STOCK", "COMMONSTOCK", "EQUITY", "ETF", "ETN", "ETP", "FUND", "MUTUALFUND", "CEF", "ADR"]);
const CONTRACT_TYPES = new Set(["OPT", "OPTION", "OPTIONS", "FUT", "FUTURE", "FUTURES", "FOP"]);

const currencySymbols = new Map<string, string>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function normalizeType(value?: string): string {
  return (value ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "");
}

function getNumberFormatter(
  minimumFractionDigits: number,
  maximumFractionDigits: number,
  useGrouping: boolean,
): Intl.NumberFormat {
  const key = `${minimumFractionDigits}:${maximumFractionDigits}:${useGrouping ? 1 : 0}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits,
      maximumFractionDigits,
      useGrouping,
    });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

function getCurrencySymbol(currency: string): string {
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const cached = currencySymbols.get(normalizedCurrency);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: normalizedCurrency,
    currencyDisplay: "symbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const symbol = formatter.formatToParts(0).find((part) => part.type === "currency")?.value ?? normalizedCurrency;
  currencySymbols.set(normalizedCurrency, symbol);
  return symbol;
}

function fitsWidth(text: string, maxWidth: number | undefined): boolean {
  return maxWidth == null || text.length <= maxWidth;
}

function isEffectivelyInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

function formatVariableNumber(
  value: number,
  maxFractionDigits: number,
  maxWidth: number | undefined,
  minimumFractionDigits = 0,
): string {
  const groupedModes = [true, false];

  for (const useGrouping of groupedModes) {
    for (let decimals = maxFractionDigits; decimals >= minimumFractionDigits; decimals -= 1) {
      const formatter = getNumberFormatter(Math.min(minimumFractionDigits, decimals), decimals, useGrouping);
      const formatted = formatter.format(value);
      if (fitsWidth(formatted, maxWidth)) return formatted;
    }
  }
  // A cell too narrow for the minimum gives up decimals one at a time.
  for (let decimals = minimumFractionDigits - 1; decimals > 0; decimals -= 1) {
    const formatted = getNumberFormatter(decimals, decimals, false).format(value);
    if (fitsWidth(formatted, maxWidth)) return formatted;
  }

  return getNumberFormatter(0, 0, false).format(value);
}

function getQuantityMaxFractionDigits(kind: AssetDisplayKind, value: number): number {
  if (isEffectivelyInteger(value)) return 0;

  switch (kind) {
    case "cash":
      return 6;
    case "crypto":
      return 8;
    case "equity":
      return 4;
    case "contract":
      return 4;
    case "other":
    default:
      return 4;
  }
}

function integerDigits(value: number): number {
  const absolute = Math.abs(value);
  return absolute >= 1 && Number.isFinite(absolute) ? Math.floor(Math.log10(absolute)) + 1 : 0;
}

function getBasePriceMaxFractionDigits(kind: AssetDisplayKind, value: number): number {
  switch (kind) {
    case "cash":
      // Six decimals, but no more than seven significant digits: providers send
      // float32 rates, so 157.8800048828125 must not print as 157.880005.
      return Math.max(2, Math.min(6, 7 - integerDigits(value)));
    case "crypto":
      // Sub-cent coins need eight decimals to stay distinguishable from zero,
      // but a four-figure coin does not. Scaling the ceiling by magnitude keeps
      // that detail where it carries information instead of surfacing the
      // provider's float tail on quotes like 109556.1640625.
      return Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : 8;
    case "equity":
      return Math.abs(value) >= 1 ? 2 : 4;
    case "contract":
      // Currency futures include five- and seven-decimal prices. This is a
      // display ceiling, not a declaration of the contract's minimum tick.
      return 8;
    case "other":
    default:
      return Math.abs(value) >= 1 ? 2 : 4;
  }
}

function getAdaptivePriceFractionDigits(priceRange: number | undefined, precisionOffset = 0): number | null {
  if (priceRange === undefined || !Number.isFinite(priceRange) || priceRange <= 0) return null;

  // The chart price axis renders four labels by default, so the visible range
  // divided across three intervals is a good proxy for the current zoom step.
  const visibleStep = priceRange / 3;
  if (!Number.isFinite(visibleStep) || visibleStep <= 0) return null;

  return Math.max(0, Math.ceil(-Math.log10(visibleStep)) + precisionOffset);
}

/** Keep four significant digits for tiny prices even when instrument metadata
 * is absent. Decimal formatting below this floor otherwise turns real prices
 * and day-range endpoints into identical zeroes. */
function tinyPriceFractionDigits(value: number): number {
  const absolute = Math.abs(value);
  return absolute > 0 && absolute < 0.01 && Number.isFinite(absolute)
    ? Math.max(0, 3 - Math.floor(Math.log10(absolute))) : 0;
}

function formatPriceNumber(value: number, decimals: number, maxWidth: number | undefined, minimumDecimals = 0): string {
  const tinyDecimals = tinyPriceFractionDigits(value);
  const rendered = tinyDecimals > 20
    ? "0"
    : formatVariableNumber(value, Math.max(decimals, tinyDecimals), tinyDecimals > 0 ? undefined : maxWidth, minimumDecimals);
  if (value === 0 || !Number.isFinite(value) || (Number(rendered.replaceAll(",", "")) !== 0 && fitsWidth(rendered, maxWidth))) return rendered;
  return scientificPrice(value, maxWidth);
}

/** A constrained cell must not imply a worthless asset or unchanged price. */
function scientificPrice(value: number, maxWidth: number | undefined): string {
  for (let precision = 4; precision >= 1; precision -= 1) {
    const scientific = Number(value.toPrecision(precision)).toExponential();
    if (fitsWidth(scientific, maxWidth)) return scientific;
  }
  return "…";
}

/** Dated OHLC values may have no instrument or unit metadata. Display their
 * numeric precision without treating them as equity prices or assigning units. */
export function formatPriceObservation(
  value: number,
  options: Pick<MarketFormatOptions, "maxWidth" | "minimumFractionDigits"> = {},
): string {
  if (!Number.isFinite(value)) return "—";
  return formatPriceNumber(value, 8, options.maxWidth, Math.max(0, Math.min(8, options.minimumFractionDigits ?? 0)));
}

/** The most decimals formatMarketPrice shows for this asset kind and magnitude,
 * for callers that render a whole column with one fixed decimal count. */
export function marketPriceFractionDigitCeiling(value: number, context: AssetDisplayContext): number {
  return Math.max(getBasePriceMaxFractionDigits(resolveAssetDisplayKind(context), value), tinyPriceFractionDigits(value));
}

function getPriceMaxFractionDigits(
  kind: AssetDisplayKind,
  value: number,
  priceRange: number | undefined,
  precisionOffset: number,
  quotedUnitDigits = 0,
): number {
  const baseMaxFractionDigits = kind === "other" && priceRange !== undefined
    ? 6
    : getBasePriceMaxFractionDigits(kind, value) + quotedUnitDigits;
  const adaptiveFractionDigits = getAdaptivePriceFractionDigits(priceRange, precisionOffset);
  return adaptiveFractionDigits === null
    ? baseMaxFractionDigits
    : Math.min(baseMaxFractionDigits, adaptiveFractionDigits);
}

function getCostMaxFractionDigits(kind: AssetDisplayKind): number {
  switch (kind) {
    case "cash":
      return 6;
    case "crypto":
      return 8;
    case "contract":
      return 4;
    case "equity":
      return 2;
    case "other":
    default:
      return 2;
  }
}

function compactScaledPrice(
  value: number,
  divisor: number,
  suffix: string,
  currency: string,
  maxWidth: number | undefined,
): string {
  const sign = value < 0 ? "-" : "";
  const symbol = getCurrencySymbol(currency);
  const numericWidth = maxWidth == null
    ? undefined
    : Math.max(1, maxWidth - sign.length - symbol.length - suffix.length);
  const formatted = formatVariableNumber(Math.abs(value) / divisor, 1, numericWidth, 1);
  return `${sign}${symbol}${formatted}${suffix}`;
}

export function resolveAssetDisplayKind({
  isCashBalance,
  assetCategory,
  contractSecType,
  multiplier,
}: AssetDisplayContext): AssetDisplayKind {
  if (isCashBalance) return "cash";

  const normalizedType = normalizeType(contractSecType || assetCategory);
  if (CRYPTO_TYPES.has(normalizedType) || normalizedType.includes("CRYPTO")) return "crypto";
  if (CASH_TYPES.has(normalizedType) || normalizedType.includes("FOREX") || normalizedType.includes("CURRENCY")) return "cash";
  if (EQUITY_TYPES.has(normalizedType)) return "equity";
  if (CONTRACT_TYPES.has(normalizedType)) return "contract";
  if ((multiplier ?? 1) > 1) return "contract";
  return "other";
}

export function formatMarketQuantity(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (options.priceBasis === "percent-of-par") {
    const suffix = `${options.quantityCurrency ? ` ${options.quantityCurrency}` : ""} face`;
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - suffix.length);
    const quantity = formatMarketQuantity(value, { ...options, priceBasis: "per-unit", maxWidth });
    const compact = formatCompact(value);
    const numeric = fitsWidth(quantity, maxWidth) ? quantity : fitsWidth(compact, maxWidth) ? compact : formatPriceNumber(value, 0, maxWidth);
    return `${numeric}${suffix}`;
  }
  const kind = resolveAssetDisplayKind(options);
  const maxFractionDigits = getQuantityMaxFractionDigits(kind, value);
  return formatVariableNumber(value, maxFractionDigits, options.maxWidth);
}

export function formatMarketPrice(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const basis = resolvePriceBasis(options.priceBasis, options.assetCategory);
  if (basis === null) return "—";
  if (basis === "percent-of-par") {
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 5);
    return `${formatMarketPrice(value, { ...options, priceBasis: "per-unit", maxWidth })}% par`;
  }
  const kind = resolveAssetDisplayKind(options);
  const quotedUnitDigits = kind === "equity" || kind === "other" ? quotedUnitFractionDigits(options.quotedUnitDivisor) : 0;
  const fixedFractionDigits = options.fixedFractionDigits;
  if (fixedFractionDigits !== undefined) {
    const reference = positiveMagnitude(options.referencePrice);
    const maxFractionDigits = kind === "other" && options.priceRange !== undefined
      ? 6
      : reference === undefined
        ? getBasePriceMaxFractionDigits(kind, value) + quotedUnitDigits
        : marketPriceFractionDigitCeiling(reference, options) + quotedUnitDigits;
    let digits = Math.max(0, Math.min(fixedFractionDigits, maxFractionDigits));
    // A live price keeps its instrument's decimals, but a trade finer than the
    // session prices showed (a half-yen print after whole-yen closes) is not
    // rounded to a price that never traded.
    if (reference !== undefined) digits = Math.max(digits, writtenFractionDigits(Math.abs(value), maxFractionDigits));
    const fitted = formatVariableNumber(value, digits, options.maxWidth, digits);
    return hasNonZeroDigit(fitted) || Number(Math.abs(value).toFixed(digits)) === 0
      ? fitted
      : scientificPrice(value, options.maxWidth);
  }
  const minimumFractionDigits = Math.max(
    0,
    Math.min(options.minimumFractionDigits ?? 0, getBasePriceMaxFractionDigits(kind, value)),
  );
  const maxFractionDigits = Math.max(
    getPriceMaxFractionDigits(kind, value, options.priceRange, options.precisionOffset ?? 0, quotedUnitDigits),
    minimumFractionDigits,
  );
  return formatPriceNumber(value, maxFractionDigits, options.maxWidth, minimumFractionDigits);
}

export function formatMarketCost(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const basis = resolvePriceBasis(options.priceBasis, options.assetCategory);
  if (basis === null) return "—";
  if (basis === "percent-of-par") {
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 5);
    return `${formatMarketCost(value, { ...options, priceBasis: "per-unit", maxWidth })}% par`;
  }
  const kind = resolveAssetDisplayKind(options);
  const maxFractionDigits = getCostMaxFractionDigits(kind);
  const minimumFractionDigits = Math.max(0, Math.min(options.minimumFractionDigits ?? 0, maxFractionDigits));
  return formatVariableNumber(value, maxFractionDigits, options.maxWidth, minimumFractionDigits);
}

export function formatSignedMarketPrice(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) === null) return "—";
  if (options.fixedFractionDigits !== undefined) {
    // A move at the instrument's fixed decimals: the sign always has its column,
    // and a move that rounds to zero is unsigned (0.00, never +0.00 or -0.00).
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 1);
    const body = formatMarketPrice(Math.abs(value), { ...options, maxWidth });
    return hasNonZeroDigit(body) ? `${value > 0 ? "+" : "-"}${body}` : body;
  }
  if (value > 0) {
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 1);
    return `+${formatMarketPrice(value, { ...options, maxWidth })}`;
  }
  return formatMarketPrice(value, options);
}

/** Preserve ordinary monetary change formatting while retaining declared par units.
 * `referencePrice` is the quote's price: a change below a cent keeps its digits
 * only when that price is itself quoted past cents and the change survives the
 * price's precision, so float residue on a flat equity still prints $0.00. */
export function formatMarketChangeWithCurrency(
  value: number | undefined,
  currency: string,
  options: MarketFormatOptions = {},
  referencePrice?: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) !== "per-unit") return formatSignedMarketPrice(value, options);
  if (options.fixedFractionDigits !== undefined) {
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 1);
    const body = formatMarketPriceWithCurrency(Math.abs(value), currency, { ...options, maxWidth });
    return hasNonZeroDigit(body) ? `${value > 0 ? "+" : "-"}${body}` : body;
  }
  if (resolveAssetDisplayKind(options) === "contract" || quotedUnitFractionDigits(options.quotedUnitDivisor) > 0) {
    return `${value > 0 ? "+" : ""}${formatMarketPriceWithCurrency(value, currency, {
      ...options, minimumFractionDigits: Math.max(2, options.minimumFractionDigits ?? 0),
    })}`;
  }
  // Cents hide the whole move of a sub-cent asset (-$0.00 for a SHIB day change).
  if (Math.abs(value) < 0.005 && referencePrice != null && Number.isFinite(referencePrice)) {
    const priceDigits = marketPriceFractionDigitCeiling(referencePrice, options);
    if (priceDigits > 2 && Math.abs(value) >= 0.5 * 10 ** -priceDigits) {
      return `${value > 0 ? "+" : ""}${formatMarketPriceWithCurrency(value, currency, options)}`;
    }
  }
  // A move that rounds to zero cents is unsigned rather than -$0.00.
  if (Math.abs(value) < 0.005) return formatCurrency(0, currency);
  return `${value > 0 ? "+" : ""}${formatCurrency(value, currency)}`;
}

/** Decimals the currency's minor unit has: two for GBP, none for JPY. */
export function currencyMinorDigits(currency: string | undefined): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Pads a money price to its currency's minor unit (two for USD, none for JPY),
 * so one card or column never mixes $309.9 with $339.75. Par-quoted prices are left as they are. */
export function withCurrencyMinorDigits(options: MarketFormatOptions, currency: string | undefined): MarketFormatOptions {
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) !== "per-unit") return options;
  return { ...options, minimumFractionDigits: Math.max(options.minimumFractionDigits ?? 0, Math.min(2, currencyMinorDigits(currency))) };
}

function positiveMagnitude(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value !== 0 ? Math.abs(value) : undefined;
}

function hasNonZeroDigit(text: string): boolean {
  return /[1-9]/.test(text);
}

/** Decimals a price was written with, ignoring binary noise: 6012.25 is 2, so
 * is a provider's float32 157.8800048828125, and a change of
 * 0.00004999999999988347 is 5. */
function writtenFractionDigits(value: number, cap: number): number {
  const float32 = Math.fround(value) === value;
  for (let digits = 0; digits < cap; digits += 1) {
    const written = Number(value.toFixed(digits));
    if (Math.abs(written - value) <= 1e-9 * value) return digits;
    if (float32 && Math.fround(written) === value) return digits;
  }
  return cap;
}

const OPTION_CONTRACT_TYPES = new Set(["OPT", "OPTION", "OPTIONS", "FOP"]);

export interface StablePriceContext extends AssetDisplayContext {
  /** The price's currency; its minor unit sets an equity's decimals (USD 2, JPY 0). */
  currency?: string;
  quotedUnitDivisor?: number;
  /** A price that holds still for the session, such as the previous close.
   * Never the live price: a precision read from each tick is what makes the
   * digits jump. */
  referencePrice?: number;
  /** Session-fixed prices as the feed wrote them (previous close, open).
   * Their decimals can ask for more than the default, such as a half-yen
   * Tokyo line. */
  sessionPrices?: readonly (number | null | undefined)[];
}

/**
 * The decimals a live price keeps for its instrument, whatever the tick: an
 * equity above $1 always shows cents (150.10, not 150.1), and a coin, pair or
 * contract takes its count from the reference price, never from the latest
 * trade, so crossing $100 or 1.0000 on a tick changes nothing. A floor per kind
 * is raised to the decimals the reference and session prices were written
 * with (a half-yen close, a 5-decimal FX feed), up to the kind's ceiling.
 * Changes, bid, ask and ranges of the same instrument use the same count.
 */
export function stablePriceFractionDigits(context: StablePriceContext): number {
  const reference = positiveMagnitude(context.referencePrice);
  const kind = resolveAssetDisplayKind(context);
  const unitDigits = kind === "equity" || kind === "other" ? quotedUnitFractionDigits(context.quotedUnitDivisor) : 0;
  const ceiling = reference === undefined ? 8 : marketPriceFractionDigitCeiling(reference, context) + unitDigits;
  const below = (limit: number) => reference !== undefined && reference < limit;
  // Four significant digits for a sub-unit price.
  const subUnitDigits = reference === undefined ? 4 : Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(reference))));
  let digits: number;
  if (resolvePriceBasis(context.priceBasis, context.assetCategory) === "percent-of-par") {
    digits = 2;
  } else if (kind === "equity" || kind === "other") {
    // A sub-unit price keeps four decimals of the major unit, pence lines
    // included; above one unit the currency's minor unit (and pence) apply.
    digits = below(1) ? 4 : Math.min(2, currencyMinorDigits(context.currency)) + unitDigits;
  } else if (kind === "cash") {
    digits = below(10) ? 4 : 2;
  } else if (kind === "crypto") {
    digits = below(1) ? subUnitDigits : below(100) ? 4 : 2;
  } else if (kind === "contract") {
    const type = normalizeType(context.contractSecType || context.assetCategory);
    digits = OPTION_CONTRACT_TYPES.has(type) || !CONTRACT_TYPES.has(type) || !below(1) ? 2 : subUnitDigits;
  } else {
    digits = 2;
  }
  if (kind !== "crypto" && reference !== undefined) digits = Math.max(digits, tinyPriceFractionDigits(reference));
  for (const price of context.sessionPrices ?? []) {
    const magnitude = positiveMagnitude(price);
    if (magnitude !== undefined) digits = Math.max(digits, writtenFractionDigits(magnitude, ceiling));
  }
  return digits;
}

type LiveQuotePrices = Pick<Quote, "price" | "previousClose" | "regularClose" | "open">;

/** The session-fixed price a quote's decimals are chosen from. */
export function quoteReferencePrice(quote: Partial<LiveQuotePrices> | null | undefined): number | undefined {
  return positiveMagnitude(quote?.previousClose)
    ?? positiveMagnitude(quote?.regularClose)
    ?? positiveMagnitude(quote?.open)
    ?? positiveMagnitude(quote?.price);
}

/**
 * Pins a live price's options to its instrument's decimals (see
 * stablePriceFractionDigits). `prices` supplies the session-fixed prices, from
 * the quote when there is one or a stored mark when there is not.
 */
export function withStablePriceDigits(
  options: MarketFormatOptions,
  currency: string | undefined,
  prices: Partial<LiveQuotePrices> | null | undefined,
): MarketFormatOptions {
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) === null) return options;
  // Without any session price, the live price can only give the magnitude.
  const referencePrice = quoteReferencePrice(prices);
  return {
    ...options,
    referencePrice,
    fixedFractionDigits: stablePriceFractionDigits({
      ...options,
      currency,
      referencePrice,
      sessionPrices: [prices?.previousClose, prices?.regularClose, prices?.open],
    }),
  };
}

/** Options for a quote's live prices and changes: its instrument's fixed decimals, whatever the tick. */
export function liveQuoteFormatOptions(
  quote: (Pick<Quote, "instrumentType" | "priceBasis" | "providerPriceDivisor"> & Partial<LiveQuotePrices>) | null | undefined,
  currency: string | undefined,
  fallbackAssetCategory?: string,
  metadataInstrumentType?: string,
): MarketFormatOptions {
  return withStablePriceDigits(quoteFormatOptions(quote, fallbackAssetCategory, metadataInstrumentType), currency, quote);
}

export function formatMarketPriceWithCurrency(
  value: number | undefined,
  currency = "USD",
  options: MarketFormatOptions = {},
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) !== "per-unit") return formatMarketPrice(value, options);
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const sign = value < 0 ? "-" : "";
  const symbol = getCurrencySymbol(normalizedCurrency);
  const numericWidth = options.maxWidth == null
    ? undefined
    : Math.max(1, options.maxWidth - sign.length - symbol.length);
  const body = formatMarketPrice(Math.abs(value), { ...options, maxWidth: numericWidth });
  return `${hasNonZeroDigit(body) ? sign : ""}${symbol}${body}`;
}

export function formatMarketCostWithCurrency(
  value: number | undefined,
  currency = "USD",
  options: MarketFormatOptions = {},
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (resolvePriceBasis(options.priceBasis, options.assetCategory) !== "per-unit") return formatMarketCost(value, options);
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const sign = value < 0 ? "-" : "";
  const symbol = getCurrencySymbol(normalizedCurrency);
  const numericWidth = options.maxWidth == null
    ? undefined
    : Math.max(1, options.maxWidth - sign.length - symbol.length);
  // A money cost keeps its currency's minor unit: $189.20, not $189.2 (JPY has none).
  const body = formatMarketCost(Math.abs(value), {
    minimumFractionDigits: Math.min(2, currencyMinorDigits(normalizedCurrency)),
    ...options,
    maxWidth: numericWidth,
  });
  return `${sign}${symbol}${body}`;
}

export function formatCompactMarketPriceWithCurrency(
  value: number | undefined,
  currency = "USD",
  options: MarketFormatOptions = {},
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);

  if (abs >= 1e6) {
    return compactScaledPrice(value, 1e6, "M", currency, options.maxWidth);
  }
  if (abs >= 1e3 && abs < 1e5) {
    return compactScaledPrice(value, 1e3, "K", currency, options.maxWidth);
  }

  return formatMarketPriceWithCurrency(value, currency, options);
}
