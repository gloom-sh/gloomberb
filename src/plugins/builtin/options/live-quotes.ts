import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionContract, OptionsChain, Quote } from "../../../types/financials";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionTableRow } from "./types";

export const OPTIONS_QUOTE_EXCHANGE = "OPTIONS";
export const OPTIONS_CHAIN_REFRESH_INTERVAL_MS = 10 * 60_000;
/**
 * Real-time chains are cached for about ten seconds upstream, so a visible
 * chain in the regular session refetches its whole snapshot at this cadence.
 * Visible strikes stream on top of it.
 */
export const OPTIONS_LIVE_CHAIN_REFRESH_INTERVAL_MS = 15_000;

/** Minutes come from the pane setting; anything unparseable keeps the default. */
export function resolveChainRefreshIntervalMs(minutes: string | number | undefined, liveSession = false): number {
  const parsed = Number(minutes);
  const configured = Number.isFinite(parsed) && parsed > 0
    ? parsed * 60_000
    : OPTIONS_CHAIN_REFRESH_INTERVAL_MS;
  return liveSession ? Math.min(configured, OPTIONS_LIVE_CHAIN_REFRESH_INTERVAL_MS) : configured;
}

/** A delayed chain is cached for minutes upstream; only a real-time chain gains from the session cadence. */
export function isRealtimeOptionsChain(chain: Pick<OptionsChain, "dataSource" | "realtimeEligible"> | null | undefined): boolean {
  return chain?.realtimeEligible === true || chain?.dataSource === "live";
}
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

  const hasNewTrade = isFiniteNumber(quote.lastTradePrice) && quote.lastTradePrice > 0
    && isFiniteNumber(quote.lastTradeTime) && quote.lastTradeTime > 0
    && quote.lastTradeTime >= contract.lastTradeDate * 1000;
  // Session volume only grows. A smaller streamed figure is an older anchor
  // (or tomorrow's session before the next chain refresh), never a correction.
  const volume = isFiniteNumber(quote.volume) && quote.volume >= 0
    && (contract.volume == null || !Number.isFinite(contract.volume) || quote.volume >= contract.volume)
    ? quote.volume : contract.volume;
  return {
    ...contract,
    // Generic quote.price may itself be a midpoint. LAST must remain an
    // executed trade, with its own timestamp, even while the bid/ask updates.
    lastPrice: hasNewTrade ? quote.lastTradePrice! : contract.lastPrice,
    lastTradeDate: hasNewTrade ? quote.lastTradeTime! / 1000 : contract.lastTradeDate,
    bid: isFiniteNumber(quote.bid) ? quote.bid : contract.bid,
    ask: isFiniteNumber(quote.ask) ? quote.ask : contract.ask,
    ...(volume === undefined ? {} : { volume }),
    lastUpdated: quote.lastUpdated,
  };
}

/** A quote delivered since this subscription started and within the freshness window, or nothing. */
export function freshOptionQuote(entry: QueryEntry<Quote> | undefined, freshness: OptionsQuoteFreshness): Quote | null {
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

export interface LiveOptionsChain {
  /** The snapshot itself when nothing streamed, so memoized consumers keep their identity. */
  chain: OptionsChain;
  /** Strikes with at least one side carrying a fresh streamed quote. */
  streamedStrikes: ReadonlySet<number>;
  /** Latest streamed quote time applied, in milliseconds. */
  quotedAt: number | null;
}

const EMPTY_STRIKES: ReadonlySet<number> = new Set();
const contractKeyIndexes = new WeakMap<readonly OptionContract[], Map<string, number[]>>();

function contractKeyIndex(contracts: readonly OptionContract[]): Map<string, number[]> {
  let index = contractKeyIndexes.get(contracts);
  if (!index) {
    index = new Map();
    contracts.forEach((contract, position) => {
      const key = buildOptionQuoteKey(contract.contractSymbol);
      index!.set(key, [...(index!.get(key) ?? []), position]);
    });
    contractKeyIndexes.set(contracts, index);
  }
  return index;
}

/**
 * The chain as the stream sees it: every fresh streamed quote overlaid on its
 * contract. Only subscribed contracts have entries, so the work per batch is
 * over the handful that streamed, not the whole snapshot. The as-of moves to
 * the newest applied quote, which is the observation time the pricers use.
 */
export function overlayOptionChainQuotes(
  chain: OptionsChain,
  quoteEntries: ReadonlyMap<string, QueryEntry<Quote>>,
  freshness: OptionsQuoteFreshness,
): LiveOptionsChain {
  if (quoteEntries.size === 0) return { chain, streamedStrikes: EMPTY_STRIKES, quotedAt: null };
  const streamedStrikes = new Set<number>();
  let quotedAt: number | null = null;
  const overlay = (contracts: OptionContract[]): OptionContract[] => {
    const index = contractKeyIndex(contracts);
    let next: OptionContract[] | null = null;
    for (const [key, entry] of quoteEntries) {
      const positions = index.get(key);
      if (!positions) continue;
      const quote = freshOptionQuote(entry, freshness);
      if (!quote) continue;
      for (const position of positions) {
        const contract = contracts[position]!;
        const live = overlayOptionContractQuote(contract, quote);
        if (!live || live === contract) continue;
        next ??= contracts.slice();
        next[position] = live;
        streamedStrikes.add(contract.strike);
        if (isFiniteNumber(quote.lastUpdated) && (quotedAt == null || quote.lastUpdated > quotedAt)) quotedAt = quote.lastUpdated;
      }
    }
    return next ?? contracts;
  };
  const calls = overlay(chain.calls);
  const puts = overlay(chain.puts);
  if (calls === chain.calls && puts === chain.puts) return { chain, streamedStrikes: EMPTY_STRIKES, quotedAt: null };
  const snapshotAt = chain.asOf ? Date.parse(chain.asOf) : Number.NaN;
  const asOf = quotedAt != null && (!Number.isFinite(snapshotAt) || quotedAt > snapshotAt)
    ? new Date(quotedAt).toISOString() : chain.asOf;
  return { chain: { ...chain, calls, puts, ...(asOf ? { asOf } : {}) }, streamedStrikes, quotedAt };
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
