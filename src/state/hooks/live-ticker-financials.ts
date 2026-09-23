import { useEffect, useMemo, useRef, useState } from "react";
import { useTickerFinancials, useTickerFinancialsMap } from "../../market-data/hooks";
import {
  quoteSubscriptionTargetFromTicker,
  type TickerInstrumentOptions,
} from "../../market-data/request-types";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { useQuoteStreaming } from "./quote-streaming";

/**
 * How a pane that shows a price asks for it to move. The passive readers
 * (`useTickerFinancials`, `useTickerFinancialsMap`, `usePaneTicker`) only
 * observe the shared store, so on their own a pane is live only while some
 * other pane streams the same symbol. These options open (or join) the stream.
 * Identical symbols merge into one subscription in the coordinator, so a pane
 * that streams what the portfolio already streams costs nothing upstream.
 */
export interface LiveQuoteStreamOptions {
  /** Keep reading passively without streaming, e.g. while a tab is inactive. */
  enabled?: boolean;
  surface?: QuoteSubscriptionTarget["surface"];
  /** Whether the value is on screen; off-screen values are sent about once a second. */
  visible?: boolean;
  selected?: boolean;
  weight?: number;
  /**
   * Portfolio scope for broker-held positions. Must match what the caller
   * reads, or the stream fills a different quote key than the one on screen.
   */
  instrumentOptions?: TickerInstrumentOptions;
}

const NO_TARGETS: QuoteSubscriptionTarget[] = [];
const NO_INSTRUMENT_OPTIONS: TickerInstrumentOptions = {};

function streamRoute(ticker: TickerRecord | null | undefined, options: TickerInstrumentOptions): QuoteSubscriptionTarget["route"] {
  // Same routing as the portfolio pane, so both subscriptions merge on one key.
  if (!options.portfolioId) return "auto";
  return (ticker?.metadata.broker_contracts?.length ?? 0) > 0 ? "broker" : "provider";
}

export function buildLiveQuoteTarget(
  symbol: string | null | undefined,
  ticker: TickerRecord | null | undefined,
  options: LiveQuoteStreamOptions = {},
): QuoteSubscriptionTarget | null {
  const instrumentOptions = options.instrumentOptions ?? NO_INSTRUMENT_OPTIONS;
  const target = quoteSubscriptionTargetFromTicker(ticker, symbol, streamRoute(ticker, instrumentOptions), instrumentOptions);
  if (!target) return null;
  return {
    ...target,
    surface: options.surface ?? "detail",
    visible: options.visible ?? true,
    ...(options.selected !== undefined ? { selected: options.selected } : {}),
    ...(options.weight !== undefined ? { weight: options.weight } : {}),
  };
}

export function buildLiveQuoteTargets(
  tickers: readonly TickerRecord[],
  options: LiveQuoteStreamOptions = {},
): QuoteSubscriptionTarget[] {
  const targets: QuoteSubscriptionTarget[] = [];
  for (const ticker of tickers) {
    const target = buildLiveQuoteTarget(ticker.metadata.ticker, ticker, options);
    if (target) targets.push(target);
  }
  return targets;
}

function optionsKey(options: LiveQuoteStreamOptions): string {
  return [
    options.surface ?? "",
    options.visible === false ? "hidden" : "visible",
    options.selected === undefined ? "" : String(options.selected),
    options.weight ?? "",
    options.instrumentOptions?.portfolioId ?? "",
  ].join("|");
}

/** Stream one symbol's quote into the shared store. Gated on app visibility. */
export function useTickerQuoteStream(
  symbol: string | null | undefined,
  ticker: TickerRecord | null | undefined,
  options: LiveQuoteStreamOptions = {},
): void {
  const key = optionsKey(options);
  const targets = useMemo(() => {
    const target = buildLiveQuoteTarget(symbol, ticker, options);
    return target ? [target] : NO_TARGETS;
    // `options` is compared by value through its key.
  }, [symbol, ticker, key]);
  useQuoteStreaming(targets, { enabled: options.enabled !== false });
}

/** Stream a set of tickers' quotes (deduped per symbol) into the shared store. */
export function useTickerQuoteStreams(
  tickers: readonly TickerRecord[],
  options: LiveQuoteStreamOptions = {},
): void {
  const key = optionsKey(options);
  const targets = useMemo(
    () => buildLiveQuoteTargets(tickers, options),
    [tickers, key],
  );
  useQuoteStreaming(targets, { enabled: options.enabled !== false });
}

/**
 * `useTickerFinancials` that also streams the quote, for a pane that shows the
 * price or something computed from it.
 */
export function useLiveTickerFinancials(
  symbol: string | null | undefined,
  ticker: TickerRecord | null | undefined,
  options: Omit<LiveQuoteStreamOptions, "instrumentOptions"> = {},
): TickerFinancials | null {
  useTickerQuoteStream(symbol, ticker, options);
  return useTickerFinancials(symbol, ticker);
}

/**
 * `useTickerFinancialsMap` that also streams every ticker's quote. Pass the
 * same `instrumentOptions` the map is read with.
 */
export function useLiveTickerFinancialsMap(
  tickers: TickerRecord[],
  options: LiveQuoteStreamOptions = {},
): Map<string, TickerFinancials> {
  useTickerQuoteStreams(tickers, options);
  return useTickerFinancialsMap(tickers, options.instrumentOptions ?? NO_INSTRUMENT_OPTIONS);
}

/**
 * The value, refreshed at most once per `intervalMs`. The first change after a
 * quiet spell passes straight through and a burst of ticks collapses into one
 * trailing update; a new `resetKey` (another portfolio, another symbol set)
 * passes through at once. For statistics derived from live prices, such as the
 * position weights behind a Sharpe ratio or a beta, that gain nothing from
 * every tick.
 */
export function useSampledValue<T>(value: T, intervalMs: number, resetKey = ""): T {
  const [sample, setSample] = useState(() => ({ value, key: resetKey }));
  const lastSampleAtRef = useRef(Number.NEGATIVE_INFINITY);
  const latestRef = useRef({ value, key: resetKey });
  latestRef.current = { value, key: resetKey };

  useEffect(() => {
    if (sample.key !== resetKey) {
      lastSampleAtRef.current = Date.now();
      setSample({ value, key: resetKey });
      return;
    }
    if (Object.is(sample.value, value)) return;
    const wait = lastSampleAtRef.current + intervalMs - Date.now();
    if (wait <= 0) {
      lastSampleAtRef.current = Date.now();
      setSample({ value, key: resetKey });
      return;
    }
    const timer = setTimeout(() => {
      lastSampleAtRef.current = Date.now();
      setSample(latestRef.current);
    }, wait);
    return () => clearTimeout(timer);
  }, [intervalMs, resetKey, sample, value]);

  return sample.key === resetKey ? sample.value : value;
}
