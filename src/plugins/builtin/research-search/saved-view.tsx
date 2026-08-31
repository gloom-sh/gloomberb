import { useCallback, useMemo, useState } from "react";
import {
  DataTableView,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import type { CloudSavedSearch } from "../../../api-client";
import { describeFilters, formatHitDate } from "./model";

type SavedColumnId = "name" | "filters" | "alert" | "last" | "hits";

interface SavedColumn extends DataTableColumn {
  id: SavedColumnId;
}

function buildSavedColumns(width: number): SavedColumn[] {
  const alertWidth = 6;
  const lastWidth = 10;
  const hitsWidth = 6;
  const remaining = Math.max(24, width - (alertWidth + lastWidth + hitsWidth + 8));
  const nameWidth = Math.max(12, Math.round(remaining * 0.5));
  return [
    { id: "name", label: "SAVED SEARCH", width: nameWidth, align: "left" },
    { id: "filters", label: "FILTERS", width: Math.max(10, remaining - nameWidth), align: "left" },
    { id: "alert", label: "ALERT", width: alertWidth, align: "left" },
    { id: "last", label: "LAST HIT", width: lastWidth, align: "left" },
    { id: "hits", label: "HITS", width: hitsWidth, align: "right" },
  ];
}

interface SavedSort {
  columnId: SavedColumnId;
  direction: "asc" | "desc";
}

function sortValue(search: CloudSavedSearch, columnId: SavedColumnId): string | number {
  switch (columnId) {
    case "last":
      return search.lastMatchAt ? Date.parse(search.lastMatchAt) : 0;
    case "hits":
      return search.matchCount;
    case "alert":
      return search.alertEnabled ? 1 : 0;
    case "filters":
      return describeFilters(search.filters).toLowerCase();
    default:
      return (search.name || search.query).toLowerCase();
  }
}

export function SavedSearchesView({
  searches,
  selectedId,
  onSelect,
  onRun,
  onToggleAlert,
  onDelete,
  focused,
  width,
  height,
  emptyTitle,
}: {
  searches: CloudSavedSearch[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (search: CloudSavedSearch) => void;
  onToggleAlert: (search: CloudSavedSearch) => void;
  onDelete: (search: CloudSavedSearch) => void;
  focused: boolean;
  width: number;
  height: number;
  emptyTitle: string;
}) {
  const [sort, setSort] = useState<SavedSort>({ columnId: "last", direction: "desc" });
  const columns = useMemo(() => buildSavedColumns(width), [width]);
  const rows = useMemo(() => [...searches].sort((left, right) => {
    const a = sortValue(left, sort.columnId);
    const b = sortValue(right, sort.columnId);
    if (a === b) return 0;
    return (a < b ? -1 : 1) * (sort.direction === "asc" ? 1 : -1);
  }), [searches, sort]);

  const renderCell = useCallback((
    search: CloudSavedSearch,
    column: SavedColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "name":
        return { text: search.name || search.query, color: selectedColor ?? colors.text };
      case "filters":
        return {
          text: describeFilters(search.filters) || "\u2014",
          color: selectedColor ?? colors.textDim,
        };
      case "alert":
        return {
          text: search.alertEnabled ? "on" : "off",
          color: selectedColor ?? (search.alertEnabled ? colors.positive : colors.textMuted),
          // The cell is the switch, so alerts can be flipped without the keyboard.
          onMouseDown: (event: any) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            onToggleAlert(search);
          },
        };
      case "last":
        return {
          text: search.lastMatchAt ? formatHitDate(search.lastMatchAt) : "\u2014",
          color: selectedColor ?? colors.textDim,
        };
      case "hits":
        return {
          text: search.matchCount > 0 ? String(search.matchCount) : "\u2014",
          color: selectedColor ?? colors.textDim,
        };
    }
  }, [onToggleAlert]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    const selected = searches.find((search) => search.id === selectedId);
    if (!selected) return false;
    if (isPlainKey(event, "a")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      onToggleAlert(selected);
      return true;
    }
    if (isPlainKey(event, "d")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      onDelete(selected);
      return true;
    }
    return false;
  }, [onDelete, onToggleAlert, searches, selectedId]);

  return (
    <DataTableView<CloudSavedSearch, SavedColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      selection={{
        kind: "id",
        selectedId,
        getId: (search) => search.id,
        onChange: onSelect,
      }}
      onActivate={onRun}
      onRootKeyDown={handleKeyDown}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => (
        current.columnId === columnId
          ? { columnId, direction: current.direction === "asc" ? "desc" : "asc" }
          : { columnId: columnId as SavedColumnId, direction: columnId === "name" ? "asc" : "desc" }
      ))}
      getItemKey={(search) => search.id}
      renderCell={renderCell}
      showHorizontalScrollbar={false}
      emptyStateTitle={emptyTitle}
    />
  );
}
