import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPredictionDetailCacheKey,
  buildPredictionDetailResourceKey,
  updatePredictionCatalogCacheEntries,
  updatePredictionDetailCacheEntries,
  updatePredictionErrorState,
  updatePredictionPendingCounts,
} from "../cache";
import type { PredictionCatalogCacheSetter } from "./catalog";
import {
  applyPredictionBestBidAskUpdate,
  applyPredictionBookUpdate,
  applyPredictionTradeUpdate,
} from "./live-updates";
import { formatPredictionLoadError } from "./status";
import { loadKalshiDetail } from "../services/kalshi/adapter";
import { getCachedPredictionResource } from "../services/fetch";
import { loadPolymarketDetail } from "../services/polymarket/adapter";
import { subscribePolymarketMarket } from "../services/polymarket/ws";
import type {
  PredictionHistoryRange,
  PredictionMarketDetail,
  PredictionMarketSummary,
  PredictionTransportState,
} from "../types";

interface UsePredictionDetailDataOptions {
  focused: boolean;
  historyRange: PredictionHistoryRange;
  selectedSummary: PredictionMarketSummary | null;
  setCatalogCache: PredictionCatalogCacheSetter;
}

export function usePredictionDetailData({
  focused,
  historyRange,
  selectedSummary,
  setCatalogCache,
}: UsePredictionDetailDataOptions) {
  const [detailCache, setDetailCache] = useState<
    Record<string, PredictionMarketDetail>
  >({});
  const [detailPending, setDetailPending] = useState<Record<string, number>>(
    {},
  );
  const [detailErrors, setDetailErrors] = useState<
    Record<string, string | null>
  >({});
  const [transportState, setTransportState] =
    useState<PredictionTransportState>("idle");
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  const selectedSummaryRef = useRef<PredictionMarketSummary | null>(null);
  const detailLoadDelayRef = useRef(0);
  const currentDetailCacheKeyRef = useRef<string | null>(null);
  const selectedSummaryKey = selectedSummary?.key ?? null;
  const selectedSummaryVenue = selectedSummary?.venue ?? null;
  const selectedYesTokenId = selectedSummary?.yesTokenId ?? null;
  const selectedNoTokenId = selectedSummary?.noTokenId ?? null;
  const detailCacheKey = selectedSummaryKey
    ? buildPredictionDetailCacheKey(selectedSummaryKey, historyRange)
    : null;
  const detailResourceKey = selectedSummaryKey
    ? buildPredictionDetailResourceKey(selectedSummaryKey, historyRange)
    : null;
  const persistedDetail = useMemo(
    () =>
      detailResourceKey
        ? getCachedPredictionResource<PredictionMarketDetail>(
            "detail",
            detailResourceKey,
          )
        : null,
    [detailResourceKey],
  );
  const detail = detailCacheKey
    ? detailCache[detailCacheKey] ?? persistedDetail ?? null
    : null;
  const detailLoadCount = detailCacheKey ? detailPending[detailCacheKey] ?? 0 : 0;
  const detailError = detailCacheKey ? detailErrors[detailCacheKey] ?? null : null;

  const loadSelectedDetail = useCallback(
    async (summary: PredictionMarketSummary) => {
      const cacheKey = buildPredictionDetailCacheKey(summary.key, historyRange);
      const isCurrentSelection = currentDetailCacheKeyRef.current === cacheKey;
      setDetailPending((current) =>
        updatePredictionPendingCounts(current, cacheKey, 1),
      );
      if (isCurrentSelection) {
        setTransportState(summary.venue === "polymarket" ? "loading" : "polling");
      }
      try {
        const next =
          summary.venue === "polymarket"
            ? await loadPolymarketDetail(summary, historyRange)
            : await loadKalshiDetail(summary, historyRange);
        setDetailCache((current) => ({
          ...current,
          [cacheKey]: next,
        }));
        setCatalogCache((current) =>
          updatePredictionCatalogCacheEntries(current, summary.key, () => next.summary),
        );
        setDetailErrors((current) =>
          updatePredictionErrorState(current, cacheKey, null),
        );
        setLastRefreshAt(Date.now());
        if (currentDetailCacheKeyRef.current === cacheKey) {
          setTransportState(
            summary.venue === "polymarket" ? "stale" : "polling",
          );
        }
      } catch (error) {
        setDetailErrors((current) =>
          updatePredictionErrorState(
            current,
            cacheKey,
            formatPredictionLoadError(summary.venue, "market detail", error),
          ),
        );
        if (currentDetailCacheKeyRef.current === cacheKey) {
          setTransportState("error");
        }
      } finally {
        setDetailPending((current) =>
          updatePredictionPendingCounts(current, cacheKey, -1),
        );
      }
    },
    [historyRange, setCatalogCache],
  );

  useEffect(() => {
    selectedSummaryRef.current = selectedSummary;
  }, [selectedSummary]);

  useEffect(() => {
    currentDetailCacheKeyRef.current = detailCacheKey;
  }, [detailCacheKey]);

  useEffect(() => {
    const detailSummary = selectedSummaryRef.current;
    if (!detailSummary) {
      setTransportState("idle");
      return;
    }
    const delayMs = detailLoadDelayRef.current;
    detailLoadDelayRef.current = 0;
    const timeoutId = setTimeout(() => {
      void loadSelectedDetail(detailSummary);
    }, delayMs);
    return () => clearTimeout(timeoutId);
  }, [loadSelectedDetail, selectedSummaryKey]);

  useEffect(() => {
    if (!focused || selectedSummaryVenue !== "kalshi" || !selectedSummaryKey) {
      return;
    }
    const intervalId = setInterval(() => {
      const summary = selectedSummaryRef.current;
      if (summary) {
        void loadSelectedDetail(summary);
      }
    }, 5_000);
    return () => clearInterval(intervalId);
  }, [focused, loadSelectedDetail, selectedSummaryKey, selectedSummaryVenue]);

  useEffect(() => {
    // Same focus gate as the Kalshi polling above: an unfocused pane must not keep
    // a live socket open.
    if (
      !focused ||
      selectedSummaryVenue !== "polymarket" ||
      (!selectedYesTokenId && !selectedNoTokenId) ||
      !selectedSummaryKey
    ) {
      return;
    }

    const marketKey = selectedSummaryKey;
    return subscribePolymarketMarket(
      [selectedYesTokenId, selectedNoTokenId].filter(
        (value): value is string => !!value,
      ),
      {
        onBestBidAsk: (assetId, bestBid, bestAsk, spread) => {
          setTransportState("live");
          setDetailCache((current) =>
            updatePredictionDetailCacheEntries(current, marketKey, (detailEntry) =>
              applyPredictionBestBidAskUpdate(
                detailEntry,
                assetId,
                bestBid,
                bestAsk,
                spread,
              ),
            ),
          );
        },
        onBook: (assetId, bids, asks, lastTradePrice) => {
          setTransportState("live");
          setDetailCache((current) =>
            updatePredictionDetailCacheEntries(current, marketKey, (detailEntry) =>
              applyPredictionBookUpdate(
                detailEntry,
                assetId,
                bids,
                asks,
                lastTradePrice,
              ),
            ),
          );
        },
        onTrade: (assetId, trade) => {
          setTransportState("live");
          setDetailCache((current) =>
            updatePredictionDetailCacheEntries(current, marketKey, (detailEntry) =>
              applyPredictionTradeUpdate(detailEntry, assetId, trade),
            ),
          );
        },
      },
    );
  }, [
    focused,
    selectedNoTokenId,
    selectedSummaryKey,
    selectedSummaryVenue,
    selectedYesTokenId,
  ]);

  const setNextDetailLoadDelay = useCallback((delayMs: number) => {
    detailLoadDelayRef.current = Math.max(0, delayMs);
  }, []);

  return {
    detail,
    detailError,
    detailLoadCount,
    lastRefreshAt,
    transportState,
    actions: {
      setNextDetailLoadDelay,
    },
  };
}
