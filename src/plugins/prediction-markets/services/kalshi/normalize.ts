import { measurePerf } from "../../../../utils/perf-marks";
import { matchesPredictionCategory } from "../../categories";
import type {
  PredictionBookLevel,
  PredictionCategoryId,
  PredictionMarketSummary,
} from "../../types";
import { parseFloatSafe } from "../fetch";
import type {
  KalshiEventRecord,
  KalshiMarketRecord,
} from "./types";

export function normalizeKalshiBookLevel(
  level: [string, string],
): PredictionBookLevel | null {
  const price = parseFloatSafe(level[0]);
  const size = parseFloatSafe(level[1]);
  if (price == null || size == null) return null;
  return { price, size };
}

function getKalshiDisplayPrice(record: KalshiMarketRecord): {
  yesPrice: number | null;
  noPrice: number | null;
  lastTradePrice: number | null;
} {
  const yesBid = parseFloatSafe(record.yes_bid_dollars);
  const yesAsk = parseFloatSafe(record.yes_ask_dollars);
  const lastPrice = parseFloatSafe(record.last_price_dollars);
  const midpoint =
    yesBid != null && yesAsk != null
      ? (yesBid + yesAsk) / 2
      : (yesAsk ?? yesBid ?? null);
  const displayYesPrice =
    lastPrice != null && lastPrice > 0 ? lastPrice : midpoint;
  return {
    yesPrice: displayYesPrice,
    noPrice: displayYesPrice != null ? Math.max(0, 1 - displayYesPrice) : null,
    lastTradePrice:
      lastPrice != null && lastPrice > 0 ? lastPrice : displayYesPrice,
  };
}

function isDormantKalshiMarket(record: KalshiMarketRecord): boolean {
  const values = [
    parseFloatSafe(record.last_price_dollars),
    parseFloatSafe(record.yes_bid_dollars),
    parseFloatSafe(record.yes_ask_dollars),
    parseFloatSafe(record.no_bid_dollars),
    parseFloatSafe(record.no_ask_dollars),
    parseFloatSafe(record.volume_24h_fp),
    parseFloatSafe(record.open_interest_fp),
  ];
  if (!values.every((value) => value == null || value === 0)) return false;
  return (
    record.is_provisional === true ||
    record.status === "initialized" ||
    record.status === "open"
  );
}

export function normalizeKalshiMarket(
  record: KalshiMarketRecord,
  eventMeta?: {
    title?: string;
    category?: string;
    series_ticker?: string;
    event_ticker?: string;
    sub_title?: string;
  },
): PredictionMarketSummary | null {
  if (record.market_type && record.market_type !== "binary") return null;
  if (isDormantKalshiMarket(record)) return null;

  const yesBid = parseFloatSafe(record.yes_bid_dollars);
  const yesAsk = parseFloatSafe(record.yes_ask_dollars);
  const noBid = parseFloatSafe(record.no_bid_dollars);
  const noAsk = parseFloatSafe(record.no_ask_dollars);
  const prices = getKalshiDisplayPrice(record);
  const category = eventMeta?.category?.trim();
  const hasTargetMetadata =
    record.strike_type != null ||
    record.floor_strike != null ||
    record.cap_strike != null ||
    record.custom_strike != null;
  const conciseTargetLabel = record.yes_sub_title?.trim();
  const marketLabel =
    hasTargetMetadata &&
    conciseTargetLabel &&
    conciseTargetLabel.length > 0 &&
    conciseTargetLabel.toLowerCase() !== "yes" &&
    conciseTargetLabel.toLowerCase() !== "no"
      ? conciseTargetLabel
      : record.title;
  const eventLabel = [eventMeta?.title?.trim(), eventMeta?.sub_title?.trim()]
    .filter((value): value is string => !!value && value.length > 0)
    .join(" · ");

  return {
    key: `kalshi:${record.ticker}`,
    venue: "kalshi",
    marketId: record.ticker,
    title: record.title,
    marketLabel,
    eventLabel: eventLabel || eventMeta?.title || record.title,
    eventTicker: record.event_ticker ?? eventMeta?.event_ticker,
    seriesTicker: eventMeta?.series_ticker,
    category,
    tags: category ? [category] : [],
    status: record.status === "active" ? "open" : (record.status ?? "unknown"),
    url: `https://kalshi.com/markets/${record.ticker}`,
    description: [record.rules_primary, record.rules_secondary]
      .filter(Boolean)
      .join("\n\n"),
    endsAt: record.close_time ?? null,
    updatedAt:
      record.updated_time ?? record.open_time ?? record.created_time ?? null,
    yesPrice: prices.yesPrice,
    noPrice: prices.noPrice,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    spread: yesBid != null && yesAsk != null ? yesAsk - yesBid : null,
    lastTradePrice: prices.lastTradePrice,
    volume24h: parseFloatSafe(record.volume_24h_fp),
    volume24hUnit: "contracts",
    totalVolume: parseFloatSafe(record.volume_fp),
    totalVolumeUnit: "contracts",
    openInterest: parseFloatSafe(record.open_interest_fp),
    openInterestUnit: "contracts",
    liquidity: parseFloatSafe(record.liquidity_dollars),
    liquidityUnit: "usd",
    rulesPrimary: record.rules_primary,
    rulesSecondary: record.rules_secondary,
  };
}

function sortKalshiMarkets(
  markets: PredictionMarketSummary[],
): PredictionMarketSummary[] {
  return [...markets].sort(
    (left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0),
  );
}

function flattenKalshiEvents(
  events: KalshiEventRecord[],
  searchQuery = "",
  categoryId: PredictionCategoryId = "all",
): PredictionMarketSummary[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const deduped = new Map<string, PredictionMarketSummary>();

  for (const event of events) {
    const eventText = [event.title, event.category ?? "", event.sub_title ?? ""]
      .join(" ")
      .toLowerCase();
    for (const market of event.markets ?? []) {
      const normalized = normalizeKalshiMarket(market, {
        title: event.title,
        category: event.category,
        series_ticker: event.series_ticker,
        event_ticker: event.event_ticker,
        sub_title: event.sub_title,
      });
      if (!normalized) continue;
      if (
        categoryId !== "all" &&
        !matchesPredictionCategory(normalized, categoryId)
      ) {
        continue;
      }
      if (normalizedQuery) {
        const searchText = [
          normalized.title,
          normalized.marketLabel,
          normalized.eventLabel,
          normalized.category ?? "",
          normalized.marketId,
          eventText,
        ]
          .join(" ")
          .toLowerCase();
        if (!searchText.includes(normalizedQuery)) continue;
      }
      deduped.set(normalized.key, normalized);
    }
  }

  return [...deduped.values()];
}

export function normalizeKalshiCatalog(
  events: KalshiEventRecord[],
  searchQuery: string,
  categoryId: PredictionCategoryId,
): PredictionMarketSummary[] {
  return measurePerf(
    "prediction.catalog.kalshi.normalize",
    () => sortKalshiMarkets(
      flattenKalshiEvents(events, searchQuery, categoryId),
    ),
    {
      categoryId,
      eventCount: events.length,
      search: searchQuery.trim().length > 0,
    },
  );
}
