import { useCallback, useEffect, useMemo, useState } from "react";
import { Box } from "../../../ui";
import {
  DataTableView,
  QueryBar,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { usePaneStatusLinkFooter } from "../../../components/layout/pane/status-footer";
import { PaneTemplateInputStep } from "../../../components/pane-template-wizard";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import {
  CHART_COMPOSER_TEMPLATE_ID,
  DATA_CATALOG_PANE_ID,
  catalogEmptyCopy,
  catalogExpressionForRow,
  catalogInstrumentMatchesQuery,
  catalogRowsForListedCrypto,
  catalogRowsForResolvedInstruments,
  catalogRowsFromEntries,
  catalogTabs,
  compareCatalogGroups,
  compareCatalogText,
  filterCatalogRows,
  frequencyRank,
  looksLikeCatalogTickerQuery,
  mergeCatalogRows,
  normalizeCatalogFilter,
  type CatalogFilterId,
  type CatalogSeriesRow,
} from "./catalog-inventory";
import { useCatalogUniverse, useRegisteredSeries } from "./use-series-catalog";

type CatalogColumnId = "series" | "group" | "unit" | "frequency" | "publisher" | "expression";
type CatalogColumn = DataTableColumn & { id: CatalogColumnId };

interface CatalogSortPreference {
  columnId: CatalogColumnId;
  direction: SortDirection;
}

const DEFAULT_SORT: CatalogSortPreference = { columnId: "group", direction: "asc" };

const FREQUENCY_LABELS: Record<CatalogSeriesRow["frequency"], string> = {
  intraday: "Intraday",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  irregular: "Irregular",
};

function compareRows(columnId: CatalogColumnId, left: CatalogSeriesRow, right: CatalogSeriesRow): number {
  switch (columnId) {
    case "series":
      return compareCatalogText(left.label, right.label);
    case "group":
      return compareCatalogGroups(left.group, right.group);
    case "unit":
      return compareCatalogText(left.unit, right.unit);
    case "frequency":
      return frequencyRank(left.frequency) - frequencyRank(right.frequency);
    case "publisher":
      // Blank publishers (market data) sort after the named ones, either way.
      if (!left.publisher || !right.publisher) return 0;
      return compareCatalogText(left.publisher, right.publisher);
    case "expression":
      return compareCatalogText(left.expression, right.expression);
  }
}

function sortRows(rows: CatalogSeriesRow[], { columnId, direction }: CatalogSortPreference): CatalogSeriesRow[] {
  // Rows arrive in the default order, so the default sort is free.
  if (columnId === DEFAULT_SORT.columnId && direction === DEFAULT_SORT.direction) return rows;
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (columnId === "publisher" && !left.publisher !== !right.publisher) return left.publisher ? -1 : 1;
    return sign * compareRows(columnId, left, right) || left.order - right.order;
  });
}

/** The table keeps the series name and its expression; the rest fold away as the pane narrows. */
function buildColumns(width: number, showGroup: boolean): CatalogColumn[] {
  const expressionWidth = Math.min(30, Math.max(16, Math.floor(width * 0.26)));
  const columns: CatalogColumn[] = [
    { id: "series", label: "SERIES", width: 18, flexGrow: 1, align: "left" },
  ];
  if (showGroup && width >= 70) columns.push({ id: "group", label: "KIND", width: 12, align: "left" });
  if (width >= 84) columns.push({ id: "unit", label: "UNIT", width: 10, align: "left" });
  if (width >= 96) columns.push({ id: "frequency", label: "FREQ", width: 9, align: "left" });
  if (width >= 60) columns.push({ id: "publisher", label: "PUBLISHER", width: 10, align: "left" });
  columns.push({ id: "expression", label: "EXPRESSION", width: expressionWidth, align: "left" });
  return columns;
}

