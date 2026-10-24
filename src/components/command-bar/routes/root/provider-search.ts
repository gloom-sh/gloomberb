import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import { LISTING_SEARCH_LIMIT, searchTickerCandidates } from "../../../../tickers/search";
import {
  mergePlainRootTickerResults,
  mergeTickerSearchResultItems,
  QUICK_LOOK_TICKER_SEARCH_OPTIONS,
  tickerSearchFailureItems,
  venueDropdownResults,
  type RootTickerReading,
} from "../ticker-search/results";
import { ProviderBusyError, SEARCH_BUSY_MESSAGE } from "../../../../sources/provider-errors";
import { OperationTimeoutError, withDeadline } from "../../../../utils/async-deadline";
import { orderListResults, type ResultItem } from "../../list/model";
import type { CommandBarCategoryPriorities, CommandBarSectionOrder } from "../../view-model";
import type { CommandBarRoute } from "../../workflow/types";

/**
 * How long the root symbol search may take. Gloom Cloud gives up after ten
 * seconds, so a search still going at this point is stuck on something else (a
 * broker that never answers) and the bar stops searching for it.
 */
export const ROOT_SEARCH_TIMEOUT_MS = 15_000;

/**
 * The search's answer, or a busy service once `timeoutMs` passes: the same row a
 * rate-limited search gets, since nothing was found and a retry may find it.
 */
export async function searchWithinDeadline<T>(search: Promise<T>, timeoutMs = ROOT_SEARCH_TIMEOUT_MS): Promise<T> {
  try {
    return await withDeadline(search, timeoutMs, "Symbol search timed out");
  } catch (error) {
    if (error instanceof OperationTimeoutError) throw new ProviderBusyError(SEARCH_BUSY_MESSAGE, { cause: error });
    throw error;
  }
}

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
  /** Set when the query is `NET:` or `NET:N`. Empty string lists every venue. */
  listingSuffix: string | null;
  /** What a plain query written as a terminal's code or a near miss reads as (`VOD LN`, `700.HK`). */
  reading?: RootTickerReading | null;
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
  /** False while the list is the local stand-in for a symbol search that has not answered. */
  rootResultsCurrent: boolean;
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
    listingSuffix,
    reading = null,
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
      let published = false;
      const publish = (candidates: TickerSearchCandidate[]) => {
        published = true;
        setRootProviderResults(mergeTickerSearchResultItems(
          searchQuery,
          buildTickerSearchResultItems(candidates, searchQuery),
          localTickerSearchResultItems(searchQuery, { limit: 6 }),
        ));
        setRootProviderResultsQuery(searchQuery);
      };
      try {
        const combined = await searchWithinDeadline(searchTickerCandidates({
          query: searchQuery,
          tickers,
          dataProvider,
          searchContext: {
            preferBroker: true,
            interactive: true,
            limit: LISTING_SEARCH_LIMIT,
            brokerId: activeSearchPortfolio?.brokerId,
            brokerInstanceId: activeSearchPortfolio?.brokerInstanceId,
          },
          // A broker that answers after the cloud upgrades the rows in place
          // rather than being dropped because the list was already drawn.
          onPartial: (candidates) => {
            if (requestId !== rootSearchRequestIdRef.current) return;
            publish(candidates);
          },
          // The rows the CLI reads a symbol's listings from, so `CAR:` offers CAR Group on ASX (its eleventh).
          totalLimit: LISTING_SEARCH_LIMIT,
          ...QUICK_LOOK_TICKER_SEARCH_OPTIONS,
        }));
        if (requestId !== rootSearchRequestIdRef.current) return;
        writeTickerSearchCache(
          searchQuery,
          combined,
          activeSearchPortfolio?.brokerId,
          activeSearchPortfolio?.brokerInstanceId,
        );
        publish(combined);
      } catch (error) {
        if (requestId !== rootSearchRequestIdRef.current) return;
        // Rows a faster source already put up are the answer a search that went quiet leaves.
        if (published && error instanceof ProviderBusyError && error.cause instanceof OperationTimeoutError) return;
        setRootProviderResults(tickerSearchFailureItems(error, searchQuery, localTickerSearchResultItems(searchQuery, { limit: 6 })));
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
    if (listingSuffix != null) {
      if (rootTickerSearchArg && rootProviderResultsQuery === rootTickerSearchArg && rootProviderResults) {
        return venueDropdownResults(rootTickerSearchArg, rootProviderResults, listingSuffix);
      }
      // The venue list replaces commands. Nothing else shows while it loads.
      return [];
    }
    if (rootTickerSearchArg && rootProviderResultsQuery === rootTickerSearchArg && rootProviderResults) {
      if (rootPlainTickerSearchArg) {
        return mergePlainRootTickerResults(rootPlainTickerSearchArg, rootProviderResults, rootResultItems, reading);
      }
      return rootProviderResults;
    }
    return rootResultItems;
  }, [
    listingSuffix,
    reading,
    rootPlainTickerSearchArg,
    rootProviderResults,
    rootProviderResultsQuery,
    rootResultItems,
    rootTickerSearchArg,
  ]);
  const rootSectionOrder: CommandBarSectionOrder = listingSuffix != null
    ? "ranked"
    : rootPlainTickerSearchArg
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

  // The rows before the answer are for whatever the query matches locally, not the rows Enter will land on.
  const rootResultsCurrent = !rootTickerSearchArg || (rootProviderResultsQuery === rootTickerSearchArg && !!rootProviderResults);

  return {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootResultsCurrent,
    rootSearching,
    rootSectionOrder,
  };
}
