import type { DataTableColumn } from "../../../components";
import { getTableWidth, hasMeaningfulTableHorizontalOverflow } from "../../../components/ui/table-layout";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { displayWidth, formatDistributionAmount } from "../../../utils/format";
import { dividendAmountDigits, dividendRowStatus, formatDividendRowAmount, type DividendRow } from "./view";

export type DividendColumnId = "exDate" | "amount" | "declared" | "currency" | "status" | "source";
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
 * The source column appears when a record cites an original publisher, at the
 * widest of its widths the pane has the room for (`paneWidth`, in cells).
 */
export function buildDividendColumns(rows: readonly Pick<DividendRow, "amount" | "currency" | "declared" | "source" | "cashEstimate" | "combined" | "special" | "pending" | "sourceScheduleUrl">[] = [], converted = false, subUnit?: string, paneWidth?: number): DividendColumn[] {
  const mixed = new Set(rows.map((row) => row.currency)).size > 1;
  const digits = dividendAmountDigits(rows, converted, subUnit);
  const declared = rows.flatMap((row) => row.declared ? [row.declared] : []);
  const declaredDigits = dividendAmountDigits(declared);
  const columns: DividendColumn[] = [
    { id: "exDate", label: "EX-DATE", width: 11, align: "left" },
    { id: "amount", label: "AMOUNT", width: Math.max(12, ...rows.map((row) => displayWidth(formatDividendRowAmount(row, converted, subUnit, digits)))), align: "right" },
    ...(declared.length ? [{ id: "declared" as const, label: "DECLARED", width: Math.max(10, ...declared.map((entry) => displayWidth(formatDistributionAmount(entry.amount, entry.currency, declaredDigits.get(entry.currency))))), align: "right" as const }] : []),
    ...(mixed ? [{ id: "currency" as const, label: "CCY", width: 6, align: "left" as const }] : []),
    ...(rows.some((row) => row.pending) ? [{ id: "status" as const, label: "STATUS", width: 10, align: "left" as const }] : []),
  ];
  const widths = sourceColumnWidths(rows);
  if (!widths.length) return columns;
  const source = (width: number): DividendColumn[] => [...columns, { id: "source", label: "SOURCE", width, align: "left" }];
  // By the table's own count of an overflow, in the pane less the cell of its scrollbar.
  const fits = (width: number) => paneWidth === undefined || !hasMeaningfulTableHorizontalOverflow(getTableWidth(source(width)), paneWidth - 1);
  return source(widths.find(fits) ?? widths.at(-1)!);
}

/** The second link of a sourced row: the timetable its publisher issued apart from the cash notice. */
export const SCHEDULE_LINK_LABEL = "Schedule";
/** A publisher's room in the source column, as wide as the longest fund sponsor's name. */
const PUBLISHER_WIDTH = 12;

/** The cells a sourced row's links take: its publisher's, and with `schedule` the schedule's a cell after it. */
export function sourceLinksWidth(row: Pick<DividendRow, "source" | "sourceScheduleUrl">, schedule = !!row.sourceScheduleUrl): number {
  return displayWidth(row.source ?? "") + (schedule && row.sourceScheduleUrl ? 1 + displayWidth(SCHEDULE_LINK_LABEL) : 0);
}

/**
 * The widths the source column can take, widest first, none without a sourced
 * row. A table whose rows link a schedule beside the notice has three: a
 * publisher's room and the schedule; then both links as the rows hold them;
 * then the publishers alone, where the schedule is left to the selected row's
 * menu. A cell draws the schedule only in a column with the room for both
 * links whole (`sourceLinksWidth`), so the pane's edge never cuts one.
 */
function sourceColumnWidths(rows: readonly Pick<DividendRow, "source" | "sourceScheduleUrl">[]): number[] {
  const sourced = rows.filter((row) => row.source);
  if (!sourced.length) return [];
  if (!sourced.some((row) => row.sourceScheduleUrl)) return [PUBLISHER_WIDTH];
  const links = Math.max(...sourced.map((row) => sourceLinksWidth(row)));
  return [
    Math.max(links, PUBLISHER_WIDTH + 1 + displayWidth(SCHEDULE_LINK_LABEL)),
    links,
    Math.max(...sourced.map((row) => sourceLinksWidth(row, false))),
  ];
}

function getSortValue(columnId: DividendColumnId, row: DividendRow): string | number | null {
  switch (columnId) {
    case "exDate": return row.exDate;
    case "amount": return row.amount;
    case "declared": return row.declared?.amount ?? null;
    case "currency": return row.currency;
    case "status": return dividendRowStatus(row);
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
