/**
 * Help > Functions: every typed prefix the bar understands, as a table.
 *
 * The list is long and the job is scanning one column, so the prefix, its
 * argument and the description get their own columns. The prefix keeps its
 * badge, which is how the command bar draws it too.
 */
import { useCallback, useMemo, useState } from "react";
import {
  buildSectionedRows,
  DataTableView,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  QueryBar,
  renderSectionedRowHeader,
  type DataTableCell,
  type DataTableColumn,
  type SectionedRow,
} from "../../../components";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { useUiCapabilities } from "../../../ui";
import { groupShortcutEntries, type HelpShortcutEntry } from "./shortcut-model";
import { badgeCell, badgeColumnWidth, helpRowLines, helpTextWidth, type HelpRowLine } from "./table-cells";

type FunctionsColumnId = "prefix" | "argument" | "description";
type FunctionsColumn = DataTableColumn & { id: FunctionsColumnId };

interface FunctionEntry {
  id: string;
  prefix: string[];
  argument: string;
  description: string;
  /** The terminal's line of the row this row draws (helpRowLines). */
  line?: HelpRowLine;
}

type FunctionsRow = SectionedRow<FunctionEntry>;

/** A row's first line, the one the cursor stops on. */
function isFunctionRow(row: FunctionsRow): row is { kind: "item"; key: string; item: FunctionEntry } {
  return isSectionedItemRow(row) && !row.item.line?.continued;
}

/** Below this the argument folds away and the description takes the room. */
const ARGUMENT_COLUMN_MIN_TABLE_WIDTH = 64;

/**
 * Entry badges are `[prefix]` or `[prefix, <arg>]`; the argument is the one
 * wrapped in angle brackets.
 */
function splitEntryBadges(badges: readonly string[]): { prefix: string[]; argument: string } {
  const argument = badges.find((badge) => badge.startsWith("<")) ?? "";
  return { prefix: badges.filter((badge) => badge !== argument), argument };
}

function toEntries(entries: HelpShortcutEntry[], namespace: string): FunctionEntry[] {
  return entries.map((entry) => ({
    id: `${namespace}:${entry.id}`,
    ...splitEntryBadges(entry.badges),
    description: entry.description,
  }));
}

/** Matches the typed text against FN, ARG and OPENS, as the user reads them. */
function matchesQuery(entry: FunctionEntry, needle: string): boolean {
  if (!needle) return true;
  return [entry.prefix.join(" "), entry.argument, t(entry.description)]
    .some((text) => text.toLowerCase().includes(needle));
}

