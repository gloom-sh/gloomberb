export type AssetDisplayKind = "cash" | "crypto" | "equity" | "contract" | "other";

export interface AssetDisplayContext {
  isCashBalance?: boolean;
  assetCategory?: string;
  contractSecType?: string;
  multiplier?: number;
}

export interface MarketFormatOptions extends AssetDisplayContext {
  maxWidth?: number;
  minimumFractionDigits?: number;
  precisionOffset?: number;
  priceRange?: number;
  fixedFractionDigits?: number;
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

function getBasePriceMaxFractionDigits(kind: AssetDisplayKind, value: number): number {
  switch (kind) {
    case "cash":
      return 6;
    case "crypto":
      return 8;
    case "equity":
      return Math.abs(value) >= 1 ? 2 : 4;
    case "contract":
      return 4;
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
  // A constrained cell must not imply a worthless asset or unchanged price.
  for (let precision = 4; precision >= 1; precision -= 1) {
    const scientific = Number(value.toPrecision(precision)).toExponential();
    if (fitsWidth(scientific, maxWidth)) return scientific;
  }
  return "…";
}

function getPriceMaxFractionDigits(
  kind: AssetDisplayKind,
  value: number,
  priceRange: number | undefined,
  precisionOffset: number,
): number {
  const baseMaxFractionDigits = kind === "other" && priceRange !== undefined
    ? 6
    : getBasePriceMaxFractionDigits(kind, value);
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
  const kind = resolveAssetDisplayKind(options);
  const maxFractionDigits = getQuantityMaxFractionDigits(kind, value);
  return formatVariableNumber(value, maxFractionDigits, options.maxWidth);
}

export function formatMarketPrice(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const kind = resolveAssetDisplayKind(options);
  const fixedFractionDigits = options.fixedFractionDigits;
  if (fixedFractionDigits !== undefined) {
    const maxFractionDigits = kind === "other" && options.priceRange !== undefined
      ? 6
      : getBasePriceMaxFractionDigits(kind, value);
    const clampedFixedFractionDigits = Math.max(0, Math.min(fixedFractionDigits, maxFractionDigits));
    return formatVariableNumber(value, clampedFixedFractionDigits, options.maxWidth, clampedFixedFractionDigits);
  }
  const minimumFractionDigits = Math.max(
    0,
    Math.min(options.minimumFractionDigits ?? 0, getBasePriceMaxFractionDigits(kind, value)),
  );
  const maxFractionDigits = Math.max(
    getPriceMaxFractionDigits(kind, value, options.priceRange, options.precisionOffset ?? 0),
    minimumFractionDigits,
  );
  return formatPriceNumber(value, maxFractionDigits, options.maxWidth, minimumFractionDigits);
}

export function formatMarketCost(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const kind = resolveAssetDisplayKind(options);
  return formatVariableNumber(value, getCostMaxFractionDigits(kind), options.maxWidth);
}

export function formatSignedMarketPrice(value: number | undefined, options: MarketFormatOptions = {}): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (value > 0) {
    const maxWidth = options.maxWidth == null ? undefined : Math.max(1, options.maxWidth - 1);
    return `+${formatMarketPrice(value, { ...options, maxWidth })}`;
  }
  return formatMarketPrice(value, options);
}

export function formatMarketPriceWithCurrency(
  value: number | undefined,
  currency = "USD",
  options: MarketFormatOptions = {},
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const sign = value < 0 ? "-" : "";
  const symbol = getCurrencySymbol(normalizedCurrency);
  const numericWidth = options.maxWidth == null
    ? undefined
    : Math.max(1, options.maxWidth - sign.length - symbol.length);
  const body = formatMarketPrice(Math.abs(value), { ...options, maxWidth: numericWidth });
  return `${sign}${symbol}${body}`;
}

export function formatMarketCostWithCurrency(
  value: number | undefined,
  currency = "USD",
  options: MarketFormatOptions = {},
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const sign = value < 0 ? "-" : "";
  const symbol = getCurrencySymbol(normalizedCurrency);
  const numericWidth = options.maxWidth == null
    ? undefined
    : Math.max(1, options.maxWidth - sign.length - symbol.length);
  const body = formatMarketCost(Math.abs(value), { ...options, maxWidth: numericWidth });
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