export function DataCatalogPane({ focused, width, height }: PaneProps) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const dialog = useDialog();
  const [seedQuery] = usePaneSettingValue("query", "");
  const [searchQuery, setSearchQuery] = useState(seedQuery);
  const [savedFilter, setFilter] = usePluginPaneState<CatalogFilterId>("activeTab", "all");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [sortPreference, setSortPreference] = useState<CatalogSortPreference>(DEFAULT_SORT);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();

  const entries = useRegisteredSeries();
  const catalogRows = useMemo(() => catalogRowsFromEntries(entries), [entries]);
  const filter = normalizeCatalogFilter(savedFilter, catalogRows);
  const tickerQuery = looksLikeCatalogTickerQuery(searchQuery);
  const { instruments, loading: universeLoading } = useCatalogUniverse(
    tickerQuery ? searchQuery : "",
  );
  const loading = tickerQuery && universeLoading;
  const emptyCopy = catalogEmptyCopy(loading, searchQuery);

  const listedCrypto = useMemo(
    () => catalogRowsForListedCrypto(catalogRows, instruments),
    [catalogRows, instruments],
  );
  const rows = useMemo(() => {
    const resolvedRows = tickerQuery
      ? catalogRowsForResolvedInstruments(
        catalogRows,
        instruments.filter((instrument) => catalogInstrumentMatchesQuery(instrument, searchQuery)),
      )
      : [];
    const merged = mergeCatalogRows(catalogRows, [...resolvedRows, ...listedCrypto]);
    return sortRows(filterCatalogRows(merged, filter, searchQuery), sortPreference);
  }, [catalogRows, filter, instruments, listedCrypto, searchQuery, sortPreference, tickerQuery]);

  useEffect(() => {
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const selectedUrl = selectedRow?.url ?? null;

  const columns = useMemo(() => buildColumns(width, filter === "all"), [filter, width]);

  const chartSelected = useCallback(async (row: CatalogSeriesRow | null) => {
    if (!row) return;
    if (row.input) {
      const option = row.input === "option";
      const crypto = row.input === "crypto";
      const ticker = await dialog.prompt<string>({
        closeOnClickOutside: true,
        content: (context: PromptContext<string>) => (
          <PaneTemplateInputStep
            {...context}
            step={{
              key: "ticker",
              label: `Chart ${row.label}`,
              placeholder: option ? "AAPL 260618C00200000" : crypto ? "BTC-USD" : "AAPL",
              type: "text",
              body: [option
                ? `Enter an option symbol to chart ${row.label}.`
                : crypto
                  ? `Enter a crypto pair to chart ${row.label}.`
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
    createPaneFromTemplate(CHART_COMPOSER_TEMPLATE_ID, { arg: row.template });
  }, [createPaneFromTemplate, dialog]);

  // `/` and `g` are footer hints, which bind their own keys; the table only
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
  ): DataTableCell => {
    switch (column.id) {
      case "series":
        return { text: row.label, color: colors.textBright };
      case "group":
        return { text: row.group, color: colors.textDim };
      case "unit":
        return { text: row.unit, color: colors.textDim };
      case "frequency":
        return { text: FREQUENCY_LABELS[row.frequency], color: colors.textDim };
      case "publisher":
        return { text: row.publisher, color: colors.textMuted };
      case "expression":
        return { text: row.expression, color: colors.text };
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
    () => catalogTabs(catalogRows).map((entry) => ({ label: entry.label, value: entry.id })),
    [catalogRows],
  );
  const selectFilter = useCallback((value: string) => setFilter(value), [setFilter]);
  const { strip: tabStrip } = usePaneTabs({
    tabs,
    activeValue: filter,
    onSelect: selectFilter,
    focused: focused && !searchFocused,
    compact: true,
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
              ...searchProps,
              debounceMs: 80,
            }}
          />
          {tabStrip}
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
      onHeaderClick={(columnId) => setSortPreference((current) => nextHeaderSort(current, columnId as CatalogColumnId, {
        resetTo: DEFAULT_SORT,
      }))}
      getItemKey={(row) => row.id}
      onActivate={chartSelected}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={emptyCopy.title}
      emptyStateHint={emptyCopy.hint}
    />
  );
}