export function FunctionsTable({
  commandShortcuts,
  windowTemplates,
  focused,
  width,
  height,
  searching,
  onSearchingChange,
  onRunPrefix,
}: {
  commandShortcuts: HelpShortcutEntry[];
  windowTemplates: HelpShortcutEntry[];
  focused: boolean;
  width: number;
  height: number;
  /** The search field owns the keyboard; the pane's own keys stand down. */
  searching: boolean;
  onSearchingChange: (searching: boolean) => void;
  /** Opens the command bar on the prefix, so a row is one Enter from running. */
  onRunPrefix: (prefix: string) => void;
}) {
  const colors = useThemeColors();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = useMemo<FunctionsRow[]>(() => {
    // Commands and pane templates can share a category; one section per name
    // keeps the section keys unique, so a filtered list drops its old headers.
    const sections = new Map<string, FunctionEntry[]>();
    const add = (entries: HelpShortcutEntry[], namespace: string) => {
      for (const group of groupShortcutEntries(entries)) {
        sections.set(group.title, [...(sections.get(group.title) ?? []), ...toEntries(group.entries, namespace)]);
      }
    };
    add(commandShortcuts, "command");
    add(windowTemplates, "template");
    return buildSectionedRows<FunctionEntry>(
      [...sections]
        .map(([label, items]) => ({ label, items: items.filter((entry) => matchesQuery(entry, needle)) }))
        .filter((section) => section.items.length > 0),
      (entry) => entry.id,
    );
  }, [commandShortcuts, needle, windowTemplates]);

  const entries = useMemo(() => rows.filter(isSectionedItemRow).map((row) => row.item), [rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveSelectedId = entries.some((entry) => entry.id === selectedId)
    ? selectedId
    : entries[0]?.id ?? null;

  const showArgument = width >= ARGUMENT_COLUMN_MIN_TABLE_WIDTH;
  const prefixWidth = useMemo(() => badgeColumnWidth(entries.map((entry) => entry.prefix), { min: 8, max: 16 }), [entries]);
  const argumentWidth = useMemo(
    () => badgeColumnWidth(entries.map((entry) => (entry.argument ? [entry.argument] : [])), { min: 8, max: 18 }),
    [entries],
  );
  const columns = useMemo<FunctionsColumn[]>(() => [
    { id: "prefix", label: "FN", width: prefixWidth, align: "left" },
    ...(showArgument
      ? [{ id: "argument" as const, label: "ARG", width: argumentWidth, align: "left" as const }]
      : []),
    { id: "description", label: "OPENS", width: 20, align: "left", flexGrow: 1 },
  ], [argumentWidth, prefixWidth, showArgument]);
  const { nativePaneChrome } = useUiCapabilities();
  // The terminal goes on under a row rather than cutting its argument or what it opens; the desktop lays it out in CSS.
  const displayRows = useMemo<FunctionsRow[]>(() => {
    if (nativePaneChrome) return rows;
    const descriptionWidth = helpTextWidth(width, prefixWidth + (showArgument ? argumentWidth + 1 : 0), 1);
    return rows.flatMap((row): FunctionsRow[] => (isSectionedItemRow(row)
      ? helpRowLines(row.item.prefix, t(row.item.description), prefixWidth, descriptionWidth,
        showArgument ? { text: row.item.argument, width: argumentWidth } : undefined).map((line, index) => ({
        kind: "item",
        key: index === 0 ? row.key : `${row.key}~${index}`,
        item: { ...row.item, line },
      }))
      : [row]));
  }, [argumentWidth, nativePaneChrome, prefixWidth, rows, showArgument, width]);

  const renderCell = useCallback((
    row: FunctionsRow,
    column: FunctionsColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const { line } = row.item;
    const selected = rowState.selected || (line?.continued === true && row.item.id === effectiveSelectedId);
    if (column.id === "prefix") {
      const badges = line ? line.badges : row.item.prefix;
      return badges.length > 0 ? badgeCell(badges, column.width) : EMPTY_TABLE_CELL;
    }
    if (column.id === "argument") {
      const argument = line ? line.middle ?? "" : row.item.argument;
      return argument
        ? { text: argument, color: colors.textMuted }
        : EMPTY_TABLE_CELL;
    }
    return {
      text: line ? line.text : t(row.item.description),
      color: selected ? colors.selectedText : colors.text,
    };
  }, [colors, effectiveSelectedId]);

  return (
    <DataTableView<FunctionsRow, FunctionsColumn>
      focused={focused && !searching}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: ["function or description", "search functions"],
            focused,
            active: searching,
            onActiveChange: onSearchingChange,
          }}
        />
      )}
      columns={columns}
      items={displayRows}
      selection={{
        kind: "id",
        selectedId: effectiveSelectedId,
        getId: (row) => row.key,
        onChange: (_id, row) => {
          if (isSectionedItemRow(row)) setSelectedId(row.item.id);
        },
      }}
      isNavigable={isFunctionRow}
      // A row's lines under its first read as one row with it.
      getRowBackgroundColor={(row) => (isSectionedItemRow(row) && row.item.line?.continued && row.item.id === effectiveSelectedId ? colors.selected : undefined)}
      onActivate={(row) => {
        if (!isSectionedItemRow(row)) return;
        const prefix = row.item.prefix.join(" ");
        onRunPrefix(row.item.argument ? `${prefix} ` : prefix);
      }}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(row) => row.key}
      renderSectionHeader={renderSectionedRowHeader}
      renderCell={renderCell}
      emptyStateTitle={needle ? "No functions match." : "No command prefixes are registered."}
    />
  );
}
