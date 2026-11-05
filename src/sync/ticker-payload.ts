import type { TickerFinancials } from "../types/financials";
import type { TickerMetadata } from "../types/ticker";
import { historyMemo } from "./history-memo";
import { sanitizePosition, sanitizeUnknown } from "./sanitize";

function pricePointTime(point: { date: Date | string | number }): number {
  const value = point.date;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/** The bars a week's move can start from, oldest first. */
const datedCloses = historyMemo((history) => history
  .filter((point) => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(pricePointTime(point)))
  .sort((left, right) => pricePointTime(left) - pricePointTime(right)));

function weeklyQuoteMove(financials: TickerFinancials | null | undefined) {
  const quote = financials?.quote;
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return undefined;
  const history = datedCloses(financials?.priceHistory);
  if (history.length === 0) return undefined;
  const latestTime = Number.isFinite(quote.lastUpdated)
    ? quote.lastUpdated
    : pricePointTime(history[history.length - 1]!);
  const cutoff = latestTime - 7 * 24 * 60 * 60 * 1000;
  const reference = history.find((point) => pricePointTime(point) >= cutoff) ?? history[Math.max(0, history.length - 7)];
  if (!reference || !Number.isFinite(reference.close) || reference.close <= 0) return undefined;
  const weekChange = quote.price - reference.close;
  return {
    weekReferencePrice: reference.close,
    weekChange,
    weekChangePercent: (weekChange / reference.close) * 100,
  };
}

function sanitizeQuote(financials: TickerFinancials | null | undefined) {
  const quote = financials?.quote;
  if (!quote) return undefined;
  const week = weeklyQuoteMove(financials);
  return {
    price: Number.isFinite(quote.price) ? quote.price : undefined,
    currency: quote.currency,
    changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : undefined,
    previousClose: Number.isFinite(quote.previousClose) ? quote.previousClose : undefined,
    weekReferencePrice: week?.weekReferencePrice,
    weekChange: week?.weekChange,
    weekChangePercent: week?.weekChangePercent,
    lastUpdated: quote.lastUpdated,
  };
}

export function sanitizeTickerMetadata(metadata: TickerMetadata, financials?: TickerFinancials | null): Omit<TickerMetadata, "broker_contracts"> & { quote?: ReturnType<typeof sanitizeQuote> } {
  return {
    ticker: metadata.ticker,
    exchange: metadata.exchange,
    currency: metadata.currency,
    name: metadata.name,
    sector: metadata.sector,
    industry: metadata.industry,
    assetCategory: metadata.assetCategory,
    isin: metadata.isin,
    cusip: metadata.cusip,
    portfolios: [...metadata.portfolios],
    watchlists: [...metadata.watchlists],
    positions: metadata.positions.map(sanitizePosition),
    custom: (sanitizeUnknown(metadata.custom) as Record<string, unknown>) ?? {},
    tags: [...metadata.tags],
    // What a listing's row took from a suffixed key's row, so a device that merges it later never counts a lot twice.
    ...metadata.mergedLots ? { mergedLots: metadata.mergedLots } : {},
    quote: sanitizeQuote(financials),
  };
}

type SanitizedTickerMetadata = ReturnType<typeof sanitizeTickerMetadata>;

/** Only tickers the user actually filed somewhere are worth syncing. */
export function isSyncableTicker(metadata: Pick<SanitizedTickerMetadata, "portfolios" | "watchlists" | "positions">): boolean {
  return metadata.portfolios.length > 0
    || metadata.watchlists.length > 0
    || metadata.positions.length > 0;
}
