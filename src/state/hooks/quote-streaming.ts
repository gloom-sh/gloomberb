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

export function useQuoteStreaming(targets: QuoteSubscriptionTarget[]): void {
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
    if (!appActive) {
      if (normalizedTargets.length > 0) {
        quoteStreamLog.info("skipping subscription while inactive", { targets: subscriptionKey });
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
  }, [appActive, coordinator, subscriptionKey]);
}

/**
 * Subscribe to a bounded target set and observe the coordinator entries filled
 * by that stream. This intentionally avoids per-symbol HTTP quote loads.
 */
export function useLiveQuoteEntries(targets: QuoteSubscriptionTarget[]): {
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
  const subscriptionKey = `${appActive ? "active" : "inactive"}\u001f${targetKey}`;
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

  useQuoteStreaming(targets);
  return {
    entries: useQuoteEntries(instruments),
    freshnessNow,
    subscriptionStartedAt: subscriptionRef.current.startedAt,
  };
}
