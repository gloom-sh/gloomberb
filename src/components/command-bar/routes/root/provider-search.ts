import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { AppState } from "../../../../state/app/context";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerSearchCandidate } from "../../../../tickers/search";
import { buildTickerSearchCandidates, LISTING_SEARCH_LIMIT, searchTickerCandidates, symbolSearchQuery } from "../../../../tickers/search";
import { getListingIndexVersion, knownListings, listingIndexKey, subscribeListingIndex } from "../../../../tickers/search/listing-index";
import {
  DID_YOU_MEAN_CATEGORY,
  isExactTickerResultMatch,
  leadWithShownListings,
  listingRowKey,
  mergePlainRootTickerResults,
  mergeTickerSearchResultItems,
  QUICK_LOOK_TICKER_SEARCH_OPTIONS,
  tickerSearchFailureItems,
  venueDropdownResults,
  withMajorCoinCandidate,
  wordNamesCommand,
  type RootTickerReading,
} from "../ticker-search/results";
import { ProviderBusyError, SEARCH_BUSY_MESSAGE } from "../../../../sources/provider-errors";
import { OperationTimeoutError, withDeadline } from "../../../../utils/async-deadline";
import { orderListResults, type ResultItem } from "../../list/model";
import { assistAfterListings, exactMatchAfterCommands, type CommandBarCategoryPriorities, type CommandBarSectionOrder } from "../../view-model";
import type { CommandBarRoute } from "../../workflow/types";

/**
 * How long the root symbol search may take. Gloom Cloud gives up after ten
 * seconds, so a search still going at this point is stuck on something else (a
 * broker that never answers) and the bar stops searching for it.
 */
const ROOT_SEARCH_TIMEOUT_MS = 15_000;

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

const NONE_SHOWN: readonly string[] = [];

/** The rows a symbol search would open with, before it answers. */
interface InstantAnswer {
  query: string;
  items: ResultItem[];
  /** Named by the listing index and saved tickers, not by this visit's own answer for the text. */
  fromIndex: boolean;
}

/** The listing rows on screen for a text (`listingRowKey`, in order), and whether the listing index named them. */
interface ShownListings {
  query: string;
  keys: readonly string[];
  fromIndex: boolean;
}

/**
 * What the bar can show for a symbol the moment it is typed: this visit's
 * answer for the same text, or else the lines the listing index and the
 * saved tickers name exactly, built by the same steps as search's answer so
 * each row is the row the answer brings. Null when neither knows the symbol.
 */
function buildInstantAnswer(options: {
  query: string;
  /** Whether the listing index and saved tickers may answer, not only this visit's search. */
  fromIndex: boolean;
  cached: TickerSearchCandidate[] | null;
  tickers: AppState["tickers"];
  savedSymbolKeys: ReadonlySet<string>;
  buildTickerSearchResultItems: (candidates: TickerSearchCandidate[], query: string) => ResultItem[];
  localTickerSearchResultItems: (query?: string, options?: { category?: string; limit?: number }) => ResultItem[];
}): InstantAnswer | null {
  const { query, fromIndex, cached, tickers, savedSymbolKeys, buildTickerSearchResultItems, localTickerSearchResultItems } = options;
  const localItems = () => localTickerSearchResultItems(query, { limit: 6 });
  if (cached) {
    return { query, items: mergeTickerSearchResultItems(query, buildTickerSearchResultItems(withMajorCoinCandidate(query, cached, tickers), query), localItems()), fromIndex: false };
  }
  if (!fromIndex) return null;
  const symbol = symbolSearchQuery(query);
  const known = knownListings(symbol);
  if (known.length === 0 && !savedSymbolKeys.has(listingIndexKey(symbol))) return null;
  const candidates = withMajorCoinCandidate(symbol, buildTickerSearchCandidates({
    query: symbol,
    tickers,
    providerResults: known,
    totalLimit: LISTING_SEARCH_LIMIT,
    ...QUICK_LOOK_TICKER_SEARCH_OPTIONS,
  }), tickers);
  if (candidates.length === 0) return null;
  // Only the exact lines: looser matches are search's to rank.
  const items = mergeTickerSearchResultItems(query, buildTickerSearchResultItems(candidates, query), localItems())
    .filter((item) => isExactTickerResultMatch(item, query));
  return items.length > 0 ? { query, items, fromIndex: true } : null;
}

