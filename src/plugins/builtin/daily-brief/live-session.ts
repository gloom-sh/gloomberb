import { useEffect, useMemo, useRef, useState } from "react";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { LiveBarAccumulator } from "../../../time-series/live-bars";
import { LIVE_CHART_TERMINAL_FRAME_MS, createLiveChartRefresher } from "../../../time-series/live-quotes";
import { mergePriceHistoryWindows } from "../../../time-series/resolve";
import type { DataProvider, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { useUiCapabilities } from "../../../ui";
import { loadSessionPoints } from "./session-history";

const ES_SYMBOL = "ES=F";
const ES_EXCHANGES = ["", "CME"] as const;
/** The session chart's bars. The same cadence the price chart paints. */
export const ES_BAR_MS = 5 * 60_000;
/** A closed bar is asked for once the provider has had a moment to settle it. */
const TAIL_SETTLE_MS = 5_000;
/** Recent-window refreshes stay at least this far apart. */
const TAIL_MIN_SPACING_MS = 30_000;

const ES_INSTRUMENT = { symbol: ES_SYMBOL, exchange: "" };

/**
 * Globex keeps trading after the equity after-hours close. Those prints are
 * the session, and the history can confirm them. An equity chart drops them
 * because nothing after 20:00 New York will ever be in its bars.
 */
export function esSessionQuote(quote: Quote | null): Quote | null {
  if (quote?.marketState !== "PREPRE" && quote?.marketState !== "POSTPOST") return quote;
  const price = quote.marketState === "POSTPOST"
    ? quote.postMarketPrice ?? quote.price
    : quote.preMarketPrice ?? quote.price;
  return { ...quote, marketState: "REGULAR", price };
}

/** Fold one quote into the forming 5-minute bar, the way a price chart does. */
export function foldEsSessionBars(
  history: PricePoint[],
  quote: Quote | null,
  bars: LiveBarAccumulator,
  now: number,
  liveSince: number,
): PricePoint[] {
  return bars.apply(history, esSessionQuote(quote), {
    now,
    resolution: "5m",
    exchange: "CME",
    liveSince,
    extendedHours: true,
  });
}

/** The recent window a price chart refetches when the tail jumps or a bar closes. */
export function esTailWindow(latest: number, now: number): { start: number; end: number } {
  return {
    start: Math.floor((latest - ES_BAR_MS) / ES_BAR_MS) * ES_BAR_MS,
    end: Math.ceil(now / 60_000) * 60_000,
  };
}

function sameSeries(left: readonly PricePoint[], right: readonly PricePoint[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = left.length - 1; index >= 0; index -= 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (a.date.getTime() !== b.date.getTime() || a.open !== b.open || a.high !== b.high
      || a.low !== b.low || a.close !== b.close || a.volume !== b.volume) return false;
  }
  return true;
}

/**
 * The loaded session, with quotes folded into the forming bar and a missing
 * tail filled from a recent-window refetch. The 17:00 New York halt stays
 * empty: a quote never invents the bars in between.
 */
export function useEsSessionSeries(
  history: readonly PricePoint[],
  provider: DataProvider | null,
  focused: boolean,
  start: number,
): PricePoint[] {
  const desktopWeb = useUiCapabilities().nativePaneChrome === true;
  const liveStreaming = useLiveStreamingSetting();
  const targets = useMemo<QuoteSubscriptionTarget[]>(() => [{
    symbol: ES_SYMBOL,
    exchange: "",
    surface: "detail",
    visible: true,
    selected: focused,
    weight: 1,
  }], [focused]);
  const { entries } = useLiveQuoteEntries(targets, { liveStreaming });
  const stored = resolveEntryData(entries.get(buildQuoteKey(ES_INSTRUMENT))) ?? null;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const frame = desktopWeb ? 0 : LIVE_CHART_TERMINAL_FRAME_MS;
  const [quote, setQuote] = useState<Quote | null>(stored);
  const refresherRef = useRef<ReturnType<typeof createLiveChartRefresher> | null>(null);
  useEffect(() => {
    const refresher = createLiveChartRefresher(() => setQuote(storedRef.current), frame);
    refresherRef.current = refresher;
    refresher.request();
    return () => {
      refresher.dispose();
      refresherRef.current = null;
    };
  }, [frame]);
  useEffect(() => {
    refresherRef.current?.request();
  }, [stored]);

  const [tracked, setTracked] = useState(history);
  const [tail, setTail] = useState<PricePoint[]>([]);
  const barsRef = useRef(new LiveBarAccumulator());
  const historyEpochRef = useRef(0);
  const pendingSoonRef = useRef(false);
  // A full reload is the session. Drop the previous tail and the bars folded
  // onto it, then let the current quote form against the bars just loaded.
  if (history !== tracked) {
    historyEpochRef.current += 1;
    pendingSoonRef.current = false;
    barsRef.current = new LiveBarAccumulator();
    setTracked(history);
    setTail([]);
  }
  const activeTail = history === tracked ? tail : [];
  const series = useMemo(() => {
    const rows = history as PricePoint[];
    // The refetch is the newer copy of the bars it overlaps. A full reload
    // replaces it, so a stale tail cannot paint over the session just loaded.
    const combined = activeTail.length === 0 ? rows : mergePriceHistoryWindows(rows, activeTail, "5m");
    const first = combined[0]?.date.getTime();
    if (first == null || first >= start) return combined;
    return combined.filter((point) => point.date.getTime() >= start);
  }, [activeTail, history, start]);

  const liveSinceRef = useRef(Date.now());
  const sessionQuote = useMemo(() => esSessionQuote(quote), [quote]);
  const painted = series.length === 0 ? series : foldEsSessionBars(
    series,
    sessionQuote,
    barsRef.current,
    Date.now(),
    liveSinceRef.current,
  );
  const stableRef = useRef(painted);
  if (!sameSeries(stableRef.current, painted)) stableRef.current = painted;

  const seriesRef = useRef(series);
  seriesRef.current = series;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const quoteRef = useRef(sessionQuote);
  quoteRef.current = sessionQuote;
  // The loaded window can already be behind the quote. The first tail request
  // runs as soon as it is due; later ones stay spaced apart.
  const reconcileAtRef = useRef(Number.NEGATIVE_INFINITY);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dueAt = Number.POSITIVE_INFINITY;
    let timerEpoch = -1;
    let request = 0;
    // Quotes rewrite the forming candle on their own. Rescheduling this timer
    // must not drop a tail refetch already in flight, or each ES print cancels
    // the bars that fill a stretch the session missed.
    const schedule = () => {
      if (!mounted) return;
      const active = providerRef.current;
      const rows = seriesRef.current;
      if (!active || rows.length === 0) return;
      const soon = pendingSoonRef.current;
      if (!soon && quoteRef.current == null) return;
      const latest = rows.at(-1)?.date.getTime();
      if (latest == null || !Number.isFinite(latest)) return;
      const now = Date.now();
      const due = Math.max(
        soon ? now : latest + ES_BAR_MS + TAIL_SETTLE_MS,
        reconcileAtRef.current + TAIL_MIN_SPACING_MS,
      );
      const epoch = historyEpochRef.current;
      if (timer !== null && due >= dueAt && timerEpoch === epoch) return;
      if (timer !== null) clearTimeout(timer);
      dueAt = due;
      timerEpoch = epoch;
      timer = setTimeout(() => {
        timer = null;
        dueAt = Number.POSITIVE_INFINITY;
        if (!mounted) return;
        if (epoch !== historyEpochRef.current) {
          schedule();
          return;
        }
        pendingSoonRef.current = false;
        const providerNow = providerRef.current;
        const endBar = seriesRef.current.at(-1)?.date.getTime();
        if (!providerNow || endBar == null || !Number.isFinite(endBar)) return;
        reconcileAtRef.current = Date.now();
        const window = esTailWindow(endBar, Date.now());
        const id = ++request;
        void loadSessionPoints(providerNow, ES_SYMBOL, ES_EXCHANGES, window.start, window.end).then((points) => {
          if (!mounted || id !== request || epoch !== historyEpochRef.current || points.length === 0) return;
          setTail((current) => {
            const merged = mergePriceHistoryWindows(current, points, "5m");
            return sameSeries(merged, current) ? current : merged;
          });
        });
      }, Math.max(0, due - now));
    };
    scheduleRef.current = schedule;
    schedule();
    return () => {
      mounted = false;
      scheduleRef.current = () => {};
      if (timer !== null) clearTimeout(timer);
    };
  }, [provider]);

  useEffect(() => {
    if (barsRef.current.takeReconcileRequest()) pendingSoonRef.current = true;
    scheduleRef.current();
  }, [provider, series, sessionQuote]);

  return stableRef.current;
}
