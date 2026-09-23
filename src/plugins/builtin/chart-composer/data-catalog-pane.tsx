import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, type InputRenderable } from "../../../ui";
import {
  DataTableView,
  QueryBar,
  Tabs,
  usePaneHeaderTabs,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { usePaneStatusLinkFooter } from "../shared/pane-footer";
import { PaneTemplateInputStep } from "../../../components/pane-template-wizard";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import {
  CATALOG_FILTERS,
  CHART_COMPOSER_TEMPLATE_ID,
  DATA_CATALOG_PANE_ID,
  catalogEmptyCopy,
  catalogExpressionForRow,
  catalogInstrumentMatchesQuery,
  catalogRowsForResolvedInstruments,
  filterCatalogRows,
  listStaticCatalogInventory,
  looksLikeCatalogTickerQuery,
  type CatalogFilterId,
  type CatalogSeriesRow,
} from "./catalog-inventory";
import { useCatalogUniverse } from "./use-series-catalog";

type CatalogColumnId = "series" | "publisher" | "kind" | "expression";
type CatalogColumn = DataTableColumn & { id: CatalogColumnId };

interface CatalogSortPreference {
  columnId: CatalogColumnId;
  direction: SortDirection;
}

const DEFAULT_SORT: CatalogSortPreference = { columnId: "publisher", direction: "asc" };

function nextSortPreference(
  current: CatalogSortPreference,
  columnId: string,
): CatalogSortPreference {
  const typed = columnId as CatalogColumnId;
  if (current.columnId !== typed) return { columnId: typed, direction: "asc" };
  if (current.direction === "asc") return { columnId: typed, direction: "desc" };
  return DEFAULT_SORT;
}

function sortValue(columnId: CatalogColumnId, row: CatalogSeriesRow): string | null {
  switch (columnId) {
    case "series":
      return row.label;
    case "publisher":
      // Blank publishers (market data) sort after the named ones.
      return row.publisher || null;
    case "kind":
      return row.kind;
    case "expression":
      return row.expression;
  }
}

function buildColumns(width: number): CatalogColumn[] {
  const publisherWidth = 10;
  const kindWidth = 12;
  const expressionWidth = Math.min(28, Math.max(16, Math.floor(width * 0.28)));
  return [
    { id: "series", label: "SERIES", width: 18, flexGrow: 1, align: "left" },
    { id: "publisher", label: "PUBLISHER", width: publisherWidth, align: "left" },
    { id: "kind", label: "KIND", width: kindWidth, align: "left" },
    { id: "expression", label: "EXPRESSION", width: expressionWidth, align: "left" },
  ];
}

export function DataCatalogPane({ focused, width, height }: PaneProps) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const dialog = useDialog();
  const [seedQuery] = usePaneSettingValue("query", "");
  const [searchQuery, setSearchQuery] = useState(seedQuery);
  const [filter, setFilter] = usePluginPaneState<CatalogFilterId>("activeTab", "all");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [sortPreference, setSortPreference] = useState<CatalogSortPreference>(DEFAULT_SORT);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);

  const tickerQuery = looksLikeCatalogTickerQuery(searchQuery);
  const { instruments, loading: universeLoading } = useCatalogUniverse(
    tickerQuery ? searchQuery : "",
  );
  const loading = tickerQuery && universeLoading;
  const emptyCopy = catalogEmptyCopy(loading, searchQuery);

  const rows = useMemo(() => {
    const staticRows = listStaticCatalogInventory(instruments);
    const resolvedRows = tickerQuery
      ? catalogRowsForResolvedInstruments(
        instruments.filter((instrument) => catalogInstrumentMatchesQuery(instrument, searchQuery)),
      )
      : [];
    const merged = new Map<string, CatalogSeriesRow>();
    for (const entry of [...resolvedRows, ...staticRows]) {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    }
    const filtered = filterCatalogRows([...merged.values()], filter, searchQuery);
    const direction = sortPreference.direction;
    const columnId = sortPreference.columnId;
    return [...filtered].sort((left, right) => (
      compareSortValues(sortValue(columnId, left), sortValue(columnId, right), direction)
      || left.label.localeCompare(right.label)
    ));
  }, [filter, instruments, searchQuery, sortPreference, tickerQuery]);

  useEffect(() => {
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const selectedUrl = selectedRow?.url ?? null;

  const columns = useMemo(() => buildColumns(width), [width]);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((token) => token + 1);
  }, []);
  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const chartSelected = useCallback(async (row: CatalogSeriesRow | null) => {
    if (!row) return;
    if (row.needsTicker) {
      const option = row.sourceId === "option";
      const ticker = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (context: PromptContext<string>) => (
          <PaneTemplateInputStep
            {...context}
            step={{
              key: "ticker",
              label: `Chart ${row.label}`,
              placeholder: option ? "AAPL 260618C00200000" : "AAPL",
              type: "text",
              body: [option
                ? `Enter an option symbol to chart ${row.label}.`
                : `Enter a ticker to chart ${row.label}.`],
            }}
          />
        ),
      }).catch(() => undefined);
      const expression = catalogExpressionForRow(row, ticker);
      if (!expression) return;
      createPaneFromTemplate(CHART_COMPOSER_TEMPLATE_ID, { arg: expression });
      return;
    }
    createPaneFromTemplate(CHART_COMPOSER_TEMPLATE_ID, { arg: row.expression });
  }, [createPaneFromTemplate, dialog]);

  useShortcut((event) => {
    if (!focused || searchFocused || event.targetEditable) return;
    if (isPlainKey(event, "/")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
    }
  }, { enabled: focused && !searchFocused });

  useShortcut((event) => {
    if (!focused || searchFocused || event.targetEditable) return;
    if (isPlainKey(event, "g") && selectedRow) {
      event.preventDefault?.();
      event.stopPropagation?.();
      chartSelected(selectedRow);
    }
  }, { enabled: focused && !searchFocused && !!selectedRow });

  // `/` and `g` are the pane's own plain-key shortcuts above; the table only
  // hands the cursor up into the search from its first row.
  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const renderCell = useCallback((
    row: CatalogSeriesRow,
    column: CatalogColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "series":
        return { text: row.label, color: selectedColor ?? colors.textBright };
      case "publisher":
        return { text: row.publisher, color: selectedColor ?? colors.textMuted };
      case "kind":
        return { text: row.kind, color: selectedColor ?? colors.textDim };
      case "expression":
        return { text: row.expression, color: selectedColor ?? colors.text };
    }
  }, []);

  usePaneStatusLinkFooter({
    registrationId: DATA_CATALOG_PANE_ID,
    focused,
    url: selectedUrl,
    source: selectedUrl ? selectedRow?.publisher : null,
    label: "source",
    loading,
    hints: [
      { id: "graph", key: "g", label: "raph", onPress: () => chartSelected(selectedRow), disabled: !selectedRow },
      { id: "search", key: "/", label: "search", onPress: focusSearch },
    ],
    showOpenHint: !!selectedUrl,
  });

  const tabs = useMemo(
    () => CATALOG_FILTERS.map((entry) => ({ label: entry.label, value: entry.id })),
    [],
  );
  const selectFilter = useCallback((value: string) => setFilter(value as CatalogFilterId), [setFilter]);
  const tabsInHeader = usePaneHeaderTabs({
    tabs,
    activeValue: filter,
    onSelect: selectFilter,
    focused: focused && !searchFocused,
  });

  return (
    <DataTableView<CatalogSeriesRow, CatalogColumn>
      focused={focused && !searchFocused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <Box flexDirection="column">
          <QueryBar
            width={width}
            search={{
              value: searchQuery,
              onChange: setSearchQuery,
              placeholder: "series or expression",
              focused,
              active: searchFocused,
              onActiveChange: (active) => (active ? focusSearch() : blurSearch()),
              focusToken: searchFocusToken,
              inputRef: searchInputRef,
              debounceMs: 80,
              onNavigateDown: blurSearch,
            }}
          />
          {!tabsInHeader && (
            <Tabs
              tabs={tabs}
              activeValue={filter}
              onSelect={selectFilter}
              focused={focused && !searchFocused}
              compact
            />
          )}
        </Box>
      )}
      selection={{
        kind: "id",
        selectedId,
        getId: (row) => row.id,
        onChange: (id) => setSelectedId(id),
      }}
      onRootKeyDown={handleRootKeyDown}
      columns={columns}
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) => setSortPreference((current) => nextSortPreference(current, columnId))}
      getItemKey={(row) => row.id}
      onActivate={chartSelected}
      renderCell={renderCell}
      emptyStateTitle={emptyCopy.title}
      emptyStateHint={emptyCopy.hint}
    />
  );
}
