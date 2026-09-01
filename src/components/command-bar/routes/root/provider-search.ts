import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import { searchTickerCandidates } from "../../../../tickers/search";
import {
  mergePlainRootTickerResults,
  mergeTickerSearchResultItems,
  QUICK_LOOK_TICKER_SEARCH_OPTIONS,
} from "../ticker-search/results";
import { orderListResults, type ResultItem } from "../../list/model";
import type { CommandBarCategoryPriorities, CommandBarSectionOrder } from "../../view-model";
import type { CommandBarRoute } from "../../workflow/types";

export function useRootProviderSearch(options: {
  activeCollectionId: string | null;
  buildTickerSearchResultItems: (candidates: TickerSearchCandidate[], query: string) => ResultItem[];
  categoryPriorities?: CommandBarCategoryPriorities;
  currentRoute: CommandBarRoute | null;
  dataProvider: DataProvider;
  localTickerSearchResultItems: (query?: string, options?: { category?: string; limit?: number }) => ResultItem[];
  portfolios: AppState["config"]["portfolios"];
  readTickerSearchCache: (
    query: string,
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ) => TickerSearchCandidate[] | null;
  rootPlainTickerSearchArg: string | null;
  rootResultItems: ResultItem[];
  rootTickerSearchArg: string | null;
  tickers: AppState["tickers"];
  writeTickerSearchCache: (
    query: string,
    candidates: TickerSearchCandidate[],
    brokerId?: string | null,
    brokerInstanceId?: string | null,
  ) => void;
}): {
  activeRootProviderResultsKey: string | null;
  orderedRootResults: ResultItem[];
  rootSearching: boolean;
  rootSectionOrder: CommandBarSectionOrder;
} {
  const {
    activeCollectionId,
    buildTickerSearchResultItems,
    categoryPriorities,
    currentRoute,
    dataProvider,
    localTickerSearchResultItems,
    portfolios,
    readTickerSearchCache,
    rootPlainTickerSearchArg,
    rootResultItems,
    rootTickerSearchArg,
    tickers,
    writeTickerSearchCache,
  } = options;
  const [rootSearching, setRootSearching] = useState(false);
  const [rootProviderResults, setRootProviderResults] = useState<ResultItem[] | null>(null);
  const [rootProviderResultsQuery, setRootProviderResultsQuery] = useState<string | null>(null);
  const rootSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootSearchRequestIdRef = useRef(0);
  const rootLastSearchedQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentRoute) {
      rootSearchRequestIdRef.current += 1;
      setRootSearching(false);
      setRootProviderResults(null);
      setRootProviderResultsQuery(null);
      rootLastSearchedQueryRef.current = null;
      if (rootSearchTimerRef.current) clearTimeout(rootSearchTimerRef.current);
      return;
    }

    if (!rootTickerSearchArg) {
      rootSearchRequestIdRef.current += 1;
      setRootSearching(false);
      setRootProviderResults(null);
      setRootProviderResultsQuery(null);
      rootLastSearchedQueryRef.current = null;
      if (rootSearchTimerRef.current) clearTimeout(rootSearchTimerRef.current);
      return;
    }

    const searchQuery = rootTickerSearchArg;
    // A re-run for the same query (a quote refresh changed `tickers`, say) must
    // leave the pending debounce alone, or the search is lost and the spinner
    // never clears. Only a new query cancels it.
    if (rootLastSearchedQueryRef.current === searchQuery) {
      return;
    }
    if (rootSearchTimerRef.current) clearTimeout(rootSearchTimerRef.current);

    rootLastSearchedQueryRef.current = searchQuery;
    setRootSearching(true);
    const activeSearchPortfolio = portfolios.find((portfolio) => portfolio.id === activeCollectionId);
    const cachedCandidates = readTickerSearchCache(
      searchQuery,
      activeSearchPortfolio?.brokerId,
      activeSearchPortfolio?.brokerInstanceId,
    );
    const localItems = localTickerSearchResultItems(searchQuery, { limit: 6 });
    setRootProviderResults(cachedCandidates
      ? mergeTickerSearchResultItems(searchQuery, buildTickerSearchResultItems(cachedCandidates, searchQuery), localItems)
      : null);
    setRootProviderResultsQuery(cachedCandidates ? searchQuery : null);

    const requestId = ++rootSearchRequestIdRef.current;
    rootSearchTimerRef.current = setTimeout(async () => {
      try {
        const publish = (candidates: TickerSearchCandidate[]) => {
          setRootProviderResults(mergeTickerSearchResultItems(
            searchQuery,
            buildTickerSearchResultItems(candidates, searchQuery),
            localTickerSearchResultItems(searchQuery, { limit: 6 }),
          ));
          setRootProviderResultsQuery(searchQuery);
        };
        const combined = await searchTickerCandidates({
          query: searchQuery,
          tickers,
          dataProvider,
          searchContext: {
            preferBroker: true,
            interactive: true,
            brokerId: activeSearchPortfolio?.brokerId,
            brokerInstanceId: activeSearchPortfolio?.brokerInstanceId,
          },
          // A broker that answers after the cloud upgrades the rows in place
          // rather than being dropped because the list was already drawn.
          onPartial: (candidates) => {
            if (requestId !== rootSearchRequestIdRef.current) return;
            publish(candidates);
          },
          ...QUICK_LOOK_TICKER_SEARCH_OPTIONS,
        });
        if (requestId !== rootSearchRequestIdRef.current) return;
        writeTickerSearchCache(
          searchQuery,
          combined,
          activeSearchPortfolio?.brokerId,
          activeSearchPortfolio?.brokerInstanceId,
        );
        publish(combined);
      } catch {
        if (requestId !== rootSearchRequestIdRef.current) return;
        setRootProviderResults([{
          id: "search-error",
          label: "Search failed",
          detail: "Check your connection",
          category: "Search",
          kind: "info",
          action: () => {},
        }]);
        setRootProviderResultsQuery(searchQuery);
      } finally {
        if (requestId === rootSearchRequestIdRef.current) {
          setRootSearching(false);
        }
      }
    }, 200);
  }, [
    activeCollectionId,
    buildTickerSearchResultItems,
    currentRoute,
    dataProvider,
    localTickerSearchResultItems,
    portfolios,
    readTickerSearchCache,
    rootTickerSearchArg,
    tickers,
    writeTickerSearchCache,
  ]);

  useEffect(() => () => {
    if (rootSearchTimerRef.current) clearTimeout(rootSearchTimerRef.current);
  }, []);

  const rootResults = useMemo(() => {
    if (rootTickerSearchArg && rootProviderResultsQuery === rootTickerSearchArg && rootProviderResults) {
      if (rootPlainTickerSearchArg) {
        return mergePlainRootTickerResults(rootPlainTickerSearchArg, rootProviderResults, rootResultItems);
      }
      return rootProviderResults;
    }
    return rootResultItems;
  }, [
    rootPlainTickerSearchArg,
    rootProviderResults,
    rootProviderResultsQuery,
    rootResultItems,
    rootTickerSearchArg,
  ]);
  const rootSectionOrder: CommandBarSectionOrder = rootPlainTickerSearchArg
    ? "app-first"
    : rootTickerSearchArg
      ? "ranked"
      : "default";
  const orderedRootResults = useMemo(
    () => orderListResults(rootResults, { sectionOrder: rootSectionOrder, categoryPriorities }),
    [categoryPriorities, rootResults, rootSectionOrder],
  );
  // Only the DES route replaces the list wholesale and so wants the selection
  // reset when the answer lands; a plain query's instruments append below the
  // local matches, and the row the user is on must stay put.
  const activeRootProviderResultsKey = useMemo(() => {
    if (rootPlainTickerSearchArg) return null;
    if (!rootTickerSearchArg || rootProviderResultsQuery !== rootTickerSearchArg || !rootProviderResults) return null;
    return [
      rootTickerSearchArg,
      ...rootProviderResults.map((item) => `${item.id}:${item.category}:${item.label}:${item.right || ""}`),
    ].join("\n");
  }, [rootPlainTickerSearchArg, rootProviderResults, rootProviderResultsQuery, rootTickerSearchArg]);

  return {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootSearching,
    rootSectionOrder,
  };
}
