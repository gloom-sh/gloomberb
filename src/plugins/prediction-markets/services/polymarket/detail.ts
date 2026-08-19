import {
  buildPredictionDetailResourceKey,
} from "../../cache";
import {
  resolvePredictionDisplayCategory,
} from "../../categories";
import type {
  PredictionBookLevel,
  PredictionBookSnapshot,
  PredictionHistoryPoint,
  PredictionMarketDetail,
  PredictionMarketSummary,
  PredictionSiblingMarket,
  PredictionTrade,
} from "../../types";
import {
  fetchJson,
  loadCachedPredictionResource,
  parseFloatSafe,
  PREDICTION_CACHE_POLICIES,
} from "../fetch";
import {
  extractPolymarketSlug,
  hydratePolymarketMarket,
  normalizePolymarketBookLevel,
  normalizePolymarketMarket,
  resolvePolymarketEventTags,
} from "./normalize";
import type {
  PolymarketBookResponse,
  PolymarketEventRecord,
  PolymarketHistoryResponse,
  PolymarketMarketRecord,
  PolymarketTradesResponseItem,
} from "./types";

export async function loadPolymarketEvent(
  eventId: string | undefined,
  signal?: AbortSignal,
): Promise<PolymarketEventRecord | null> {
  if (!eventId) return null;
  signal?.throwIfAborted();
  try {
    return await loadCachedPredictionResource(
      "rules",
      `polymarket:event:${eventId}`,
      async () =>
        await fetchJson<PolymarketEventRecord>(
          `https://gamma-api.polymarket.com/events/${eventId}`,
          signal,
        ),
      PREDICTION_CACHE_POLICIES.rules,
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

function findCanonicalPolymarketMarket(
  event: PolymarketEventRecord,
  summary: PredictionMarketSummary,
): PolymarketMarketRecord | null {
  const marketSlug = extractPolymarketSlug(summary.url);
  return (
    event.markets?.find((market) => {
      if (summary.conditionId && market.conditionId === summary.conditionId) {
        return true;
      }
      if (market.id && market.id === summary.marketId) {
        return true;
      }
      if (marketSlug && market.slug === marketSlug) {
        return true;
      }
      if (market.question === summary.title) {
        return true;
      }
      return (
        !!summary.marketLabel &&
        !!market.groupItemTitle &&
        market.groupItemTitle === summary.marketLabel
      );
    }) ?? null
  );
}

export async function resolvePolymarketChartSummary(
  eventId: string,
  marketId: string,
  signal?: AbortSignal,
): Promise<PredictionMarketSummary> {
  const event = await fetchJson<PolymarketEventRecord>(
    `https://gamma-api.polymarket.com/events/${eventId}`,
    signal,
  );
  const market = event.markets?.find((candidate) => candidate.id === marketId);
  const summary = market
    ? normalizePolymarketMarket(hydratePolymarketMarket(market, event))
    : null;
  if (!summary) {
    throw new Error(`Polymarket market ${marketId} in event ${eventId} is no longer resolvable. Remove or replace this chart series.`);
  }
  return summary;
}

async function resolvePolymarketSummary(
  summary: PredictionMarketSummary,
): Promise<{
  event: PolymarketEventRecord | null;
  summary: PredictionMarketSummary;
}> {
  const event = await loadPolymarketEvent(summary.eventId);
  if (!event) {
    return { event: null, summary };
  }

  const eventTags = resolvePolymarketEventTags(event);
  const canonicalMarket = findCanonicalPolymarketMarket(event, summary);
  if (!canonicalMarket) {
    return {
      event,
      summary: {
        ...summary,
        eventLabel: event.title ?? summary.eventLabel,
        category:
          summary.category ?? resolvePredictionDisplayCategory(eventTags),
        tags: summary.tags ?? eventTags,
        description: summary.description || event.description || "",
        resolutionSource:
          summary.resolutionSource || event.resolutionSource || "",
        openInterest: event.openInterest ?? summary.openInterest,
      },
    };
  }

  const normalized = normalizePolymarketMarket(
    hydratePolymarketMarket(canonicalMarket, event),
    { keyOverride: summary.key },
  );
  return {
    event,
    summary: normalized ?? summary,
  };
}

export async function loadPolymarketHistory(
  summary: PredictionMarketSummary,
  range: "1D" | "1W" | "1M" | "ALL",
  options: { start?: Date; end?: Date; signal?: AbortSignal; strict?: boolean } = {},
): Promise<PredictionHistoryPoint[]> {
  const tokenId = summary.yesTokenId;
  if (!tokenId) {
    if (options.strict) throw new Error(`Polymarket market ${summary.marketId} no longer exposes a YES token for chart history.`);
    return [];
  }
  const interval =
    range === "1D"
      ? "1d"
      : range === "1W"
        ? "1w"
        : range === "1M"
          ? "1m"
          : "max";
  const fidelity =
    range === "1D" ? 15 : range === "1W" ? 60 : range === "1M" ? 240 : 1440;
  const start = options.start ? Math.floor(options.start.getTime() / 1000) : null;
  const end = options.end ? Math.floor(options.end.getTime() / 1000) : null;
  const bounded = start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end) && start <= end;

  return await loadCachedPredictionResource(
    "history",
    `${summary.key}:${range}${bounded ? `:${start}:${end}` : ""}`,
    async () => {
      const url = new URL("https://clob.polymarket.com/prices-history");
      url.searchParams.set("market", tokenId);
      url.searchParams.set("fidelity", String(fidelity));
      if (bounded) {
        url.searchParams.set("startTs", String(start));
        url.searchParams.set("endTs", String(end));
      } else {
        url.searchParams.set("interval", interval);
      }
      const response = await fetchJson<PolymarketHistoryResponse>(url.toString(), options.signal);
      return (response.history ?? [])
        .map((point) => ({
          date: new Date(point.t * 1000),
          close: point.p,
        }))
        .filter((point) => Number.isFinite(point.date.getTime()));
    },
    PREDICTION_CACHE_POLICIES.history,
  );
}

async function loadPolymarketTrades(
  summary: PredictionMarketSummary,
): Promise<PredictionTrade[]> {
  if (!summary.conditionId) return [];
  return await loadCachedPredictionResource(
    "trades",
    summary.key,
    async () => {
      const items = await fetchJson<PolymarketTradesResponseItem[]>(
        `https://data-api.polymarket.com/trades?market=${summary.conditionId}&limit=30`,
      );
      return items.map((item, index) => ({
        id:
          item.transactionHash ??
          `${summary.key}:${index}:${item.timestamp ?? 0}`,
        timestamp:
          typeof item.timestamp === "number"
            ? item.timestamp * 1000
            : Date.now(),
        side: String(item.side).toUpperCase() === "SELL" ? "sell" : "buy",
        outcome: String(item.outcome).toLowerCase() === "no" ? "no" : "yes",
        price: typeof item.price === "number" ? item.price : 0,
        size: typeof item.size === "number" ? item.size : 0,
      }));
    },
    PREDICTION_CACHE_POLICIES.trades,
  );
}

async function loadPolymarketBook(
  summary: PredictionMarketSummary,
): Promise<PredictionBookSnapshot> {
  const yesTokenId = summary.yesTokenId;
  const noTokenId = summary.noTokenId;
  if (!yesTokenId && !noTokenId) {
    return {
      yesBids: [],
      yesAsks: [],
      noBids: [],
      noAsks: [],
      lastTradePrice: summary.lastTradePrice,
    };
  }

  return await loadCachedPredictionResource(
    "book",
    summary.key,
    async () => {
      const loadSide = async (tokenId: string | null | undefined) => {
        if (!tokenId) return { book: null, error: null as string | null };
        try {
          return {
            book: await fetchJson<PolymarketBookResponse>(
              `https://clob.polymarket.com/book?token_id=${tokenId}`,
            ),
            error: null as string | null,
          };
        } catch (error) {
          // Keep the failure: an empty book and a failed book look identical downstream.
          return {
            book: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      };
      const [yesResult, noResult] = await Promise.all([
        loadSide(yesTokenId),
        loadSide(noTokenId),
      ]);
      const yesBook = yesResult.book;
      const noBook = noResult.book;
      return {
        error: yesResult.error ?? noResult.error,
        yesBids: (yesBook?.bids ?? [])
          .map(normalizePolymarketBookLevel)
          .filter((level): level is PredictionBookLevel => level != null),
        yesAsks: (yesBook?.asks ?? [])
          .map(normalizePolymarketBookLevel)
          .filter((level): level is PredictionBookLevel => level != null),
        noBids: (noBook?.bids ?? [])
          .map(normalizePolymarketBookLevel)
          .filter((level): level is PredictionBookLevel => level != null),
        noAsks: (noBook?.asks ?? [])
          .map(normalizePolymarketBookLevel)
          .filter((level): level is PredictionBookLevel => level != null),
        lastTradePrice:
          parseFloatSafe(yesBook?.last_trade_price) ??
          parseFloatSafe(noBook?.last_trade_price) ??
          summary.lastTradePrice,
      };
    },
    PREDICTION_CACHE_POLICIES.book,
  );
}

export async function loadPolymarketDetail(
  summary: PredictionMarketSummary,
  range: "1D" | "1W" | "1M" | "ALL",
): Promise<PredictionMarketDetail> {
  return await loadCachedPredictionResource(
    "detail",
    buildPredictionDetailResourceKey(summary.key, range),
    async () => {
      const resolved = await resolvePolymarketSummary(summary);
      const resolvedSummary = resolved.summary;
      const [history, book, trades] = await Promise.all([
        loadPolymarketHistory(resolvedSummary, range),
        loadPolymarketBook(resolvedSummary),
        loadPolymarketTrades(resolvedSummary),
      ]);
      const event = resolved.event;
      const siblings: PredictionSiblingMarket[] = (event?.markets ?? [])
        .map((market) =>
          event
            ? normalizePolymarketMarket(
                hydratePolymarketMarket(market, event),
              )
            : null,
        )
        .filter(
          (market): market is PredictionMarketSummary =>
            market != null && market.status === "open",
        )
        .map((market) => ({
          key: market.key,
          marketId: market.marketId,
          label: market.marketLabel,
          yesPrice: market.yesPrice,
          volume24h: market.volume24h,
        }));

      return {
        summary: {
          ...resolvedSummary,
          eventLabel: event?.title ?? resolvedSummary.eventLabel,
          category:
            resolvedSummary.category ??
            resolvePredictionDisplayCategory(resolvePolymarketEventTags(event)),
          description:
            resolvedSummary.description || event?.description || "",
          resolutionSource:
            resolvedSummary.resolutionSource || event?.resolutionSource || "",
          openInterest: event?.openInterest ?? resolvedSummary.openInterest,
          tags:
            resolvedSummary.tags ?? resolvePolymarketEventTags(event),
        },
        siblings,
        rules: [
          resolvedSummary.description,
          resolvedSummary.resolutionSource || "",
          event?.description || "",
          event?.resolutionSource || "",
        ].filter((value) => value.trim().length > 0),
        history,
        book,
        trades,
      };
    },
    PREDICTION_CACHE_POLICIES.detail,
  );
}
