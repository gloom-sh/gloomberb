import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataTableVisibleRange, PaneFooterSegment } from "../../../components";
import { useQuoteEntries } from "../../../market-data/hooks";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { useAppVisible, usePaneVisible } from "../../../state/app/activity";
import { useQuoteStreaming } from "../../../state/hooks/quote-streaming";
import { colors } from "../../../theme/colors";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { MarketState, Quote } from "../../../types/financials";
import { useAssetData } from "../../runtime";

export interface BoardQuoteState {
  quote: Quote | null;
  loading: boolean;
  error: string | null;
  /** The quote is the last good one, kept because the newest load returned nothing. */
  stale: boolean;
}

export type BoardQuoteMap = Map<string, BoardQuoteState>;

export interface QuoteBoardOptions {
  /** Stream the board over the shared quote feed. Off, the snapshot poll carries every symbol. */
  liveStreaming?: boolean;
  /**
   * Symbols on screen, including any overscan. They stream at full rate and
   * rank first when the plan caps how many symbols one client may stream;
   * the rest of the board streams at the off-screen cadence. Omitted, every
   * symbol counts as on screen.
   */
  visibleSymbols?: ReadonlySet<string> | null;
  selectedSymbol?: string | null;
  /** Snapshot poll cadence for on-screen symbols the stream is not carrying. */
  fallbackIntervalMs?: number;
}

/**
 * The snapshot poll covers what the stream cannot: symbols the plan's stream
 * cap evicted, listings no live feed carries, and a dropped connection. It
 * runs only while the board can be seen.
 */
const QUOTE_BOARD_FALLBACK_MS = 60_000;
/** An open market the stream has not moved for this long is polled as well. */
const STREAM_SILENCE_MS = 3 * 60_000;

const EMPTY_STATE: BoardQuoteState = { quote: null, loading: false, error: null, stale: false };

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function boardInstrument(symbol: string): InstrumentRef {
  return { symbol, exchange: "" };
}

/**
 * A failed refresh must not blank a board that was showing prices a second
 * ago: keep the last good quote and mark it stale instead.
 */
function mergeQuotes(previous: BoardQuoteMap, loaded: BoardQuoteMap): BoardQuoteMap {
  const next: BoardQuoteMap = new Map(previous);
  for (const [symbol, state] of loaded) {
    const retained = state.quote ?? previous.get(symbol)?.quote ?? null;
    next.set(symbol, {
      quote: retained,
      loading: false,
      error: state.error,
      stale: !state.quote && retained !== null,
    });
  }
  return next;
}

function finitePrice(quote: Quote | null): quote is Quote {
  return !!quote && typeof quote.price === "number" && Number.isFinite(quote.price);
}

/**
 * Whether the stream is keeping a symbol current: it delivered since this
 * subscription started (the server sends a snapshot on subscribe, so a quiet
 * closed market still counts), the connection has not marked it stale, and an
 * open market has not gone silent.
 */
function isStreamCarryingQuote(
  entry: QueryEntry<Quote> | undefined,
  subscriptionStartedAt: number,
  now: number,
): boolean {
  const quote = resolveEntryData(entry);
  if (!finitePrice(quote) || quote.stale === true) return false;
  const receivedAt = quote.receivedAt;
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt) || receivedAt < subscriptionStartedAt) return false;
  return quote.marketState !== "REGULAR" || now - receivedAt <= STREAM_SILENCE_MS;
}

/** The newer of the board's snapshot and the shared feed's quote, per symbol. */
function overlayStreamQuote(base: BoardQuoteState, streamed: Quote | null): BoardQuoteState {
  if (!finitePrice(streamed)) return base;
  if (base.quote && (streamed.lastUpdated ?? 0) < (base.quote.lastUpdated ?? 0)) return base;
  if (base.quote === streamed && !base.stale && base.error === null) return base;
  return { quote: streamed, loading: base.loading, error: null, stale: streamed.stale === true };
}

function sameBoard(left: BoardQuoteMap, right: BoardQuoteMap): boolean {
  if (left.size !== right.size) return false;
  const leftEntries = [...left];
  let index = 0;
  for (const [symbol, state] of right) {
    const [leftSymbol, leftState] = leftEntries[index++]!;
    if (leftSymbol !== symbol || leftState !== state) return false;
  }
  return true;
}

interface OverlayCacheEntry {
  base: BoardQuoteState;
  streamed: Quote | null;
  result: BoardQuoteState;
}

/**
 * Quotes for a board of index, futures or FX symbols (world indices, futures,
 * the movers index strip).
 *
 * The first load may serve the provider cache, which is what makes a board
 * paint instantly on open. After that the symbols ride the shared quote feed,
 * deduplicated with every other pane and ranked by what is on screen; the
 * snapshot poll only fills in what the feed is not carrying. A manual refresh
 * bypasses every cache. `symbols` and `visibleSymbols` must keep stable
 * references until their contents change.
 */
