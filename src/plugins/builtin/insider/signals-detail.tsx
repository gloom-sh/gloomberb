import { useMemo, useState } from "react";
import type { InsiderSignalRow, InsiderSignalSide } from "../../../api-client/insider-signals";
import { DataTableView, StatGrid, usePaneNoticeFooter, type DataTableCell, type StatItem } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useUiCapabilities } from "../../../ui";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { factCell } from "./signals-cells";
import {
  buildInsiderSignalDetailColumns,
  insiderSignalDetailFirstDirection,
  insiderSignalDetailLines,
  insiderSignalDetailSortValue,
  insiderSignalFigures,
  type InsiderSignalDetailColumn,
  type InsiderSignalDetailColumnId,
  type InsiderSignalDetailLine,
} from "./signals-model";

/**
 * A company opened from the ranking: its figures, each said once, then its
 * insiders in the ranking's columns, largest first. The trades behind them,
 * as filed, are the company's own INS, which `i` opens.
 */
export function InsiderSignalCompanyDetail({ row, side, window, width, focused }: {
  row: InsiderSignalRow;
  side: InsiderSignalSide;
  /** The ranking's window, in days. */
  window: number;
  width: number;
  focused: boolean;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const lines = useMemo(() => insiderSignalDetailLines(row), [row]);
  const [sort, setSort] = useState<{ columnId: InsiderSignalDetailColumnId; direction: SortDirection }>({ columnId: "value", direction: "desc" });
  const sortedLines = useMemo(() => {
    const order = new Map(lines.map((line, index) => [line, index]));
    return [...lines].sort((a, b) => (
      compareSortValues(insiderSignalDetailSortValue(a, sort.columnId), insiderSignalDetailSortValue(b, sort.columnId), sort.direction)
      || order.get(a)! - order.get(b)!
    ));
  }, [lines, sort]);
  const columns = useMemo(() => buildInsiderSignalDetailColumns(width, lines, { side }), [lines, side, width]);
  const figures = useMemo<StatItem[]>(() => insiderSignalFigures(row, window, side), [row, side, window]);

  // The ranking keeps its ten largest insiders; INS lists every one.
  usePaneNoticeFooter({
    registrationId: "insider:signals:detail:notices",
    focused,
    notices: row.insiders > row.buyers.length
      ? [`The ranking lists the ${row.buyers.length} largest of the ${row.insiders} insiders; the company's INS lists every trade.`]
      : [],
  });

  const renderCell = (line: InsiderSignalDetailLine, column: InsiderSignalDetailColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "name": return { text: line.name, color: colors.text };
      case "role": return { text: line.role, color: colors.textMuted };
      case "nth": return factCell(line.nth, side, colors, state.selected);
      case "usual": return factCell(line.usual, side, colors, state.selected);
      case "stake": return factCell(line.stake, side, colors, state.selected, nativePaneChrome ? undefined : column.width);
      case "value": return { text: line.value, value: line.buyer.value, color: side === "sell" ? colors.negative : colors.positive };
      case "lastBuy": return { text: line.last, value: line.buyer.lastBuy, color: colors.textDim };
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <DataTableView<InsiderSignalDetailLine, InsiderSignalDetailColumn>
        focused={focused}
        rootWidth={width}
        rootBefore={<StatGrid items={figures} width={width} />}
        columns={columns}
        items={sortedLines}
        getItemKey={(line) => line.buyer.name}
        selection={{ kind: "none" }}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as InsiderSignalDetailColumnId, {
          firstDirection: insiderSignalDetailFirstDirection,
        }))}
        renderCell={renderCell}
        showHorizontalScrollbar={false}
        emptyStateTitle="No insiders listed for this company."
      />
    </Box>
  );
}
