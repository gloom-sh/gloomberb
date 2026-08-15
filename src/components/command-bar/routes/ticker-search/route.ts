import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import { searchTickerCandidates } from "../../../../tickers/search";
import {
  mergeTickerSearchResultItems,
  QUICK_LOOK_TICKER_SEARCH_OPTIONS,
} from "./results";
import type { ResultItem } from "../../list/model";

export function useTickerSearchRouteResults(options: {
  brokerId?: string | null;
  brokerInstanceId?: string | null;
  buildTickerSearchResultItems: (candidates: TickerSearchCandidate[], query: string) => ResultItem[];
  dataProvider: DataProvider;
  getTickers: () => AppState["tickers"];
  localTickerSearchResultItems: (query?: string, options?: { category?: string; limit?: number }) => ResultItem[];
  readTickerSearchCache: (
    query: string,
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ) => TickerSearchCandidate[] | null;
  routeQuery: string | null;
  skipTickerSearchDebounceRef: { current: boolean };
  writeTickerSearchCache: (
    query: string,
    candidates: TickerSearchCandidate[],
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ) => void;
}): {
  tickerSearchPending: boolean;
  tickerSearchResults: ResultItem[];
} {
  const {
    brokerId,
    brokerInstanceId,
    buildTickerSearchResultItems,
    dataProvider,
    getTickers,
    localTickerSearchResultItems,
    readTickerSearchCache,
    routeQuery,
    skipTickerSearchDebounceRef,
    writeTickerSearchCache,
  } = options;
  const [tickerSearchResults, setTickerSearchResults] = useState<ResultItem[]>([]);
  const [tickerSearchPending, setTickerSearchPending] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);

  const resetTickerSearchRoute = useCallback(() => {
    searchRequestIdRef.current += 1;
    setTickerSearchPending(false);
    setTickerSearchResults([]);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    if (routeQuery == null) {
      resetTickerSearchRoute();
      return;
    }

    const searchQuery = routeQuery.trim();
    if (!searchQuery) {
      searchRequestIdRef.current += 1;
      setTickerSearchPending(false);
      setTickerSearchResults(localTickerSearchResultItems(undefined, { limit: 8 }));
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      return;
    }

    setTickerSearchPending(true);
    const localItems = localTickerSearchResultItems(searchQuery, { limit: 6 });
    const cachedCandidates = readTickerSearchCache(
      searchQuery,
      brokerId,
      brokerInstanceId,
    );
    setTickerSearchResults(cachedCandidates
      ? mergeTickerSearchResultItems(searchQuery, buildTickerSearchResultItems(cachedCandidates, searchQuery), localItems)
      : localItems);
    const requestId = ++searchRequestIdRef.current;
    const searchDelay = skipTickerSearchDebounceRef.current ? 0 : 200;
    skipTickerSearchDebounceRef.current = false;

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const combined = await searchTickerCandidates({
          query: searchQuery,
          tickers: getTickers(),
          dataProvider,
          searchContext: {
            preferBroker: true,
            brokerId: brokerId ?? undefined,
            brokerInstanceId: brokerInstanceId ?? undefined,
          },
          ...QUICK_LOOK_TICKER_SEARCH_OPTIONS,
        });
        if (requestId !== searchRequestIdRef.current) return;
        writeTickerSearchCache(
          searchQuery,
          combined,
          brokerId,
          brokerInstanceId,
        );
        setTickerSearchResults(mergeTickerSearchResultItems(
          searchQuery,
          buildTickerSearchResultItems(combined, searchQuery),
          localTickerSearchResultItems(searchQuery, { limit: 6 }),
        ));
      } catch {
        if (requestId !== searchRequestIdRef.current) return;
        const nextItems: ResultItem[] = [{
          id: "search-error",
          label: "Search failed",
          detail: "Check your connection",
          category: "Search",
          kind: "info",
          action: () => {},
        }];
        setTickerSearchResults(nextItems);
      } finally {
        if (requestId === searchRequestIdRef.current) {
          setTickerSearchPending(false);
        }
      }
    }, searchDelay);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [
    brokerId,
    brokerInstanceId,
    buildTickerSearchResultItems,
    dataProvider,
    getTickers,
    localTickerSearchResultItems,
    readTickerSearchCache,
    resetTickerSearchRoute,
    routeQuery,
    skipTickerSearchDebounceRef,
    writeTickerSearchCache,
  ]);

  return {
    tickerSearchPending,
    tickerSearchResults,
  };
}
