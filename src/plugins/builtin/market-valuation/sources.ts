import { apiClient } from "../../../api-client";
import type { CloudShillerPayload } from "../../../api-client";
import type { SeriesDef, ShillerField } from "./defs";
import type { DatedObservation, DatedSeries } from "./series";
import type { SeriesCacheInput } from "../shared/series-cache";

/**
 * Every leg goes through the market backend so terminal and browser use the same data.
 */
export interface ValuationSourceDeps {
  loadFred: (seriesId: string, limit: number) => Promise<DatedObservation[] | SeriesCacheInput>;
  loadMarketHistory: (
    symbol: string,
    exchange: string,
    startDate: string,
  ) => Promise<DatedObservation[]>;
  loadShiller: () => Promise<CloudShillerPayload>;
}

export function shillerObservations(
  payload: CloudShillerPayload,
  field: ShillerField,
): DatedObservation[] {
  const observations: DatedObservation[] = [];
  for (const row of payload.observations) {
    const value = row[field];
    observations.push({
      date: row.date,
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
    });
  }
  if (!observations.some((entry) => entry.value != null)) {
    throw new Error(`Shiller dataset has no ${field} observations`);
  }
  return observations;
}

function historyToObservations(
  points: ReadonlyArray<{ date: string; close: number | null }>,
): DatedObservation[] {
  const observations: DatedObservation[] = [];
  for (const point of points) {
    const close = point.close;
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    observations.push({ date: point.date.slice(0, 10), value: close });
  }
  if (observations.length === 0) throw new Error("No price history");
  return observations;
}

type FredLoad = DatedObservation[] | SeriesCacheInput;

function fredObservations(loaded: FredLoad): DatedObservation[] {
  return Array.isArray(loaded) ? loaded : loaded.observations;
}

function fredProvider(loaded: FredLoad): SeriesCacheInput["provider"] | undefined {
  return Array.isArray(loaded) ? undefined : loaded.provider;
}

/**
 * Adds legs on their shared dates. The result carries the oldest fetch time and
 * is stale if any leg is, so freshness never looks better than the worst input.
 */
export function sumFredSeries(legs: readonly FredLoad[]): SeriesCacheInput {
  if (legs.length === 0) throw new Error("No series to sum");
  const valuesByDate = new Map<string, number[]>();
  for (const leg of legs) {
    for (const obs of fredObservations(leg)) {
      if (typeof obs.value !== "number" || !Number.isFinite(obs.value)) continue;
      const values = valuesByDate.get(obs.date) ?? [];
      values.push(obs.value);
      valuesByDate.set(obs.date, values);
    }
  }
  const observations: DatedObservation[] = [];
  for (const [date, values] of valuesByDate) {
    if (values.length !== legs.length) continue;
    observations.push({ date, value: values.reduce((sum, value) => sum + value, 0) });
  }
  observations.sort((a, b) => a.date.localeCompare(b.date));
  if (observations.length === 0) throw new Error("Summed series share no observation dates");
  const providers = legs.map(fredProvider).filter((provider): provider is NonNullable<typeof provider> => !!provider);
  if (providers.length === 0) return { observations };
  const fetchedAt = providers.map((provider) => provider.fetchedAt).filter((value): value is string => !!value).sort()[0] ?? null;
  const staleFlags = providers.map((provider) => provider.stale);
  const stale = staleFlags.some((flag) => flag === true) ? true : staleFlags.every((flag) => flag === false) ? false : null;
  return { observations, provider: { fetchedAt, stale } };
}

export function provenanceFor(def: SeriesDef): DatedSeries["provenance"] {
  switch (def.source.kind) {
    case "fred":
    case "fred-sum":
      return "fred";
    case "market-history":
      return "market";
    case "shiller":
      return "shiller";
    default: {
      const _exhaustive: never = def.source;
      return _exhaustive;
    }
  }
}

export function createSourceLoader(deps: ValuationSourceDeps) {
  // One Shiller fetch serves every column the registry asks for.
  let shillerRequest: Promise<CloudShillerPayload> | null = null;
  const shiller = () => {
    if (shillerRequest) return shillerRequest;
    const request = deps.loadShiller().finally(() => {
      if (shillerRequest === request) shillerRequest = null;
    });
    shillerRequest = request;
    return request;
  };

  return async (def: SeriesDef): Promise<DatedSeries> => {
    const source = def.source;
    switch (source.kind) {
      case "fred": {
        const loaded = await deps.loadFred(source.seriesId, source.limit);
        return {
          seriesId: def.key,
          ...(Array.isArray(loaded) ? { observations: loaded } : loaded),
          provenance: "fred",
        };
      }
      case "fred-sum": {
        const legs = await Promise.all(
          source.seriesIds.map((seriesId) => deps.loadFred(seriesId, source.limit)),
        );
        return { seriesId: def.key, ...sumFredSeries(legs), provenance: "fred" };
      }
      case "market-history":
        return {
          seriesId: def.key,
          observations: await deps.loadMarketHistory(
            source.symbol,
            source.exchange,
            source.startDate,
          ),
          provenance: "market",
        };
      case "shiller": {
        const payload = await shiller();
        return {
          seriesId: def.key,
          observations: shillerObservations(payload, source.field),
          provider: { fetchedAt: providerTimestamp(payload.fetchedAt), stale: null },
          provenance: "shiller",
        };
      }
      default: {
        const _exhaustive: never = source;
        return _exhaustive;
      }
    }
  };
}

export type ValuationCloudClient = Pick<
  typeof apiClient,
  "getCloudFredSeries" | "getCloudHistory" | "getCloudShiller"
>;

function providerTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function createCloudSourceDeps(client: ValuationCloudClient): ValuationSourceDeps {
  return {
    loadFred: async (seriesId, limit) => {
      const data = await client.getCloudFredSeries(seriesId, { limit, sortOrder: "desc" });
      return { observations: data.observations, provider: {
        fetchedAt: providerTimestamp(data.fetchedAt),
        stale: typeof data.stale === "boolean" ? data.stale : null,
      } };
    },
    loadMarketHistory: async (symbol, exchange, startDate) => {
      const response = await client.getCloudHistory(symbol, exchange, {
        interval: "1d",
        startDate,
      });
      return historyToObservations(response.data ?? []);
    },
    loadShiller: () => client.getCloudShiller(),
  };
}

export const cloudSourceDeps: ValuationSourceDeps = createCloudSourceDeps(apiClient);
