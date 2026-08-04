import { useEffect, useMemo, useRef, useState } from "react";
import { useAppActive } from "../app/activity";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { debugLog } from "../../utils/debug-log";
import { normalizeSymbol } from "../../utils/exchanges";
import { getSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { useQuoteEntries } from "../../market-data/hooks";
import type { InstrumentRef } from "../../market-data/request-types";
import type { QueryEntry } from "../../market-data/result-types";
import { buildQuoteKey } from "../../market-data/selectors";

const quoteStreamLog = debugLog.createLogger("quote-stream");
export const DEFAULT_QUOTE_POLL_INTERVAL_MS = 60_000;

export interface QuoteStreamingOptions {
  enabled?: boolean;
}

export interface QuoteUpdateOptions {
  liveStreaming?: boolean;
  pollIntervalMs?: number;
  freshnessScopeKey?: string;
}

export function normalizeQuoteStreamSubscriptionTarget(target: QuoteSubscriptionTarget): QuoteSubscriptionTarget | null {
  const symbol = normalizeSymbol(target.symbol);
  if (!symbol) return null;
  return {
    ...target,
    symbol,
    exchange: target.exchange?.trim().toUpperCase() ?? "",
  };
}

export function buildQuoteStreamSubscriptionKey(target: QuoteSubscriptionTarget): string {
  const contractKey = target.context?.instrument?.conId
    ?? target.context?.instrument?.localSymbol
    ?? target.context?.instrument?.symbol
    ?? "";
  const weight = Number.isFinite(target.weight) ? String(target.weight) : "";
  return [
    target.symbol,
    target.exchange ?? "",
    target.context?.brokerId ?? "",
    target.context?.brokerInstanceId ?? "",
    contractKey,
    target.route ?? "auto",
    target.surface ?? "",
    target.visible ? "visible" : "",
    target.selected ? "selected" : "",
    weight,
  ].join("|");
}

export function useQuoteStreaming(
  targets: QuoteSubscriptionTarget[],
  { enabled = true }: QuoteStreamingOptions = {},
): void {
  const appActive = useAppActive();
  const coordinator = getSharedMarketDataCoordinator();

  const normalizedEntries = new Map<string, QuoteSubscriptionTarget>();
  for (const target of targets) {
    const normalized = normalizeQuoteStreamSubscriptionTarget(target);
    if (!normalized) continue;
    const key = buildQuoteStreamSubscriptionKey(normalized);
    normalizedEntries.set(key, normalized);
  }
  const sortedEntries = [...normalizedEntries.entries()].sort(([left], [right]) => left.localeCompare(right));
  const normalizedTargets = sortedEntries.map(([, target]) => target);
  const subscriptionKey = sortedEntries.map(([key]) => key).join("|");

  useEffect(() => {
    if (!enabled || !appActive) {
      if (normalizedTargets.length > 0) {
        quoteStreamLog.info("skipping subscription", {
          reason: enabled ? "inactive" : "disabled",
          targets: subscriptionKey,
        });
      }
      return;
    }
    if (!coordinator || normalizedTargets.length === 0) return;
    quoteStreamLog.info("subscribe", {
      providerId: "market-data",
      count: normalizedTargets.length,
      targets: subscriptionKey,
    });
    const unsubscribe = coordinator.subscribeQuotes(normalizedTargets.map((target) => ({
      instrument: {
        symbol: target.symbol,
        exchange: target.exchange,
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
        instrument: target.context?.instrument ?? null,
      },
      priority: {
        route: target.route,
        surface: target.surface,
        visible: target.visible,
        selected: target.selected,
        weight: target.weight,
      },
    })));
    return () => {
      quoteStreamLog.info("unsubscribe", {
        providerId: "market-data",
        count: normalizedTargets.length,
        targets: subscriptionKey,
      });
      unsubscribe?.();
    };
  }, [appActive, coordinator, enabled, subscriptionKey]);
}

export function useQuoteUpdates(
  targets: QuoteSubscriptionTarget[],
  {
    liveStreaming = true,
    pollIntervalMs = DEFAULT_QUOTE_POLL_INTERVAL_MS,
  }: QuoteUpdateOptions = {},
): void {
  const appActive = useAppActive();
  const coordinator = getSharedMarketDataCoordinator();
  const normalizedTargets = targets.flatMap((target) => {
    const normalized = normalizeQuoteStreamSubscriptionTarget(target);
    return normalized ? [normalized] : [];
  });
  const instrumentKey = normalizedTargets
    .map((target) => buildQuoteKey({
      symbol: target.symbol,
      exchange: target.exchange,
      brokerId: target.context?.brokerId,
      brokerInstanceId: target.context?.brokerInstanceId,
      instrument: target.context?.instrument ?? null,
    }))
    .sort()
    .join("\u001f");
  const instruments = useMemo(() => {
    const unique = new Map<string, InstrumentRef>();
    for (const target of normalizedTargets) {
      const instrument: InstrumentRef = {
        symbol: target.symbol,
        exchange: target.exchange,
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
        instrument: target.context?.instrument ?? null,
      };
      unique.set(buildQuoteKey(instrument), instrument);
    }
    return [...unique.values()];
  }, [instrumentKey]);

  useQuoteStreaming(targets, { enabled: liveStreaming });

  useEffect(() => {
    if (liveStreaming || !appActive || !coordinator || instruments.length === 0) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await coordinator.loadQuotesBatch(instruments, { forceRefresh: true });
      } catch {
        // Polling is best effort and the coordinator retains the last good quote.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const intervalId = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [appActive, coordinator, instrumentKey, instruments, liveStreaming, pollIntervalMs]);
}

/**
 * Subscribe to a bounded target set and observe the coordinator entries filled
 * by that stream. This intentionally avoids per-symbol HTTP quote loads.
 */
export function useLiveQuoteEntries(
  targets: QuoteSubscriptionTarget[],
  options: QuoteUpdateOptions = {},
): {
  entries: Map<string, QueryEntry<Quote>>;
  freshnessNow: number;
  subscriptionStartedAt: number;
} {
  const appActive = useAppActive();
  const normalizedTargets = targets.flatMap((target) => {
    const normalized = normalizeQuoteStreamSubscriptionTarget(target);
    return normalized ? [normalized] : [];
  });
  const targetKey = normalizedTargets
    .map((target) => buildQuoteStreamSubscriptionKey(target))
    .sort()
    .join("\u001f");
  const liveStreaming = options.liveStreaming !== false;
  const freshnessKey = options.freshnessScopeKey ?? targetKey;
  const subscriptionKey = `${appActive ? "active" : "inactive"}\u001f${liveStreaming ? "live" : "poll"}\u001f${freshnessKey}`;
  const subscriptionRef = useRef({
    key: subscriptionKey,
    startedAt: Date.now(),
  });
  if (subscriptionRef.current.key !== subscriptionKey) {
    subscriptionRef.current = {
      key: subscriptionKey,
      startedAt: Date.now(),
    };
  }
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  const instruments = useMemo(() => {
    const unique = new Map<string, InstrumentRef>();
    for (const target of normalizedTargets) {
      const instrument: InstrumentRef = {
        symbol: target.symbol,
        exchange: target.exchange,
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
        instrument: target.context?.instrument ?? null,
      };
      unique.set(buildQuoteKey(instrument), instrument);
    }
    return [...unique.values()];
  }, [targetKey]);

  useEffect(() => {
    setFreshnessNow(Date.now());
    if (!appActive || normalizedTargets.length === 0) return;
    const interval = setInterval(() => setFreshnessNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [appActive, targetKey]);

  useQuoteUpdates(targets, options);
  return {
    entries: useQuoteEntries(instruments),
    freshnessNow,
    subscriptionStartedAt: subscriptionRef.current.startedAt,
  };
}
