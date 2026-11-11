import { useCallback, useMemo, useState } from "react";
import {
  ChartTableHeader,
  DataTableView,
  loadingText,
  spanAxisFormatter,
  staticSeries,
  useChartTableSelection,
  type DataTableCell,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import type { StoredBondPayload, StoredBondPrint } from "../../../api-client/bond-trades";
import { colors } from "../../../theme/colors";
import { MISSING_VALUE } from "../../../utils/format";
import { compareSortValues, nextHeaderSort, type SortPreference } from "../../../utils/sort-values";
import type { CorporateBond } from "./client";
import { bondPricePoints, formatPrintSide, formatPrintSize, standingPrints } from "./history";
import { formatBondDecimal } from "./model";

type PrintColumnId = "date" | "time" | "price" | "yield" | "size" | "side";
type PrintColumn = DataTableColumn & { id: PrintColumnId };

/** A kept print as a row: its place in the read names it, as two prints can share every field. */
interface PrintRow extends StoredBondPrint {
  id: string;
}

const PRINT_COLUMNS: readonly PrintColumn[] = [
  { id: "date", label: "Date", width: 11, align: "left" },
  { id: "price", label: "Price", width: 9, align: "right" },
  { id: "yield", label: "Yield", width: 8, align: "right" },
  { id: "size", label: "Size", width: 7, align: "right" },
  { id: "time", label: "Time", width: 9, align: "left" },
  { id: "side", label: "Side", width: 5, align: "left" },
];
/** A narrow pane keeps what was printed and when; the time of day and the dealer's side go first. */
const PRINT_DROP_ORDER: readonly PrintColumnId[] = ["side", "time", "size"];

type PrintSort = SortPreference<PrintColumnId>;
/** Newest print first; a third header click returns here. */
const DEFAULT_PRINT_SORT: PrintSort = { columnId: "date", direction: "desc" };

function printSortValue(columnId: PrintColumnId, row: PrintRow): string | number | null {
  switch (columnId) {
    case "date":
      return `${row.date} ${row.time ?? ""}`;
    case "time":
      return row.time;
    case "price":
      return row.price;
    case "yield":
      return row.yield;
    case "size":
      return row.quantity;
    case "side":
      return row.side;
  }
}

/** Rows in the sort, ties in the order the read listed them (newest first). */
function sortPrints(rows: readonly PrintRow[], sort: PrintSort): PrintRow[] {
  const columnId = sort.columnId ?? "date";
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => compareSortValues(printSortValue(columnId, left.row), printSortValue(columnId, right.row), sort.direction)
      || left.index - right.index)
    .map(({ row }) => row);
}

const isPrintColumnId = (value: string): value is PrintColumnId => PRINT_COLUMNS.some((column) => column.id === value);

const NO_ROWS: PrintRow[] = [];
const printDate = (row: PrintRow) => new Date(`${row.date}T00:00:00Z`);
const printId = (row: PrintRow) => row.id;
/** Prices on the chart's axis: `52.5`, `101.25`. */
const formatPriceAxis = spanAxisFormatter((value, digits) => value.toFixed(digits), 3);

function renderPrintCell(row: PrintRow, column: PrintColumn): DataTableCell {
  switch (column.id) {
    case "date":
      return { text: row.date, value: row.date, color: colors.textMuted };
    case "time":
      return { text: row.time ?? MISSING_VALUE, color: colors.textDim };
    case "price":
      return { text: formatBondDecimal(row.price, 3), value: row.price, color: colors.textBright };
    case "yield":
      return { text: formatBondDecimal(row.yield, 3), value: row.yield, color: colors.text };
    case "size":
      return { text: formatPrintSize(row), value: row.quantity, color: colors.text };
    case "side":
      return { text: formatPrintSide(row.side), color: colors.textDim };
  }
}

/**
 * One bond's kept history: its last sale and since when its prints are kept,
 * the daily closes as a line, then the prints behind them, newest first. The
 * selected print is the chart's cursor. Without Gloom Pro, or while the
 * history loads, the band says so and the table waits.
 */
export function BondHistoryDetail({
  bond,
  history,
  loading,
  refusal,
  focused,
  width,
  height,
}: {
  bond: CorporateBond;
  history: StoredBondPayload | null;
  loading: boolean;
  /** Why no history is read (`Kept price history needs Gloom Pro.`), or null. */
  refusal: string | null;
  focused: boolean;
  width: number;
  height: number;
}) {
  const [sort, setSort] = useState<PrintSort>(DEFAULT_PRINT_SORT);
  const listed = useMemo<PrintRow[]>(
    () => (history ? standingPrints(history.trades).map((print, index) => ({ ...print, id: `${print.date}_${print.time ?? ""}_${index}` })) : NO_ROWS),
    [history],
  );
  const rows = useMemo(() => sortPrints(listed, sort), [listed, sort]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shownId = selectedId && rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id ?? null;
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const link = useChartTableSelection({ rows, getId: printId, getDate: printDate, selectedId: shownId, onSelect: select, focused });
  // A server from before daily closes were served answers none.
  const series = useMemo(() => [staticSeries(
    bondPricePoints(history?.days ?? []),
    { id: "bond-price", label: "Price", color: colors.positive, calendarSpaced: true },
  )], [history]);
  const charted = series[0]!.points.filter((point) => point.value != null).length;
  const figures: StatItem[] = [
    { id: "price", label: "Last", value: formatBondDecimal(bond.lastSalePrice, 3), ...(bond.lastTradeDate ? { detail: bond.lastTradeDate } : {}) },
    { id: "yield", label: "Yield", value: formatBondDecimal(bond.lastSaleYield, 3) },
    ...(history?.keptSince ? [{
      id: "kept",
      label: "Kept since",
      value: history.keptSince,
      ...(history.backfillPending ? { detail: "earlier prints being read", detailVariants: ["reading earlier"] } : {}),
    }] : []),
    ...(bond.cusip ? [{ id: "cusip", label: "CUSIP", value: bond.cusip }] : []),
  ];
  const columns = useMemo(() => fitChartTableColumns(PRINT_COLUMNS, width, PRINT_DROP_ORDER), [width]);
  const empty = refusal
    ?? (history?.backfillPending ? "No kept prints yet; the source's earlier prints are still being read." : null)
    ?? (history?.keptSince ? `No kept prints since ${history.keptSince}.` : "No kept prints.");
  const header = (
    <ChartTableHeader
      width={width}
      height={height}
      tableRows={rows.length}
      figures={figures}
      tableColumns={columns}
      chart={charted >= 2 || loading ? {
        series,
        formatValue: (value: number) => formatBondDecimal(value, 3),
        formatAxisValue: formatPriceAxis,
        remoteKind: "bond-price-history",
        loading,
        ...link,
      } : null}
    />
  );
  return (
    <DataTableView<PrintRow, PrintColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={header}
      selection={{ kind: "id", selectedId: shownId, getId: printId, onChange: select }}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => {
        if (isPrintColumnId(columnId)) {
          setSort((current) => nextHeaderSort(current, columnId, {
            firstDirection: (id) => (id === "side" ? "asc" : "desc"),
            resetTo: DEFAULT_PRINT_SORT,
          }));
        }
      }}
      onSortChange={(columnId, direction) => {
        if (isPrintColumnId(columnId)) setSort({ columnId, direction });
      }}
      resetScrollKey={`${sort.columnId ?? ""}:${sort.direction}`}
      getItemKey={printId}
      renderCell={renderPrintCell}
      selectedTextOverridesCellColor
      emptyStateTitle={loading ? loadingText("kept prints") : empty}
    />
  );
}
