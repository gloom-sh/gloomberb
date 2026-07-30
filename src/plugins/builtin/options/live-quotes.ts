import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionContract, Quote } from "../../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionTableRow } from "./types";

export const OPTIONS_QUOTE_EXCHANGE = "OPTIONS";
export const OPTIONS_CHAIN_REFRESH_INTERVAL_MS = 10 * 60_000;
export const OPTIONS_STREAM_FRESHNESS_MS = 2 * 60_000;

const OPTIONS_STREAM_MAX_TARGETS = 16;
const OPTIONS_STREAM_MAX_ROWS = OPTIONS_STREAM_MAX_TARGETS / 2;
const OPTIONS_STREAM_OVERSCAN_ROWS = 4;

export interface OptionsQuoteFreshness {
  chainAsOf?: string;
  chainDataSource?: "live" | "delayed";
  now: number;
  subscriptionStartedAt: number;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionStreamRowCount(height: number): number {
  const visibleRows = Math.max(1, Math.floor(height) - 3);
  return Math.min(
    OPTIONS_STREAM_MAX_ROWS,
    visibleRows + OPTIONS_STREAM_OVERSCAN_ROWS,
  );
}

function optionStreamWindow(totalRows: number, selectedIndex: number, height: number): [number, number] {
  const count = Math.min(totalRows, optionStreamRowCount(height));
  const clampedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, totalRows - 1)));
  const start = Math.max(0, Math.min(clampedIndex - Math.floor(count / 2), totalRows - count));
  return [start, start + count];
}

export function buildOptionQuoteTargets(
  rows: readonly OptionTableRow[],
  selectedIndex: number,
  height: number,
): QuoteSubscriptionTarget[] {
  if (rows.length === 0) return [];
  const [start, end] = optionStreamWindow(rows.length, selectedIndex, height);
  const targets = new Map<string, QuoteSubscriptionTarget>();

  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const selected = index === selectedIndex;
    const distance = Math.abs(index - selectedIndex);
    for (const contract of [row.call, row.put]) {
      const symbol = contract?.contractSymbol.trim().toUpperCase();
      if (!symbol) continue;
      targets.set(symbol, {
        symbol,
        exchange: OPTIONS_QUOTE_EXCHANGE,
        surface: "options",
        visible: true,
        selected,
        weight: Math.max(50, 100 - distance),
      });
    }
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
    receivedAt <= freshness.subscriptionStartedAt ||
    freshness.now - receivedAt > OPTIONS_STREAM_FRESHNESS_MS
  ) {
    return null;
  }
  const chainAsOf = freshness.chainAsOf ? Date.parse(freshness.chainAsOf) : Number.NaN;
  if (
    freshness.chainDataSource === "live" &&
    quote.dataSource === "live" &&
    Number.isFinite(chainAsOf) &&
    Number.isFinite(quote.lastUpdated) &&
    quote.lastUpdated < chainAsOf
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

export function hasLiveOptionQuote(
  quoteEntries: ReadonlyMap<string, QueryEntry<Quote>>,
  freshness: OptionsQuoteFreshness,
): boolean {
  for (const entry of quoteEntries.values()) {
    const quote = freshOptionQuote(entry, freshness);
    if (quote?.dataSource === "live" && quote.delivery === "stream") return true;
  }
  return false;
}
