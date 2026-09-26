import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableView,
  QueryBar,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableSelectionChangeReason,
  type QueryBarView,
} from "../../../components";
import type { DataTableViewProps } from "../../../components/data-table/view";
import { useShortcut } from "../../../react/input";
import { Box, ScrollBox, useUiCapabilities, type InputRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";

/** Below this the detail sits under the table instead of beside it. */
const SPLIT_MIN_WIDTH = 108;

/**
 * The table commits keyboard moves by index after a short delay. When a filter
 * changes the rows in between, that index lands on a different item, and
 * honouring it would silently rewrite the persisted setting as the user types.
 * Pointer and activation commits are explicit, so they are always honoured.
 */
export function shouldPersistSelection({
  id,
  reason,
  selectionOnScreen,
  knownIds,
}: {
  id: string;
  reason: DataTableSelectionChangeReason;
  selectionOnScreen: boolean;
  knownIds: readonly string[];
}): boolean {
  if (!knownIds.includes(id)) return false;
  return reason !== "keyboard" || selectionOnScreen;
}

/**
 * Filter, selection and keys for a series list beside its detail: `/` focuses
 * the filter, `r` reloads, and a range option's `hint` key picks that range.
 */
export function useSeriesList<Item, R extends string>({
  focused,
  items,
  getId,
  matchesQuery,
  selectedId,
  onSelect,
  reload,
  range,
}: {
  focused: boolean;
  /** Every selectable series, in list order. */
  items: readonly Item[];
  getId: (item: Item) => string;
  /** Keep module-level: the filtered list is memoized on it. */
  matchesQuery: (item: Item, query: string) => boolean;
  /** The persisted selection; the first item stands in until it resolves. */
  selectedId: string;
  onSelect: (id: string) => void;
  reload: () => void;
  range: Pick<QueryBarView<R>, "value" | "options" | "onChange">;
}) {
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "r")) {
      stopSearchFocusNavigation(event);
      reload();
      return true;
    }
    return false;
  }, [focusSearch, reload]);

  // A modified r (Shift+R refresh all, CmdOrCtrl+Shift+R resize) belongs to the app.
  useShortcut((event) => {
    if (!focused || searchFocused || event.targetEditable || event.defaultPrevented) return;
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      reload();
      return;
    }
    const picked = range.options.find((option) => option.hint && isPlainKey(event, option.hint));
    if (!picked) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    range.onChange(picked.value);
  });

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () => items.filter((item) => matchesQuery(item, normalizedQuery)),
    [items, matchesQuery, normalizedQuery],
  );
  // Filtering narrows the list, but the detail keeps showing the chosen series
  // until the user picks another, so typing never blanks the chart.
  const selected = items.find((item) => getId(item) === selectedId) ?? items[0] ?? null;
  const selectedItemId = selected ? getId(selected) : null;
  const selectionOnScreen = visible.some((item) => getId(item) === selectedItemId);

  const choose = useCallback((id: string, reason: DataTableSelectionChangeReason) => {
    if (!shouldPersistSelection({
      id,
      reason,
      selectionOnScreen,
      knownIds: items.map(getId),
    })) return;
    onSelect(id);
  }, [getId, items, onSelect, selectionOnScreen]);

  return {
    normalizedQuery,
    visible,
    selected,
    selectedId: selectedItemId,
    choose,
    searchFocused,
    handlePaneKey,
    range,
    search: {
      value: query,
      onChange: setQuery,
      focused,
      active: searchFocused,
      onActiveChange: (active: boolean) => active ? focusSearch() : blurSearch(),
      focusToken: searchFocusToken,
      inputRef: searchInputRef,
      debounceMs: 80,
    },
  };
}

/**
 * A filter and range strip over a series table, with the selected series'
 * detail beside it on a wide pane and under it on a narrow one.
 */
export function SeriesListDetail<Row, Column extends DataTableColumn, R extends string>({
  list,
  width,
  height,
  focused,
  listWidth: maxListWidth,
  searchPlaceholder,
  columns: buildColumns,
  rows,
  getRowId,
  renderCell,
  isNavigable,
  renderSectionHeader,
  emptyStateTitle,
  renderDetail,
}: Pick<DataTableViewProps<Row, Column>, "renderCell" | "isNavigable" | "renderSectionHeader" | "emptyStateTitle"> & {
  list: ReturnType<typeof useSeriesList<unknown, R>>;
  width: number;
  height: number;
  focused: boolean;
  /** The table's width beside the detail. */
  listWidth: number;
  searchPlaceholder: string;
  columns: (width: number, stacked: boolean) => Column[];
  /** Table rows for the visible items, with any section headers. */
  rows: Row[];
  /** Keep module-level, like the cell and header renderers, so memoized rows survive re-renders. */
  getRowId: (row: Row) => string;
  renderDetail: (size: { width: number; height: number; focused: boolean }) => ReactNode;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const split = width >= SPLIT_MIN_WIDTH;
  const listWidth = split ? Math.min(maxListWidth, Math.floor(width * 0.4)) : width;
  const detailWidth = split ? width - listWidth : width;
  // The terminal scroller draws its bar in the last column; the detail stays clear of it.
  const detailContentWidth = Math.max(1, detailWidth - (nativePaneChrome ? 0 : 1));
  const columns = buildColumns(listWidth, !split);
  // Everything under the query bar. The split table fills it to the footer.
  const bodyHeight = Math.max(1, height - 1);
  // Stacked: header plus every row, and one more line for the horizontal scrollbar.
  const tableHeight = split
    ? Math.max(3, bodyHeight)
    : Math.min(rows.length + 2, Math.max(3, height - 12));
  // The stacked table consumes real rows. Giving its detail scroller the whole
  // pane height leaves its lower content clipped outside the scroll viewport.
  const detailHeight = split ? bodyHeight : Math.max(1, bodyHeight - tableHeight);
  const bodyFocused = focused && !list.searchFocused;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar width={width} search={{ ...list.search, placeholder: searchPlaceholder }} view={list.range} />
      <Box flexDirection={split ? "row" : "column"} flexGrow={1} overflow="hidden">
        <Box flexDirection="column" width={listWidth} flexShrink={0}>
          <Box flexDirection="column" width={listWidth} height={tableHeight} flexShrink={0} overflow="hidden">
            <DataTableView<Row, Column>
              focused={bodyFocused}
              rootWidth={listWidth}
              rootHeight={tableHeight}
              columns={columns}
              items={rows}
              sortColumnId={null}
              sortDirection="asc"
              selection={{
                kind: "id",
                selectedId: list.selectedId,
                getId: getRowId,
                onChange: (id, _item, _index, reason) => list.choose(String(id), reason),
              }}
              isNavigable={isNavigable}
              onRootKeyDown={list.handlePaneKey}
              getItemKey={getRowId}
              renderCell={renderCell}
              renderSectionHeader={renderSectionHeader}
              emptyStateTitle={emptyStateTitle}
            />
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1} width={detailWidth} height={detailHeight} overflow="hidden">
          <ScrollBox height={detailHeight} scrollY focusable={false}>
            {renderDetail({ width: detailContentWidth, height: detailHeight, focused: bodyFocused })}
          </ScrollBox>
        </Box>
      </Box>
    </Box>
  );
}
