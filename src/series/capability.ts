import { chartSeriesProvider } from "../capabilities/factories";
import { chartSeriesResolveOutputSchema, REGISTERED_SERIES_SOURCE_ID } from "../capabilities/chart-series";
import type { CapabilityOperation, ChartSeriesCapability, PluginCapability } from "../capabilities/types";
import type { ResolvedSeries, ChartViewportSpec } from "../time-series/types";
import type { SeriesRegistry } from "./registry";
import { resolveLoadedSeries } from "./resolve";
import type { LoadedSeriesDefinition, SeriesCatalogEntry } from "./types";

export const SERIES_CATALOG_CAPABILITY_ID = "series-catalog";

/** Resolves a loaded series in this process; null when none is registered here under that source. */
export async function resolveRegisteredSeries(
  registry: SeriesRegistry,
  capabilityId: string,
  seriesId: string,
  viewport: ChartViewportSpec,
  signal?: AbortSignal,
): Promise<ResolvedSeries | null> {
  const found = registry.findLoaded(capabilityId, seriesId);
  if (!found) return null;
  const resolved = await resolveLoadedSeries(found.series.definition as LoadedSeriesDefinition, {
    viewport,
    ...(found.ticker ? { ticker: found.ticker } : {}),
    ...(found.line ? { line: found.line } : {}),
    ...(signal ? { signal } : {}),
  });
  // The same checks a series from another process passes.
  return chartSeriesResolveOutputSchema.parse(resolved);
}

/**
 * The chart-series capability of one namespace: what `CAP:<namespace>:<name>`
 * resolves through, here and from the desktop view.
 */
export function registeredSeriesCapability(registry: SeriesRegistry, namespace: string): ChartSeriesCapability {
  const capability = chartSeriesProvider({
    id: namespace,
    name: "Registered series",
    provider: {
      resolve: async ({ seriesId, viewport, signal }) => {
        const resolved = await resolveRegisteredSeries(registry, namespace, seriesId, viewport, signal);
        if (!resolved) throw new Error(`No series ${namespace}:${seriesId} is registered.`);
        return resolved;
      },
    },
  });
  return { ...capability, sourceId: REGISTERED_SERIES_SOURCE_ID };
}

/**
 * Lists every series this process registered, after asking sources that
 * change at runtime to catch up. The desktop view reads it for the series
 * only its Bun process has, such as files in the profile's series folder.
 */
export function seriesCatalogCapability(registry: SeriesRegistry): PluginCapability {
  const list: CapabilityOperation<unknown, { entries: SeriesCatalogEntry[] }> = {
    kind: "query",
    rendererSafe: true,
    cli: {
      summary: "List the series the data catalog shows",
      outputShape: "{ entries: Array<{ id, name, unit, frequency, group, expression, pluginId }> }",
      formats: ["json"],
      sideEffectLevel: "none",
    },
    handler: async () => {
      await registry.refresh();
      return { entries: [...registry.catalog()] };
    },
  };
  return {
    id: SERIES_CATALOG_CAPABILITY_ID,
    kind: SERIES_CATALOG_CAPABILITY_ID,
    name: "Series Catalog",
    operations: { list },
  };
}
