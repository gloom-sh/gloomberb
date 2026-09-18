import { useEffect, useMemo, useState } from "react";
import {
  buildTickerSearchCandidates,
  searchTickerCandidates,
} from "../../../tickers/search";
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
const EMPTY_RECENT: readonly string[] = [];
const MAX_SERIES_SUGGESTIONS = 8;
const DEFAULT_CATALOG_INSTRUMENTS: readonly SeriesCatalogInstrument[] = [
  { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." },
  { symbol: "MSFT", exchange: "NASDAQ", name: "Microsoft Corporation" },
  { symbol: "GOOGL", exchange: "NASDAQ", name: "Alphabet Inc." },
  { symbol: "AMZN", exchange: "NASDAQ", name: "Amazon.com Inc." },
  { symbol: "NVDA", exchange: "NASDAQ", name: "NVIDIA Corporation" },
  { symbol: "TSLA", exchange: "NASDAQ", name: "Tesla Inc." },
  { symbol: "META", exchange: "NASDAQ", name: "Meta Platforms Inc." },
  { symbol: "BRK.B", exchange: "NYSE", name: "Berkshire Hathaway Inc." },
  { symbol: "JPM", exchange: "NYSE", name: "JPMorgan Chase & Co." },
  { symbol: "V", exchange: "NYSE", name: "Visa Inc." },
  { symbol: "BTC-USD", exchange: "CCC", name: "Bitcoin USD" },
  { symbol: "ETH-USD", exchange: "CCC", name: "Ethereum USD" },
];

function instrumentFromTicker(ticker: TickerRecord): SeriesCatalogInstrument {
  return {
    symbol: ticker.metadata.ticker,
    ...(ticker.metadata.exchange ? { exchange: ticker.metadata.exchange } : {}),
    ...(ticker.metadata.name ? { name: ticker.metadata.name } : {}),
    ...(ticker.metadata.assetCategory ? { assetCategory: ticker.metadata.assetCategory } : {}),
  };
}

function uniqueCatalogInstruments(
  instruments: readonly SeriesCatalogInstrument[],
): SeriesCatalogInstrument[] {
  const seen = new Set<string>();
  return instruments.filter((instrument) => {
    const key = `${instrument.symbol}:${instrument.exchange ?? ""}:${instrument.assetCategory ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateToInstrument(candidate: {
  symbol: string;
  ticker?: TickerRecord;
  result?: { primaryExchange?: string; exchange?: string; name?: string; type?: string };
}): SeriesCatalogInstrument {
  const exchange = candidate.ticker?.metadata.exchange
    || candidate.result?.primaryExchange
    || candidate.result?.exchange;
  const name = candidate.ticker?.metadata.name || candidate.result?.name;
  const assetCategory = candidate.ticker?.metadata.assetCategory || candidate.result?.type;
  return {
    symbol: candidate.symbol,
    ...(exchange ? { exchange } : {}),
    ...(name ? { name } : {}),
    ...(assetCategory ? { assetCategory } : {}),
  };
}

export function useCatalogUniverse(query: string): {
  instruments: SeriesCatalogInstrument[];
  loading: boolean;
} {
  const tickers = useOptionalAppSelector((state) => state.tickers, EMPTY_TICKERS);
  const recentSymbols = useOptionalAppSelector((state) => state.recentTickers, EMPTY_RECENT);
  const watchlist = useMemo(
    () => [...tickers.values()].map(instrumentFromTicker),
    [tickers],
  );
  const recents = useMemo(
    () => recentSymbols.flatMap((symbol) => {
      const ticker = tickers.get(symbol);
      if (ticker) return [instrumentFromTicker(ticker)];
      const trimmed = symbol.trim();
      return trimmed ? [{ symbol: trimmed }] : [];
    }),
    [recentSymbols, tickers],
  );
  const [search, setSearch] = useState<{
    query: string;
    instruments: SeriesCatalogInstrument[];
    loading: boolean;
  }>({ query: "", instruments: [], loading: false });

  useEffect(() => {
    const instrumentQuery = query.trim();
    if (!instrumentQuery || instrumentQuery.includes(":")) {
      setSearch((current) => (
        current.query === "" && current.instruments.length === 0 && !current.loading
          ? current
          : { query: "", instruments: [], loading: false }
      ));
      return;
    }

    const applyLocal = () => {
      const candidates = buildTickerSearchCandidates({
        query: instrumentQuery,
        tickers,
        providerResults: [],
        totalLimit: 12,
        localLimit: 8,
        includeOptionContracts: true,
      });
      setSearch({
        query: instrumentQuery,
        instruments: candidates.map(candidateToInstrument),
        loading: false,
      });
    };

    const registry = getSharedRegistry();
    if (!registry) {
      applyLocal();
      return;
    }

    let cancelled = false;
    setSearch({ query: instrumentQuery, instruments: [], loading: true });
    const timer = setTimeout(() => {
      void searchTickerCandidates({
        query: instrumentQuery,
        tickers,
        dataProvider: registry.marketData,
        totalLimit: 12,
        localLimit: 8,
        includeOptionContracts: true,
      }).then((candidates) => {
        if (cancelled) return;
        setSearch({
          query: instrumentQuery,
          instruments: candidates.map(candidateToInstrument),
          loading: false,
        });
      }).catch(() => {
        if (!cancelled) applyLocal();
      });
    }, 80);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tickers]);

  const searched = search.query === query.trim() ? search.instruments : [];
  const instruments = useMemo(() => {
    const merged = uniqueCatalogInstruments([...watchlist, ...recents, ...searched]);
    return merged.length > 0 ? merged : [...DEFAULT_CATALOG_INSTRUMENTS];
  }, [recents, searched, watchlist]);

  return {
    instruments,
    loading: search.loading && search.query === query.trim(),
  };
}

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
      void searchChartSeriesCapabilities(registry, normalizedQuery, MAX_SERIES_SUGGESTIONS, controller.signal).then((items) => {
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
          instruments: candidates.map(candidateToInstrument),
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
  // Securities and metrics come first: they are what most searches are after,
  // and they arrive well before plugin catalogs (which can take seconds), so
  // late plugin results append below instead of pushing the list around.
  const suggestions = useMemo(() => {
    const builtIn = buildSeriesCatalogSuggestions(query, defaultInstrument, instruments);
    const provider = providerSearch.query === query.trim() ? providerSearch.suggestions : [];
    return [...builtIn, ...provider.filter((entry) => !builtIn.some((candidate) => candidate.id === entry.id))]
      .slice(0, MAX_SERIES_SUGGESTIONS);
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