export function useQuoteBoard(symbols: string[], options: QuoteBoardOptions = {}): {
  quotes: BoardQuoteMap;
  refresh: () => void;
} {
  const {
    liveStreaming = true,
    visibleSymbols = null,
    selectedSymbol = null,
    fallbackIntervalMs = QUOTE_BOARD_FALLBACK_MS,
  } = options;
  const dataProvider = useAssetData();
  const appVisible = useAppVisible();
  const paneVisible = usePaneVisible();
  const [snapshots, setSnapshots] = useState<BoardQuoteMap>(new Map());
  // A manual refresh can land after an in-flight poll, so only the newest
  // request is allowed to write.
  const fetchGenRef = useRef(0);
  const lastLoadAtRef = useRef(0);

  const targets = useMemo<QuoteSubscriptionTarget[]>(() => symbols.map((symbol) => {
    const selected = symbol === selectedSymbol;
    const visible = !visibleSymbols || visibleSymbols.has(symbol) || selected;
    return {
      symbol,
      exchange: "",
      surface: "screener",
      visible,
      selected,
      weight: selected ? 100 : visible ? 70 : 20,
    };
  }), [selectedSymbol, symbols, visibleSymbols]);
  useQuoteStreaming(targets, { enabled: liveStreaming });
  const instruments = useMemo(() => symbols.map(boardInstrument), [symbols]);
  const entries = useQuoteEntries(instruments);
  // Counted from when the feed could first answer this symbol set.
  const streamKey = `${appVisible && liveStreaming ? "live" : "off"}\u001f${symbols.join("\u001f")}`;
  const streamStartRef = useRef({ key: streamKey, at: Date.now() });
  if (streamStartRef.current.key !== streamKey) streamStartRef.current = { key: streamKey, at: Date.now() };

  const load = useCallback((forceRefresh: boolean, subset: readonly string[] = symbols) => {
    // A background top-up writes only if no full load started after it, and
    // never cancels one: a full load is what clears the loading markers.
    const background = subset !== symbols;
    if (!background) fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    lastLoadAtRef.current = Date.now();

    // A background top-up must not flash "loading" in the footer every minute.
    if (!background) {
      setSnapshots((prev) => {
        const next: BoardQuoteMap = new Map();
        for (const symbol of symbols) {
          next.set(symbol, { ...(prev.get(symbol) ?? EMPTY_STATE), loading: !!dataProvider });
        }
        return next;
      });
    }
    if (!dataProvider || subset.length === 0) return;

    const loadQuotes = async (): Promise<BoardQuoteMap> => {
      const next: BoardQuoteMap = new Map();
      if (dataProvider.getQuotesBatch) {
        const results = await dataProvider.getQuotesBatch(
          subset.map((symbol) => ({ symbol, exchange: "" })),
          { forceRefresh },
        );
        const bySymbol = new Map(results.map((result) => [result.target.symbol, result]));
        for (const symbol of subset) {
          const result = bySymbol.get(symbol);
          next.set(symbol, {
            quote: result?.quote ?? null,
            loading: false,
            error: result?.error ? errorMessage(result.error) : null,
            stale: false,
          });
        }
        return next;
      }

      const context = forceRefresh ? { cacheMode: "refresh" as const } : undefined;
      await Promise.all(subset.map(async (symbol) => {
        try {
          const quote = await dataProvider.getQuote(symbol, "", context);
          next.set(symbol, { quote, loading: false, error: null, stale: false });
        } catch (error: unknown) {
          next.set(symbol, { quote: null, loading: false, error: errorMessage(error), stale: false });
        }
      }));
      return next;
    };

    loadQuotes().then((loaded) => {
      if (fetchGenRef.current !== gen) return;
      setSnapshots((prev) => mergeQuotes(prev, loaded));
    }).catch((error: unknown) => {
      if (fetchGenRef.current !== gen) return;
      const message = errorMessage(error);
      const failed: BoardQuoteMap = new Map(subset.map((symbol) => [
        symbol,
        { quote: null, loading: false, error: message, stale: false },
      ]));
      setSnapshots((prev) => mergeQuotes(prev, failed));
    });
  }, [dataProvider, symbols]);

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    load(false);
    return () => {
      fetchGenRef.current += 1;
    };
  }, [load]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    if (!paneVisible || !dataProvider || symbols.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      const now = Date.now();
      const due = symbols.filter((symbol) => {
        if (visibleSymbols && !visibleSymbols.has(symbol) && symbol !== selectedSymbol) return false;
        if (!liveStreaming) return true;
        const entry = entriesRef.current.get(buildQuoteKey(boardInstrument(symbol)));
        return !isStreamCarryingQuote(entry, streamStartRef.current.at, now);
      });
      if (due.length > 0) load(true, due);
      else lastLoadAtRef.current = now;
      schedule();
    };
    const schedule = () => {
      const delay = lastLoadAtRef.current + fallbackIntervalMs - Date.now();
      timer = setTimeout(poll, Math.max(0, delay));
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [dataProvider, fallbackIntervalMs, liveStreaming, load, paneVisible, selectedSymbol, symbols, visibleSymbols]);

  // Settings changes must affect rows and footer status in the same render,
  // including the frame before the next request effect starts. Unchanged
  // symbols keep their state object so memoized rows can skip the work.
  const overlayCacheRef = useRef(new Map<string, OverlayCacheEntry>());
  const previousQuotesRef = useRef<BoardQuoteMap>(new Map());
  const quotes = useMemo(() => {
    const cache = overlayCacheRef.current;
    const nextCache = new Map<string, OverlayCacheEntry>();
    const next: BoardQuoteMap = new Map();
    for (const symbol of symbols) {
      const base = snapshots.get(symbol);
      if (!base) continue;
      const streamed = resolveEntryData(entries.get(buildQuoteKey(boardInstrument(symbol))));
      const cached = cache.get(symbol);
      const result = cached && cached.base === base && cached.streamed === streamed
        ? cached.result
        : overlayStreamQuote(base, streamed);
      nextCache.set(symbol, { base, streamed, result });
      next.set(symbol, result);
    }
    overlayCacheRef.current = nextCache;
    const previous = previousQuotesRef.current;
    if (sameBoard(previous, next)) return previous;
    previousQuotesRef.current = next;
    return next;
  }, [entries, snapshots, symbols]);

  return { quotes, refresh };
}

