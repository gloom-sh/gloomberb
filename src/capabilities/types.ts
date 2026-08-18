import type { CachePolicyMap } from "../types/persistence";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { AssetDataProvider } from "../types/data-provider";
import type { NewsDataProvider } from "../types/capability-route-source";
import type {
  CapabilitySeriesSource,
  ChartViewportSpec,
  ResolvedSeries,
  SeriesStyle,
  SeriesTransform,
} from "../time-series/types";

type CapabilityOperationKind = "read" | "query" | "action" | "stream";
type CapabilitySideEffectLevel = "none" | "local-write" | "network-write" | "external-trade" | "external-side-effect";

type CapabilityKind =
  | "asset-data"
  | "news"
  | "chart-series"
  | "plugin-service";

export interface CapabilitySchema<T = unknown> {
  parse(value: unknown): T;
}

interface CapabilityHandlerContext {
  capability: PluginCapability;
  operationId: string;
}

type CapabilityStreamEmit<T = unknown> = (event: T) => void;

export interface CapabilityOperationCliManifest {
  summary?: string;
  inputShape?: string;
  outputShape?: string;
  examples?: string[];
  sideEffectLevel?: CapabilitySideEffectLevel;
  requirements?: string[];
  batch?: boolean;
  formats?: Array<"text" | "json" | "csv" | "ndjson">;
  safety?: string[];
}

export interface CapabilityOperation<I = unknown, O = unknown, E = unknown> {
  kind: CapabilityOperationKind;
  rendererSafe?: boolean;
  cli?: CapabilityOperationCliManifest;
  input?: CapabilitySchema<I>;
  output?: CapabilitySchema<O>;
  cachePolicy?: CachePolicyMap[keyof CachePolicyMap];
  handler?: (input: I, ctx: CapabilityHandlerContext) => Promise<O> | O;
  subscribe?: (input: I, emit: CapabilityStreamEmit<E>, ctx: CapabilityHandlerContext) => (() => void) | Promise<() => void>;
}

export interface PluginCapability {
  readonly id: string;
  readonly kind: CapabilityKind | string;
  readonly name: string;
  readonly priority?: number;
  readonly cachePolicy?: CachePolicyMap;
  readonly sourceId?: string;
  readonly operations: Record<string, CapabilityOperation<any, any, any>>;
  isEnabled?(): boolean;
}

export interface AssetDataCapability extends PluginCapability {
  readonly kind: "asset-data";
  readonly provider: AssetDataProvider;
}

export interface NewsCapability extends PluginCapability {
  readonly kind: "news";
  readonly provider: NewsDataProvider;
}

export interface ChartSeriesCatalogItem {
  seriesId: string;
  label: string;
  description?: string;
  detail?: string;
  parameters?: CapabilitySeriesSource["parameters"];
  style?: SeriesStyle;
  transform?: SeriesTransform;
}

export interface ChartSeriesCatalogRequest {
  query?: string;
  limit?: number;
}

export interface ChartSeriesResolveRequest {
  seriesId: string;
  parameters?: CapabilitySeriesSource["parameters"];
  viewport: ChartViewportSpec;
}

export interface ChartSeriesProvider {
  catalog?(request: ChartSeriesCatalogRequest): Promise<ChartSeriesCatalogItem[]> | ChartSeriesCatalogItem[];
  search?(request: ChartSeriesCatalogRequest): Promise<ChartSeriesCatalogItem[]> | ChartSeriesCatalogItem[];
  resolve(request: ChartSeriesResolveRequest): Promise<ResolvedSeries> | ResolvedSeries;
}

export interface ChartSeriesCapability extends PluginCapability {
  readonly kind: "chart-series";
  readonly provider: ChartSeriesProvider;
}

export interface CapabilityOperationManifest {
  id: string;
  kind: CapabilityOperationKind;
  rendererSafe: boolean;
  summary?: string;
  inputShape?: string;
  outputShape?: string;
  examples?: string[];
  sideEffectLevel?: CapabilitySideEffectLevel;
  requirements?: string[];
  batch?: boolean;
  formats?: Array<"text" | "json" | "csv" | "ndjson">;
  safety?: string[];
}

export interface CapabilityManifest {
  id: string;
  kind: string;
  name: string;
  priority?: number;
  sourceId?: string;
  operations: CapabilityOperationManifest[];
}

export interface CapabilityRegistryOptions {
  isPluginEnabled?(pluginId: string): boolean;
  isCapabilityEnabled?(capability: PluginCapability, pluginId: string): boolean;
  connectionHealth?: ConnectionHealthRegistry;
}

export interface CapabilityInvoker {
  capabilityManifests(kind?: string): CapabilityManifest[];
  invokeCapability<T = unknown>(capabilityId: string, operationId: string, payload: unknown): Promise<T>;
}

export interface RegisteredCapability {
  pluginId: string;
  capability: PluginCapability;
}

export const recordSchema: CapabilitySchema<Record<string, unknown>> = {
  parse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  },
};
