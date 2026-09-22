import { CHART_RESOLUTION_STEP_MS, type ManualChartResolution } from "../time-series/resolution";
import type { TimeRange } from "../time-series/range";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { PriceHistoryResult } from "../types/price-history";
import { parseHistorySession } from "../market-data/history-session";
import { canonicalHistoryInterval } from "./history-retention";

export type HistoryResultRequest =
  | { kind: "range"; range: TimeRange }
  | { kind: "resolution"; range: TimeRange; resolution: ManualChartResolution }
  | { kind: "detail"; start: Date; end: Date; interval: string };

export class InvalidHistoryResultError extends Error {
  constructor() { super("Malformed price history acquisition or mismatched cadence"); this.name = "InvalidHistoryResultError"; }
}

export function historyResolutionForInterval(interval: string | undefined): ManualChartResolution | null {
  const canonical = canonicalHistoryInterval(interval);
  return (Object.keys(CHART_RESOLUTION_STEP_MS) as ManualChartResolution[])
    .find(resolution => canonicalHistoryInterval(resolution) === canonical) ?? null;
}

/** Sanitize one acquisition without promoting a bare default array to a cadence. */
export function normalizeHistoryResult(
  value: unknown,
  target: { symbol: string; exchange: string },
  requestedInterval?: string,
): PriceHistoryResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as PriceHistoryResult;
  if (!Array.isArray(result.points) || (result.resolution !== null
    && (typeof result.resolution !== "string" || !Object.hasOwn(CHART_RESOLUTION_STEP_MS, result.resolution)))) return null;
  if (requestedInterval && result.resolution !== historyResolutionForInterval(requestedInterval)) return null;
  const session = parseHistorySession(result.session, { ...target,
    interval: requestedInterval ?? result.resolution ?? undefined });
  // A contradictory declaration cannot be laundered into unknown legacy data.
  if (result.session != null && (!session || result.resolution === null)) return null;
  return { points: result.points, resolution: result.resolution,
    ...(session ? { session } : {}),
    ...(typeof result.sourceKey === "string" && /^(provider|broker):[^\r\n\0]+$/.test(result.sourceKey) ? { sourceKey: result.sourceKey } : {}),
  };
}

/** null means this exact method is absent, allowing the original router traversal. */
export async function fetchHistoryResult(
  provider: DataProvider,
  symbol: string,
  exchange: string,
  request: HistoryResultRequest,
  context?: MarketDataRequestContext,
): Promise<PriceHistoryResult | null> {
  let value: unknown;
  let interval: string | undefined;
  if (request.kind === "range") {
    value = provider.getPriceHistoryWithMetadata
      ? await provider.getPriceHistoryWithMetadata(symbol, exchange, request.range, context)
      : { points: await provider.getPriceHistory(symbol, exchange, request.range, context), resolution: null };
  } else if (request.kind === "resolution") {
    interval = request.resolution;
    if (provider.getPriceHistoryForResolutionWithMetadata) {
      value = await provider.getPriceHistoryForResolutionWithMetadata(symbol, exchange, request.range, request.resolution, context);
    } else if (provider.getPriceHistoryForResolution) {
      value = { points: await provider.getPriceHistoryForResolution(symbol, exchange, request.range, request.resolution, context), resolution: request.resolution };
    } else return null;
  } else {
    interval = request.interval;
    if (provider.getDetailedPriceHistoryWithMetadata) {
      value = await provider.getDetailedPriceHistoryWithMetadata(symbol, exchange, request.start, request.end, request.interval, context);
    } else if (provider.getDetailedPriceHistory) {
      value = { points: await provider.getDetailedPriceHistory(symbol, exchange, request.start, request.end, request.interval, context), resolution: historyResolutionForInterval(request.interval) };
    } else return null;
  }
  const result = normalizeHistoryResult(value, { symbol, exchange }, interval);
  if (!result) throw new InvalidHistoryResultError();
  return context?.instrument ? { ...result, session: undefined } : result;
}
