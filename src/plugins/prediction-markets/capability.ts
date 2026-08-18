import { chartSeriesProvider, type ChartSeriesCatalogItem, type ChartSeriesResolveRequest } from "../../capabilities";
import { debugLog } from "../../utils/debug-log";
import type { ResolvedSeries, TimeSeriesPoint } from "../../time-series/types";
import {
  loadKalshiCatalog,
  loadKalshiHistory,
  resolveKalshiChartSummary,
} from "./services/kalshi/adapter";
import { loadPolymarketCatalog } from "./services/polymarket/adapter";
import {
  loadPolymarketHistory,
  resolvePolymarketChartSummary,
} from "./services/polymarket/detail";
import type { PredictionHistoryPoint, PredictionHistoryRange, PredictionMarketSummary, PredictionVenue } from "./types";

export const PREDICTION_CHART_SERIES_CAPABILITY_ID = "prediction-markets.series";
const predictionSeriesLog = debugLog.createLogger("prediction-markets.series");

interface PredictionSeriesIdentity {
  venue: PredictionVenue;
  eventId: string;
  marketId: string;
}

export function predictionSeriesId(summary: PredictionMarketSummary): string | null {
  const eventId = summary.venue === "kalshi" ? summary.eventTicker : summary.eventId;
  if (!eventId?.trim() || !summary.marketId.trim()) return null;
  const id = `${summary.venue}/${encodeURIComponent(eventId)}/${encodeURIComponent(summary.marketId)}`;
  return id.length <= 240 ? id : null;
}

function parsePredictionSeriesId(seriesId: string): PredictionSeriesIdentity {
  const parts = seriesId.split("/");
  if (parts.length !== 3 || (parts[0] !== "kalshi" && parts[0] !== "polymarket")) {
    throw new Error(`Prediction series ID ${seriesId} is invalid. Remove and add the series again.`);
  }
  try {
    const eventId = decodeURIComponent(parts[1] ?? "");
    const marketId = decodeURIComponent(parts[2] ?? "");
    if (!eventId || !marketId) throw new Error("missing identity");
    return { venue: parts[0], eventId, marketId };
  } catch {
    throw new Error(`Prediction series ID ${seriesId} is invalid. Remove and add the series again.`);
  }
}

function historyRange(request: ChartSeriesResolveRequest): PredictionHistoryRange {
  if (request.viewport.dateWindow) {
    const span = Date.parse(request.viewport.dateWindow.end) - Date.parse(request.viewport.dateWindow.start);
    if (span <= 24 * 60 * 60_000) return "1D";
    if (span <= 7 * 24 * 60 * 60_000) return "1W";
    if (span <= 31 * 24 * 60 * 60_000) return "1M";
    return "ALL";
  }
  switch (request.viewport.range) {
    case "1D": return "1D";
    case "1W": return "1W";
    case "1M": return "1M";
    default: return "ALL";
  }
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

function catalogItem(summary: PredictionMarketSummary): ChartSeriesCatalogItem | null {
  const seriesId = predictionSeriesId(summary);
  if (!seriesId) return null;
  return {
    seriesId,
    label: summary.title.slice(0, 160),
    description: `${summary.venue === "kalshi" ? "Kalshi" : "Polymarket"} · YES probability`,
    detail: summary.venue === "kalshi" ? "Kalshi" : "Polymarket",
    style: "area",
  };
}

async function catalog(
  query = "",
  limit = 8,
  signal?: AbortSignal,
): Promise<ChartSeriesCatalogItem[]> {
  const providers = [
    { id: "polymarket", load: () => loadPolymarketCatalog(query, "all", { limit, signal }) },
    { id: "kalshi", load: () => loadKalshiCatalog(query, "all", { limit, signal }) },
  ] as const;
  const results = await Promise.allSettled(providers.map((provider) => provider.load()));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
    predictionSeriesLog.warn("Prediction chart catalog provider failed", {
      provider: providers[index]?.id,
      error,
    });
    return [`${providers[index]?.id}: ${error}`];
  });
  if (failures.length === providers.length) {
    throw new Error(`Prediction chart catalog failed (${failures.join("; ")}).`);
  }
  return results
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
    .flatMap((summary) => {
      const item = catalogItem(summary);
      return item ? [item] : [];
    })
    .slice(0, limit);
}

async function resolveCurrentSummary(identity: PredictionSeriesIdentity, signal?: AbortSignal) {
  return identity.venue === "kalshi"
    ? resolveKalshiChartSummary(identity.eventId, identity.marketId, signal)
    : resolvePolymarketChartSummary(identity.eventId, identity.marketId, signal);
}

export const predictionChartSeriesCapability = chartSeriesProvider({
  id: PREDICTION_CHART_SERIES_CAPABILITY_ID,
  name: "Prediction Markets",
  provider: {
    catalog: (request) => catalog(request.query, request.limit, request.signal),
    search: (request) => catalog(request.query, request.limit, request.signal),
    async resolve(request): Promise<ResolvedSeries> {
      const identity = parsePredictionSeriesId(request.seriesId);
      const summary = await resolveCurrentSummary(identity, request.signal);
      const range = historyRange(request);
      const dateWindow = request.viewport.dateWindow;
      const historyOptions = {
        ...(dateWindow ? {
          start: new Date(dateWindow.start),
          end: new Date(dateWindow.end),
        } : {}),
        signal: request.signal,
        strict: true,
      };
      const history = summary.venue === "kalshi"
        ? await loadKalshiHistory(summary, range, historyOptions)
        : await loadPolymarketHistory(summary, range, historyOptions);
      return {
        id: request.seriesId,
        label: summary.title.slice(0, 160),
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
