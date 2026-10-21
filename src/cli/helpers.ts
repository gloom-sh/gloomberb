import {
  formatCompact,
  formatCurrency,
  formatCurrencyCode,
  formatNumber,
  formatPercentRaw,
} from "../utils/format";
import { formatMarketChangeWithCurrency, formatMarketPriceWithCurrency, type MarketFormatOptions } from "../market-data/market/format";
import { futuresChangeBasisText, futuresQuoteChangeBasis } from "../market-data/futures-contract";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import type { ActiveQuoteDisplay } from "../market-data/market/status";
import type { Quote } from "../types/financials";
import { cliStyles, colorBySign } from "../utils/cli-output";
import type { AppConfig } from "../types/config";
import type { Watchlist, TickerRecord } from "../types/ticker";
import { isFiniteNumber } from "../utils/guards";
import { formatUtcTime } from "../utils/utc-time";
import { findNamedCollection } from "../portfolio/collection-name";

/** A signed amount with its sign ($), or with `code` its code (+12.50 CAD) as a report for another base currency writes it. */
export function formatSignedCurrency(value: number, currency: string, code = false): string {
  const text = (code ? formatCurrencyCode : formatCurrency)(value, currency);
  return value > 0 ? `+${text}` : text;
}

/**
 * The Change line of `ticker` and of `quote`'s futures block: the regular
 * session's move and its percent, colored by sign, and for a future what the
 * move is measured from, "-$22.00 (-0.39%) vs Mon close".
 */
export function quoteChangeText(
  quote: Quote,
  session: Pick<ActiveQuoteDisplay, "price" | "change" | "changePercent">,
  options: MarketFormatOptions,
  terms?: Pick<FuturesContractTermsPayload, "settlement" | "spec"> | null,
): string {
  // A listing that no longer trades: its last close moves no more.
  if (quote.delisting) return "—";
  const move = colorBySign(
    `${formatMarketChangeWithCurrency(session.change, quote.currency ?? "USD", options, session.price)} (${formatPercentRaw(session.changePercent)})`,
    session.change,
  );
  const basis = terms ? futuresQuoteChangeBasis(terms, quote) : null;
  return basis ? `${move} ${cliStyles.muted(futuresChangeBasisText(basis))}` : move;
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

/** Appended to a change message when `--dry-run` kept it from being saved. */
export function dryRunNote(dryRun: boolean): string {
  return dryRun ? cliStyles.muted(" (dry run, nothing saved)") : "";
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

/** A timestamp in CLI text: UTC with the zone named, the same on every machine. */
export function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  return formatUtcTime(new Date(timestamp)) || "—";
}

export function formatBidAsk(
  bid: number | undefined,
  ask: number | undefined,
  bidSize: number | undefined,
  askSize: number | undefined,
  currency: string,
  options: MarketFormatOptions = {},
): string {
  if (bid == null && ask == null) return "—";
  // A zero size is the vendor's placeholder outside the session, not a quoted size.
  const side = (price: number | undefined, size: number | undefined) => price != null
    ? `${formatMarketPriceWithCurrency(price, currency, options)}${size ? ` x ${formatNumber(size, 0)}` : ""}`
    : "—";
  return `${side(bid, bidSize)} / ${side(ask, askSize)}`;
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
  return findNamedCollection(config.watchlists, rawName);
}
