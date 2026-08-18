import { useMemo } from "react";
import { apiClient } from "../api-client";
import { loadCachedFredSeries } from "../data/fred-series";
import { instrumentFromTicker } from "../market-data/request-types";
import { useAssetData, useCapabilityInvoker } from "../plugins/runtime";
import { createChartSeriesResolver } from "../capabilities";
import { useAppSelector } from "../state/app/context";
import type { FredSeriesRequest } from "../data/fred-series";
import type { TickerRecord } from "../types/ticker";
import type { ChartSpec } from "./types";
import {
  useChartResolution,
  type UseChartResolutionOptions,
  type UseChartResolutionResult,
} from "./use-chart-resolution";

async function loadFred(request: FredSeriesRequest) {
  return loadCachedFredSeries(
    request,
    () => apiClient.getCloudFredSeries(request.seriesId, {
      startDate: request.startDate,
      sortOrder: request.sortOrder,
    }),
  );
}

export function hydrateChartSpecInstruments(
  spec: ChartSpec,
  tickers: ReadonlyMap<string, TickerRecord>,
): ChartSpec {
  let changed = false;
  const series = spec.series.map((entry) => {
    if (entry.source.kind !== "security" || entry.source.instrument.exchange?.trim()) {
      return entry;
    }
    const symbol = entry.source.instrument.symbol.trim().toUpperCase();
    const instrument = instrumentFromTicker(tickers.get(symbol), symbol);
    if (!instrument?.exchange) return entry;
    changed = true;
    return {
      ...entry,
      source: {
        ...entry.source,
        instrument: {
          ...instrument,
          ...entry.source.instrument,
          exchange: instrument.exchange,
        },
      },
    };
  });
  return changed ? { ...spec, series } : spec;
}

export function useResolvedChartSpec(
  spec: ChartSpec,
  options: UseChartResolutionOptions = {},
): UseChartResolutionResult {
  const dataProvider = useAssetData();
  const capabilityInvoker = useCapabilityInvoker();
  const tickers = useAppSelector((state) => state.tickers);
  const hydratedSpec = useMemo(
    () => hydrateChartSpecInstruments(spec, tickers),
    [spec, tickers],
  );
  const sources = useMemo(() => ({
    dataProvider,
    loadFredSeries: loadFred,
    resolveCapabilitySeries: createChartSeriesResolver(capabilityInvoker),
  }), [capabilityInvoker, dataProvider]);
  return useChartResolution(hydratedSpec, sources, options);
}
