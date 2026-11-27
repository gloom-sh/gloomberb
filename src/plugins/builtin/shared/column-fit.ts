import { displayWidth } from "../../../utils/format";

/** Cells left and right of the columns, and between two of them. */
export const TABLE_PADDING = 2;
export const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;

export function fitColumnWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, value) => Math.max(width, displayWidth(value)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/** Total width of positive-width columns, each followed by `COLUMN_GAP`. */
export function sumColumnWidths(widths: readonly number[]): number {
  return widths.reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0);
}
