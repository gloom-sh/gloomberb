import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getSharedRegistry } from "../../plugins/registry";
import { useAppDispatch, useAppSelector } from "../app/context";
import {
  AmbiguousTickerError,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
} from "../../tickers/search";
import { collectUniqueTickerSymbols } from "../../tickers/tokenizer";
import { useQuoteStreaming } from "./quote-streaming";
import {
  inlineTickerQuoteFailures,
  inlineTickerResolutionFailures,
  type InlineTickerFailureKind,
} from "./inline-ticker-failures";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../../market-data/coordinator";
import { useQuoteEntries } from "../../market-data/hooks";
import { instrumentFromTicker, type InstrumentRef } from "../../market-data/request-types";
import { buildQuoteKey } from "../../market-data/selectors";
import type { QueryEntry } from "../../market-data/result-types";
import type { AppAction } from "../app/context";
import type { PluginRegistry } from "../../plugins/registry";
import type { Quote, TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { TICKER_RESEARCH_PANE_ID } from "../../types/config";

/**
 * `ambiguous` is not a failure to show as one: the symbol resolved to several
 * listings, so the badge stays a badge and opening it asks which listing was
 * meant. Only `missing` degrades to plain text.
 */
export type InlineTickerStatus = "loading" | "ready" | "ambiguous" | "missing";

export interface InlineTickerCatalogEntry {
  status: InlineTickerStatus;
  ticker: TickerRecord | null;
  quote: Quote | null;
  /**
   * Set by `badgeQuotes`: the badge reads its own live quote, and `quote` is
   * only the price known when the catalog was built (enough to size a layout).
   */
  liveBadge?: boolean;
}

export interface UseInlineTickersOptions {
  liveQuotes?: boolean;
  /**
   * How long a badge must stay mounted before it resolves anything. Rows in a
   * virtualised table mount only while they are in the visible range, so a
   * settle window means rows flicked past during a scroll never cost a lookup
   * or a quote subscription.
   */
  settleMs?: number;
  /**
   * Leave live prices to the badges. The catalog then changes only when a
   * symbol resolves or its first quote lands, so a host that lays out a whole
   * document (a chat transcript, an answer, a detail page) does not re-render
   * on every tick; each badge re-renders on its own symbol's quote instead.
   * Render the entries with `InlineTickerBadge`.
   */
  badgeQuotes?: boolean;
}

/**
 * Badges print the day's change rounded to 0.1%, so they gain nothing from the
 * fast lane a portfolio row or a detail price gets. They stream as off-screen,
 * low-weight targets: about one update a second, and they give way to the
 * symbols a user is watching when a plan's symbol budget runs out.
 */
export const INLINE_TICKER_STREAM_WEIGHT = 20;

const NO_INSTRUMENTS: InstrumentRef[] = [];
const resolutionInFlight = new Map<string, Promise<void>>();
const quoteInFlight = new Map<string, Promise<void>>();

function normalizeSymbols(texts: readonly string[]): string[] {
  return collectUniqueTickerSymbols(texts);
}

function quoteFailureKind(entry: QueryEntry<Quote> | undefined): InlineTickerFailureKind {
  const reasonCode = entry?.error?.reasonCode;
  return reasonCode === "NOT_FOUND" || reasonCode === "BAD_MAPPING" || reasonCode === "NO_DATA"
    ? "unknown"
    : "error";
}

interface InlineTickerContext {
  tickers: ReadonlyMap<string, TickerRecord>;
  financials: ReadonlyMap<string, TickerFinancials>;
  dispatch: (action: AppAction) => void;
  registry: PluginRegistry | undefined;
}

interface QuoteRequest {
  instrument: InstrumentRef;
  context: InlineTickerContext;
}

/**
 * Every badge in a table is its own component asking for its own symbol. Each
 * one queues here instead of fetching, so the whole visible page of rows leaves
 * as a single batch the coordinator can dedupe, cache and prioritise.
 */
let pendingQuoteBatch: { requests: Map<string, QuoteRequest>; promise: Promise<void> } | null = null;

function queueQuoteLoad(symbol: string, request: QuoteRequest): Promise<void> {
  if (!pendingQuoteBatch) {
    const requests = new Map<string, QuoteRequest>();
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        pendingQuoteBatch = null;
        void loadInlineQuotes(requests).finally(resolve);
      }, 0);
    });
    pendingQuoteBatch = { requests, promise };
  }
  pendingQuoteBatch.requests.set(symbol, request);
  return pendingQuoteBatch.promise;
}

