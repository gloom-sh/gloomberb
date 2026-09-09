import type { MarketDataRequestContext } from "../types/data-provider";
import type { Quote, TickerFinancials } from "../types/financials";
import type { InstrumentRef, OptionsRequest, SecFilingsRequest, ChartRequest } from "./request-types";
import type { QueryEntry } from "./result-types";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { normalizePriceHistory } from "../utils/price-history";
import { resolveTickerFinancialsQuoteState } from "./quotes/resolution";

export function buildInstrumentKey(instrument: InstrumentRef): string {
  const contractKey = instrument.instrument?.conId
    ?? instrument.instrument?.localSymbol
    ?? instrument.instrument?.symbol
    ?? "";
  return [
    instrument.symbol.trim().toUpperCase(),
    (instrument.exchange ?? "").trim().toUpperCase(),
    instrument.brokerId ?? "",
    instrument.brokerInstanceId ?? "",
    contractKey,
  ].join("|");
}

export function toMarketDataContext(instrument: InstrumentRef): MarketDataRequestContext {
  return {
    brokerId: instrument.brokerId,
    brokerInstanceId: instrument.brokerInstanceId,
    instrument: instrument.instrument ?? null,
  };
}

export function buildQuoteKey(instrument: InstrumentRef): string {
  return `quote:${buildInstrumentKey(instrument)}`;
}

export function buildSnapshotKey(instrument: InstrumentRef): string {
  return `snapshot:${buildInstrumentKey(instrument)}`;
}

export function buildChartKey(request: ChartRequest): string {
  return [
    "chart",
    buildInstrumentKey(request.instrument),
    request.bufferRange,
    request.granularity ?? "range",
    request.resolution ?? "",
    request.startDate ? request.startDate.toISOString() : "",
    request.endDate ? request.endDate.toISOString() : "",
    request.barSize ?? "",
  ].join(":");
}

export function buildOptionsKey(request: OptionsRequest): string {
  return `options:${buildInstrumentKey(request.instrument)}:${request.expirationDate ?? "default"}`;
}

export function buildSecFilingsKey(request: SecFilingsRequest): string {
  return `sec:${buildInstrumentKey(request.instrument)}:${request.count ?? 50}`;
}

export function buildSecContentKey(accessionNumber: string): string {
  return `sec-content:${accessionNumber}`;
}

export function buildSecDocumentsKey(accessionNumber: string): string {
  return `sec-documents:${accessionNumber}`;
}

export function buildArticleSummaryKey(url: string): string {
  return `article-summary:${url.trim()}`;
}

export function buildFxKey(currency: string): string {
  return `fx:${currency.trim().toUpperCase()}`;
}

export function resolveEntryData<T>(entry: QueryEntry<T> | null | undefined): T | null {
  if (!entry) return null;
  return entry.data ?? entry.lastGoodData ?? null;
}

function hasLikelyPriceUnitMismatch(
  left: Quote | null | undefined,
  right: Quote | null | undefined,
): boolean {
  return hasLikelyQuoteUnitMismatch(left, right);
}

export function buildTickerFinancialsSnapshot(
  snapshotEntry: QueryEntry<TickerFinancials>,
  quoteEntry?: QueryEntry<TickerFinancials["quote"]>,
  chartEntry?: QueryEntry<TickerFinancials["priceHistory"]>,
): TickerFinancials | null {
  const snapshot = resolveEntryData(snapshotEntry);
  const quote = resolveEntryData(quoteEntry);
  const priceHistory = resolveEntryData(chartEntry);
  if (!snapshot && !quote && !priceHistory) return null;
  if (snapshot?.quote && quote && hasLikelyPriceUnitMismatch(snapshot.quote, quote)) {
    return {
      ...(resolveTickerFinancialsQuoteState(snapshot) ?? {
        annualStatements: snapshot?.annualStatements ?? [],
        quarterlyStatements: snapshot?.quarterlyStatements ?? [],
        priceHistory: snapshot?.priceHistory ?? [],
      }),
      priceHistory: normalizePriceHistory(priceHistory ?? snapshot?.priceHistory ?? []),
    };
  }

  const resolved = resolveTickerFinancialsQuoteState(snapshot ?? {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  }, quote);

  if (!resolved) return null;

  return {
    ...resolved,
    priceHistory: normalizePriceHistory(priceHistory ?? snapshot?.priceHistory ?? []),
  };
}
