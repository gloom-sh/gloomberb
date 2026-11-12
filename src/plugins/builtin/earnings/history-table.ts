import { MISSING_VALUE } from "../../../utils/format";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { TABLE_COLUMN_GAP, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { datedYear, epsText, impliedText, moneyText, signedPercent, TIMING_LABEL } from "./format";
import { epsBasisShort, showsEpsBasis } from "../shared/earnings-report";
import { periodText, type HistoryRow } from "./history-model";

type HistoryColumnId =
  | "date" | "when" | "period" | "epsEstimate" | "analysts" | "epsActual" | "basis" | "epsSurprise"
  | "revenueEstimate" | "revenueActual" | "revenueSurprise" | "implied" | "move" | "ratio";

export type HistoryColumn = DataTableColumn & { id: HistoryColumnId };

const ALL_COLUMNS: HistoryColumn[] = [
  { id: "date", label: "DATE", width: 10, align: "left" },
  { id: "when", label: "WHEN", width: 4, align: "left" },
  { id: "period", label: "QTR", width: 7, align: "left" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "analysts", label: "ESTS", width: 4, align: "right" },
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right" },
  { id: "basis", label: "BASIS", width: 5, align: "left" },
  { id: "epsSurprise", label: "EPS SURP", width: 8, align: "right" },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "revenueActual", label: "SALES ACT", width: 9, align: "right" },
  { id: "revenueSurprise", label: "SALES SURP", width: 10, align: "right" },
  { id: "implied", label: "IMPLIED", width: 7, align: "right" },
  { id: "move", label: "MOVE", width: 7, align: "right" },
  { id: "ratio", label: "VS IMPL", width: 7, align: "right" },
];

/** Dropped first when the pane is narrow: the table keeps dates, the two moves and EPS. */
const DROP_ORDER: HistoryColumnId[] = [
  "period", "analysts", "revenueSurprise", "ratio", "revenueEstimate", "when", "basis", "epsSurprise", "revenueActual", "epsEstimate",
];

/** The sales columns and what fills them; a company with no revenue on record shows none of them. */
const SALES_COLUMNS: Partial<Record<HistoryColumnId, (row: HistoryRow) => number | null>> = {
  revenueEstimate: (row) => row.revenueEstimate,
  revenueActual: (row) => row.revenueActual,
  revenueSurprise: (row) => row.revenueSurprise,
};

/** What fills the move columns: a listing abroad has no options or moves read, so it shows none of them. */
const MOVE_COLUMNS: Partial<Record<HistoryColumnId, (row: HistoryRow) => number | null>> = {
  implied: (row) => row.implied,
  move: (row) => row.move,
  ratio: (row) => row.moveRatio,
};

/** Amount columns that carry a listing abroad's currency after each figure ("7.22 CNY"), and the room it takes. */
const AMOUNT_COLUMNS: ReadonlySet<HistoryColumnId> = new Set(["epsEstimate", "epsActual", "revenueEstimate", "revenueActual"]);
const CURRENCY_WIDTH = 4;

/** A listing abroad's figure with its currency; a US listing's dollars stay bare. */
const inCurrency = (text: string, row: HistoryRow) => (row.currency && text !== MISSING_VALUE ? `${text} ${row.currency}` : text);

/**
 * The columns that fit `width`. A listing abroad's (`abroad`, Hong Kong's)
 * read the same whatever its rows hold: PERIOD, since its rows may be halves
 * or years, a currency after every amount, and no move columns.
 */
export function historyColumns(width: number, rows: readonly HistoryRow[], options: { abroad?: boolean } = {}): HistoryColumn[] {
  const abroad = options.abroad === true;
  const labelled = abroad || rows.some((row) => row.currency != null);
  const periods = abroad || rows.some((row) => row.periodKind !== "quarter");
  let columns = ALL_COLUMNS.filter((column) => {
    const value = SALES_COLUMNS[column.id] ?? (labelled ? MOVE_COLUMNS[column.id] : undefined);
    return !value || rows.some((row) => value(row) != null);
  }).map((column): HistoryColumn => {
    if (labelled && AMOUNT_COLUMNS.has(column.id)) return { ...column, width: column.width + CURRENCY_WIDTH };
    // A half or a year is no quarter: the column names what it holds.
    if (periods && column.id === "period") {
      return { ...column, label: "PERIOD", width: Math.max(column.width, "PERIOD".length, ...rows.map((row) => periodText(row).length)) };
    }
    return column;
  });
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

/**
 * The move so far on a report out today (reportMove), as EVTS shows it, until
 * the first close after the report settles the row's own; "loading" while its
 * quote is.
 */
export type LiveMove = (row: HistoryRow) => number | "loading" | null;

export function renderHistoryCell(row: HistoryRow, column: HistoryColumn, liveMove?: LiveMove): DataTableCell {
  const dim = colors.textDim;
  switch (column.id) {
    case "date":
      return { text: datedYear(row.date), color: row.upcoming ? colors.textBright : colors.text, attributes: row.upcoming ? TextAttributes.BOLD : undefined };
    case "when":
      return { text: row.timing ? TIMING_LABEL[row.timing] : MISSING_VALUE, color: row.expectedTiming ? colors.textMuted : dim };
    case "period":
      return { text: periodText(row), color: dim };
    case "epsEstimate":
      return { text: inCurrency(epsText(row.epsEstimate), row), color: dim };
    case "analysts":
      return { text: row.epsAnalysts == null ? MISSING_VALUE : String(row.epsAnalysts), color: dim };
    case "epsActual":
      // The company's press release's figure reads quieter until the calendar's replaces it.
      return { text: inCurrency(epsText(row.epsActual), row), color: row.provisional ? colors.textMuted : colors.text };
    case "basis":
      // A listing abroad's basic EPS is not the statements' diluted figure: it says what it is.
      return !showsEpsBasis(row)
        ? { text: MISSING_VALUE, color: dim }
        : !row.epsBasis && row.epsDilution === "basic"
          ? { text: "basic", color: colors.textMuted }
          : { text: epsBasisShort(row.epsBasis), color: row.epsBasis ? colors.textMuted : dim };
    case "epsSurprise":
      return signed(row.epsSurprise);
    case "revenueEstimate":
      return { text: inCurrency(moneyText(row.revenueEstimate), row), color: dim };
    case "revenueActual":
      return { text: inCurrency(moneyText(row.revenueActual), row), color: row.revenueProvisional ? colors.textMuted : colors.text };
    case "revenueSurprise":
      return signed(row.revenueSurprise);
    case "implied":
      return { text: impliedText(row.implied), color: row.upcoming ? colors.textBright : colors.text };
    case "move": {
      // The averages, VS IMPL and the chart wait for the settled move; the cell shows the move so far.
      const live = row.move == null ? liveMove?.(row) ?? null : null;
      return live === "loading" ? { text: "…", color: dim } : signed(row.move ?? live);
    }
    case "ratio":
      return { text: row.moveRatio == null ? MISSING_VALUE : `${row.moveRatio.toFixed(1)}x`, color: row.moveRatio != null && row.moveRatio > 1 ? colors.warning : dim };
  }
}
