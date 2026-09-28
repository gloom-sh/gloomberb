import type { DataTableCell, DataTableColumn } from "../../../components";
import { TABLE_COLUMN_GAP, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import type { BoardRow, BoardSort } from "./board-model";
import { epsText, impliedText, moneyText, moveSize, TIMING_LABEL, weekday } from "./format";

type BoardColumnId = "owned" | "symbol" | "name" | "when" | "cap" | "epsEstimate" | "epsActual" | "revenueEstimate" | "implied" | "average";

export type BoardColumn = DataTableColumn & { id: BoardColumnId };

const NAME_MIN_WIDTH = 12;

const ALL_COLUMNS: BoardColumn[] = [
  { id: "owned", label: "", width: 1, align: "left" },
  { id: "symbol", label: "TICKER", width: 6, align: "left" },
  { id: "name", label: "NAME", width: NAME_MIN_WIDTH, align: "left" },
  { id: "when", label: "WHEN", width: 7, align: "left" },
  { id: "implied", label: "IMPLIED", width: 7, align: "right" },
  { id: "average", label: "AVG MOVE", width: 8, align: "right" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right" },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "cap", label: "MKT CAP", width: 8, align: "right" },
];

/** Dropped first when narrow; the implied move and its average stay beside the name. */
const DROP_ORDER: BoardColumnId[] = ["epsActual", "cap", "revenueEstimate", "epsEstimate", "owned"];

/** Header clicks sort these; the rest keep the ranking. */
export const SORTABLE: Partial<Record<BoardColumnId, BoardSort["column"]>> = {
  symbol: "symbol", cap: "cap", implied: "implied", average: "average",
};

export function boardColumns(width: number): BoardColumn[] {
  const fixed = (list: BoardColumn[]) =>
    list.reduce((sum, column) => sum + (column.id === "name" ? 0 : tableColumnWidth(column)) + TABLE_COLUMN_GAP, 2);
  let columns = ALL_COLUMNS;
  for (const id of DROP_ORDER) {
    if (fixed(columns) + NAME_MIN_WIDTH <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  // The name takes what the other columns leave.
  const nameWidth = Math.max(NAME_MIN_WIDTH, width - fixed(columns));
  return columns.map((column) => (column.id === "name" ? { ...column, width: nameWidth } : column));
}

export function renderBoardSection(row: BoardRow) {
  return row.kind === "section" ? { text: row.label, color: colors.textBright, attributes: TextAttributes.BOLD } : null;
}

export function renderBoardCell(row: BoardRow, column: BoardColumn): DataTableCell {
  if (row.kind !== "report") return { text: "" };
  const report = row.report;
  const dim = colors.textDim;
  switch (column.id) {
    case "owned":
      return report.owned === "held" ? { text: "●", color: colors.borderFocused, keepColorWhenSelected: true }
        : report.owned === "watched" ? { text: "○", color: dim } : { text: "" };
    case "symbol":
      return { text: report.symbol, color: colors.text, attributes: TextAttributes.BOLD };
    case "name":
      return { text: report.name, color: colors.text };
    case "when": {
      const timing = report.timing ? TIMING_LABEL[report.timing] : "--";
      // An expected time, from the company's last reports, reads quieter than an announced one.
      return { text: row.showDay ? `${weekday(report.date)} ${timing}` : timing, color: report.expectedTiming ? colors.textMuted : dim };
    }
    case "cap":
      return { text: moneyText(report.marketCap), color: dim };
    case "epsEstimate":
      return { text: epsText(report.epsEstimate), color: dim };
    case "epsActual": {
      const beat = report.epsActual != null && report.epsEstimate != null ? report.epsActual - report.epsEstimate : null;
      return { text: report.epsActual == null ? "" : epsText(report.epsActual), color: beat == null || beat === 0 ? colors.text : beat > 0 ? colors.positive : colors.negative };
    }
    case "revenueEstimate":
      return { text: moneyText(report.revenueEstimate), color: dim };
    case "implied":
      return { text: impliedText(report.impliedMove), color: colors.textBright };
    case "average":
      return { text: moveSize(report.averageMove), color: colors.text };
  }
}
