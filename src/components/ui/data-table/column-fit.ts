import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePaneMenuItems } from "../../layout/pane/footer/registration";
import { fitColumnsToWidth, hiddenTableColumns, type TableColumnDropOrder } from "../table-layout";
import type { DataTableColumn, DataTableColumnFit } from "./types";

/**
 * False where a table draws every column whatever its width: a report reads
 * them all, and no reader is there to ask for the ones a fit left out.
 */
export const TableColumnFitContext = createContext(true);

interface ColumnFitOptions {
  /** The leading columns that name the row where no column says it does (`DataTableColumn.identifiesRow`): they never leave. */
  anchoredColumns: number;
  /** The column the table is sorted by stays: rows in an order no column shows read as unsorted. */
  sortColumnId: string | null;
  /**
   * False for a table set not to scroll sideways: the desktop narrows its
   * columns to the pane instead of drawing them at their set widths, so
   * there is no column for the pane's edge to cut and none to leave out.
   */
  scrollsSideways: boolean;
  dropOrder: TableColumnDropOrder | undefined;
  /**
   * The columns that date a row's figures, which leave last. Read from the
   * labels the pane wrote ("As of"), since the columns fitted carry the
   * header as drawn, which a translation no longer heads so.
   */
  asOfColumnIds?: readonly string[];
  columnGap: number | undefined;
  horizontalPadding: number | undefined;
}

/**
 * A table's columns fitted to a body `cells` wide (`fitColumnsToWidth`), by
 * what the table says of them. The row's identifier is the columns that say
 * so (`DataTableColumn.identifiesRow`: a chain's strike, wherever the reader
 * put the other fields), else the leading `anchoredColumns`; it and the
 * sorted column stay, each with the set the pane's order lists it in. The
 * same array where everything fits, or where what must stay does not.
 */
export function fitDataTableColumns<C extends DataTableColumn>(
  columns: readonly C[],
  cells: number,
  options: Pick<ColumnFitOptions, "anchoredColumns" | "sortColumnId"> & Partial<Pick<ColumnFitOptions, "dropOrder" | "asOfColumnIds" | "columnGap" | "horizontalPadding">>,
): C[] {
  const marked = columns.filter((column) => column.identifiesRow);
  return fitColumnsToWidth(columns, cells, {
    dropOrder: options.dropOrder,
    identifier: (marked.length ? marked : columns.slice(0, options.anchoredColumns)).map((column) => column.id),
    sorted: options.sortColumnId,
    asOf: options.asOfColumnIds,
    columnGap: options.columnGap,
    horizontalPadding: options.horizontalPadding,
  });
}

/**
 * The columns a table draws at the width its renderer reports
 * (`onViewportWidthChange`): all of them as set where they fit, where the
 * renderer reports none (the terminal, which fits what its columns hold) or
 * where the table narrows its columns rather than scroll sideways, else the
 * ones `fitColumnsToWidth` keeps, at the widths it narrowed them to.
 * `showAll` draws them all as set at the reader's asking and names the first
 * one the fit had left out, for the renderer to scroll to; `fit` goes back.
 * Both are in the pane menu while there is something to show or to fit, and
 * the asking is forgotten once every column fits again.
 */
export function useDataTableColumnFit<C extends DataTableColumn>(columns: readonly C[], options: ColumnFitOptions): {
  /** The columns the fit draws and the width of each one it narrowed; null draws them all as set. */
  fitted: { ids: ReadonlySet<string>; widths: ReadonlyMap<string, number> } | null;
  fit: DataTableColumnFit;
  onViewportWidthChange: (cells: number) => void;
  scrollToColumn: { id: string; version: number } | undefined;
} {
  const enabled = useContext(TableColumnFitContext);
  const [viewportCells, setViewportCells] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [scrollToColumn, setScrollToColumn] = useState<{ id: string; version: number } | undefined>(undefined);
  // A pane's order written inline is a new array on every render: the fit follows what it says.
  const orderRef = useRef(options.dropOrder);
  orderRef.current = options.dropOrder;
  const orderKey = options.dropOrder ? JSON.stringify(options.dropOrder) : "";
  const fitted = useMemo(() => {
    if (!enabled || !options.scrollsSideways || viewportCells == null) return null;
    const drawn = fitDataTableColumns(columns, viewportCells, {
      anchoredColumns: options.anchoredColumns, sortColumnId: options.sortColumnId, dropOrder: orderRef.current,
      asOfColumnIds: options.asOfColumnIds, columnGap: options.columnGap, horizontalPadding: options.horizontalPadding,
    });
    if (drawn === columns) return null;
    const set = new Map(columns.map((column) => [column.id, column.width]));
    return {
      ids: new Set(drawn.map((column) => column.id)),
      widths: new Map(drawn.filter((column) => column.width !== set.get(column.id)).map((column) => [column.id, column.width])),
    };
  }, [columns, enabled, options.anchoredColumns, options.asOfColumnIds, options.columnGap, options.horizontalPadding, options.scrollsSideways, options.sortColumnId, orderKey, viewportCells]);
  const hidden = fitted ? columns.length - fitted.ids.size : 0;
  // Wide enough for every column as set again: the next narrow width starts from the fit.
  useEffect(() => {
    if (all && !fitted) setAll(false);
  }, [all, fitted]);

  const latest = useRef({ columns, fitted });
  latest.current = { columns, fitted };
  const showAll = useCallback(() => {
    const { columns: current, fitted: fit } = latest.current;
    if (!fit) return;
    setAll(true);
    const first = current.find((column) => !fit.ids.has(column.id));
    if (first) setScrollToColumn((previous) => ({ id: first.id, version: (previous?.version ?? 0) + 1 }));
  }, []);
  const fit = useCallback(() => setAll(false), []);
  const isFitted = fitted != null;
  // Columns the pane itself left out for this width are not the table's to draw: the entry then promises more, not all.
  const paneHidden = hiddenTableColumns(columns).length > 0;
  usePaneMenuItems(`data-table-fit:${useId()}`, () => !isFitted ? null
    : [all ? { id: "fit-columns", label: "Fit Columns", onSelect: fit }
      : { id: "show-all-columns", label: hidden === 0 ? "Full Column Widths" : paneHidden ? "Show More Columns" : "Show All Columns", onSelect: showAll }],
  [all, fit, hidden > 0, isFitted, paneHidden, showAll]);

  return {
    fitted: all ? null : fitted,
    fit: useMemo(() => ({ hidden: all ? 0 : hidden, fitted: !all && isFitted, all: all && isFitted, showAll, fit }), [all, fit, hidden, isFitted, showAll]),
    onViewportWidthChange: useCallback((cells: number) => {
      setViewportCells((current) => current === cells ? current : cells);
    }, []),
    scrollToColumn,
  };
}
