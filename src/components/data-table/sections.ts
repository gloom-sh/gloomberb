/**
 * Grouped rows for a data table.
 *
 * The table renders a section header wherever `renderSectionHeader` returns
 * one, and skips those rows for selection and CSV export. Panes used to spell
 * that out with a local `{ kind: "header" } | { kind: "entry" }` union each
 * time (plugin marketplace, earnings, world indices, futures); this is the same
 * shape, once, with the header count the marketplace established.
 */
import type { DataTableCell } from "../ui";
import type { DataTableSectionHeader } from "../ui/data-table";

export interface TableSection<T> {
  label: string;
  /** Tells apart two sections under one label (a month split by today); the label by default. */
  key?: string;
  items: T[];
  /** Kept even with no items, to show the section exists. */
  emptyLabel?: string;
}

export type SectionedRow<T> =
  | { kind: "section"; key: string; label: string; count: number }
  | { kind: "item"; key: string; item: T }
  /** Stands in for an empty section, and is not selectable. */
  | { kind: "empty"; key: string; label: string };

export const EMPTY_TABLE_CELL: DataTableCell = { text: "" };

export function buildSectionedRows<T>(
  sections: ReadonlyArray<TableSection<T>>,
  getItemKey: (item: T) => string,
): Array<SectionedRow<T>> {
  return sections.flatMap((section) => {
    if (section.items.length === 0 && !section.emptyLabel) return [];
    return [
      { kind: "section" as const, key: `section:${section.key ?? section.label}`, label: section.label, count: section.items.length },
      ...(section.items.length === 0
        ? [{ kind: "empty" as const, key: `empty:${section.key ?? section.label}`, label: section.emptyLabel! }]
        : section.items.map((item) => ({ kind: "item" as const, key: getItemKey(item), item }))),
    ];
  });
}

/** Only real rows take the selection; headers and placeholders are skipped. */
export function isSectionedItemRow<T>(row: SectionedRow<T>): row is { kind: "item"; key: string; item: T } {
  return row.kind === "item";
}

export function renderSectionedRowHeader<T>(row: SectionedRow<T>): DataTableSectionHeader | null {
  return row.kind === "section" ? { text: `${row.label} (${row.count})` } : null;
}

/** Row count a section list needs when the table is embedded at a fixed height. */
export function sectionedRowsHeight<T>(rows: ReadonlyArray<SectionedRow<T>>, options?: { header?: boolean }): number {
  return rows.length + (options?.header === false ? 0 : 1);
}
