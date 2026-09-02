import { apiClient } from "../../../api-client";
import type { CloudShillerPayload } from "../../../api-client";
import type { SeriesDef, ShillerField } from "./defs";
import type { DatedObservation, DatedSeries } from "./series";

/**
 * Every leg goes through the Gloom Cloud proxy. Earlier revisions reached Yahoo and
 * fredgraph.csv directly, which forced the pane out of the hosted browser build,
 * since both are blocked there by CORS and the worker's connect-src policy.
 */
export interface ValuationSourceDeps {
  loadFred: (seriesId: string, limit: number) => Promise<DatedObservation[]>;
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

export function historyToObservations(
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

export function provenanceFor(def: SeriesDef): DatedSeries["provenance"] {
  switch (def.source.kind) {
    case "fred":
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
  const shiller = () => (shillerRequest ??= deps.loadShiller().catch((error) => {
    shillerRequest = null;
    throw error;
  }));

  return async (def: SeriesDef): Promise<DatedSeries> => {
    const source = def.source;
    switch (source.kind) {
      case "fred":
        return {
          seriesId: def.key,
          observations: await deps.loadFred(source.seriesId, source.limit),
          provenance: "fred",
        };
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
      case "shiller":
        return {
          seriesId: def.key,
          observations: shillerObservations(await shiller(), source.field),
          provenance: "shiller",
        };
      default: {
        const _exhaustive: never = source;
        return _exhaustive;
      }
    }
  };
}

export const cloudSourceDeps: ValuationSourceDeps = {
  loadFred: async (seriesId, limit) => {
    const data = await apiClient.getCloudFredSeries(seriesId, { limit, sortOrder: "desc" });
    return data.observations;
  },
  loadMarketHistory: async (symbol, exchange, startDate) => {
    const response = await apiClient.getCloudHistory(symbol, exchange, {
      interval: "1d",
      startDate,
    });
    return historyToObservations(response.data ?? []);
  },
  loadShiller: () => apiClient.getCloudShiller(),
};
