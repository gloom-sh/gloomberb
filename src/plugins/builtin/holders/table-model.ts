import type { HolderData } from "../../../types/financials";
import { compareSortValues } from "../../../utils/sort-values";
import type { HolderColumn, HolderColumnId, HolderRow, SortPreference, ViewMode } from "./types";
import { resolveHolderOwnershipPercent } from "./format";

export const DEFAULT_SORT: SortPreference = {
  columnId: "value",
  direction: "desc",
};

export const VIEW_TABS: Array<{ label: string; value: ViewMode }> = [
  { label: "Table", value: "table" },
  { label: "Chart", value: "chart" },
];

export function buildRows(data: HolderData | null): HolderRow[] {
  return (data?.holders ?? []).map((holder, index) => ({
    ...holder,
    id: `${holder.ownerType}:${holder.name}:${holder.reportDate ?? ""}:${index}`,
  }));
}

/** Whether any holder carries the quarter's change; many sources report none. */
export function hasHolderChanges(rows: readonly HolderRow[]): boolean {
  return rows.some((row) => row.changeShares != null || row.changePercent != null);
}

export function buildColumns(width: number, showChange: boolean): HolderColumn[] {
  const valueWidth = 10;
  const sharesWidth = 10;
  const changeWidth = 10;
  const changePercentWidth = 8;
  const heldWidth = 7;
  const dateWidth = 10;
  const columnCount = showChange ? 7 : 5;
  const fixedWidth = valueWidth + sharesWidth + heldWidth + dateWidth
    + (showChange ? changeWidth + changePercentWidth : 0);
  const holderWidth = Math.max(16, width - 2 - columnCount - fixedWidth);

  return [
    { id: "holder", label: "HOLDER", width: holderWidth, align: "left" },
    { id: "value", label: "MKT VAL", width: valueWidth, align: "right" },
    { id: "shares", label: "AMOUNT", width: sharesWidth, align: "right" },
    ...(showChange ? [
      { id: "changeShares", label: "CHG", width: changeWidth, align: "right" },
      { id: "changePercent", label: "CHG%", width: changePercentWidth, align: "right" },
    ] satisfies HolderColumn[] : []),
    { id: "percentHeld", label: "HELD", width: heldWidth, align: "right" },
    { id: "reportDate", label: "PERIOD", width: dateWidth, align: "right" },
  ];
}

function sortValue(row: HolderRow, columnId: HolderColumnId, marketCap?: number): string | number | null {
  switch (columnId) {
    case "holder":
      return row.name;
    case "value":
      return row.value ?? null;
    case "shares":
      return row.shares ?? null;
    case "changeShares":
      return row.changeShares ?? null;
    case "changePercent":
      return row.changePercent ?? null;
    case "percentHeld":
      return resolveHolderOwnershipPercent(row, marketCap) ?? null;
    case "reportDate":
      return row.reportDate ?? null;
  }
}

export function sortRows(rows: HolderRow[], preference: SortPreference, marketCap?: number): HolderRow[] {
  return [...rows].sort((left, right) => compareSortValues(
    sortValue(left, preference.columnId, marketCap),
    sortValue(right, preference.columnId, marketCap),
    preference.direction,
  ));
}
