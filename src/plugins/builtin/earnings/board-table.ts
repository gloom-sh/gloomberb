import { MISSING_VALUE } from "../../../utils/format";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { withCompanyLogo } from "../../../components/company-logo";
import { TABLE_COLUMN_GAP, tableColumnLeadGap, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { notMeaningfulCell } from "../../../components/ui/not-meaningful";
import { isNotMeaningful } from "../../../utils/growth";
import { TextAttributes } from "../../../ui";
import { ACTUAL_PENDING, actualPending, epsBasisShort, showsEpsBasis } from "../shared/earnings-report";
import { listingAbroadVenue } from "../../../utils/sec";
import type { BoardKind, BoardReport, BoardRow, BoardSort } from "./board-model";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL, weekday, type Surprise } from "./format";

type BoardColumnId =
  | "owned" | "symbol" | "name" | "when" | "status" | "cap" | "epsEstimate" | "analysts" | "epsActual" | "basis"
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
  // The implied move, the move on the report and their average are left out
  // while no report in view has one: small caps list no options and too few
  // reports to average, and a move is only measured on the day a report is out.
  { id: "implied", label: "IMPLIED", width: 7, align: "right", omitWhenEmpty: "visible" },
  { id: "move", label: "MOVE", width: 7, align: "right", mayBeBlank: true, omitWhenEmpty: "visible" },
  { id: "average", label: "AVG MOVE", width: 8, align: "right", omitWhenEmpty: "visible" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "analysts", label: "ESTS", width: 4, align: "right" },
  // A report out without its actual yet says it is pending.
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right", mayBeBlank: true },
  { id: "basis", label: "BASIS", width: 5, align: "left", mayBeBlank: true },
  { id: "epsSurprise", label: "EPS SURP", width: 8, align: "right", mayBeBlank: true },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "cap", label: "MKT CAP", width: 8, align: "right" },
];

/**
 * Each kind of report has its own columns. One to come has its date's status
 * (confirmed or projected), its implied move and its analysts, and nothing of
 * a report yet. One out has the move on it, its actual and surprise, and no
 * status: the view says it is out.
 */
const KIND_COLUMNS: Record<BoardKind, ReadonlySet<BoardColumnId>> = {
  upcoming: new Set(["owned", "symbol", "name", "when", "status", "implied", "average", "epsEstimate", "analysts", "revenueEstimate", "cap"]),
  reported: new Set(["owned", "symbol", "name", "when", "implied", "move", "average", "epsEstimate", "epsActual", "basis", "epsSurprise", "revenueEstimate", "cap"]),
};

/**
 * Dropped first when narrow, labels before figures. Upcoming: the analysts,
 * the status, then the cap and the estimates; the implied move and its
 * average stay beside the name. WHEN quiets a projected date once STATUS goes.
 */
const DROP_ORDER: Record<BoardKind, BoardColumnId[]> = {
  upcoming: ["analysts", "status", "cap", "revenueEstimate", "epsEstimate", "owned"],
  // Out, the report is the news: EPS ACT, then EPS SURP, outrank SALES EST, MKT CAP and AVG MOVE, which go first.
  reported: ["basis", "average", "cap", "revenueEstimate", "epsSurprise", "epsActual", "epsEstimate", "owned"],
};

/**
 * The columns in the report's currency. A report in another currency than
 * dollars (a listing abroad's) writes its code after each figure ("7.21 CNY"),
 * and these columns take the room for it; dollars stay bare, so no column
 * says USD down the board.
 */
const CURRENCY_FIGURES: ReadonlySet<BoardColumnId> = new Set(["epsEstimate", "epsActual", "revenueEstimate"]);
/** " CNY" after a figure. */
const CURRENCY_CODE_WIDTH = 4;

/**
 * A figure with its report's currency after it when that is not dollars; a
 * missing or pending one bare. The figure itself is the cell's value, so an
 * export writes numbers down a column whose rows show different codes, and
 * names each row's currency in its own column (BOARD_CURRENCY_EXPORT).
 */
function inReportCurrency(cell: DataTableCell, report: BoardReport, figure: number | null | undefined): DataTableCell {
  if (figure == null || cell.text === MISSING_VALUE || cell.text === ACTUAL_PENDING) return cell;
  const currency = report.currency;
  return { ...cell, value: figure, ...(currency && currency !== "USD" ? { text: `${cell.text} ${currency}` } : {}) };
}