async function loadInlineQuotes(requests: Map<string, QuoteRequest>): Promise<void> {
  const batch = [...requests.entries()];
  if (batch.length === 0) return;
  const coordinator = getSharedMarketDataCoordinator();

  if (coordinator) {
    const entries = await coordinator.loadQuotesBatch(batch.map(([, request]) => request.instrument));
    batch.forEach(([symbol, request], index) => {
      const entry = entries[index];
      const quote = entry ? resolveEntryValue(entry) : null;
      if (quote) {
        inlineTickerQuoteFailures.clear(symbol);
        request.context.dispatch({ type: "MERGE_QUOTE", symbol, quote });
        return;
      }
      inlineTickerQuoteFailures.record(symbol, quoteFailureKind(entry));
    });
    return;
  }

  // Without a coordinator there is nothing to batch through, so each symbol
  // asks the provider directly.
  await Promise.all(batch.map(async ([symbol, { instrument, context }]) => {
    const provider = context.registry?.marketData;
    if (!provider) return;
    try {
      const quote = await provider.getQuote(
        symbol,
        instrument.exchange ?? "",
        instrument.instrument
          ? {
            brokerId: instrument.brokerId,
            brokerInstanceId: instrument.brokerInstanceId,
            instrument: instrument.instrument,
          }
          : undefined,
      );
      inlineTickerQuoteFailures.clear(symbol);
      context.dispatch({ type: "MERGE_QUOTE", symbol, quote });
    } catch {
      inlineTickerQuoteFailures.record(symbol, "error");
    }
  }));
}

function subscribeQuoteKeys(keys: readonly string[], listener: () => void): () => void {
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator || keys.length === 0) return () => {};
  if (typeof coordinator.subscribeKeys === "function") return coordinator.subscribeKeys(keys, listener);
  return coordinator.subscribe(listener);
}

function quoteKeysVersion(keys: readonly string[]): number {
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator || keys.length === 0) return 0;
  if (typeof coordinator.getKeysVersion === "function") return coordinator.getKeysVersion(keys);
  return coordinator.getVersion();
}

function readQuote(instrument: InstrumentRef): Quote | null {
  const entry = getSharedMarketDataCoordinator()?.getQuoteEntry(instrument);
  return entry ? resolveEntryValue(entry) : null;
}

/**
 * Which of the instruments have any quote yet, as a string that only changes
 * when one arrives or goes away. Ticks leave it alone, so the host holding the
 * catalog does not re-render with the market.
 */
function useQuotePresence(instruments: readonly InstrumentRef[]): string {
  const keys = useMemo(() => instruments.map((instrument) => buildQuoteKey(instrument)), [instruments]);
  const subscribe = useCallback((listener: () => void) => subscribeQuoteKeys(keys, listener), [keys]);
  const getSnapshot = useCallback(
    () => instruments.map((instrument) => (readQuote(instrument) ? "1" : "0")).join(""),
    [instruments],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => "");
}

/**
 * One badge's live quote. Subscribes to that symbol's quote key only, so a tick
 * re-renders this badge and nothing around it. The stream itself is opened by
 * `useInlineTickers`; this only reads what it fills.
 */
export function useInlineTickerQuote(
  symbol: string | null,
  ticker: TickerRecord | null | undefined,
): Quote | null {
  const instrument = useMemo(
    () => (symbol ? instrumentFromTicker(ticker ?? null, symbol) : null),
    [symbol, ticker],
  );
  const key = instrument ? buildQuoteKey(instrument) : null;
  const keys = useMemo(() => (key ? [key] : []), [key]);
  const subscribe = useCallback((listener: () => void) => subscribeQuoteKeys(keys, listener), [keys]);
  const getSnapshot = useCallback(() => quoteKeysVersion(keys), [keys]);
  const version = useSyncExternalStore(subscribe, getSnapshot, () => 0);
  return useMemo(() => (instrument ? readQuote(instrument) : null), [instrument, version]);
}

