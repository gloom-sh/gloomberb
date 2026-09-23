/**
 * A reference table of keys: badge, then what the key does.
 *
 * Used for the parts of Help that describe fixed keys rather than rebindable
 * ones. Without a `height` it is sized to its rows so it can sit inside the
 * scrolling tab body next to prose, the way other panes embed a short table;
 * with one it is the whole tab and scrolls itself, like Functions.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import {
  buildSectionedRows,
  DataTableView,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  renderSectionedRowHeader,
  sectionedRowsHeight,
  type DataTableCell,
  type DataTableColumn,
  type SectionedRow,
  type TableSection,
} from "../../../components";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { Box } from "../../../ui";
import { badgeCell, badgeColumnWidth } from "./table-cells";

export interface ShortcutTableEntry {
  id: string;
  badges: string[];
  description: string;
}

type ShortcutColumn = DataTableColumn & { id: "key" | "description" };
type ShortcutRow = SectionedRow<ShortcutTableEntry>;

export function ShortcutTable({
  sections,
  width,
  height: fillHeight,
  after,
  keyLabel = "KEY",
  descriptionLabel = "DOES",
}: {
  sections: ReadonlyArray<TableSection<ShortcutTableEntry>>;
  /** Content width available inside the tab body. */
  width: number;
  /** Fill this many rows and scroll, instead of growing to fit every row. */
  height?: number;
  /** Sits under a full-height table inside the same frame. */
  after?: ReactNode;
  keyLabel?: string;
  descriptionLabel?: string;
}) {
  const colors = useThemeColors();
  const rows = useMemo<ShortcutRow[]>(
    () => buildSectionedRows(sections, (entry) => entry.id),
    [sections],
  );
  const keyWidth = useMemo(
    () => badgeColumnWidth(rows.filter(isSectionedItemRow).map((row) => row.item.badges), { min: 8, max: 24 }),
    [rows],
  );
  const columns = useMemo<ShortcutColumn[]>(() => [
    { id: "key", label: keyLabel, width: keyWidth, align: "left" },
    { id: "description", label: descriptionLabel, width: 20, align: "left", flexGrow: 1 },
  ], [descriptionLabel, keyLabel, keyWidth]);

  const renderCell = useCallback((row: ShortcutRow, column: ShortcutColumn): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    if (column.id === "key") return badgeCell(row.item.badges, column.width);
    return { text: t(row.item.description), color: colors.text };
  }, [colors]);

  if (fillHeight !== undefined) {
    return (
      <DataTableView<ShortcutRow, ShortcutColumn>
        columns={columns}
        items={rows}
        selection={{ kind: "none" }}
        rootWidth={width}
        rootHeight={fillHeight}
        rootAfter={after}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.key}
        renderSectionHeader={renderSectionedRowHeader}
        renderCell={renderCell}
        emptyStateTitle="Nothing to show"
      />
    );
  }

  const height = sectionedRowsHeight(rows);

  return (
    <Box flexDirection="column" height={height}>
      <DataTableView<ShortcutRow, ShortcutColumn>
        columns={columns}
        items={rows}
        selection={{ kind: "none" }}
        rootWidth={width}
        rootHeight={height}
        // The tab body owns the gutter, so the table does not add its own.
        horizontalPadding={0}
        virtualize={false}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.key}
        renderSectionHeader={renderSectionedRowHeader}
        renderCell={renderCell}
        emptyStateTitle="Nothing to show"
      />
    </Box>
  );
}
