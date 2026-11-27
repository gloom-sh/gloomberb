import { displayWidth } from "../../../utils/format";
import type { DataTableCell, DataTableColumn } from "./types";

/** A cell that draws its text and nothing else: no drawing, artwork, note, fill or press of its own. */
function drawsPlainText(cell: DataTableCell): boolean {
  return cell.content === undefined && !cell.note && cell.leading === undefined && cell.backgroundColor === undefined && !cell.onMouseDown;
}

/**
 * How many cells past its column a row's text reads on. A left-aligned text
 * its column cuts ("RatingDog Manufacturing …") goes on into the blank the
 * right-aligned text after it leaves in the same row (a dash in a figure
 * column seven cells wide leaves six), up to one blank before that text, and
 * is cut there if it is longer still. Each row reads only its own blank: no
 * column moves as the rows scroll by, and a long figure in another row takes
 * nothing from this one. 0 when the text fits, when the next column is not
 * right-aligned, or when either cell draws more than its text.
 *
 * Every renderer draws it from this: the terminal moves the edge between the
 * two cells, the desktop and the web let the text's cell span the next
 * column, its text stopping a blank before the figure.
 */
export function tableCellSpill(
  column: Pick<DataTableColumn, "width" | "align">,
  cell: DataTableCell,
  next: Pick<DataTableColumn, "width" | "align"> | undefined,
  nextCell: DataTableCell | undefined,
  columnGap: number,
): number {
  if (!next || !nextCell || (column.align ?? "left") !== "left" || next.align !== "right") return 0;
  if (!drawsPlainText(cell) || !drawsPlainText(nextCell)) return 0;
  const past = displayWidth(cell.text) - column.width;
  if (past <= 0) return 0;
  const blank = next.width - displayWidth(nextCell.text.trimStart()) + columnGap - 1;
  return Math.max(0, Math.min(past, blank));
}