/** Rows streamed beyond the visible window so a short scroll lands on live prices. */
const BOARD_STREAM_OVERSCAN = 4;

/**
 * The symbols of the rows on screen plus overscan, as a set that keeps its
 * identity while its contents do not change. `rowSymbols` holds one entry per
 * table row, null for section headers. Before the table reports its window
 * this returns null, which the board reads as "all on screen".
 */
export function useVisibleBoardSymbols(
  rowSymbols: readonly (string | null)[],
  range: DataTableVisibleRange | null,
  overscan = BOARD_STREAM_OVERSCAN,
): ReadonlySet<string> | null {
  const key = range
    ? rowSymbols
      .slice(Math.max(0, range.start - overscan), range.end + overscan)
      .filter((symbol): symbol is string => !!symbol)
      .join("\u001f")
    : null;
  return useMemo(() => (key == null ? null : new Set(key ? key.split("\u001f") : [])), [key]);
}

export interface QuoteBoardStatus {
  loading: number;
  /** Symbols showing their last good quote after a failed load. */
  stale: number;
  /** Symbols with no quote to show at all. */
  unavailable: number;
  latestTs: number;
}

export function quoteBoardStatus(quotes: BoardQuoteMap): QuoteBoardStatus {
  let loading = 0;
  let stale = 0;
  let unavailable = 0;
  let latestTs = 0;
  for (const state of quotes.values()) {
    if (state.loading) loading += 1;
    if (state.stale) stale += 1;
    else if (!state.quote && !state.loading) unavailable += 1;
    latestTs = Math.max(latestTs, state.quote?.lastUpdated ?? 0);
  }
  return { loading, stale, unavailable, latestTs };
}

/** Board footer status: everything here changes as loads succeed or fail. */
export function quoteBoardFooterInfo(status: QuoteBoardStatus): PaneFooterSegment[] {
  const info: PaneFooterSegment[] = [];
  if (status.loading > 0) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
  if (status.stale > 0) {
    info.push({ id: "stale", parts: [{ text: `${status.stale} stale`, tone: "warning" }] });
  }
  if (status.unavailable > 0) {
    info.push({ id: "error", parts: [{ text: `${status.unavailable} unavailable`, tone: "warning" }] });
  }
  if (status.latestTs > 0) {
    info.push({
      id: "fresh",
      parts: [{
        text: new Date(status.latestTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        tone: "muted",
      }],
    });
  }
  return info;
}

/**
 * Board session indicator: one glyph whose color carries the whole signal.
 * `marketStateDot` in `src/market-data/market/status.ts` encodes the state in
 * the glyph instead, which reads poorly in a one-cell column.
 */
export function marketStatusDot(state: MarketState | undefined): { char: string; color: string } {
  switch (state) {
    case "REGULAR":
      return { char: "●", color: colors.positive };
    case "PRE":
    case "POST":
    case "PREPRE":
    case "POSTPOST":
      return { char: "●", color: colors.warning };
    default:
      return { char: "●", color: colors.negative };
  }
}
