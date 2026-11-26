import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePaneMenuItems } from "../../layout/pane/footer/registration";
import { fitColumnsToWidth, type TableColumnDropOrder } from "../table-layout";
import type { DataTableColumn, DataTableColumnFit } from "./types";

/**
 * False where a table draws every column whatever its width: a report reads
 * them all, and no reader is there to ask for the ones a fit left out.
 */
export const TableColumnFitContext = createContext(true);

interface ColumnFitOptions {
  /** The leading columns that name the row: they never leave. */
  anchoredColumns: number;
  /** The column the table is sorted by stays: rows in an order no column shows read as unsorted. */
  sortColumnId: string | null;
  dropOrder: TableColumnDropOrder | undefined;
  columnGap: number | undefined;
  horizontalPadding: number | undefined;
}

/**
 * The columns a table draws at the width its renderer reports
 * (`onViewportWidthChange`): all of them where they fit or the renderer
 * reports none (the terminal, which fits what its columns hold), else the
 * ones `fitColumnsToWidth` keeps. `showAll` draws them all at the reader's
 * asking and names the first one the fit had left out, for the renderer to
 * scroll to; `fit` goes back. Both are in the pane menu while there is
 * something to show or to fit, and the asking is forgotten once every column
 * fits again.
 */
export function useDataTableColumnFit<C extends DataTableColumn>(columns: readonly C[], options: ColumnFitOptions): {
  /** The ids of the columns to draw; null draws them all. */
  shownIds: ReadonlySet<string> | null;
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
  const fittedIds = useMemo(() => {
    if (!enabled || viewportCells == null) return null;
    const keep = [...columns.slice(0, options.anchoredColumns).map((column) => column.id), ...options.sortColumnId ? [options.sortColumnId] : []];
    const fitted = fitColumnsToWidth(columns, viewportCells, {
      dropOrder: orderRef.current, keep, columnGap: options.columnGap, horizontalPadding: options.horizontalPadding,
    });
    return fitted.length === columns.length ? null : new Set(fitted.map((column) => column.id));
  }, [columns, enabled, options.anchoredColumns, options.columnGap, options.horizontalPadding, options.sortColumnId, orderKey, viewportCells]);
  const hidden = fittedIds ? columns.length - fittedIds.size : 0;
  // Wide enough for every column again: the next narrow width starts from the fit.
  useEffect(() => {
    if (all && hidden === 0) setAll(false);
  }, [all, hidden]);

  const latest = useRef({ columns, fittedIds });
  latest.current = { columns, fittedIds };
  const showAll = useCallback(() => {
    const { columns: current, fittedIds: fitted } = latest.current;
    const first = fitted ? current.find((column) => !fitted.has(column.id)) : undefined;
    if (!first) return;
    setAll(true);
    setScrollToColumn((previous) => ({ id: first.id, version: (previous?.version ?? 0) + 1 }));
  }, []);
  const fit = useCallback(() => setAll(false), []);
  usePaneMenuItems(`data-table-fit:${useId()}`, () => hidden === 0 ? null
    : [all ? { id: "fit-columns", label: "Fit Columns", onSelect: fit } : { id: "show-all-columns", label: "Show All Columns", onSelect: showAll }],
  [all, fit, hidden === 0, showAll]);

  return {
    shownIds: all ? null : fittedIds,
    fit: useMemo(() => ({ hidden: all ? 0 : hidden, all: all && hidden > 0, showAll, fit }), [all, fit, hidden, showAll]),
    onViewportWidthChange: useCallback((cells: number) => {
      setViewportCells((current) => current === cells ? current : cells);
    }, []),
    scrollToColumn,
  };
}
