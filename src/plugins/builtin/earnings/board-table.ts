import type { DataTableCell, DataTableColumn } from "../../../components";
import { withCompanyLogo } from "../../../components/company-logo";
import { TABLE_COLUMN_GAP, tableColumnLeadGap, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { notMeaningfulCell } from "../../../components/ui/not-meaningful";
import { isNotMeaningful } from "../../../utils/growth";
import { TextAttributes } from "../../../ui";
import { epsBasisShort, showsEpsBasis } from "../shared/earnings-report";
import type { BoardReport, BoardRow, BoardSort } from "./board-model";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL, weekday, type Surprise } from "./format";

type BoardColumnId =
  | "owned" | "symbol" | "name" | "when" | "status" | "cap" | "ccy" | "epsEstimate" | "analysts" | "epsActual" | "basis"
  | "epsSurprise" | "revenueEstimate" | "implied" | "move" | "average";

export type BoardColumn = DataTableColumn & { id: BoardColumnId };

const NAME_MIN_WIDTH = 12;
/** TICKER fits a US ticker; a listing abroad's key is longer (0700:HKEX, 601939:SSE, 000333:SZSE). */
const SYMBOL_WIDTH = 6;
const SYMBOL_MAX_WIDTH = 11;

const ALL_COLUMNS: BoardColumn[] = [
  { id: "owned", label: "", width: 1, align: "left" },
  { id: "symbol", label: "TICKER", width: SYMBOL_WIDTH, align: "left" },
  { id: "name", label: "NAME", width: NAME_MIN_WIDTH, align: "left" },
  { id: "when", label: "WHEN", width: 7, align: "left" },
  { id: "status", label: "STATUS", width: 9, align: "left" },
  { id: "implied", label: "IMPLIED", width: 7, align: "right" },
  // The move, the actual EPS and its surprise come with the report: an upcoming one has none.
  { id: "move", label: "MOVE", width: 7, align: "right", mayBeBlank: true },
  { id: "average", label: "AVG MOVE", width: 8, align: "right" },
  // The currency of the EPS and sales figures, on a board with a listing abroad's (CNY for Tencent).
  { id: "ccy", label: "CCY", width: 3, align: "left" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "analysts", label: "ESTS", width: 4, align: "right" },
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right", mayBeBlank: true },
  { id: "basis", label: "BASIS", width: 5, align: "left" },
  { id: "epsSurprise", label: "EPS SURP", width: 8, align: "right", mayBeBlank: true },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "cap", label: "MKT CAP", width: 8, align: "right" },
];

/**
 * Dropped first when narrow, the report's labels before its figures; the
 * implied move, the move on the report and their average stay beside the name.
 * CCY goes only with the last figure it is the currency of.
 */
const DROP_ORDER: BoardColumnId[] = ["basis", "analysts", "epsSurprise", "status", "epsActual", "cap", "revenueEstimate", "epsEstimate", "ccy", "owned"];

/**
 * With an actual on the board the report is the news: EPS ACT, then EPS SURP,
 * outrank SALES EST, MKT CAP and AVG MOVE, which go first, the average before
 * the cap before the sales estimate. WHEN carries the status (✓) once STATUS
 * goes. Without one, those two columns would be empty, so DROP_ORDER holds.
 */
const REPORTED_DROP_ORDER: BoardColumnId[] = [
  "basis", "analysts", "status", "average", "cap", "revenueEstimate", "epsSurprise", "epsActual", "epsEstimate", "ccy", "owned",
];

/** The columns in the report's currency, which CCY names. */
const CURRENCY_FIGURES: BoardColumnId[] = ["epsEstimate", "epsActual", "revenueEstimate"];

/** Header clicks sort these; the rest keep the ranking. */
export const SORTABLE: Partial<Record<BoardColumnId, BoardSort["column"]>> = {
  symbol: "symbol", cap: "cap", implied: "implied", average: "average",
};

/** Whether any report on the board has an actual: the narrow board then keeps EPS ACT and EPS SURP (boardColumns). */
export function boardHasActuals(rows: readonly BoardRow[]): boolean {
  return rows.some((row) => row.kind === "report" && row.report.epsActual != null);
}

/**
 * Whether a report on the board is in another currency than dollars (a
 * listing abroad's): the board then shows CCY, and says its market cap is in
 * dollars (boardColumns). A board of US reports looks as it always has.
 */
export function boardHasCurrencies(rows: readonly BoardRow[]): boolean {
  return rows.some((row) => row.kind === "report" && row.report.currency != null && row.report.currency !== "USD");
}

/** TICKER's width for the board's symbols: a US ticker's, or wide enough for the longest listing abroad's key. */
export function boardSymbolWidth(rows: readonly BoardRow[]): number {
  const longest = Math.max(0, ...rows.map((row) => (row.kind === "report" ? row.report.symbol.length : 0)));
  return Math.min(SYMBOL_MAX_WIDTH, Math.max(SYMBOL_WIDTH, longest));
}

