import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionContract, Quote } from "../../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionTableRow } from "./types";

export const OPTIONS_QUOTE_EXCHANGE = "OPTIONS";
export const OPTIONS_CHAIN_REFRESH_INTERVAL_MS = 10 * 60_000;
export const OPTIONS_STREAM_FRESHNESS_MS = 2 * 60_000;
export const OPTIONS_STREAM_CONNECTING_GRACE_MS = 15_000;

const OPTIONS_STREAM_OVERSCAN_ROWS = 4;

export interface OptionsQuoteFreshness {
  now: number;
  subscriptionStartedAt: number;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface OptionQuoteTargetWindow {
  fallbackHeight: number;
  selectedIndex: number;
  visibleRange: { start: number; end: number } | null;
}

export type OptionQuoteCoverageStatus = "live" | "mixed" | "connecting" | "delayed";

export interface OptionQuoteCoverage {
  fallbackCount: number;
  liveCount: number;
  status: OptionQuoteCoverageStatus;
  totalCount: number;
}

function fallbackVisibleRange(
  totalRows: number,
  selectedIndex: number,
  height: number,
): { start: number; end: number } {
  const count = Math.min(totalRows, Math.max(1, Math.floor(height) - 3));
  const clampedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, totalRows - 1)));
  const start = Math.max(0, Math.min(clampedIndex - Math.floor(count / 2), totalRows - count));
  return { start, end: start + count };
}

function normalizeVisibleRange(
  totalRows: number,
  window: OptionQuoteTargetWindow,
): { start: number; end: number } {
  if (!window.visibleRange) {
    return fallbackVisibleRange(totalRows, window.selectedIndex, window.fallbackHeight);
  }
  const start = Math.max(0, Math.min(totalRows, Math.floor(window.visibleRange.start)));
  const end = Math.max(start, Math.min(totalRows, Math.ceil(window.visibleRange.end)));
  return { start, end };
}

export function buildOptionQuoteTargets(
  rows: readonly OptionTableRow[],
  window: OptionQuoteTargetWindow,
): QuoteSubscriptionTarget[] {
  if (rows.length === 0) return [];
  const visibleRange = normalizeVisibleRange(rows.length, window);
  const start = Math.max(0, visibleRange.start - OPTIONS_STREAM_OVERSCAN_ROWS);
  const end = Math.min(rows.length, visibleRange.end + OPTIONS_STREAM_OVERSCAN_ROWS);
  const targets = new Map<string, QuoteSubscriptionTarget>();

  const addRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const selected = index === window.selectedIndex;
    const visible = index >= visibleRange.start && index < visibleRange.end;
    const distance = visible
      ? 0
      : index < visibleRange.start
        ? visibleRange.start - index
        : index - visibleRange.end + 1;
    for (const contract of [row.call, row.put]) {
      const symbol = contract?.contractSymbol.trim().toUpperCase();
      if (!symbol) continue;
      targets.set(symbol, {
        symbol,
        exchange: OPTIONS_QUOTE_EXCHANGE,
        surface: "options",
        visible,
        selected,
        weight: selected ? 100 : visible ? 80 : Math.max(50, 70 - distance),
      });
    }
  };

  for (let index = start; index < end; index += 1) {
    addRow(index);
  }
  if (window.selectedIndex < start || window.selectedIndex >= end) {
    addRow(window.selectedIndex);
  }

  return [...targets.values()];
}

export function buildOptionQuoteKey(contractSymbol: string): string {
  return buildQuoteKey({
    symbol: contractSymbol,
    exchange: OPTIONS_QUOTE_EXCHANGE,
  });
}

export function overlayOptionContractQuote(
  contract: OptionContract | undefined,
  quote: Quote | null | undefined,
): OptionContract | undefined {
  if (!contract || !quote) return contract;
  if (contract.lastUpdated != null && quote.lastUpdated < contract.lastUpdated) return contract;

  const streamedPrice = isFiniteNumber(quote.mark) ? quote.mark : quote.price;
  return {
    ...contract,
    lastPrice: isFiniteNumber(streamedPrice) ? streamedPrice : contract.lastPrice,
    bid: isFiniteNumber(quote.bid) ? quote.bid : contract.bid,
    ask: isFiniteNumber(quote.ask) ? quote.ask : contract.ask,
    lastUpdated: quote.lastUpdated,
  };
}

function freshOptionQuote(entry: QueryEntry<Quote> | undefined, freshness: OptionsQuoteFreshness): Quote | null {
  const quote = resolveEntryData(entry);
  if (!quote || quote.stale === true) return null;
  const receivedAt = quote.receivedAt ?? 0;
  if (
    !Number.isFinite(receivedAt) ||
    receivedAt < freshness.subscriptionStartedAt ||
    freshness.now - receivedAt > OPTIONS_STREAM_FRESHNESS_MS
  ) {
    return null;
  }
  return quote;
}

export function overlayOptionRowQuotes(
  rows: readonly OptionTableRow[],
  quoteEntries: ReadonlyMap<string, QueryEntry<Quote>>,
  freshness: OptionsQuoteFreshness,
): OptionTableRow[] {
  return rows.map((row) => ({
    ...row,
    call: overlayOptionContractQuote(
      row.call,
      row.call ? freshOptionQuote(quoteEntries.get(buildOptionQuoteKey(row.call.contractSymbol)), freshness) : null,
    ),
    put: overlayOptionContractQuote(
      row.put,
      row.put ? freshOptionQuote(quoteEntries.get(buildOptionQuoteKey(row.put.contractSymbol)), freshness) : null,
    ),
  }));
}

export function resolveOptionQuoteCoverage(
  targets: readonly QuoteSubscriptionTarget[],
  quoteEntries: ReadonlyMap<string, QueryEntry<Quote>>,
  freshness: OptionsQuoteFreshness,
): OptionQuoteCoverage {
  const visibleSymbols = new Set(
    targets
      .filter((target) => target.visible === true)
      .map((target) => target.symbol.trim().toUpperCase())
      .filter(Boolean),
  );
  let liveCount = 0;
  let fallbackCount = 0;
  for (const symbol of visibleSymbols) {
    const quote = freshOptionQuote(
      quoteEntries.get(buildOptionQuoteKey(symbol)),
      freshness,
    );
    if (
      quote?.dataSource === "live"
      && quote.delivery === "stream"
      && quote.stale === false
    ) {
      liveCount += 1;
    } else if (quote) {
      fallbackCount += 1;
    }
  }

  const totalCount = visibleSymbols.size;
  const status: OptionQuoteCoverageStatus = totalCount > 0 && liveCount === totalCount
    ? "live"
    : liveCount > 0
      ? "mixed"
      : fallbackCount === 0
        && totalCount > 0
        && freshness.now - freshness.subscriptionStartedAt < OPTIONS_STREAM_CONNECTING_GRACE_MS
        ? "connecting"
        : "delayed";
  return { fallbackCount, liveCount, status, totalCount };
}
