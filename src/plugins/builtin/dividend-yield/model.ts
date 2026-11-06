import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { DividendRow } from "./view";

export type DividendColumnId = "exDate" | "amount" | "declared" | "currency" | "source";
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
 * The amount sits beside its ex-date rather than across the pane. The declared
 * amount follows it only for a company declaring in another currency than the
 * listing pays (BP's dollars beside its pence). The currency column shows only
 * when the payments mix currencies; otherwise the amount's own symbol says it.
 * The source column shows only when a fund's sponsor gave a row its history lacks.
 */
export function buildDividendColumns(rows: readonly Pick<DividendRow, "currency" | "declared" | "source">[] = []): DividendColumn[] {
  const mixed = new Set(rows.map((row) => row.currency)).size > 1;
  return [
    { id: "exDate", label: "EX-DATE", width: 10, align: "left" },
    { id: "amount", label: "AMOUNT", width: 12, align: "right" },
    ...(rows.some((row) => row.declared) ? [{ id: "declared" as const, label: "DECLARED", width: 10, align: "right" as const }] : []),
    ...(mixed ? [{ id: "currency" as const, label: "CCY", width: 6, align: "left" as const }] : []),
    ...(rows.some((row) => row.source) ? [{ id: "source" as const, label: "SOURCE", width: 12, align: "left" as const }] : []),
  ];
}

function getSortValue(columnId: DividendColumnId, row: DividendRow): string | number | null {
  switch (columnId) {
    case "exDate": return row.exDate;
    case "amount": return row.amount;
    case "declared": return row.declared?.amount ?? null;
    case "currency": return row.currency;
    case "source": return row.source ?? null;
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