export function boardColumns(
  width: number,
  { actuals = false, currencies = false, symbolWidth = SYMBOL_WIDTH }: { actuals?: boolean; currencies?: boolean; symbolWidth?: number } = {},
): BoardColumn[] {
  // Every column but the name, with the space a left-aligned column keeps from a right-aligned one before it (CCY after
  // AVG MOVE, BASIS after EPS ACT), so the last column is never cut at the pane's edge.
  const fixed = (list: BoardColumn[]) =>
    list.reduce((sum, column, index) =>
      sum + tableColumnLeadGap(list, index, TABLE_COLUMN_GAP) + (column.id === "name" ? 0 : tableColumnWidth(column)) + TABLE_COLUMN_GAP, 2);
  // Beside figures in yuan or Hong Kong dollars, the cap says it is in dollars.
  let columns = (currencies ? ALL_COLUMNS : ALL_COLUMNS.filter((column) => column.id !== "ccy")).map((column) =>
    column.id === "cap" && currencies ? { ...column, label: "MKT CAP $", width: 9 }
      : column.id === "symbol" ? { ...column, width: symbolWidth }
        : column);
  for (const id of actuals ? REPORTED_DROP_ORDER : DROP_ORDER) {
    if (fixed(columns) + NAME_MIN_WIDTH <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  // CCY is the currency of the figures beside it; with none left it goes too.
  if (!columns.some((column) => CURRENCY_FIGURES.includes(column.id))) columns = columns.filter((column) => column.id !== "ccy");
  // The name takes what the other columns leave.
  const nameWidth = Math.max(NAME_MIN_WIDTH, width - fixed(columns));
  return columns.map((column) => (column.id === "name" ? { ...column, width: nameWidth } : column));
}

export function renderBoardSection(row: BoardRow) {
  return row.kind === "section" ? { text: row.label, color: colors.textBright, attributes: TextAttributes.BOLD } : null;
}

/** What a board cell draws besides its report. */
export interface BoardCellContext {
  /** Whether the STATUS column is on screen; without it the WHEN cell says which reports are out. */
  statusShown: boolean;
  /** The move on a report out today (reportMove); "loading" while its quote is. */
  move: (report: BoardReport) => number | "loading" | null;
  /** The desktop and the web lead each name with the company's logo; the terminal draws none. */
  logos?: boolean;
}

const NO_CONTEXT: BoardCellContext = { statusShown: true, move: () => null };

/** A signed move or surprise, as ERN draws one. */
function signed(value: Surprise): DataTableCell {
  // N/M (a surprise against a loss or zero estimate) as every pane draws it; a missing figure dim.
  if (isNotMeaningful(value)) return notMeaningfulCell();
  return { text: signedPercent(value), color: typeof value !== "number" || value === 0 ? colors.textDim : value > 0 ? colors.positive : colors.negative };
}

export function renderBoardCell(row: BoardRow, column: BoardColumn, context: BoardCellContext = NO_CONTEXT): DataTableCell {
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
      return withCompanyLogo({ text: report.name, color: colors.text }, report, context.logos === true);
    case "when": {
      const timing = report.timing ? TIMING_LABEL[report.timing] : "--";
      const text = row.showDay ? `${weekday(report.date)} ${timing}` : timing;
      // An expected time, from the company's last reports, reads quieter than an announced one.
      if (context.statusShown) return { text, color: report.expectedTiming ? colors.textMuted : dim };
      // Narrow, with no STATUS column: a report that is out is checked, and a projected date reads quieter, as its status would.
      return report.dateStatus === "reported"
        ? { text: `${text} ✓`, color: report.expectedTiming ? colors.textMuted : dim }
        : { text, color: report.expectedTiming || report.dateStatus === "projected" ? colors.textMuted : dim };
    }
    case "status":
      // A projected date reads quieter than an announced one, as an expected time does.
      return { text: report.dateStatus ?? "--", color: report.dateStatus === "projected" ? colors.textMuted : dim };
    case "cap":
      return { text: moneyText(report.marketCap), color: dim };
    case "ccy":
      return { text: report.currency ?? "--", color: dim };
    case "epsEstimate":
      return { text: epsText(report.epsEstimate), color: dim };
    case "analysts":
      return { text: report.epsAnalysts == null ? "--" : String(report.epsAnalysts), color: dim };
    case "epsActual":
      // The company's press release's figure reads quieter until the calendar's replaces it.
      return { text: epsText(report.epsActual), color: report.epsActual == null ? dim : report.provisional ? colors.textMuted : colors.text };
    case "basis":
      return !showsEpsBasis(report)
        ? { text: "--", color: dim }
        : { text: epsBasisShort(report.epsBasis), color: report.epsBasis ? colors.textMuted : dim };
    case "epsSurprise":
      return signed(report.epsSurprise);
    case "revenueEstimate":
      return { text: moneyText(report.revenueEstimate), color: dim };
    case "implied":
      return { text: impliedText(report.impliedMove), color: colors.textBright };
    case "move": {
      const move = context.move(report);
      return move === "loading" ? { text: "…", color: dim } : signed(move);
    }
    case "average":
      return { text: moveSize(report.averageMove), color: colors.text };
  }
}
