import { displayWidth, inFigureColumn } from "../../../utils/format";
import type { DataTableColumn, DataTableProps } from "./types";

type RenderCell<T, C extends DataTableColumn> = DataTableProps<T, C>["renderCell"];

/**
 * A table's cells as it draws, reports and exports them. A right-aligned
 * column is a column of figures, so its compact numbers keep their decimals
 * and line up (`inFigureColumn`): 12.00M over 10.73M, never 12M. A pane that
 * sized the column to the short figures keeps the short one wherever the
 * decimals would not fit, so a figure is never cut for them.
 */
export function figureColumnCells<T, C extends DataTableColumn>(renderCell: RenderCell<T, C>): RenderCell<T, C> {
  return (item, column, index, rowState) => {
    if (column.align !== "right") return renderCell(item, column, index, rowState);
    const cell = inFigureColumn(() => renderCell(item, column, index, rowState));
    return displayWidth(cell.text) > column.width ? renderCell(item, column, index, rowState) : cell;
  };
}

/** Rows read to tell how a first column is drawn. */
const FIRST_COLUMN_SAMPLE = 20;

/**
 * Whether a table's first column is plain text in the rows it draws first:
 * what an unset `freezeFirstColumn` pins (`tableFreezesFirstColumn`). A cell
 * the pane lays out itself (`content`: a name clipped beside its kind, a
 * badge) keeps scrolling with the rest; the pinned column draws text.
 */
export function firstColumnDrawsText<T, C extends DataTableColumn>(
  items: readonly T[],
  columns: readonly C[],
  renderCell: RenderCell<T, C>,
  renderSectionHeader?: DataTableProps<T, C>["renderSectionHeader"],
): boolean {
  const column = columns[0];
  if (!column) return false;
  let rows = 0;
  for (let index = 0; index < items.length && rows < FIRST_COLUMN_SAMPLE; index += 1) {
    const item = items[index]!;
    if (renderSectionHeader?.(item, index)) continue;
    if (renderCell(item, column, index, { selected: false }).content !== undefined) return false;
    rows += 1;
  }
  return rows > 0;
}
