import type {
  CapabilitySeriesSource,
  ChartSeriesSpec,
  ChartViewportSpec,
  ResolvedSeries,
} from "../time-series/types";
import type {
  CapabilityInvoker,
  ChartSeriesCatalogItem,
  ChartSeriesResolveRequest,
} from "./types";

export const CHART_SERIES_CAPABILITY_KIND = "chart-series";

export function chartSeriesCapabilityManifests(invoker: CapabilityInvoker) {
  return invoker.capabilityManifests(CHART_SERIES_CAPABILITY_KIND);
}

export async function searchChartSeriesCapabilities(
  invoker: CapabilityInvoker,
  query: string,
  limit = 8,
): Promise<Array<ChartSeriesCatalogItem & { capabilityId: string; capabilityName: string }>> {
  const manifests = chartSeriesCapabilityManifests(invoker);
  const results = await Promise.all(manifests.map(async (manifest) => {
    try {
      const items = await invoker.invokeCapability<ChartSeriesCatalogItem[]>(
        manifest.id,
        query.trim() ? "search" : "catalog",
        { query, limit },
      );
      return items.map((item) => ({
        ...item,
        capabilityId: manifest.id,
        capabilityName: manifest.name,
      }));
    } catch {
      return [];
    }
  }));
  return results.flat().slice(0, limit);
}

export function chartSeriesSourceKey(source: CapabilitySeriesSource): string {
  return `${source.capabilityId}|${source.seriesId}|${JSON.stringify(source.parameters ?? {})}`;
}

export function createChartSeriesResolver(invoker: CapabilityInvoker) {
  return async (
    source: CapabilitySeriesSource,
    viewport: ChartViewportSpec,
    _spec: ChartSeriesSpec,
  ): Promise<ResolvedSeries> => invoker.invokeCapability<ResolvedSeries>(
    source.capabilityId,
    "resolve",
    {
      seriesId: source.seriesId,
      parameters: source.parameters,
      viewport,
    } satisfies ChartSeriesResolveRequest,
  );
}
