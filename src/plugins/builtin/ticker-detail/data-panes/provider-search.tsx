import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type InputRenderable } from "../../../../ui";
import {
  DataTableView,
  InputSearchBar,
  loadingText,
  unavailableText,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { isPlainKey } from "../../../../utils/keyboard";
import type { PaneProps, PaneTemplateDef } from "../../../../types/plugin";
import { TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import { usePaneInstance } from "../../../../state/app/context";
import { colors } from "../../../../theme/colors";
import { useAssetData, usePluginPaneState, usePluginTickerActions } from "../../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo, useClampSelectedIndex } from "../../shared/table-pane";
import type { LoadState } from "../../shared/ticker-request";

const SEARCH_DEBOUNCE_MS = 250;

function resultSymbol(result: InstrumentSearchResult): string {
  return result.symbol.trim().toUpperCase();
}

function useSearchQuerySetting(): string {
  const pane = usePaneInstance();
  const raw = pane?.settings?.query;
  return typeof raw === "string" ? raw.trim() : "";
}

function buildSearchColumns(width: number): Array<DataTableColumn & { id: "symbol" | "name" | "exchange" | "type" }> {
  const symbolWidth = 12;
  const exchangeWidth = 14;
  const typeWidth = 10;
  const nameWidth = Math.max(18, width - 2 - symbolWidth - exchangeWidth - typeWidth - 4);
  return [
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "name", label: "NAME", width: nameWidth, align: "left" },
    { id: "exchange", label: "EXCHANGE", width: exchangeWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
  ];
}

export function ProviderSearchPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const initialQuery = useSearchQuerySetting();
  const { pinTicker } = usePluginTickerActions();
  const [query, setQuery] = usePluginPaneState<string>("query", initialQuery);
  const [selectedIdx, setSelectedIdx] = usePluginPaneState<number>("selectedIdx", 0);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const [state, setState] = useState<LoadState<InstrumentSearchResult[]>>({
    data: null,
    loading: false,
    error: null,
  });
  const fetchGenRef = useRef(0);

  const load = useCallback((forceRefresh = false) => {
    if (!query) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    if (!dataProvider) {
      setState({ data: null, loading: false, error: "Search unavailable" });
      return;
    }
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    dataProvider.search(query, forceRefresh ? { preferBroker: false } : undefined)
      .then((results) => {
        if (fetchGenRef.current !== gen) return;
        setState({ data: results, loading: false, error: null });
      })
      .catch((error) => {
        if (fetchGenRef.current !== gen) return;
        setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) });
      });
  }, [dataProvider, query]);

  useEffect(() => {
    load(false);
  }, [load]);

  const rows = state.data ?? [];
  const columns = useMemo(() => buildSearchColumns(width), [width]);
  const boundedSelectedIdx = rows.length > 0 ? Math.min(selectedIdx, rows.length - 1) : -1;
  const openResult = useCallback((row: InstrumentSearchResult) => {
    pinTicker(resultSymbol(row), { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((token) => token + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);
  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim());
    setSelectedIdx(0);
  }, [setQuery, setSelectedIdx]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "/")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    return handleRefreshKey(event, () => load(true));
  }, [focusSearch, load]);

  useShortcut((event) => {
    if (!focused || searchFocused || event.targetEditable) return;
    if (!isPlainKey(event, "/")) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    focusSearch();
  }, { allowEditable: true, enabled: focused });

  const renderCell = useCallback((
    row: InstrumentSearchResult,
    column: DataTableColumn & { id: "symbol" | "name" | "exchange" | "type" },
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "symbol":
        return { text: resultSymbol(row), color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "name":
        return { text: row.name || "-", color: selectedColor ?? colors.text };
      case "exchange":
        return { text: row.exchange || row.primaryExchange || "-", color: selectedColor ?? colors.textDim };
      case "type":
        return { text: row.type || "-", color: selectedColor ?? colors.textDim };
    }
  }, []);

  usePaneFooter("provider-search", () => ({
    info: loadingErrorFooterInfo(state.loading, state.error),
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusSearch },
    ],
  }), [focusSearch, state.error, state.loading]);

  return (
    <DataTableView<InstrumentSearchResult, DataTableColumn & { id: "symbol" | "name" | "exchange" | "type" }>
      focused={focused && !searchFocused}
      rootBefore={(
        <InputSearchBar
          value={query}
          focused={focused}
          active={searchFocused}
          width={width}
          focusToken={searchFocusToken}
          inputRef={searchInputRef}
          placeholder="symbol or company name"
          debounceMs={SEARCH_DEBOUNCE_MS}
          normalizeValue={(value) => value.trim()}
          onFocus={focusSearch}
          onBlur={blurSearch}
          onNavigateDown={blurSearch}
          onQueryChange={updateQuery}
        />
      )}
      selection={{
        kind: "index",
        selectedIndex: boundedSelectedIdx,
        onChange: (index) => setSelectedIdx(index),
      }}
      onActivate={(row) => openResult(row)}
      onRootKeyDown={handleKeyDown}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(row, index) => `${row.providerId}:${row.symbol}:${row.exchange}:${row.type}:${index}`}
      renderCell={renderCell}
      emptyStateTitle={state.error
        ? unavailableText("Provider search")
        : state.loading
          ? loadingText("search results")
          : query ? "No search results" : "No search query"}
      emptyStateHint={state.error ?? (query ? undefined : "Press / to search.")}
    />
  );
}

export function createProviderSearchPaneTemplate(): PaneTemplateDef {
  return {
    id: "provider-search-pane",
    paneId: "provider-search-results",
    label: "Provider Search",
    description: "Search upstream provider instruments and open a selected ticker.",
    keywords: ["search", "srch", "provider", "symbol"],
    shortcut: { prefix: "SRCH", argPlaceholder: "query", argKind: "text" },
    wizard: [
      {
        key: "query",
        label: "Search Query",
        placeholder: "apple, sony, AAPL",
        type: "text",
      },
    ],
    canCreate: (_context, options) => !!(options?.arg ?? options?.values?.query)?.trim(),
    createInstance: (_context, options) => {
      const query = (options?.arg ?? options?.values?.query ?? "").trim();
      return query
        ? {
          title: `SRCH ${query}`,
          placement: "floating",
          settings: { query },
        }
        : null;
    },
  };
}
