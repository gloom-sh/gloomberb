import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { DividendRow } from "./view";

export { toDividendRows } from "./view";
export type { DividendRow } from "./view";

export type DividendColumnId = "exDate" | "amount" | "currency";
export type DividendColumn = DataTableColumn & { id: DividendColumnId };

export interface DividendSortPreference {
  columnId: DividendColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_SORT_PREFERENCE: DividendSortPreference = {
  columnId: "exDate",
  direction: "desc",
};

/**
 * The amount sits beside its ex-date rather than across the pane. The currency
 * column shows only when the payments mix currencies; otherwise the amount's
 * own symbol says it.
 */
export function buildDividendColumns(rows: readonly Pick<DividendRow, "currency">[] = []): DividendColumn[] {
  const mixed = new Set(rows.map((row) => row.currency)).size > 1;
  return [
    { id: "exDate", label: "EX-DATE", width: 10, align: "left" },
    { id: "amount", label: "AMOUNT", width: 12, align: "right" },
    ...(mixed ? [{ id: "currency" as const, label: "CCY", width: 6, align: "left" as const }] : []),
  ];
}

function getSortValue(columnId: DividendColumnId, row: DividendRow): string | number | null {
  switch (columnId) {
    case "exDate": return row.exDate;
    case "amount": return row.amount;
    case "currency": return row.currency;
  }
}

export function sortRows(
  rows: DividendRow[],
  sortPreference: DividendSortPreference,
): DividendRow[] {
  if (!sortPreference.columnId) return rows;
  return [...rows].sort((left, right) => compareSortValues(
    getSortValue(sortPreference.columnId!, left),
    getSortValue(sortPreference.columnId!, right),
    sortPreference.direction,
  ));
}

export function nextSortPreference(
  current: DividendSortPreference,
  columnId: string,
): DividendSortPreference {
  const typedColumnId = columnId as DividendColumnId;
  if (current.columnId !== typedColumnId) {
    return { columnId: typedColumnId, direction: "desc" };
  }
  if (current.direction === "desc") {
    return { columnId: typedColumnId, direction: "asc" };
  }
  return DEFAULT_SORT_PREFERENCE;
}
