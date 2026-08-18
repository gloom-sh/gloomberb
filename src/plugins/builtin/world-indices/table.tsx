import type { DataTableCell, DataTableColumn } from "../../../components";
import { colors, priceColor } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { marketStatusDot, type BoardQuoteMap } from "../shared/use-quote-board";
import type {
  WorldIndexColumnId,
  WorldIndexTableRow,
} from "./model";

export type WorldIndexColumn = DataTableColumn & { id: WorldIndexColumnId };

export function createWorldIndexColumns(width: number): WorldIndexColumn[] {
  const statusWidth = 1;
  const symbolWidth = 8;
  const priceWidth = 15;
  const changeWidth = 9;
  const columnCount = 5;
  const fixedWidth = statusWidth + symbolWidth + priceWidth + changeWidth;
  const nameWidth = Math.max(10, width - 2 - columnCount - fixedWidth);

  return [
    { id: "status", label: "", width: statusWidth, align: "left" },
    { id: "symbol", label: "INDEX", width: symbolWidth, align: "left" },
    { id: "name", label: "NAME", width: nameWidth, align: "left" },
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    { id: "changePercent", label: "CHG%", width: changeWidth, align: "right" },
  ];
}

export function renderWorldIndexCell(
  row: WorldIndexTableRow,
  column: WorldIndexColumn,
  rowState: { selected: boolean },
  quotes: BoardQuoteMap,
): DataTableCell {
  if (row.type === "header") return { text: "" };

  const { entry } = row;
  const state = quotes.get(entry.symbol);
  const quote = state?.quote;
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const dimmed = rowState.selected ? colors.selectedText : colors.textDim;

  switch (column.id) {
    case "status": {
      const dot = marketStatusDot(quote?.marketState);
      return { text: dot.char, color: dot.color };
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
      if (state?.loading && !quote) return { text: "…", color: dimmed };
      if (quote?.price === undefined) return { text: "—", color: dimmed };
      // A retained quote still beats a dash; dim it so stale is visible.
      return {
        text: formatCurrency(quote.price, quote.currency ?? "USD"),
        color: state?.stale ? dimmed : selectedColor,
      };
    case "changePercent":
      if (!quote || quote.changePercent === undefined) return { text: "—", color: dimmed };
      return {
        text: formatPercentRaw(quote.changePercent),
        color: selectedColor ?? priceColor(quote.changePercent),
      };
  }
}
