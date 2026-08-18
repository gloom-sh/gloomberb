import { chartSeriesProvider, type ChartSeriesCatalogItem, type ChartSeriesResolveRequest } from "../../capabilities";
import type { ChartSeriesParameterValue, ResolvedSeries, TimeSeriesPoint } from "../../time-series/types";
import { loadKalshiCatalog, loadKalshiHistory } from "./services/kalshi/adapter";
import { loadPolymarketCatalog } from "./services/polymarket/adapter";
import { loadPolymarketHistory } from "./services/polymarket/detail";
import type { PredictionHistoryPoint, PredictionHistoryRange, PredictionMarketSummary } from "./types";

export const PREDICTION_CHART_SERIES_CAPABILITY_ID = "prediction-markets.series";

function historyRange(request: ChartSeriesResolveRequest): PredictionHistoryRange {
  switch (request.viewport.range) {
    case "1D": return "1D";
    case "1W": return "1W";
    case "1M": return "1M";
    default: return "ALL";
  }
}

function summaryParameters(summary: PredictionMarketSummary) {
  return { summary: JSON.parse(JSON.stringify({
    venue: summary.venue,
    key: summary.key,
    marketId: summary.marketId,
    title: summary.title,
    eventTicker: summary.eventTicker,
    yesTokenId: summary.yesTokenId,
  })) as ChartSeriesParameterValue };
}

function summaryFrom(request: ChartSeriesResolveRequest): PredictionMarketSummary {
  const value = request.parameters?.summary;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Prediction market metadata is missing for ${request.seriesId}. Add the series again from search.`);
  }
  const summary = value as unknown as PredictionMarketSummary;
  if ((summary.venue !== "kalshi" && summary.venue !== "polymarket") || !summary.marketId || !summary.key || !summary.title) {
    throw new Error(`Prediction market metadata is invalid for ${request.seriesId}.`);
  }
  return summary;
}

export function predictionHistoryPoints(points: PredictionHistoryPoint[], venue: string): TimeSeriesPoint[] {
  return points.flatMap((point) => {
    const date = point.date instanceof Date ? new Date(point.date) : new Date(point.date as unknown as string);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(point.close)) return [];
    return [{
      date,
      observedAt: new Date(date),
      value: point.close,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: point.volume,
      provenance: { providerId: venue, quality: "reported" as const },
    }];
  }).sort((left, right) => left.date.getTime() - right.date.getTime());
}

function catalogItem(summary: PredictionMarketSummary): ChartSeriesCatalogItem {
  return {
    seriesId: summary.key,
    label: summary.title,
    description: `${summary.venue === "kalshi" ? "Kalshi" : "Polymarket"} · YES probability`,
    detail: summary.venue === "kalshi" ? "Kalshi" : "Polymarket",
    parameters: summaryParameters(summary),
    style: "area",
  };
}

async function catalog(query = "", limit = 8): Promise<ChartSeriesCatalogItem[]> {
  const [polymarket, kalshi] = await Promise.all([
    loadPolymarketCatalog(query).catch(() => []),
    loadKalshiCatalog(query).catch(() => []),
  ]);
  return [...polymarket, ...kalshi]
    .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
    .slice(0, limit)
    .map(catalogItem);
}

export const predictionChartSeriesCapability = chartSeriesProvider({
  id: PREDICTION_CHART_SERIES_CAPABILITY_ID,
  name: "Prediction Markets",
  provider: {
    catalog: (request) => catalog(request.query, request.limit),
    search: (request) => catalog(request.query, request.limit),
    async resolve(request): Promise<ResolvedSeries> {
      const summary = summaryFrom(request);
      const range = historyRange(request);
      const history = summary.venue === "kalshi"
        ? await loadKalshiHistory(summary, range)
        : await loadPolymarketHistory(summary, range);
      return {
        id: request.seriesId,
        label: summary.title,
        color: "#4dabf7",
        unit: "probability",
        unitGroup: "probability",
        nativeFrequency: "auto",
        dataShape: "scalar",
        style: "area",
        transform: "raw",
        axis: "left",
        panelId: "main",
        interpolation: "none",
        points: predictionHistoryPoints(history, summary.venue),
      };
    },
  },
});
