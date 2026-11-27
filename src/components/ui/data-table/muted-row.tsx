import { createContext, useContext, type ReactNode } from "react";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { DataTableCell, DataTableColumn, DataTableProps } from "./types";

const MutedRowContext = createContext(false);

/**
 * Whether the drawn content around it is in a muted table row
 * (`DataTableProps.isRowMuted`): a cell's own components (ticker badges) read
 * it and draw muted and plain, as the row's text does.
 */
export function useDataTableRowMuted(): boolean {
  return useContext(MutedRowContext);
}

function MutedContent({ children }: { children: ReactNode }) {
  return <MutedRowContext value>{children}</MutedRowContext>;
}

type RenderCell<T, C extends DataTableColumn> = DataTableProps<T, C>["renderCell"];

/**
 * A table's cells with its muted rows (`isRowMuted`) drawn the one way: every
 * cell in `textMuted` and plain weight, its value colours included, and the
 * content a cell draws itself told to do the same. The selection still shows
 * on a muted row, which stays selectable.
 */
export function mutedRowCells<T, C extends DataTableColumn>(
  renderCell: RenderCell<T, C>,
  isRowMuted: DataTableProps<T, C>["isRowMuted"],
): RenderCell<T, C> {
  if (!isRowMuted) return renderCell;
  return (item, column, index, rowState) => {
    const cell = renderCell(item, column, index, rowState);
    if (!isRowMuted(item, index)) return cell;
    const muted: DataTableCell = {
      ...cell,
      // The selected row keeps the selection's text colour, so it reads on its fill.
      color: rowState.selected ? undefined : colors.textMuted,
      keepColorWhenSelected: false,
      attributes: (cell.attributes ?? 0) & ~TextAttributes.BOLD,
    };
    if (cell.content !== undefined) muted.content = <MutedContent>{cell.content}</MutedContent>;
    return muted;
  };
}
