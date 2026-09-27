import type { DataTableCell, DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { TextAttributes } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { renderQuoteBoardCell, type BoardQuoteMap } from "../shared/use-quote-board";
import type {
  WorldIndexColumnId,
  WorldIndexTableRow,
} from "./model";

export type WorldIndexColumn = DataTableColumn & { id: WorldIndexColumnId };

const SESSION_TEXT_MIN_WIDTH = 84;
const CHANGE_MIN_WIDTH = 62;
const TIME_MIN_WIDTH = 78;

/** A colored dot needs a legend; the session word does not, so wide panes spell it out. */
export function usesSessionText(width: number): boolean {
  return width >= SESSION_TEXT_MIN_WIDTH;
}

export function createWorldIndexColumns(width: number): WorldIndexColumn[] {
  const statusWidth = usesSessionText(width) ? 9 : 1;
  const symbolWidth = 8;
  const priceWidth = 15;
  const changeWidth = 12;
  const changePercentWidth = 9;
  // An 8-char TIME UTC header over a 5-char time (or a 6-char "Sep 18" date): the shared table's floating-pane
  // width accounting runs a few cells long, and the slack keeps the header intact.
  const timeWidth = 11;
  const showChange = width >= CHANGE_MIN_WIDTH;
  const showTime = width >= TIME_MIN_WIDTH;

  const trailing: WorldIndexColumn[] = [
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    ...(showChange
      ? [{ id: "change" as const, label: "CHG", width: changeWidth, align: "right" as const }]
      : []),
    { id: "changePercent", label: "CHG%", width: changePercentWidth, align: "right" },
    // Left-aligned on purpose: the shared table trims a few cells off the right
    // edge of a floating pane, and a right-aligned value would lose digits.
    ...(showTime
      ? [{ id: "time" as const, label: "TIME UTC", width: timeWidth, align: "left" as const }]
      : []),
  ];

  const columnCount = trailing.length + 3;
  const fixedWidth = statusWidth + symbolWidth
    + trailing.reduce((total, column) => total + (column.width ?? 0), 0);
  // Leaves room for the pane border and scrollbar gutter; the name column grows
  // back into any slack because it is the flexible one.
  const nameWidth = Math.max(10, width - 6 - columnCount - fixedWidth);

  return [
    { id: "status", label: usesSessionText(width) ? "SESSION" : "", width: statusWidth, align: "left" },
    { id: "symbol", label: "INDEX", width: symbolWidth, align: "left" },
    // The leftover width lands here rather than being spread across the number
    // columns, which is what left a dead zone between NAME and LAST.
    { id: "name", label: "NAME", width: nameWidth, align: "left", flexGrow: 1 },
    ...trailing,
  ];
}

const formatIndexPrice = (quote: Quote) => formatNumber(quote.price, 2);
const formatIndexChange = (quote: Quote) =>
  `${quote.change >= 0 ? "+" : "-"}${formatNumber(Math.abs(quote.change), 2)}`;

export function renderWorldIndexCell(
  row: WorldIndexTableRow,
  column: WorldIndexColumn,
  rowState: { selected: boolean },
  quotes: BoardQuoteMap,
  options?: { sessionText?: boolean },
): DataTableCell {
  if (row.type === "header") return { text: "" };

  const { entry } = row;
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "symbol":
      return {
        text: entry.shortName,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "name":
      return {
        text: entry.name,
        color: selectedColor,
      };
    default:
      return renderQuoteBoardCell(column.id, quotes.get(entry.symbol), rowState.selected, {
        sessionText: options?.sessionText,
        formatPrice: formatIndexPrice,
        formatChange: formatIndexChange,
      });
  }
}
