import type { DataTableCell, DataTableColumn } from "../../../components";
import { TABLE_COLUMN_GAP, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { datedYear, epsText, fiscalMonth, impliedText, moneyText, signedPercent, TIMING_LABEL } from "./format";
import type { HistoryRow } from "./history-model";

type HistoryColumnId =
  | "date" | "when" | "period" | "epsEstimate" | "epsActual" | "epsSurprise"
  | "revenueEstimate" | "revenueActual" | "revenueSurprise" | "implied" | "move" | "ratio";

export type HistoryColumn = DataTableColumn & { id: HistoryColumnId };

const ALL_COLUMNS: HistoryColumn[] = [
  { id: "date", label: "DATE", width: 10, align: "left" },
  { id: "when", label: "WHEN", width: 4, align: "left" },
  { id: "period", label: "QTR", width: 7, align: "left" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right" },
  { id: "epsSurprise", label: "EPS SURP", width: 8, align: "right" },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "revenueActual", label: "SALES ACT", width: 9, align: "right" },
  { id: "revenueSurprise", label: "SALES SURP", width: 10, align: "right" },
  { id: "implied", label: "IMPLIED", width: 7, align: "right" },
  { id: "move", label: "MOVE", width: 7, align: "right" },
  { id: "ratio", label: "VS IMPL", width: 7, align: "right" },
];

/** Dropped first when the pane is narrow: the table keeps dates, the two moves and EPS. */
const DROP_ORDER: HistoryColumnId[] = ["period", "revenueSurprise", "ratio", "revenueEstimate", "when", "epsSurprise", "revenueActual", "epsEstimate"];

export function historyColumns(width: number): HistoryColumn[] {
  let columns = ALL_COLUMNS;
  const used = (list: HistoryColumn[]) => list.reduce((sum, column) => sum + tableColumnWidth(column) + TABLE_COLUMN_GAP, 2);
  for (const id of DROP_ORDER) {
    if (used(columns) <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  return columns;
}

function signed(value: number | null): DataTableCell {
  return { text: signedPercent(value), color: value == null || value === 0 ? colors.textDim : value > 0 ? colors.positive : colors.negative };
}

export function renderHistoryCell(row: HistoryRow, column: HistoryColumn): DataTableCell {
  const dim = colors.textDim;
  switch (column.id) {
    case "date":
      return { text: datedYear(row.date), color: row.upcoming ? colors.textBright : colors.text, attributes: row.upcoming ? TextAttributes.BOLD : undefined };
    case "when":
      return { text: row.timing ? TIMING_LABEL[row.timing] : "--", color: row.expectedTiming ? colors.textMuted : dim };
    case "period":
      return { text: fiscalMonth(row.fiscalPeriod), color: dim };
    case "epsEstimate":
      return { text: epsText(row.epsEstimate), color: dim };
    case "epsActual":
      return { text: epsText(row.epsActual), color: colors.text };
    case "epsSurprise":
      return signed(row.epsSurprise);
    case "revenueEstimate":
      return { text: moneyText(row.revenueEstimate), color: dim };
    case "revenueActual":
      return { text: moneyText(row.revenueActual), color: colors.text };
    case "revenueSurprise":
      return signed(row.revenueSurprise);
    case "implied":
      return { text: impliedText(row.implied), color: row.upcoming ? colors.textBright : colors.text };
    case "move":
      return signed(row.move);
    case "ratio":
      return { text: row.moveRatio == null ? "--" : `${row.moveRatio.toFixed(1)}x`, color: row.moveRatio != null && row.moveRatio > 1 ? colors.warning : dim };
  }
}
