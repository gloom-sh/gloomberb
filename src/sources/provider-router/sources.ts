import type { AssetDataCapability, NewsCapability, PluginCapability } from "../../capabilities";
import { routeSourcePriority, type CapabilityRouteSource } from "../../types/capability-route-source";
import type { DataProvider } from "../../types/data-provider";

type RouteSourceCapability = AssetDataCapability | NewsCapability;

export function normalizeRouteSource(source: CapabilityRouteSource | DataProvider): CapabilityRouteSource {
  return "market" in source || "news" in source
    ? source as CapabilityRouteSource
    : routeSourceFromMarketProvider(source as DataProvider);
}

export function collectCapabilityRouteSources(capabilities: PluginCapability[]): CapabilityRouteSource[] {
  const capabilitySources = new Map<string, CapabilityRouteSource>();
  for (const capability of capabilities) {
    if (!isRouteSourceCapability(capability)) continue;
    const sourceId = capabilityRouteSourceId(capability);
    capabilitySources.set(sourceId, mergeCapabilityRouteSource(capabilitySources.get(sourceId), capability));
  }
  return [...capabilitySources.values()];
}

/**
 * One source per id. A host can hand the router a source a plugin also
 * registers (the web app passes its own Gloom Cloud client, which stays when
 * the plugin is turned off): asked as two, every read that falls through to
 * the next source, or races it, sends the same request twice. The first one
 * listed keeps its clients; the other fills in what it lacks.
 */
export function mergeRouteSourcesById(sources: readonly CapabilityRouteSource[]): CapabilityRouteSource[] {
  const byId = new Map<string, CapabilityRouteSource>();
  for (const source of sources) {
    const kept = byId.get(source.id);
    byId.set(source.id, kept ? {
      id: kept.id,
      name: kept.name,
      priority: kept.priority === undefined && source.priority === undefined
        ? undefined : Math.min(routeSourcePriority(kept), routeSourcePriority(source)),
      cachePolicy: kept.cachePolicy ?? source.cachePolicy,
      isEnabled: kept.isEnabled ?? source.isEnabled,
      market: kept.market ?? source.market,
      news: kept.news ?? source.news,
    } : source);
  }
  return [...byId.values()];
}

function routeSourceFromMarketProvider(provider: DataProvider): CapabilityRouteSource {
  return {
    id: provider.id,
    name: provider.name,
    priority: provider.priority,
    cachePolicy: provider.cachePolicy,
    market: provider,
  };
}

function isRouteSourceCapability(capability: PluginCapability): capability is RouteSourceCapability {
  return capability.kind === "asset-data" || capability.kind === "news";
}

function capabilityRouteSourceId(capability: RouteSourceCapability): string {
  return capability.sourceId ?? capability.id;
}

function mergeCapabilityRouteSource(current: CapabilityRouteSource | undefined, capability: RouteSourceCapability): CapabilityRouteSource {
  const priority = Math.min(
    current?.priority ?? Number.MAX_SAFE_INTEGER,
    capability.priority ?? 1000,
  );
  return {
    id: capabilityRouteSourceId(capability),
    name: current?.name ?? capability.name,
    priority,
    cachePolicy: capability.cachePolicy ?? current?.cachePolicy,
    isEnabled: capability.isEnabled ?? current?.isEnabled,
    market: capability.kind === "asset-data" ? capability.provider : current?.market,
    news: capability.kind === "news" ? capability.provider : current?.news,
  };
}
