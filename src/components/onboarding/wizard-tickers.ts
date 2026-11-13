import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { useAppStateRef } from "../../state/app/context";
import { LISTING_SEARCH_LIMIT, searchTickerCandidates, type TickerSearchCandidate } from "../../tickers/search";
import { isProviderBusy } from "../../sources/provider-errors";
import { t } from "../../i18n";
import {
  MAX_TICKER_PICKS,
  tickerStepRows,
  tickerSuggestions,
  toggleTickerPick,
  type TickerPick,
} from "./tickers-step-model";

const SEARCH_DEBOUNCE_MS = 250;
/** Search rows the step lists while a search is typed. */
const SEARCH_ROWS = 6;

/** A search row as the step lists it: a saved ticker as it is saved, a found one with its result to save. */
function searchPick(candidate: TickerSearchCandidate): TickerPick {
  if (candidate.kind === "ticker" && candidate.ticker) {
    return {
      symbol: candidate.ticker.metadata.ticker,
      name: candidate.ticker.metadata.name || candidate.detail,
      ticker: candidate.ticker,
    };
  }
  return { symbol: candidate.symbol, name: candidate.result?.name || candidate.detail, result: candidate.result };
}

/**
 * "Which tickers do you follow?": up to three names, picked from the
 * suggestions for the desks the user picked or found with the app's ticker
 * search. Typing searches; the rows are the results while a search is typed
 * and the picks and suggestions otherwise. Nothing is saved here: the
 * wizard puts the picks on the watchlist once the step closes.
 */
export function useOnboardingTickers({
  pluginRegistry,
  desks,
}: {
  pluginRegistry: PluginRegistry;
  /** The desks picked before the step, which choose its suggestions. */
  desks: readonly string[] | undefined;
}) {
  const stateRef = useAppStateRef();
  // Keyed by the desks' names, not the array's identity, which each save renews.
  const deskKey = (desks ?? []).join(",");
  const suggestions = useMemo(() => tickerSuggestions(deskKey ? deskKey.split(",") : []), [deskKey]);
  const [picks, setPicks] = useState<TickerPick[]>([]);
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<TickerPick[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const searchSeqRef = useRef(0);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setCursor(0);
  }, []);

  // Search as it is typed, debounced; the newest answer wins.
  useEffect(() => {
    const text = query.trim();
    const seq = ++searchSeqRef.current;
    if (!text) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchTickerCandidates({
        query: text,
        tickers: stateRef.current.tickers,
        dataProvider: pluginRegistry.marketData,
        // As the command bar searches, so the step lists its first rows.
        searchContext: { interactive: true, limit: LISTING_SEARCH_LIMIT },
        totalLimit: LISTING_SEARCH_LIMIT,
        includeOptionContracts: false,
      }).then((found) => {
        if (searchSeqRef.current !== seq) return;
        const seen = new Set<string>();
        setResults(found.map(searchPick).filter((pick) => {
          if (!pick.symbol || seen.has(pick.symbol)) return false;
          seen.add(pick.symbol);
          return true;
        }).slice(0, SEARCH_ROWS));
        setSearchError(null);
      }, (error: unknown) => {
        if (searchSeqRef.current !== seq) return;
        setResults([]);
        setSearchError(isProviderBusy(error) ? t("Search is busy") : t("Ticker lookup failed"));
      }).finally(() => {
        if (searchSeqRef.current === seq) setSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pluginRegistry.marketData, query, stateRef]);

  const typed = query.trim().length > 0;
  const rows = useMemo(
    () => (typed ? results : tickerStepRows(picks, suggestions)),
    [picks, results, suggestions, typed],
  );

  /** Picks or unpicks a row; a result picked from a search clears it, so the picks show again. */
  const toggleRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row) return;
    const picked = picks.some((pick) => pick.symbol === row.symbol);
    if (!picked && picks.length >= MAX_TICKER_PICKS) return;
    setPicks((current) => toggleTickerPick(current, row));
    if (typed) setQuery("");
    else setCursor(index);
  }, [picks, rows, setQuery, typed]);

  const moveCursor = useCallback((delta: number) => {
    setCursor((index) => Math.max(0, Math.min(rows.length - 1, index + delta)));
  }, [rows.length]);

  return {
    picks,
    query,
    setQuery,
    rows,
    /** The row the keyboard is on, kept within the rows. */
    cursor: Math.max(0, Math.min(rows.length - 1, cursor)),
    setCursor,
    moveCursor,
    toggleRow,
    searching,
    searchError,
  };
}

export type OnboardingTickersState = ReturnType<typeof useOnboardingTickers>;
