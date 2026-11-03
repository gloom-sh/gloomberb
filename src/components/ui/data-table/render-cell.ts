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
