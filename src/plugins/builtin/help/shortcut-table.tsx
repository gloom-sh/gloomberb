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
import { Box, useUiCapabilities } from "../../../ui";
import { badgeCell, helpRowLines, helpTextWidth, type HelpRowLine } from "./table-cells";

export interface ShortcutTableEntry {
  id: string;
  badges: string[];
  description: string;
  /** Makes the row one click: anywhere on it runs this. */
  run?: () => void;
  /** The terminal's line of the row this row draws (helpRowLines). */
  line?: HelpRowLine;
}

type ShortcutColumn = DataTableColumn & { id: "key" | "description" };
type ShortcutRow = SectionedRow<ShortcutTableEntry>;

export function ShortcutTable({
  sections,
  width,
  keyWidth,
  height: fillHeight,
  after,
  keyLabel = "KEY",
  descriptionLabel = "DOES",
}: {
  sections: ReadonlyArray<TableSection<ShortcutTableEntry>>;
  /** Content width available inside the tab body. */
  width: number;
  /** The key column's width, one for every table in Help so their descriptions line up. */
  keyWidth: number;
  /** Fill this many rows and scroll, instead of growing to fit every row. */
  height?: number;
  /** Sits under a full-height table inside the same frame. */
  after?: ReactNode;
  keyLabel?: string;
  descriptionLabel?: string;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const rows = useMemo<ShortcutRow[]>(() => {
    const built = buildSectionedRows(sections, (entry) => entry.id);
    // The desktop and the web lay a row out in CSS; the terminal goes on under it rather than cutting.
    if (nativePaneChrome) return built;
    const textWidth = helpTextWidth(width, keyWidth, fillHeight === undefined ? 0 : 1);
    return built.flatMap((row): ShortcutRow[] => (isSectionedItemRow(row)
      ? helpRowLines(row.item.badges, t(row.item.description), keyWidth, textWidth).map((line, index) => ({
        kind: "item",
        key: index === 0 ? row.key : `${row.key}~${index}`,
        item: { ...row.item, line },
      }))
      : [row]));
  }, [fillHeight, keyWidth, nativePaneChrome, sections, width]);
  const columns = useMemo<ShortcutColumn[]>(() => [
    { id: "key", label: keyLabel, width: keyWidth, align: "left" },
    { id: "description", label: descriptionLabel, width: 20, align: "left", flexGrow: 1 },
  ], [descriptionLabel, keyLabel, keyWidth]);

  const renderCell = useCallback((row: ShortcutRow, column: ShortcutColumn): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const run = row.item.run;
    const { line } = row.item;
    const cell: DataTableCell = column.id === "key"
      ? badgeCell(line ? line.badges : row.item.badges, column.width, { wholeOnly: true })
      : { text: line ? line.text : t(row.item.description), color: colors.text };
    if (!run) return cell;
    return {
      ...cell,
      onMouseDown: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        run();
      },
    };
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
    <Box flexDirection="column" height={nativePaneChrome ? undefined : height}>
      <DataTableView<ShortcutRow, ShortcutColumn>
        columns={columns}
        items={rows}
        selection={{ kind: "none" }}
        rootWidth={width}
        rootHeight={height}
        // The tab body owns the gutter, so the table does not add its own.
        horizontalPadding={0}
        virtualize={false}
        fitRows
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
