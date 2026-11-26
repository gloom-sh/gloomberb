import { MISSING_VALUE } from "../../../utils/format";
import type { DataTableColumn, DataTableProps, DataTableVisibleRange } from "./types";

type DisplayColumnProps<T, C extends DataTableColumn> = Pick<DataTableProps<T, C>, "columns" | "items" | "renderCell" | "renderSectionHeader" | "isSelected">;

/** The text each data row (not a section header) shows in `column`, trimmed. */
function columnTexts<T, C extends DataTableColumn>(props: DisplayColumnProps<T, C>, column: C, inView?: { start: number; end: number } | null): string[] {
  const texts: string[] = [];
  props.items.forEach((item, index) => {
    if (inView && (index < inView.start || index >= inView.end)) return;
    if (props.renderSectionHeader?.(item, index)) return;
    texts.push(props.renderCell(item, column, index, { selected: props.isSelected(item, index) }).text.trim());
  });
  return texts;
}

const isBlank = (text: string) => text === "" || text === MISSING_VALUE;

export function dataTableDisplayColumns<T, C extends DataTableColumn>(
  props: DisplayColumnProps<T, C>,
  visibleRange?: DataTableVisibleRange | null,
): C[] {
  if (!props.columns.some((column) => column.omitWhenEmpty || column.omitWhenSame)) return props.columns;
  // A row cut at the viewport's edge is not in view; a viewport shorter than a row has only the cut ones.
  const inView = visibleRange && visibleRange.wholeStart !== undefined && visibleRange.wholeEnd !== undefined
    && visibleRange.wholeEnd > visibleRange.wholeStart ? { start: visibleRange.wholeStart, end: visibleRange.wholeEnd } : visibleRange;
  return props.columns.filter((column) => {
    if (column.omitWhenEmpty) {
      const texts = columnTexts(props, column, column.omitWhenEmpty === "visible" ? inView : null);
      if (texts.every(isBlank)) return false;
    }
    if (column.omitWhenSame) {
      const texts = columnTexts(props, column);
      if (texts.length >= 2 && texts.every((text) => text === texts[0] || (isBlank(text) && isBlank(texts[0]!)))) return false;
    }
    return true;
  });
}