/** The listing an answer leads with: its first exact line of the text, or its first line. */
function answerTopListing(items: readonly ResultItem[], query: string | null): string | null {
  const top = (query ? items.find((item) => isExactTickerResultMatch(item, query)) : undefined)
    ?? items.find((item) => listingRowKey(item) != null);
  return top ? listingRowKey(top) : null;
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
  /** Set once the user has moved the highlight in this query. */
  rootSelectionNavigatedRef?: RefObject<boolean>;
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
  /** The section order to draw the list with: the providers', and the AI's place once a typed symbol names a listing. */
  rootCategoryPriorities?: CommandBarCategoryPriorities;
  /**
   * Counts the answers that led with another listing than the one the index
   * named on screen: the highlight the user has not moved goes to the answer's.
   */
  rootAnswerTookTop: number;
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
    rootSelectionNavigatedRef,
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
  const listingIndexVersion = useSyncExternalStore(subscribeListingIndex, getListingIndexVersion, getListingIndexVersion);
  const savedSymbolKeys = useMemo(
    () => new Set([...tickers.values()].map((ticker) => listingIndexKey(ticker.metadata.ticker))),
    [tickers],
  );
  const activeSearchPortfolio = portfolios.find((portfolio) => portfolio.id === activeCollectionId);
  const searchBrokerId = activeSearchPortfolio?.brokerId;
  const searchBrokerInstanceId = activeSearchPortfolio?.brokerInstanceId;
  // Built with the keystroke, so the first frame for the text already has it. The index
  // answers only for a plain symbol: a venue list, a code or near miss whose listing the
  // answer decides, DES's own list, which the answer replaces whole, and a broker account's
  // search, whose rows are its own contracts, wait for search.
  const instantAnswer = useMemo(() => {
    if (currentRoute || !rootTickerSearchArg) return null;
    return buildInstantAnswer({
      query: rootTickerSearchArg,
      fromIndex: rootTickerSearchArg === rootPlainTickerSearchArg && listingSuffix == null && !reading
        && !searchBrokerId && !searchBrokerInstanceId,
      cached: readTickerSearchCache(rootTickerSearchArg, searchBrokerId, searchBrokerInstanceId),
      tickers,
      savedSymbolKeys,
      buildTickerSearchResultItems,
      localTickerSearchResultItems,
    });
  // The index is read inside; its version says when what it knows changed.
  }, [
    buildTickerSearchResultItems,
    currentRoute,
    listingIndexVersion,
    listingSuffix,
    localTickerSearchResultItems,
    readTickerSearchCache,
    reading,
    rootPlainTickerSearchArg,
    rootTickerSearchArg,
    savedSymbolKeys,
    searchBrokerId,
    searchBrokerInstanceId,
    tickers,
  ]);
  const instantAnswerRef = useRef(instantAnswer);
  instantAnswerRef.current = instantAnswer;
  /** The listing rows on screen for the text as last drawn; an answer keeps them there (`answerLead`). */
  const shownListingsRef = useRef<ShownListings | null>(null);
  /** The rows each answer leads with, decided once as it lands. */
  const answerLeadRef = useRef<{ answer: ResultItem[]; keys: readonly string[] } | null>(null);
  const answerTookTopRef = useRef(0);

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
    // What the bar already knows for the text is on screen (`instantAnswer`) until search answers.
    setRootProviderResults(null);
    setRootProviderResultsQuery(null);

    const requestId = ++rootSearchRequestIdRef.current;
    rootSearchTimerRef.current = setTimeout(async () => {
      let published = false;
      const publish = (candidates: TickerSearchCandidate[]) => {
        published = true;
        setRootProviderResults(mergeTickerSearchResultItems(
          searchQuery,
          buildTickerSearchResultItems(withMajorCoinCandidate(searchQuery, candidates, tickers), searchQuery),
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
            brokerId: searchBrokerId,
            brokerInstanceId: searchBrokerInstanceId,
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
          searchBrokerId,
          searchBrokerInstanceId,
        );
        publish(combined);
      } catch (error) {
        if (requestId !== rootSearchRequestIdRef.current) return;
        // Rows a faster source already put up are the answer a search that went quiet leaves.
        if (published && error instanceof ProviderBusyError && error.cause instanceof OperationTimeoutError) return;
        // So are the lines the bar named before asking: a failed search takes nothing back.
        if (instantAnswerRef.current?.query === searchQuery) return;
        setRootProviderResults(tickerSearchFailureItems(error, searchQuery, localTickerSearchResultItems(searchQuery, { limit: 6 })));
        setRootProviderResultsQuery(searchQuery);
      } finally {
        if (requestId === rootSearchRequestIdRef.current) {
          setRootSearching(false);
        }
      }
    }, 200);
  }, [
    buildTickerSearchResultItems,
    currentRoute,
    dataProvider,
    localTickerSearchResultItems,
    rootTickerSearchArg,
    searchBrokerId,
    searchBrokerInstanceId,
    tickers,
    writeTickerSearchCache,
  ]);

  useEffect(() => () => {
    if (rootSearchTimerRef.current) clearTimeout(rootSearchTimerRef.current);
  }, []);

  const answered = !!rootTickerSearchArg && rootProviderResultsQuery === rootTickerSearchArg && !!rootProviderResults;
  const showingInstant = !answered && !!instantAnswer && instantAnswer.query === rootTickerSearchArg;
  // An answer keeps the listing rows on screen where they are, its own following, so the row
  // under the cursor stays put. Not when the index named them, the user has not moved the
  // highlight, and the answer leads with another listing: then the index was wrong, and the
  // answer's order and its first row stand.
  if (answered && answerLeadRef.current?.answer !== rootProviderResults) {
    const shown = shownListingsRef.current?.query === rootTickerSearchArg ? shownListingsRef.current : null;
    const overruled = !!shown && shown.fromIndex && shown.keys.length > 0 && !rootSelectionNavigatedRef?.current
      && answerTopListing(rootProviderResults!, rootPlainTickerSearchArg) !== shown.keys[0];
    if (overruled) answerTookTopRef.current += 1;
    answerLeadRef.current = { answer: rootProviderResults!, keys: shown && !overruled ? shown.keys : NONE_SHOWN };
  }
  const answerLead = answered ? answerLeadRef.current!.keys : NONE_SHOWN;
  const providerItems = useMemo(() => {
    if (answered) return leadWithShownListings(rootProviderResults!, answerLead);
    return showingInstant ? instantAnswer!.items : null;
  }, [answerLead, answered, instantAnswer, rootProviderResults, showingInstant]);

  const rootResults = useMemo(() => {
    if (listingSuffix != null) {
      if (rootTickerSearchArg && providerItems) {
        return venueDropdownResults(rootTickerSearchArg, providerItems, listingSuffix);
      }
      // The venue list replaces commands. Nothing else shows while it loads.
      return [];
    }
    if (rootTickerSearchArg && providerItems) {
      if (rootPlainTickerSearchArg) {
        return mergePlainRootTickerResults(rootPlainTickerSearchArg, providerItems, rootResultItems, reading, answerLead);
      }
      return providerItems;
    }
    return rootResultItems;
  }, [
    listingSuffix,
    providerItems,
    reading,
    rootPlainTickerSearchArg,
    rootResultItems,
    rootTickerSearchArg,
    answerLead,
  ]);
  // The listing rows as drawn, for the next answer to keep in place.
  if (providerItems && rootTickerSearchArg) {
    const named = new Set(providerItems.map(listingRowKey));
    const keys = rootResults.map(listingRowKey).filter((key): key is string => key != null && named.has(key));
    const fromIndex = showingInstant && instantAnswer!.fromIndex;
    const kept = shownListingsRef.current;
    if (kept?.query !== rootTickerSearchArg || kept.fromIndex !== fromIndex || kept.keys.join("\n") !== keys.join("\n")) {
      shownListingsRef.current = { query: rootTickerSearchArg, keys, fromIndex };
    }
  }
  const rootSectionOrder: CommandBarSectionOrder = listingSuffix != null
    ? "ranked"
    : rootPlainTickerSearchArg
      ? "app-first"
      : rootTickerSearchArg
        ? "ranked"
        : "default";
  // Text that names a listing is a symbol: its rows lead, and the AI's reading of it follows them,
  // so neither its Thinking row nor its answer moves a listing.
  const namesListing = !!rootPlainTickerSearchArg
    && rootResults.some((item) => item.category === "Exact Match" || item.category === DID_YOU_MEAN_CATEGORY);
  // A word in small letters that names one of the bar's commands ("full", Fullscreen Pane) is that command first.
  const commandNamed = !!rootPlainTickerSearchArg && wordNamesCommand(rootPlainTickerSearchArg, rootResultItems);
  const rootCategoryPriorities = useMemo(() => {
    const listings = namesListing ? assistAfterListings(categoryPriorities) : categoryPriorities;
    return commandNamed ? exactMatchAfterCommands(listings) : listings;
  }, [categoryPriorities, commandNamed, namesListing]);
  const orderedRootResults = useMemo(
    () => orderListResults(rootResults, { sectionOrder: rootSectionOrder, categoryPriorities: rootCategoryPriorities }),
    [rootCategoryPriorities, rootResults, rootSectionOrder],
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

  // The rows before the answer are for whatever the query matches locally, not the rows Enter will land on,
  // unless the bar already knows the symbol's lines.
  const rootResultsCurrent = !rootTickerSearchArg || !!providerItems;

  return {
    activeRootProviderResultsKey,
    orderedRootResults,
    rootAnswerTookTop: answerTookTopRef.current,
    rootCategoryPriorities,
    rootResultsCurrent,
    rootSearching,
    rootSectionOrder,
  };
}
