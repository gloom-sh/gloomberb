import type { DataTableCell, DataTableColumn } from "../../../components";
import { withCompanyLogo } from "../../../components/company-logo";
import { TABLE_COLUMN_GAP, tableColumnWidth } from "../../../components/ui/table-layout";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { epsBasisShort, showsEpsBasis } from "../shared/earnings-report";
import type { BoardReport, BoardRow, BoardSort } from "./board-model";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL, weekday } from "./format";

type BoardColumnId =
  | "owned" | "symbol" | "name" | "when" | "status" | "cap" | "epsEstimate" | "analysts" | "epsActual" | "basis"
  | "epsSurprise" | "revenueEstimate" | "implied" | "move" | "average";

export type BoardColumn = DataTableColumn & { id: BoardColumnId };

const NAME_MIN_WIDTH = 12;

const ALL_COLUMNS: BoardColumn[] = [
  { id: "owned", label: "", width: 1, align: "left" },
  { id: "symbol", label: "TICKER", width: 6, align: "left" },
  { id: "name", label: "NAME", width: NAME_MIN_WIDTH, align: "left" },
  { id: "when", label: "WHEN", width: 7, align: "left" },
  { id: "status", label: "STATUS", width: 9, align: "left" },
  { id: "implied", label: "IMPLIED", width: 7, align: "right" },
  { id: "move", label: "MOVE", width: 7, align: "right" },
  { id: "average", label: "AVG MOVE", width: 8, align: "right" },
  { id: "epsEstimate", label: "EPS EST", width: 7, align: "right" },
  { id: "analysts", label: "ESTS", width: 4, align: "right" },
  { id: "epsActual", label: "EPS ACT", width: 7, align: "right" },
  { id: "basis", label: "BASIS", width: 5, align: "left" },
  { id: "epsSurprise", label: "EPS SURP", width: 8, align: "right" },
  { id: "revenueEstimate", label: "SALES EST", width: 9, align: "right" },
  { id: "cap", label: "MKT CAP", width: 8, align: "right" },
];

/**
 * Dropped first when narrow, the report's labels before its figures; the
 * implied move, the move on the report and their average stay beside the name.
 */
const DROP_ORDER: BoardColumnId[] = ["basis", "analysts", "epsSurprise", "status", "epsActual", "cap", "revenueEstimate", "epsEstimate", "owned"];

/**
 * With an actual on the board the report is the news: EPS ACT, then EPS SURP,
 * outrank SALES EST, MKT CAP and AVG MOVE, which go first, the average before
 * the cap before the sales estimate. WHEN carries the status (✓) once STATUS
 * goes. Without one, those two columns would be empty, so DROP_ORDER holds.
 */
const REPORTED_DROP_ORDER: BoardColumnId[] = [
  "basis", "analysts", "status", "average", "cap", "revenueEstimate", "epsSurprise", "epsActual", "epsEstimate", "owned",
];

/** Header clicks sort these; the rest keep the ranking. */
export const SORTABLE: Partial<Record<BoardColumnId, BoardSort["column"]>> = {
  symbol: "symbol", cap: "cap", implied: "implied", average: "average",
};

/** Whether any report on the board has an actual: the narrow board then keeps EPS ACT and EPS SURP (boardColumns). */
export function boardHasActuals(rows: readonly BoardRow[]): boolean {
  return rows.some((row) => row.kind === "report" && row.report.epsActual != null);
}

export function boardColumns(width: number, { actuals = false }: { actuals?: boolean } = {}): BoardColumn[] {
  const fixed = (list: BoardColumn[]) =>
    list.reduce((sum, column) => sum + (column.id === "name" ? 0 : tableColumnWidth(column)) + TABLE_COLUMN_GAP, 2);
  let columns = ALL_COLUMNS;
  for (const id of actuals ? REPORTED_DROP_ORDER : DROP_ORDER) {
    if (fixed(columns) + NAME_MIN_WIDTH <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  // The name takes what the other columns leave.
  const nameWidth = Math.max(NAME_MIN_WIDTH, width - fixed(columns));
  return columns.map((column) => (column.id === "name" ? { ...column, minWidth: NAME_MIN_WIDTH, width: nameWidth } : column));
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
function signed(value: number | null): DataTableCell {
  return { text: signedPercent(value), color: value == null || value === 0 ? colors.textDim : value > 0 ? colors.positive : colors.negative };
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
