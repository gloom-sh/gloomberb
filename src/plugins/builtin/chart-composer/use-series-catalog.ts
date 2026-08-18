import { useEffect, useMemo, useState } from "react";
import { searchTickerCandidates } from "../../../tickers/search";
import { useOptionalAppSelector } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { searchChartSeriesCapabilities } from "../../../capabilities";
import { getSharedRegistry } from "../../registry";
import {
  analyzeSeriesSearchQuery,
  buildCapabilitySeriesSuggestions,
  buildSeriesCatalogSuggestions,
  type SeriesCatalogInstrument,
  type SeriesCatalogSuggestion,
} from "./series-catalog";

const EMPTY_TICKERS: ReadonlyMap<string, TickerRecord> = new Map();

export interface SeriesCatalogSearchResult {
  suggestions: SeriesCatalogSuggestion[];
  instruments: SeriesCatalogInstrument[];
  loading: boolean;
}

/** Shared smart-series search used by both inline quick-add and the full editor. */
export function useSeriesCatalogSuggestions({
  query,
  defaultInstrument,
  enabled,
}: {
  query: string;
  defaultInstrument: SeriesCatalogInstrument;
  enabled: boolean;
}): SeriesCatalogSearchResult {
  const tickers = useOptionalAppSelector((state) => state.tickers, EMPTY_TICKERS);
  const analysis = useMemo(() => analyzeSeriesSearchQuery(query), [query]);
  const [providerSearch, setProviderSearch] = useState<{
    query: string;
    suggestions: SeriesCatalogSuggestion[];
    loading: boolean;
  }>({ query: "", suggestions: [], loading: false });
  const [search, setSearch] = useState<{
    query: string;
    instruments: SeriesCatalogInstrument[];
    loading: boolean;
  }>({ query: "", instruments: [], loading: false });

  useEffect(() => {
    const normalizedQuery = query.trim();
    const registry = getSharedRegistry();
    if (!enabled || !normalizedQuery || !registry) {
      setProviderSearch({ query: "", suggestions: [], loading: false });
      return;
    }
    let cancelled = false;
    setProviderSearch({ query: normalizedQuery, suggestions: [], loading: true });
    const timer = setTimeout(() => {
      void searchChartSeriesCapabilities(registry, normalizedQuery).then((items) => {
        if (!cancelled) setProviderSearch({
          query: normalizedQuery,
          suggestions: buildCapabilitySeriesSuggestions(items),
          loading: false,
        });
      }).catch(() => {
        if (!cancelled) setProviderSearch({ query: normalizedQuery, suggestions: [], loading: false });
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, query]);

  useEffect(() => {
    const instrumentQuery = analysis.instrumentQuery.trim();
    if (!enabled || !instrumentQuery || analysis.directInstrument) {
      setSearch({ query: "", instruments: [], loading: false });
      return;
    }

    const registry = getSharedRegistry();
    if (!registry) {
      setSearch({ query: instrumentQuery, instruments: [], loading: false });
      return;
    }

    let cancelled = false;
    setSearch({ query: instrumentQuery, instruments: [], loading: true });
    const timer = setTimeout(() => {
      void searchTickerCandidates({
        query: instrumentQuery,
        tickers,
        dataProvider: registry.marketData,
        totalLimit: 4,
        localLimit: 3,
        includeOptionContracts: false,
      }).then((candidates) => {
        if (cancelled) return;
        setSearch({
          query: instrumentQuery,
          instruments: candidates.map((candidate) => ({
            symbol: candidate.symbol,
            ...(candidate.ticker?.metadata.exchange
              ? { exchange: candidate.ticker.metadata.exchange }
              : candidate.result?.primaryExchange || candidate.result?.exchange
                ? { exchange: candidate.result?.primaryExchange || candidate.result?.exchange }
                : {}),
            ...(candidate.ticker?.metadata.name || candidate.result?.name
              ? { name: candidate.ticker?.metadata.name || candidate.result?.name }
              : {}),
          })),
          loading: false,
        });
      }).catch(() => {
        if (!cancelled) setSearch({ query: instrumentQuery, instruments: [], loading: false });
      });
    }, 80);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [analysis.directInstrument, analysis.instrumentQuery, enabled, tickers]);

  const instruments = search.query === analysis.instrumentQuery
    ? search.instruments
    : [];
  const suggestions = useMemo(() => {
    const builtIn = buildSeriesCatalogSuggestions(query, defaultInstrument, instruments);
    const provider = providerSearch.query === query.trim() ? providerSearch.suggestions : [];
    return [...provider, ...builtIn.filter((entry) => !provider.some((candidate) => candidate.id === entry.id))].slice(0, 8);
  }, [defaultInstrument, instruments, providerSearch, query]);

  return {
    suggestions,
    instruments,
    loading: (search.loading && search.query === analysis.instrumentQuery)
      || (providerSearch.loading && providerSearch.query === query.trim()),
  };
}
