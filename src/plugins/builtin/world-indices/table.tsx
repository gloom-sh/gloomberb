import type { DataTableCell, DataTableColumn } from "../../../components";
import { marketStateColor, marketStateLabel } from "../../../market-data/market/status";
import { colors, priceColor } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { formatCurrency, formatNumber, formatPercentRaw } from "../../../utils/format";
import { marketStatusDot, type BoardQuoteMap } from "../shared/use-quote-board";
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
  // 5-char 24h time in an 8-wide column: the shared table's floating-pane width
  // accounting runs a few cells long, and the slack keeps the value intact.
  const timeWidth = 8;
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
      ? [{ id: "time" as const, label: "TIME", width: timeWidth, align: "left" as const }]
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

/** 24-hour so the cell stays 5 wide in every locale and never clips. */
export function formatQuoteTime(lastUpdated: number | undefined): string {
  if (!lastUpdated) return "—";
  const date = new Date(lastUpdated);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function renderWorldIndexCell(
  row: WorldIndexTableRow,
  column: WorldIndexColumn,
  rowState: { selected: boolean },
  quotes: BoardQuoteMap,
  options?: { sessionText?: boolean },
): DataTableCell {
  if (row.type === "header") return { text: "" };

  const { entry } = row;
  const state = quotes.get(entry.symbol);
  const quote = state?.quote;
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const dimmed = rowState.selected ? colors.selectedText : colors.textDim;
  // One row must not mix a loading marker with a no-data marker.
  const loadingCell = !quote && (state?.loading ?? true);

  switch (column.id) {
    case "status": {
      if (loadingCell) return { text: "", color: dimmed };
      if (options?.sessionText) {
        const marketState = quote?.marketState;
        return {
          text: marketState ? marketStateLabel(marketState) : "—",
          color: rowState.selected
            ? colors.selectedText
            : marketState ? marketStateColor(marketState) : colors.textDim,
        };
      }
      const dot = marketStatusDot(quote?.marketState);
      return { text: dot.char, color: rowState.selected ? colors.selectedText : dot.color };
    }
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
    case "price":
      if (loadingCell) return { text: "…", color: dimmed };
      if (quote?.price === undefined) return { text: "—", color: dimmed };
      // A retained quote still beats a dash; dim it so stale is visible.
      return {
        text: formatCurrency(quote.price, quote.currency ?? "USD"),
        color: state?.stale ? dimmed : selectedColor,
      };
    case "change":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || !Number.isFinite(quote.change)) return { text: "—", color: dimmed };
      return {
        text: `${quote.change >= 0 ? "+" : "-"}${formatNumber(Math.abs(quote.change), 2)}`,
        color: selectedColor ?? priceColor(quote.change),
      };
    case "changePercent":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || quote.changePercent === undefined) return { text: "—", color: dimmed };
      return {
        text: formatPercentRaw(quote.changePercent),
        color: selectedColor ?? priceColor(quote.changePercent),
      };
    case "time":
      if (loadingCell) return { text: "…", color: dimmed };
      return { text: formatQuoteTime(quote?.lastUpdated), color: dimmed };
  }
}
