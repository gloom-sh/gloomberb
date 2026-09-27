import type { ReactNode } from "react";
import { DataTableView, type StatItem } from "../../../components";
import type { DataTableCell } from "../../../components/ui/data-table/types";
import { colors, priceColor } from "../../../theme/colors";
import { formatCompactAmount, formatPercentRaw } from "../../../utils/format";
import { formatSignedCompact, formatWeight, renderBar } from "./display";
import type {
  SectorSortPreference,
  SectorTableColumn,
  SectorTableRow,
} from "./sector-model";

export interface AnalyticsMetricRow {
  id: string;
  label: string;
  value: string;
  detail?: string;
  color?: string;
}

/**
 * Most important first: in a short pane the figures at the end give way. The
 * account's level and its moves lead, the basket estimates follow, and the
 * margin detail, as-of and source close the list.
 */
const FIGURE_ORDER = [
  "fx-unavailable",
  "net-liquidation",
  "total-value",
  "day-pnl",
  "pnl",
  "historical-return",
  "cash",
  "sharpe",
  "beta",
  "volatility",
  "max-drawdown",
  "margin-leverage",
  "realized-pnl",
  "available-funds",
  "buying-power",
  "excess-liquidity",
  "settled-cash",
  "account-freshness",
  "account-source",
];
const RISK_FIGURE_IDS: ReadonlySet<string> = new Set(["sharpe", "beta", "volatility", "max-drawdown"]);

function figureRank(id: string): number {
  const index = FIGURE_ORDER.indexOf(id);
  return index < 0 ? FIGURE_ORDER.length : index;
}

/**
 * The overview's summary and risk rows as one set of figures. A figure's
 * detail stays short so the grid keeps its columns: the P&L percent loses its
 * brackets, and the risk rows' sample window and reasons are left to the
 * footer (`riskFigureNotices`).
 */
export function analyticsFigures(summaryRows: readonly AnalyticsMetricRow[], riskRows: readonly AnalyticsMetricRow[]): StatItem[] {
  return [...summaryRows, ...riskRows]
    .map((row, index) => ({ row, index }))
    .sort((left, right) => figureRank(left.row.id) - figureRank(right.row.id) || left.index - right.index)
    .map(({ row }) => {
      const percent = row.id === "day-pnl" || row.id === "pnl" ? row.detail?.replace(/^\((.*)\)$/, "$1") : row.detail;
      const detail = RISK_FIGURE_IDS.has(row.id) || percent === "—" ? undefined : percent;
      return {
        id: row.id,
        label: row.label,
        value: row.value,
        ...(detail ? { detail } : {}),
        // Plain text takes the grid's own value colour, which the desktop brightens.
        ...(row.color && row.color !== colors.text ? { color: row.color } : {}),
      };
    });
}

/** Why a risk figure reads "—", once per reason, for the footer warning. */
export function riskFigureNotices(riskRows: readonly AnalyticsMetricRow[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const row of riskRows) {
    if (row.value !== "—" || !row.detail) continue;
    byReason.set(row.detail, [...(byReason.get(row.detail) ?? []), row.label]);
  }
  return [...byReason].map(([reason, labels]) => `${labels.join(", ")}: ${reason}`);
}

const sectorRowKey = (row: SectorTableRow) => row.id;

// Module-level so the table's memoized rows keep their identity across renders.
function renderSectorCell(row: SectorTableRow, column: SectorTableColumn): DataTableCell {
  switch (column.id) {
    case "sector":
      return { text: row.sector };
    case "weight":
      return { text: formatWeight(row.weight) };
    case "value":
      return { text: formatCompactAmount(row.value ?? undefined) };
    case "pnl":
      return {
        text: formatSignedCompact(row.pnl),
        color: row.pnl == null ? colors.textMuted : priceColor(row.pnl),
      };
    case "return":
      return {
        text: row.returnPct == null ? "—" : formatPercentRaw(row.returnPct),
        color: row.returnPct == null ? colors.textMuted : priceColor(row.returnPct),
      };
    case "bar":
      return {
        text: renderBar(row.weight, column.width),
        color: colors.textMuted,
      };
  }
}

export function SectorAllocationTable({
  focused,
  resetScrollKey,
  columns,
  rows,
  sort,
  selectedSectorId,
  onHeaderClick,
  onSelectSector,
  width,
  height,
  before,
}: {
  focused: boolean;
  resetScrollKey: string;
  columns: SectorTableColumn[];
  rows: SectorTableRow[];
  sort: SectorSortPreference;
  selectedSectorId: string | null;
  onHeaderClick: (columnId: string) => void;
  onSelectSector: (sectorId: string) => void;
  width?: number;
  height?: number;
  /** The figures and the account history above the sectors. */
  before?: ReactNode;
}) {
  return (
    <DataTableView<SectorTableRow, SectorTableColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={before}
      selection={{
        kind: "id",
        selectedId: selectedSectorId,
        getId: (row) => row.id,
        onChange: (id) => onSelectSector(id),
      }}
      resetScrollKey={resetScrollKey}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={onHeaderClick}
      getItemKey={sectorRowKey}
      emptyStateTitle="No sector data available"
      emptyStateHint="Load profile data or add sectors to the portfolio positions."
      renderCell={renderSectorCell}
    />
  );
}
