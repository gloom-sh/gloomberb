import type { PriceBasis } from "../types/instrument";
import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercentRaw,
} from "../utils/format";
import { formatMarketPriceWithCurrency, type MarketFormatOptions } from "../market-data/market/format";
import { cliStyles, colorBySign } from "../utils/cli-output";

export { slugifyName } from "../utils/slugify";
import type { AppConfig } from "../types/config";
import type { Watchlist, TickerRecord } from "../types/ticker";

export function formatSignedCurrency(value: number, currency: string): string {
  return value > 0 ? `+${formatCurrency(value, currency)}` : formatCurrency(value, currency);
}

export function formatSignedPercentRaw(value: number | undefined): string {
  return formatPercentRaw(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Text-table cell formats. They leave missing values blank; CSV and JSON keep the raw numbers.

/** A change already in percent: 1.23 becomes +1.23%, colored by sign. */
export function formatChangePercentCell(value: unknown): string {
  return isFiniteNumber(value) ? colorBySign(formatPercentRaw(value), value) : "";
}

/** A fraction as a percent: 0.0797 becomes 7.97%. */
export function formatFractionPercentCell(value: unknown): string {
  return isFiniteNumber(value) ? `${(value * 100).toFixed(2)}%` : "";
}

/** A count with thousands separators. */
export function formatCountCell(value: unknown): string {
  return isFiniteNumber(value) ? formatNumber(value, 0) : "";
}

/** A large amount in compact form: 4.96T, 128.9B. */
export function formatCompactCell(value: unknown): string {
  return isFiniteNumber(value) ? formatCompact(value) : "";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** A byte count in the largest unit that keeps it at or above 1: 40590994 becomes 38.7 MB. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** A check or health status word, colored by outcome. */
export function formatStatusCell(value: unknown): string {
  const status = String(value ?? "");
  if (status === "ok" || status === "pass") return cliStyles.success(status);
  if (status === "warn" || status === "warning") return cliStyles.warning(status);
  if (status === "error" || status === "fail") return cliStyles.danger(status);
  return status;
}

/** Decimals the currency's minor unit has: two for GBP, none for JPY. */
export function currencyMinorDigits(currency: string | undefined): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function fractionDigits(text: string): number {
  return /\.(\d+)/.exec(text)?.[1]?.length ?? 0;
}

/** Low and high of a range. A sub-unit quote (pence shown in pounds) varies in decimals,
 * so its pair shares one count: £35.1000 - £35.4871, not £35.10 - £35.4871. */
export function formatPriceRange(
  low: number | undefined,
  high: number | undefined,
  currency: string,
  options: MarketFormatOptions,
  separator = " - ",
): string {
  const format = (value: number | undefined, extra: MarketFormatOptions = {}) => (
    value == null ? "—" : formatMarketPriceWithCurrency(value, currency, { ...options, ...extra })
  );
  const lowText = format(low);
  const highText = format(high);
  if (!options.quotedUnitDivisor || low == null || high == null) return `${lowText}${separator}${highText}`;
  const digits = Math.max(fractionDigits(lowText), fractionDigits(highText));
  if (fractionDigits(lowText) === digits && fractionDigits(highText) === digits) return `${lowText}${separator}${highText}`;
  return `${format(low, { fixedFractionDigits: digits })}${separator}${format(high, { fixedFractionDigits: digits })}`;
}

export function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatNullableCompact(value: number | undefined): string {
  return value == null ? "—" : formatCompact(value);
}

export function formatStatementValue(value: number | undefined, kind: "compact" | "eps" = "compact"): string {
  if (value == null) return "—";
  return kind === "eps" ? formatNumber(value, 2) : formatCompact(value);
}

export function formatBidAsk(
  bid: number | undefined,
  ask: number | undefined,
  bidSize: number | undefined,
  askSize: number | undefined,
  currency: string,
  assetCategory?: string,
  priceBasis?: PriceBasis,
): string {
  if (bid == null && ask == null) return "—";
  const bidText = bid != null
    ? `${formatMarketPriceWithCurrency(bid, currency, { assetCategory, priceBasis })}${bidSize != null ? ` x ${formatNumber(bidSize, 0)}` : ""}`
    : "—";
  const askText = ask != null
    ? `${formatMarketPriceWithCurrency(ask, currency, { assetCategory, priceBasis })}${askSize != null ? ` x ${formatNumber(askSize, 0)}` : ""}`
    : "—";
  return `${bidText} / ${askText}`;
}

export function formatWatchlistNames(config: AppConfig, watchlistIds: string[]): string[] {
  return watchlistIds
    .map((id) => config.watchlists.find((watchlist) => watchlist.id === id)?.name)
    .filter((name): name is string => !!name);
}

export function formatPortfolioNames(config: AppConfig, portfolioIds: string[]): string[] {
  return portfolioIds
    .map((id) => config.portfolios.find((portfolio) => portfolio.id === id)?.name)
    .filter((name): name is string => !!name);
}

export function countCollectionTickers(
  tickers: TickerRecord[],
  field: "portfolios" | "watchlists",
  id: string,
): number {
  return tickers.filter((ticker) => ticker.metadata[field].includes(id)).length;
}

export function findWatchlist(config: AppConfig, rawName: string): Watchlist | null {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return null;
  return config.watchlists.find((watchlist) =>
    watchlist.id.toLowerCase() === normalized || watchlist.name.toLowerCase() === normalized
  ) ?? null;
}
