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
  /** Set when a lookup failed, so an outage is never reported as zero matches. */
  error: string | null;
}

function searchFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Series search failed.";
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
    error: string | null;
  }>({ query: "", suggestions: [], loading: false, error: null });
  const [search, setSearch] = useState<{
    query: string;
    instruments: SeriesCatalogInstrument[];
    loading: boolean;
    error: string | null;
  }>({ query: "", instruments: [], loading: false, error: null });

  useEffect(() => {
    const normalizedQuery = query.trim();
    const registry = getSharedRegistry();
    if (!enabled || !normalizedQuery || !registry) {
      setProviderSearch({ query: "", suggestions: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setProviderSearch({ query: normalizedQuery, suggestions: [], loading: true, error: null });
    const timer = setTimeout(() => {
      void searchChartSeriesCapabilities(registry, normalizedQuery, 8, controller.signal).then((items) => {
        if (!cancelled) setProviderSearch({
          query: normalizedQuery,
          suggestions: buildCapabilitySeriesSuggestions(items),
          loading: false,
          error: null,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || cancelled) return;
        setProviderSearch({
          query: normalizedQuery,
          suggestions: [],
          loading: false,
          error: searchFailureMessage(error),
        });
      });
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, query]);

  useEffect(() => {
    const instrumentQuery = analysis.instrumentQuery.trim();
    if (!enabled || !instrumentQuery || analysis.directInstrument) {
      setSearch({ query: "", instruments: [], loading: false, error: null });
      return;
    }

    const registry = getSharedRegistry();
    if (!registry) {
      setSearch({ query: instrumentQuery, instruments: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setSearch({ query: instrumentQuery, instruments: [], loading: true, error: null });
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
          error: null,
        });
      }).catch((error: unknown) => {
        if (!cancelled) {
          setSearch({
            query: instrumentQuery,
            instruments: [],
            loading: false,
            error: searchFailureMessage(error),
          });
        }
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
    error: (search.query === analysis.instrumentQuery ? search.error : null)
      ?? (providerSearch.query === query.trim() ? providerSearch.error : null),
  };
}
