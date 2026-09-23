import { useMemo, useState, type ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import { DataTableStackView } from "../data-table/stack-view";
import { PriceSparkline } from "../price-sparkline/view";
import type { DataTableColumn, DataTableCell } from "../ui";

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
  rootBefore?: ReactNode;
  emptyTitle?: string;
}

/** Funding, policy, volume and price boards share sorting, date context,
 * native sparklines, stable selection and a mouse/keyboard detail stack. */
export function MarketBoardStack<T extends MarketBoardRow>({ rows, width, height, focused,
  selectedId, onSelectedIdChange, openId, onOpenIdChange, renderDetail, changeLabel = "1D", valueWidth = 12,
  labelWidth = 18, labelHeader = "INSTRUMENT", labelDetailHeader = "DETAIL", labelDetailWidth = 22, valueLabel = "LEVEL", percentileLabel = "PCTL 1Y", asOfWidth = 10, signedChange = false, extraColumns,
  rootBefore, emptyTitle = "No observations." }: MarketBoardStackProps<T>) {
  const colors = useThemeColors();
  const [sort, setSort] = useState({ id: "", direction: "asc" as "asc" | "desc" });
  const items = useMemo(() => sort.id ? [...rows].sort((a, b) => {
    const key = sort.id as "label" | "labelDetail" | "value" | "change" | "percentile" | "asOf" | "changeAsOf";
    const extra = extraColumns?.find((item) => item.column.id === sort.id);
    const left = extra ? extra.sortValue(a) : a[key], right = extra ? extra.sortValue(b) : b[key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.direction === "asc" ? comparison : -comparison;
  }) : rows, [rows, sort, extraColumns]);
  const open = rows.find((row) => row.id === openId);
  const withLabelDetail = rows.some((row) => row.labelDetail !== undefined);
  const columns: DataTableColumn[] = [
    { id: "label", label: labelHeader, width: labelWidth, align: "left", flexGrow: withLabelDetail ? 0 : 1 },
    ...(withLabelDetail ? [{ id: "labelDetail", label: labelDetailHeader, width: labelDetailWidth, align: "left" as const, flexGrow: 1 }] : []),
    { id: "value", label: valueLabel, width: valueWidth, align: "right" },
    { id: "change", label: changeLabel, width: 10, align: "right" },
    ...(rows.some((row) => row.changeAsOf !== undefined) ? [{ id: "changeAsOf", label: "LAST CHANGE", width: 11, align: "left" as const }] : []),
    ...(extraColumns?.map((item) => item.column) ?? []),
    { id: "percentile", label: percentileLabel, width: 8, align: "right" },
    { id: "history", label: "1Y", width: 14, align: "left" },
    { id: "asOf", label: "AS OF", width: asOfWidth, align: "left" },
  ];
  const renderCell = (row: T, column: DataTableColumn): DataTableCell => {
    const extra = extraColumns?.find((item) => item.column.id === column.id);
    if (extra) return extra.renderCell(row);
    const muted = row.status === "unavailable" ? colors.textDim : colors.text;
    if (column.id === "label") return { text: row.label, color: muted };
    if (column.id === "labelDetail") return { text: row.labelDetail ?? "", color: colors.textMuted };
    if (column.id === "value") return { text: row.valueText, color: muted };
    if (column.id === "change") return { text: row.changeText, color: signedChange && row.change != null && row.change !== 0
      ? row.change > 0 ? colors.positive : colors.negative : colors.textMuted };
    if (column.id === "changeAsOf") return { text: row.changeAsOf ?? "--", color: colors.textDim };
    if (column.id === "percentile") return { text: row.percentileText ?? row.percentile?.toFixed(0) ?? "--", color: row.percentile != null && (row.percentile <= 10 || row.percentile >= 90) ? colors.warning : colors.textMuted };
    if (column.id === "history") return { text: "", content: <PriceSparkline priceHistory={row.history} width={column.width} period="1Y" trend="neutral" /> };
    return { text: row.asOfText ?? row.asOf ?? "--", color: row.status === "stale" ? colors.warning : colors.textDim };
  };
  return <DataTableStackView columns={columns} items={items} getItemKey={(row) => row.id} renderCell={renderCell}
    focused={focused} selection={{ kind: "id", selectedId, getId: (row) => row.id, onChange: onSelectedIdChange }}
    onActivate={(row) => onOpenIdChange(row.id)} detailOpen={!!open} onBack={() => onOpenIdChange(null)}
    detailTitle={open?.label} detailContent={open ? renderDetail(open) : null}
    sortColumnId={sort.id || null} sortDirection={sort.direction} onHeaderClick={(id) => {
      if (id !== "history") setSort((current) => ({ id, direction: current.id === id && current.direction === "asc" ? "desc" : "asc" }));
    }} rootWidth={width} rootHeight={Math.max(3, height)} rootBefore={rootBefore}
    freezeFirstColumn emptyStateTitle={emptyTitle} />;
}