/** A board with a report in another currency than dollars exports each report's currency after the table's columns. */
export const BOARD_CURRENCY_EXPORT = {
  headers: ["CCY"],
  cells: (row: BoardRow): readonly unknown[] | null => (row.kind === "report" ? [row.report.currency ?? ""] : null),
} as const;

/** Header clicks sort these; the rest keep the ranking. */
export const SORTABLE: Partial<Record<BoardColumnId, BoardSort["column"]>> = {
  symbol: "symbol", cap: "cap", implied: "implied", average: "average",
};

/**
 * Whether a report on the board is in another currency than dollars (a
 * listing abroad's): the board then makes room for a code after its figures,
 * and says its market cap is in dollars (boardColumns). A board of US reports
 * looks as it always has.
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
  { kind = "upcoming", currencies = false, symbolWidth = SYMBOL_WIDTH }: { kind?: BoardKind; currencies?: boolean; symbolWidth?: number } = {},
): BoardColumn[] {
  // Every column but the name, with the space a left-aligned column keeps from a right-aligned one before it (BASIS
  // after EPS ACT), so the last column is never cut at the pane's edge.
  const fixed = (list: BoardColumn[]) =>
    list.reduce((sum, column, index) =>
      sum + tableColumnLeadGap(list, index, TABLE_COLUMN_GAP) + (column.id === "name" ? 0 : tableColumnWidth(column)) + TABLE_COLUMN_GAP, 2);
  // Beside figures in yuan or Hong Kong dollars, the cap says it is in dollars.
  let columns = ALL_COLUMNS.filter((column) => KIND_COLUMNS[kind].has(column.id)).map((column) =>
    column.id === "cap" && currencies ? { ...column, label: "MKT CAP $", width: 9 }
      : column.id === "symbol" ? { ...column, width: symbolWidth }
        : currencies && CURRENCY_FIGURES.has(column.id) ? { ...column, width: column.width + CURRENCY_CODE_WIDTH }
          : column);
  for (const id of DROP_ORDER[kind]) {
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

/** What a board cell draws besides its report. */
export interface BoardCellContext {
  /** Whether the STATUS column is on screen; without it WHEN quiets a projected date, as STATUS would. */
  statusShown: boolean;
  /** The move on the report (boardMove): so far for one out today, across it for one out before; "loading" while today's quote is. */
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
      const timing = report.timing ? TIMING_LABEL[report.timing] : MISSING_VALUE;
      const text = row.showDay ? `${weekday(report.date)} ${timing}` : timing;
      // An expected time, from the company's last reports, reads quieter than an announced one; so does a projected
      // date once no STATUS column says it is.
      const quiet = report.expectedTiming || (!context.statusShown && report.dateStatus === "projected");
      return { text, color: quiet ? colors.textMuted : dim };
    }
    case "status":
      // A projected date reads quieter than an announced one, as an expected time does.
      return { text: report.dateStatus ?? MISSING_VALUE, color: report.dateStatus === "projected" ? colors.textMuted : dim };
    case "cap":
      return { text: moneyText(report.marketCap), color: dim };
    case "epsEstimate":
      return inReportCurrency({ text: epsText(report.epsEstimate), color: dim }, report, report.epsEstimate);
    case "analysts":
      return { text: report.epsAnalysts == null ? MISSING_VALUE : String(report.epsAnalysts), color: dim };
    case "epsActual":
      // A report out with no actual yet says so; the company's press release's figure reads quieter until the calendar's replaces it.
      if (actualPending(report, listingAbroadVenue(report.symbol) != null)) return { text: ACTUAL_PENDING, color: dim };
      return inReportCurrency({ text: epsText(report.epsActual), color: report.epsActual == null ? dim : report.provisional ? colors.textMuted : colors.text }, report, report.epsActual);
    case "basis":
      return !showsEpsBasis(report)
        ? { text: MISSING_VALUE, color: dim }
        : { text: epsBasisShort(report.epsBasis), color: report.epsBasis ? colors.textMuted : dim };
    case "epsSurprise":
      return signed(report.epsSurprise);
    case "revenueEstimate":
      return inReportCurrency({ text: moneyText(report.revenueEstimate), color: dim }, report, report.revenueEstimate);
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
