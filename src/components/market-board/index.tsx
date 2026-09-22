import { useMemo, useState, type ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import { DataTableStackView } from "../data-table/stack-view";
import { PriceSparkline } from "../price-sparkline/view";
import type { DataTableColumn, DataTableCell } from "../ui";

export interface MarketBoardRow {
  id: string;
  label: string;
  value: number | null;
  valueText: string;
  change: number | null;
  changeText: string;
  percentile: number | null;
  asOf: string | null;
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
  rootBefore?: ReactNode;
  emptyTitle?: string;
}

/** Funding, policy, volume and price boards share sorting, date context,
 * native sparklines, stable selection and a mouse/keyboard detail stack. */
export function MarketBoardStack<T extends MarketBoardRow>({ rows, width, height, focused,
  selectedId, onSelectedIdChange, openId, onOpenIdChange, renderDetail, changeLabel = "1D",
  rootBefore, emptyTitle = "No observations." }: MarketBoardStackProps<T>) {
  const colors = useThemeColors();
  const [sort, setSort] = useState({ id: "", direction: "asc" as "asc" | "desc" });
  const items = useMemo(() => sort.id ? [...rows].sort((a, b) => {
    const key = sort.id as "label" | "value" | "change" | "percentile" | "asOf";
    const left = a[key], right = b[key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return sort.direction === "asc" ? comparison : -comparison;
  }) : rows, [rows, sort]);
  const open = rows.find((row) => row.id === openId);
  const columns: DataTableColumn[] = [
    { id: "label", label: "INSTRUMENT", width: 18, align: "left", flexGrow: 1 },
    { id: "value", label: "LEVEL", width: 12, align: "right" },
    { id: "change", label: changeLabel, width: 10, align: "right" },
    { id: "percentile", label: "PCTL 1Y", width: 8, align: "right" },
    { id: "history", label: "1Y", width: 14, align: "left" },
    { id: "asOf", label: "AS OF", width: 10, align: "left" },
  ];
  const renderCell = (row: T, column: DataTableColumn): DataTableCell => {
    const muted = row.status === "unavailable" ? colors.textDim : colors.text;
    if (column.id === "label") return { text: row.label, color: muted };
    if (column.id === "value") return { text: row.valueText, color: muted };
    if (column.id === "change") return { text: row.changeText, color: colors.textMuted };
    if (column.id === "percentile") return { text: row.percentile?.toFixed(0) ?? "--", color: row.percentile != null && (row.percentile <= 10 || row.percentile >= 90) ? colors.warning : colors.textMuted };
    if (column.id === "history") return { text: "", content: <PriceSparkline priceHistory={row.history} width={column.width} period="1Y" trend="neutral" /> };
    return { text: row.asOf ?? "--", color: row.status === "stale" ? colors.warning : colors.textDim };
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
