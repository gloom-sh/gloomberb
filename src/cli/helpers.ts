import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercentRaw,
} from "../utils/format";
import { formatMarketPriceWithCurrency } from "../market-data/market/format";

export { slugifyName } from "../utils/slugify";
import type { AppConfig } from "../types/config";
import type { Watchlist, TickerRecord } from "../types/ticker";

export function formatSignedCurrency(value: number, currency: string): string {
  return value > 0 ? `+${formatCurrency(value, currency)}` : formatCurrency(value, currency);
}

export function formatSignedPercentRaw(value: number | undefined): string {
  return formatPercentRaw(value);
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
): string {
  if (bid == null && ask == null) return "—";
  const bidText = bid != null
    ? `${formatMarketPriceWithCurrency(bid, currency, { assetCategory })}${bidSize != null ? ` x ${formatNumber(bidSize, 0)}` : ""}`
    : "—";
  const askText = ask != null
    ? `${formatMarketPriceWithCurrency(ask, currency, { assetCategory })}${askSize != null ? ` x ${formatNumber(askSize, 0)}` : ""}`
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
