import { useCallback, type Dispatch } from "react";
import type { AppAction, AppState } from "../../../state/app/context";
import type { HeaderMarketChoice } from "../../../types/config";
import { HEADER_MARKET_SEARCH } from "../../../core/state/app/command-bar-launch";
import {
  HEADER_BENCHMARKS,
  headerBenchmarkForListing,
  resolveHeaderMarket,
  systemTimeZone,
} from "../../../market-data/market/header-market";
import { fuzzyFilter } from "../../../utils/fuzzy-search";
import type { ResultItem } from "../list/model";

/** The picker's title, as the command that opens it is named. */
export const HEADER_MARKET_TITLE = "Header Market";

/** The heading over the benchmarks, which lead the picker above any ticker its search finds. */
const HEADER_MARKET_CATEGORY = "Benchmarks";

/** Whether a ticker search route is the header's market picker. */
export function isHeaderMarketRoute(payload: Record<string, unknown> | undefined): boolean {
  return payload?.action === HEADER_MARKET_SEARCH.action;
}

/**
 * The benchmarks the picker offers, by name, the one the header shows marked
 * current; a query keeps the ones it matches, by name, symbol, venue or
 * region (`hong kong`, `HSI`).
 */
function headerMarketBenchmarkItems(
  query: string,
  currentKey: string,
  choose: (choice: HeaderMarketChoice) => void,
): ResultItem[] {
  const benchmarks = query.trim()
    ? fuzzyFilter([...HEADER_BENCHMARKS], query.trim(), (benchmark) => `${benchmark.name} ${benchmark.symbol} ${benchmark.venue} ${benchmark.keywords}`)
    : HEADER_BENCHMARKS;
  return benchmarks.map((benchmark) => {
    const crypto = benchmark.venue === "CCC";
    return {
      id: `header-market:${benchmark.id}`,
      label: benchmark.name,
      name: benchmark.symbol,
      detail: benchmark.symbol,
      badge: crypto ? "CRYP" : "IDX",
      ...(crypto ? {} : { right: benchmark.venue }),
      category: HEADER_MARKET_CATEGORY,
      kind: "ticker" as const,
      current: currentKey === `benchmark:${benchmark.id}`,
      action: () => choose({ benchmark: benchmark.id }),
    };
  });
}

/**
 * What the header's market picker does: its benchmark rows, and every ticker
 * row its search finds made to set the header's market rather than open the
 * ticker. The choice is saved on this machine and closes the bar.
 */
export function useHeaderMarketPicker({
  closeAll,
  dispatch,
  getState,
  notify,
  persistConfig,
}: {
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  persistConfig: (nextConfig: AppState["config"]) => void;
}) {
  const choose = useCallback((choice: HeaderMarketChoice) => {
    const config = { ...getState().config, headerMarket: choice };
    dispatch({ type: "SET_CONFIG", config });
    persistConfig(config);
    closeAll({ revertThemePreview: false });
  }, [closeAll, dispatch, getState, persistConfig]);

  const headerMarketItems = useCallback((query: string) => headerMarketBenchmarkItems(
    query,
    resolveHeaderMarket(getState().config.headerMarket, systemTimeZone()).key,
    choose,
  ), [choose, getState]);

  const adaptHeaderMarketResult = useCallback((item: ResultItem): ResultItem => {
    if (!item.resolveTicker) return item;
    const resolveTicker = item.resolveTicker;
    return {
      ...item,
      secondaryAction: undefined,
      action: async () => {
        try {
          const ticker = await resolveTicker();
          const symbol = ticker.metadata.ticker;
          const exchange = ticker.metadata.exchange?.trim();
          // A benchmark found by its symbol is saved as that benchmark, so it reads by name.
          const benchmark = headerBenchmarkForListing(symbol);
          choose(benchmark ? { benchmark: benchmark.id } : exchange ? { symbol, exchange } : { symbol });
        } catch (error) {
          notify(error instanceof Error ? error.message : "Could not open the selected listing.", { type: "error" });
        }
      },
    };
  }, [choose, notify]);

  return { adaptHeaderMarketResult, headerMarketItems };
}
