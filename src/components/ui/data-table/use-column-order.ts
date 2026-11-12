import { useCallback, useId, useMemo, useRef } from "react";
import { findPaneInstance } from "../../../types/config";
import {
  useAppSelector,
  useOptionalPaneInstanceId,
  useOptionalPaneSettingUpdater,
} from "../../../state/app/context";
import { usePaneMenuItems } from "../../layout/pane/footer/registration";
import {
  COLUMN_ORDER_SETTING,
  defaultColumnOrder,
  moveColumnId,
  orderColumns,
  readColumnOrders,
  rememberColumnOrder,
  rowAnchorColumnCount,
  sameIds,
} from "./column-order";
import type { DataTableColumn, DataTableColumnReorder } from "./types";

/** Joins a remembered order into one string, so the selector's value only changes when the order does. */
const ID_SEPARATOR = "\u0000";

export interface DataTableColumnOrder<C extends DataTableColumn> {
  /** The columns in the order the reader left them. */
  columns: C[];
  /** Moves a column to an index of `columns`; absent where the order is fixed. */
  onColumnMove?: (columnId: string, toIndex: number) => void;
  anchoredColumns: number;
  /** The reader has changed the order: Reset Columns has something to put back. */
  customized: boolean;
  reset: () => void;
}

/**
 * A table's columns in the order its pane remembers, the move a header drag
 * makes, and Reset Columns. The order is kept in the pane's settings, so it is
 * saved and synced with the layout, per pane; a pane whose settings already
 * order its columns passes them as `control` and the drag rewrites those
 * instead. With `menu`, Reset Columns goes in the pane menu while the order
 * is the reader's own; `DataTableView` lists it with the table's sort instead.
 */
export function useDataTableColumnOrder<C extends DataTableColumn>(
  columns: readonly C[],
  reorder: false | DataTableColumnReorder | undefined,
  { menu = true }: { menu?: boolean } = {},
): DataTableColumnOrder<C> {
  const paneId = useOptionalPaneInstanceId();
  const options = reorder === false ? null : reorder ?? {};
  const control = options?.control;
  const anchored = Math.min(columns.length, options?.anchored ?? rowAnchorColumnCount(columns));
  const key = options?.key ?? columns[0]?.id ?? "";
  const enabled = options !== null && (control !== undefined || paneId !== null) && columns.length - anchored >= 2;
  const savedText = useAppSelector((state) => {
    if (!enabled || control || !paneId) return null;
    const ids = readColumnOrders(findPaneInstance(state.config.layout, paneId)?.settings?.[COLUMN_ORDER_SETTING])[key];
    return ids ? ids.join(ID_SEPARATOR) : null;
  });
  const controlOrder = control?.order;
  const saved = useMemo(
    () => controlOrder ?? (savedText === null ? undefined : savedText.split(ID_SEPARATOR)),
    [controlOrder, savedText],
  );
  const ordered = useMemo(
    () => enabled ? orderColumns(columns, saved, anchored) : columns,
    [anchored, columns, enabled, saved],
  );
  const updateSetting = useOptionalPaneSettingUpdater(paneId, COLUMN_ORDER_SETTING);
  const latest = useRef({ columns, ordered, control, key, anchored });
  latest.current = { columns, ordered, control, key, anchored };

  const onColumnMove = useCallback((columnId: string, toIndex: number) => {
    const current = latest.current;
    const before = current.ordered.map((column) => column.id);
    const after = moveColumnId(before, columnId, toIndex, current.anchored);
    if (!after) return;
    if (current.control) {
      // Columns the pane adds on its own (a portfolio's target weights) keep their own place.
      const listed = new Set(current.control.order);
      current.control.onChange(rememberColumnOrder(current.control.order, before, after).filter((id) => listed.has(id)));
      return;
    }
    const defaults = current.columns.map((column) => column.id);
    updateSetting((value) => {
      const { [current.key]: previous, ...others } = readColumnOrders(value);
      const next = rememberColumnOrder(previous, before, after);
      // Dragged back to the pane's own order, with no other column's place to keep, it is forgotten.
      const forget = sameIds(after, defaults) && next.every((id) => defaults.includes(id));
      const orders = forget ? others : { ...others, [current.key]: next };
      return Object.keys(orders).length > 0 ? orders : undefined;
    });
  }, [updateSetting]);

  const reset = useCallback(() => {
    const current = latest.current.control;
    if (!current) {
      updateSetting(() => undefined);
      return;
    }
    if (current.defaultOrder) current.onChange(defaultColumnOrder(current.order, current.defaultOrder));
  }, [updateSetting]);

  const customized = enabled && (control
    ? !!control.defaultOrder && !sameIds(control.order, defaultColumnOrder(control.order, control.defaultOrder))
    : ordered !== columns);
  usePaneMenuItems(`data-table-columns:${useId()}`, () => menu && customized
    ? [{ id: "reset-columns", label: "Reset Columns", onSelect: reset }]
    : null, [customized, menu, reset]);

  return {
    columns: ordered as C[],
    onColumnMove: enabled ? onColumnMove : undefined,
    anchoredColumns: anchored,
    customized,
    reset,
  };
}