export function useInlineTickerOpener(): (symbol: string) => void {
  const registry = getSharedRegistry();
  return useCallback((symbol: string) => {
    registry?.pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [registry]);
}

export function useInlineTickers(
  texts: readonly string[],
  options: UseInlineTickersOptions = {},
): {
  catalog: Record<string, InlineTickerCatalogEntry>;
  openTicker: (symbol: string) => void;
} {
  const liveQuotes = options.liveQuotes ?? true;
  const badgeQuotes = liveQuotes && options.badgeQuotes === true;
  const settleMs = Math.max(0, options.settleMs ?? 0);
  const dispatch = useAppDispatch();
  const tickers = useAppSelector((state) => state.tickers);
  const financials = useAppSelector((state) => state.financials);
  const registry = getSharedRegistry();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [settled, setSettled] = useState(settleMs <= 0);
  const textsKey = texts.join("\u0000");
  const symbols = useMemo(() => normalizeSymbols(texts), [textsKey]);
  const symbolsKey = symbols.join("|");
  const financialsEffectTarget = liveQuotes ? financials : null;
  const latestRef = useRef<InlineTickerContext>({ tickers, financials, dispatch, registry });

  latestRef.current = { tickers, financials, dispatch, registry };

  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), settleMs);
    return () => clearTimeout(timer);
  }, [settleMs, settled]);

  const instruments = useMemo(() => {
    if (!liveQuotes) return NO_INSTRUMENTS;
    return symbols.flatMap((symbol) => {
      const instrument = instrumentFromTicker(tickers.get(symbol) ?? null, symbol);
      return instrument && tickers.has(symbol) ? [instrument] : [];
    });
  }, [liveQuotes, symbolsKey, tickers]);
  const streamingTargets = useMemo(() => {
    if (!settled) return [];
    return instruments.map((instrument) => ({
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      surface: "inline" as const,
      visible: false,
      weight: INLINE_TICKER_STREAM_WEIGHT,
      context: instrument.instrument
        ? {
          brokerId: instrument.brokerId,
          brokerInstanceId: instrument.brokerInstanceId,
          instrument: instrument.instrument,
        }
        : undefined,
    }));
  }, [instruments, settled]);

  useQuoteStreaming(streamingTargets);
  // The stream fills the coordinator, so reading it here is what makes a badge
  // tick with the market instead of freezing on its first snapshot. With
  // `badgeQuotes` the host only learns when a first quote lands; the badges
  // follow the ticks themselves.
  const observed = settled ? instruments : NO_INSTRUMENTS;
  const quoteEntries = useQuoteEntries(badgeQuotes ? NO_INSTRUMENTS : observed);
  const quotePresence = useQuotePresence(badgeQuotes ? observed : NO_INSTRUMENTS);
  const readStreamedQuote = useCallback((symbol: string): Quote | null => {
    const ticker = latestRef.current.tickers.get(symbol);
    const instrument = ticker ? instrumentFromTicker(ticker, symbol) : null;
    if (!instrument) return null;
    if (badgeQuotes) return readQuote(instrument);
    const entry = quoteEntries.get(buildQuoteKey(instrument));
    return entry ? resolveEntryValue(entry) : null;
  }, [badgeQuotes, quoteEntries, quotePresence]);

  useEffect(() => {
    if (!settled) return;
    // A rebound registry is a new provider, a reconnect, or a network that came
    // back, and none of the old verdicts survive it.
    inlineTickerResolutionFailures.scopeTo(registry);
    inlineTickerQuoteFailures.scopeTo(registry);

    let mounted = true;
    const notify = () => {
      if (!mounted) return;
      setRefreshVersion((value) => value + 1);
    };
    const now = Date.now();
    const pendingQuotes = new Map<string, InstrumentRef>();

    for (const symbol of symbols) {
      const current = latestRef.current;
      const currentTicker = current.tickers.get(symbol) ?? null;
      const currentQuote = liveQuotes
        ? readStreamedQuote(symbol) ?? current.financials.get(symbol)?.quote ?? null
        : null;

      if (currentTicker && (!liveQuotes || currentQuote)) {
        inlineTickerResolutionFailures.clear(symbol);
        if (liveQuotes) inlineTickerQuoteFailures.clear(symbol);
        continue;
      }

      if (!currentTicker) {
        if (inlineTickerResolutionFailures.read(symbol, now)) continue;
        let resolution = resolutionInFlight.get(symbol);
        if (!resolution) {
          resolution = (async () => {
            const current = latestRef.current;
            const activeRegistry = current.registry;
            if (!activeRegistry) return;
            const resolved = await resolveTickerSearch({
              query: symbol,
              activeTicker: null,
              tickers: current.tickers,
              dataProvider: activeRegistry.marketData,
            });

            if (!resolved) {
              inlineTickerResolutionFailures.record(symbol, "unknown");
              return;
            }

            if (resolved.kind === "local") return;

            const { ticker, created } = await upsertTickerFromSearchResult(activeRegistry.tickerRepository, resolved.result);
            current.dispatch({ type: "UPDATE_TICKER", ticker });
            if (created) {
              activeRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
            }
            inlineTickerResolutionFailures.clear(symbol);
          })()
            .catch((error: unknown) => {
              // An ambiguous symbol resolved fine, it just named several
              // listings. The badge stays, and clicking it asks which one.
              inlineTickerResolutionFailures.record(
                symbol,
                error instanceof AmbiguousTickerError ? "ambiguous" : "error",
              );
            })
            .finally(() => {
              resolutionInFlight.delete(symbol);
            });
          resolutionInFlight.set(symbol, resolution);
        }
        void resolution.finally(notify);
        continue;
      }

      if (!liveQuotes || quoteInFlight.has(symbol) || inlineTickerQuoteFailures.read(symbol, now)) continue;
      const instrument = instrumentFromTicker(currentTicker, symbol);
      if (instrument) pendingQuotes.set(symbol, instrument);
    }

    if (pendingQuotes.size > 0) {
      const context = latestRef.current;
      let batch: Promise<void> | undefined;
      for (const [symbol, instrument] of pendingQuotes) {
        batch = queueQuoteLoad(symbol, { instrument, context });
      }
      const request = batch!
        .catch(() => {
          for (const symbol of pendingQuotes.keys()) {
            inlineTickerQuoteFailures.record(symbol, "error");
          }
        })
        .finally(() => {
          for (const symbol of pendingQuotes.keys()) {
            if (quoteInFlight.get(symbol) === request) quoteInFlight.delete(symbol);
          }
        });
      for (const symbol of pendingQuotes.keys()) {
        quoteInFlight.set(symbol, request);
      }
      void request.finally(notify);
    }

    return () => {
      mounted = false;
    };
  }, [
    dispatch,
    financialsEffectTarget,
    liveQuotes,
    readStreamedQuote,
    refreshVersion,
    registry,
    settled,
    symbols,
    symbolsKey,
    tickers,
  ]);

  // Nothing re-renders when a cached failure ages out, so the earliest retry
  // wakes the effect that would otherwise wait for unrelated state to change.
  useEffect(() => {
    if (!settled) return;
    const now = Date.now();
    const deadlines = [
      inlineTickerResolutionFailures.nextRetryAt(symbols, now),
      liveQuotes ? inlineTickerQuoteFailures.nextRetryAt(symbols, now) : null,
    ].filter((deadline): deadline is number => deadline != null);
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => setRefreshVersion((value) => value + 1),
      Math.max(0, Math.min(...deadlines) - now) + 50,
    );
    return () => clearTimeout(timer);
  }, [liveQuotes, refreshVersion, settled, symbols, symbolsKey]);

  const openTicker = useInlineTickerOpener();

  const catalog = useMemo(() => {
    const entries: Record<string, InlineTickerCatalogEntry> = {};
    for (const symbol of symbols) {
      const ticker = tickers.get(symbol) ?? null;
      const quote = liveQuotes
        ? readStreamedQuote(symbol) ?? financials.get(symbol)?.quote ?? null
        : null;
      const resolutionFailure = ticker ? null : inlineTickerResolutionFailures.read(symbol);
      // A ticker the provider cannot price is still a ticker: it keeps its
      // badge and simply shows no change. `missing` is reserved for text that
      // never named an instrument at all.
      const status: InlineTickerStatus = ticker
        ? liveQuotes && !quote && !inlineTickerQuoteFailures.read(symbol)
          ? "loading"
          : "ready"
        : resolutionFailure === "ambiguous"
          ? "ambiguous"
          : resolutionFailure
            ? "missing"
            : "loading";
      entries[symbol] = badgeQuotes ? { status, ticker, quote, liveBadge: true } : { status, ticker, quote };
    }
    return entries;
  }, [badgeQuotes, financials, liveQuotes, readStreamedQuote, refreshVersion, symbols, tickers]);

  return { catalog, openTicker };
}
