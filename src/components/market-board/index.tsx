import { useMemo, useState, type ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import { Box } from "../../ui";
import { compareSortValues, nextHeaderSort, type SortPreference } from "../../utils/sort-values";
import { DataTableStackView } from "../data-table/stack-view";
import { PriceSparkline } from "../price-sparkline/view";
import { PaneStatusBody, StatGrid, statGridRows, type DataTableColumn, type DataTableCell, type StatItem } from "../ui";
import { getTableWidth } from "../ui/table-layout";

export interface MarketBoardRow {
  id: string;
  label: string;
  /** Secondary name shown beside the label, such as the instrument a jurisdiction sets. */
  labelDetail?: string;
  value: number | null;
  valueText: string;
  change: number | null;
  changeText: string;
  /** Date of the displayed move, independent from the latest observation. */
  changeAsOf?: string | null;
  percentile: number | null;
  percentileText?: string;
  asOf: string | null;
  asOfText?: string;
  history: PricePoint[];
  status?: "available" | "stale" | "unavailable";
  /**
   * Which way a move is bad news when `signedChange` colours it: a spread
   * widening is "up"; a price falling is "down", the default.
   */
  adverseMove?: "up" | "down";
}

/** The colour of a signed move: red when it goes the `adverse` way. */
export function signedMoveColor(
  change: number | null | undefined,
  adverse: "up" | "down" = "down",
  palette: { positive: string; negative: string; textMuted: string },
): string {
  if (change == null || change === 0 || !Number.isFinite(change)) return palette.textMuted;
  return (change > 0) === (adverse === "up") ? palette.negative : palette.positive;
}

export interface MarketBoardStackProps<T extends MarketBoardRow> {
  rows: T[];
  width: number;
  height: number;
  focused: boolean;
  selectedId: string | null;
  onSelectedIdChange: (id: string) => void;
  openId: string | null;
  onOpenIdChange: (id: string | null) => void;
  renderDetail: (row: T) => ReactNode;
  /** Domain-specific interval, such as 1D or previous published observation. */
  changeLabel?: string;
  valueWidth?: number;
  labelWidth?: number;
  /** Header over the row names; defaults to INSTRUMENT. */
  labelHeader?: string;
  /** Header over `labelDetail`, shown when any row carries one. */
  labelDetailHeader?: string;
  labelDetailWidth?: number;
  valueLabel?: string;
  percentileLabel?: string;
  asOfWidth?: number;
  /** Colour the change by sign. Off by default: a rate moving up is not good news. */
  signedChange?: boolean;
  extraColumns?: Array<{ column: DataTableColumn; sortValue: (row: T) => string | number | null; renderCell: (row: T) => DataTableCell }>;
  /**
   * Content above the board. A function gets the columns the board fitted to
   * the width, so a header zone can count the scrollbar row they need.
   */
  rootBefore?: ReactNode | ((board: { columns: readonly DataTableColumn[] }) => ReactNode);
  emptyTitle?: string;
}

/**
 * What a board gives up, in order, when the pane is too narrow for it: the
 * second label, the sparkline, the as-of year, then the change date and the
 * percentile. Shortening dates costs less than losing a column, so it comes
 * before the data columns.
 */
const FIT_STEPS = ["labelDetail", "history", "shortAsOf", "changeAsOf", "percentile"] as const;
/** An as-of date without its year ("09-17"). */
const SHORT_AS_OF_WIDTH = 5;

function shortIsoDate(text: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text;
}

/** Fit the board to the pane rather than cut its right edge mid-value. */
function fitBoardColumns(candidates: DataTableColumn[], width: number): { columns: DataTableColumn[]; shortAsOf: boolean } {
  const withAsOfWidth = (list: DataTableColumn[], asOfWidth: number | null) => asOfWidth === null
    ? list
    : list.map((column) => column.id === "asOf" ? { ...column, width: asOfWidth } : column);
  let columns = candidates;
  let shortAsOf = false;
  for (const step of FIT_STEPS) {
    if (getTableWidth(columns) <= width) break;
    if (step === "shortAsOf") {
      shortAsOf = true;
      columns = withAsOfWidth(columns, SHORT_AS_OF_WIDTH);
    } else {
      columns = columns.filter((column) => column.id !== step);
    }
  }
  // Dropping a column after the dates were shortened may leave room for the year again.
  const fullAsOf = candidates.find((column) => column.id === "asOf")?.width ?? null;
  if (shortAsOf && getTableWidth(withAsOfWidth(columns, fullAsOf)) <= width) {
    shortAsOf = false;
    columns = withAsOfWidth(columns, fullAsOf);
  }
  // The detail name, when it survives, is the column that grows.
  const growId = columns.some((column) => column.id === "labelDetail") ? "labelDetail" : "label";
  return {
    columns: columns.map((column) => column.id === growId ? { ...column, flexGrow: 1 } : column),
    shortAsOf,
  };
}

/** Funding, policy, volume and price boards share sorting, date context,
 * native sparklines, stable selection and a mouse/keyboard detail stack. */
export function MarketBoardStack<T extends MarketBoardRow>({ rows, width, height, focused,
  selectedId, onSelectedIdChange, openId, onOpenIdChange, renderDetail, changeLabel = "1D", valueWidth = 12,
  labelWidth = 18, labelHeader = "INSTRUMENT", labelDetailHeader = "DETAIL", labelDetailWidth = 22, valueLabel = "LEVEL", percentileLabel = "PCTL 1Y", asOfWidth = 10, signedChange = false, extraColumns,
  rootBefore, emptyTitle = "No observations." }: MarketBoardStackProps<T>) {
  const colors = useThemeColors();
  const [sort, setSort] = useState<SortPreference<string>>({ columnId: null, direction: "asc" });
  const items = useMemo(() => sort.columnId ? [...rows].sort((a, b) => {
    const key = sort.columnId as "label" | "labelDetail" | "value" | "change" | "percentile" | "asOf" | "changeAsOf";
    const extra = extraColumns?.find((item) => item.column.id === sort.columnId);
    const left = extra ? extra.sortValue(a) : a[key], right = extra ? extra.sortValue(b) : b[key];
    return compareSortValues(left, right, sort.direction);
  }) : rows, [rows, sort, extraColumns]);
  const open = rows.find((row) => row.id === openId);
  const { columns, shortAsOf } = fitBoardColumns([
    { id: "label", label: labelHeader, width: labelWidth, align: "left" },
    ...(rows.some((row) => row.labelDetail !== undefined)
      ? [{ id: "labelDetail", label: labelDetailHeader, width: labelDetailWidth, align: "left" as const }] : []),
    { id: "value", label: valueLabel, width: valueWidth, align: "right" },
    { id: "change", label: changeLabel, width: 10, align: "right" },
    ...(rows.some((row) => row.changeAsOf !== undefined) ? [{ id: "changeAsOf", label: "LAST CHANGE", width: 11, align: "left" as const }] : []),
    ...(extraColumns?.map((item) => item.column) ?? []),
    { id: "percentile", label: percentileLabel, width: 8, align: "right" },
    { id: "history", label: "1Y", width: 14, align: "left" },
    { id: "asOf", label: "AS OF", width: asOfWidth, align: "left" },
  ], width);
  const renderCell = (row: T, column: DataTableColumn): DataTableCell => {
    const extra = extraColumns?.find((item) => item.column.id === column.id);
    if (extra) return extra.renderCell(row);
    const muted = row.status === "unavailable" ? colors.textDim : colors.text;
    if (column.id === "label") return { text: row.label, color: muted };
    if (column.id === "labelDetail") return { text: row.labelDetail ?? "", color: colors.textMuted };
    if (column.id === "value") return { text: row.valueText, color: muted };
    if (column.id === "change") return { text: row.changeText,
      color: signedChange ? signedMoveColor(row.change, row.adverseMove, colors) : colors.textMuted };
    if (column.id === "changeAsOf") return { text: row.changeAsOf ?? "--", color: colors.textDim };
    if (column.id === "percentile") return { text: row.percentileText ?? row.percentile?.toFixed(0) ?? "--", color: row.percentile != null && (row.percentile <= 10 || row.percentile >= 90) ? colors.warning : colors.textMuted };
    if (column.id === "history") return { text: "", content: <PriceSparkline priceHistory={row.history} width={column.width} period="1Y" trend="neutral" /> };
    const asOf = row.asOfText ?? row.asOf ?? "--";
    // A narrow board drops the year; the export keeps the full date.
    return { text: shortAsOf ? shortIsoDate(asOf) : asOf, ...(row.asOf ? { value: row.asOf } : {}),
      color: row.status === "stale" ? colors.warning : colors.textDim };
  };
  return <DataTableStackView columns={columns} items={items} getItemKey={(row) => row.id} renderCell={renderCell}
    focused={focused} selection={{ kind: "id", selectedId, getId: (row) => row.id, onChange: onSelectedIdChange }}
    onActivate={(row) => onOpenIdChange(row.id)} detailOpen={!!open} onBack={() => onOpenIdChange(null)}
    detailTitle={open?.label} detailContent={open ? renderDetail(open) : null}
    sortable isColumnSortable={(column) => column.id !== "history"}
    sortColumnId={sort.columnId} sortDirection={sort.direction} onHeaderClick={(id) => {
      if (id !== "history") setSort((current) => nextHeaderSort(current, id));
    }} rootWidth={width} rootHeight={Math.max(3, height)} rootBefore={typeof rootBefore === "function" ? rootBefore({ columns }) : rootBefore}
    freezeFirstColumn emptyStateTitle={emptyTitle} />;
}

export interface StatChartDetailProps {
  items: StatItem[];
  width: number;
  height: number;
  /** Nothing to chart; the body says so under the figures instead. */
  empty: boolean;
  emptySubject: string;
  emptyTitle: string;
  /** The history chart, given the rows the figures leave it. */
  renderChart: (height: number) => ReactNode;
}

/** An opened board row: its figures over a chart of its history. */
export function StatChartDetail({ items, width, height, empty, emptySubject, emptyTitle, renderChart }: StatChartDetailProps) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      <StatGrid items={items} width={width} />
      <PaneStatusBody empty={empty} subject={emptySubject} emptyTitle={emptyTitle}>
        {renderChart(Math.max(3, height - statGridRows(items, width)))}
      </PaneStatusBody>
    </Box>
  );
}
