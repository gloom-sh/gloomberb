import type { CommandBarResultLine } from "../../../types/plugin";
import {
  buildSections,
  type CommandBarCategoryPriorities,
  type CommandBarSectionOptions,
  type CommandBarSectionOrder,
} from "../view-model";

/**
 * A row stays scannable next to its neighbours, so a snippet gets two rows at
 * most however many lines a provider hands over.
 */
const MAX_RESULT_ITEM_LINES = 2;

export interface ResultItem {
  id: string;
  label: string;
  detail: string;
  category: string;
  kind: "command" | "ticker" | "search" | "plugin" | "action" | "info";
  /** Extra rows under the label, e.g. a matched snippet from a search provider. */
  lines?: CommandBarResultLine[];
  /** Short tag drawn left of the label: a shortcut, an asset class, a document type. */
  badge?: string;
  right?: string;
  shortcutQuery?: string;
  searchText?: string;
  /** Tints the trailing marker and the section heading with the AI accent. */
  accent?: boolean;
  /**
   * Set false for rows that answer nothing on their own — a placeholder, or an
   * offer the user never asked for. The list skips them when it picks the
   * selection for an untouched query, so plain Enter always runs a real match.
   */
  defaultSelectable?: boolean;
  secondaryAction?: () => void | Promise<void>;
  checked?: boolean;
  current?: boolean;
  disabled?: boolean;
  action: () => void | Promise<void>;
}

type ListScreenKind = "root" | "mode" | "picker" | "pane-settings";

export interface ListScreenState {
  kind: ListScreenKind;
  title: string;
  subtitle?: string;
  query: string;
  selectedIdx: number;
  hoveredIdx: number | null;
  results: ResultItem[];
  searching: boolean;
  emptyLabel: string;
  emptyDetail: string;
  footerLeft: string;
  footerRight: string;
  sectionOrder?: CommandBarSectionOrder;
  categoryPriorities?: CommandBarCategoryPriorities;
}

export type CommandBarListRow =
  | { kind: "spacer"; id: string }
  | { kind: "heading"; id: string; label: string; accent?: boolean }
  | { kind: "item"; item: ResultItem; globalIdx: number }
  | { kind: "message"; id: string; label: string; dim?: boolean }
  | { kind: "spinner"; id: string; label: string }
  | { kind: "filler"; id: string };

export function orderListResults(
  results: ResultItem[],
  options?: CommandBarSectionOptions,
): ResultItem[] {
  return buildSections(results, options).flatMap((section) => section.items);
}

export function buildListRows(listState: ListScreenState): CommandBarListRow[] {
  const rows: CommandBarListRow[] = [];
  const sections = buildSections(listState.results, {
    sectionOrder: listState.sectionOrder,
    categoryPriorities: listState.categoryPriorities,
  });
  let globalIdx = 0;
  sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) {
      rows.push({ kind: "spacer", id: `spacer:${sectionIndex}:${section.category}` });
    }
    rows.push({
      kind: "heading",
      id: `heading:${sectionIndex}:${section.category}`,
      label: section.category,
      accent: section.items.some((item) => item.accent),
    });
    for (const item of section.items) {
      rows.push({ kind: "item", item, globalIdx });
      globalIdx += 1;
    }
  });
  return rows;
}

export function getResultItemLines(item: ResultItem): CommandBarResultLine[] {
  const lines = item.lines;
  if (!lines || lines.length === 0) return [];
  return lines.length > MAX_RESULT_ITEM_LINES ? lines.slice(0, MAX_RESULT_ITEM_LINES) : lines;
}

/** Terminal rows the list spends on one entry; every row but an item is one line. */
function getListRowHeight(row: CommandBarListRow): number {
  return row.kind === "item" ? 1 + getResultItemLines(row.item).length : 1;
}

export function getListRowsHeight(rows: readonly CommandBarListRow[]): number {
  return rows.reduce((total, row) => total + getListRowHeight(row), 0);
}

/**
 * Line the list has to scroll to for the selected row to be fully visible.
 *
 * The scroll box works in lines and takes a single target, which is enough to
 * pull one line into view from either edge but not a whole multi-line row. So
 * the target follows the direction of travel: moving down aims at the row's last
 * line, which lands its snippet just inside the bottom edge, and anything else
 * aims at its first line. Returns -1 when nothing is selected.
 */
export function resolveSelectedScrollLine(
  rows: readonly CommandBarListRow[],
  selectedRowIndex: number,
  movedDown: boolean,
): number {
  const selectedRow = rows[selectedRowIndex];
  if (!selectedRow) return -1;
  let line = 0;
  for (let index = 0; index < selectedRowIndex; index += 1) {
    line += getListRowHeight(rows[index]!);
  }
  return movedDown ? line + getListRowHeight(selectedRow) - 1 : line;
}

export function buildNativeListRows(listState: ListScreenState, rows: CommandBarListRow[]): CommandBarListRow[] {
  if (listState.searching && rows.length === 0) {
    return [{ kind: "spinner", id: "searching", label: "Searching…" }];
  }
  if (rows.length === 0) {
    return [{ kind: "message", id: "empty", label: listState.emptyLabel }];
  }
  if (listState.searching) {
    return [...rows, { kind: "spinner", id: "searching", label: "Searching…" }];
  }
  return rows;
}
