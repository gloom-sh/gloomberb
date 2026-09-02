import { useEffect, useMemo, useRef, useState } from "react";
import { useAppActive } from "../app/activity";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { debugLog } from "../../utils/debug-log";
import { normalizeSymbol } from "../../utils/exchanges";
import { getSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../market-data/coordinator";
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

export function buildQuoteStreamSubscriptionIdentityKey(target: QuoteSubscriptionTarget): string {
  const contractKey = target.context?.instrument?.conId
    ?? target.context?.instrument?.localSymbol
    ?? target.context?.instrument?.symbol
    ?? "";
  return [
    target.symbol,
    target.exchange ?? "",
    target.context?.brokerId ?? "",
    target.context?.brokerInstanceId ?? "",
    contractKey,
    target.route ?? "auto",
  ].join("|");
}

export function buildQuoteStreamSubscriptionKey(target: QuoteSubscriptionTarget): string {
  const weight = Number.isFinite(target.weight) ? String(target.weight) : "";
  return [
    buildQuoteStreamSubscriptionIdentityKey(target),
    target.surface ?? "",
    target.visible ? "visible" : "",
    target.selected ? "selected" : "",
    weight,
  ].join("|");
}

type CoordinatorQuoteTargets = Parameters<MarketDataCoordinator["subscribeQuotes"]>[0];
type UpdateableQuoteSubscription = (() => void) & {
  update?: (targets: CoordinatorQuoteTargets) => void;
};

interface ActiveQuoteSubscription {
  identityKey: string;
  subscriptionKey: string;
  count: number;
  dispose: UpdateableQuoteSubscription;
}

function toCoordinatorQuoteTargets(targets: QuoteSubscriptionTarget[]): CoordinatorQuoteTargets {
  return targets.map((target) => ({
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
  }));
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
  const identityKey = [...new Set(normalizedTargets.map(buildQuoteStreamSubscriptionIdentityKey))]
    .sort()
    .join("\u001f");
  const coordinatorTargets = toCoordinatorQuoteTargets(normalizedTargets);
  const latestSubscriptionRef = useRef({
    identityKey,
    subscriptionKey,
    targets: coordinatorTargets,
  });
  latestSubscriptionRef.current = {
    identityKey,
    subscriptionKey,
    targets: coordinatorTargets,
  };
  const activeSubscriptionRef = useRef<ActiveQuoteSubscription | null>(null);

  useEffect(() => {
    const latest = latestSubscriptionRef.current;
    if (!enabled || !appActive) {
      if (latest.targets.length > 0) {
        quoteStreamLog.info("skipping subscription", {
          reason: enabled ? "inactive" : "disabled",
          targets: latest.subscriptionKey,
        });
      }
      return;
    }
    if (!coordinator || latest.targets.length === 0) return;
    quoteStreamLog.info("subscribe", {
      providerId: "market-data",
      count: latest.targets.length,
      targets: latest.subscriptionKey,
    });
    const active: ActiveQuoteSubscription = {
      identityKey: latest.identityKey,
      subscriptionKey: latest.subscriptionKey,
      count: latest.targets.length,
      dispose: coordinator.subscribeQuotes(latest.targets) as UpdateableQuoteSubscription,
    };
    activeSubscriptionRef.current = active;
    return () => {
      if (activeSubscriptionRef.current === active) {
        activeSubscriptionRef.current = null;
      }
      quoteStreamLog.info("unsubscribe", {
        providerId: "market-data",
        count: active.count,
        targets: active.subscriptionKey,
      });
      active.dispose();
    };
  }, [appActive, coordinator, enabled, identityKey]);

  useEffect(() => {
    if (!enabled || !appActive || !coordinator) return;
    const active = activeSubscriptionRef.current;
    const latest = latestSubscriptionRef.current;
    if (
      !active
      || active.identityKey !== latest.identityKey
      || active.subscriptionKey === latest.subscriptionKey
    ) {
      return;
    }

    quoteStreamLog.info("update subscription", {
      providerId: "market-data",
      count: latest.targets.length,
      targets: latest.subscriptionKey,
    });
    if (typeof active.dispose.update === "function") {
      active.dispose.update(latest.targets);
    } else {
      const previousDispose = active.dispose;
      active.dispose = coordinator.subscribeQuotes(latest.targets) as UpdateableQuoteSubscription;
      previousDispose();
    }
    active.subscriptionKey = latest.subscriptionKey;
    active.count = latest.targets.length;
  }, [appActive, coordinator, enabled, identityKey, subscriptionKey]);
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
  const targetKey = [...new Set(
    normalizedTargets.map((target) => buildQuoteStreamSubscriptionIdentityKey(target)),
  )]
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
