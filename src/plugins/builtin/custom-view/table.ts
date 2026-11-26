/**
 * How a view's table draws its source's rows: the text of each cell, from
 * the spec's transform or the source's own format, and how wide each column
 * is set (docs/pane-conventions.md, "Columns in a narrow pane"): codes and
 * figures as wide as what they hold, the columns of names and sentences set
 * to grow with the pane.
 */

import type { DataTableColumn } from "../../../components/ui/data-table/types";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { displayWidth } from "../../../utils/format";
import { formatViewValue, type ViewColumn, type ViewRow, type ViewSpec, type ViewTransform } from "./view-spec";

/** A view's column before it is sized: what heads it and draws its cells. */
interface ViewCellColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** The width the spec set, which the table keeps whatever the cells hold. */
  width?: number;
  transform?: ViewTransform;
  /** The source's own column for the key, whose format draws its cells; absent for a key the source lists no column for. */
  source?: HeadlessPaneColumn;
}

export type ViewTableColumn = DataTableColumn & Pick<ViewCellColumn, "key" | "transform" | "source">;

const ROW_SOURCE = Symbol("view row source");

/**
 * How the source drew one row's cells, where the view's columns cannot say
 * it: a bundle's sections each format their own keys, and two sections can
 * format one key apart; an entry carries its value's text already formatted.
 */
interface ViewRowSource {
  columns: ReadonlyMap<string, HeadlessPaneColumn>;
  /** Cell text the source wrote itself, by key. */
  text?: Readonly<Record<string, string>>;
}

type SourcedRow = ViewRow & { [ROW_SOURCE]?: ViewRowSource };

/**
 * Tags `row` with the columns and text its source drew it with. A symbol key
 * is no row key: filters, sorts, the source's key list and exports never see
 * it, and the copy a live quote makes of the row keeps it.
 */
export function withViewRowSource(row: ViewRow, source: ViewRowSource): ViewRow {
  (row as SourcedRow)[ROW_SOURCE] = source;
  return row;
}

/** The spec's columns, or the source's when it names none, with their source column and the header, alignment and width the spec set. */
export function viewCellColumns(spec: ViewSpec, columns: readonly HeadlessPaneColumn[]): ViewCellColumn[] {
  const known = new Map(columns.map((column) => [column.key, column]));
  const picked: ViewColumn[] = spec.projection.columns.length > 0 ? spec.projection.columns : columns.map((column) => ({ key: column.key }));
  return picked.map((column) => {
    const source = known.get(column.key);
    const align = column.align ?? source?.align;
    return {
      key: column.key,
      label: column.label ?? source?.header ?? column.key,
      // Center reads as left in a table; a column neither aligns is aligned by what it holds (sizeViewColumns).
      ...(align ? { align: align === "right" ? "right" as const : "left" as const } : {}),
      ...(column.width !== undefined ? { width: column.width } : {}),
      ...(column.transform ? { transform: column.transform } : {}),
      ...(source ? { source } : {}),
    };
  });
}

/** A source format's text, or null where it has none to give: none set, an empty cell for a value it prints elsewhere, or a row it cannot read. */
function formattedText(format: HeadlessPaneColumn["format"], value: unknown, row: ViewRow): string | null {
  if (!format) return null;
  let text: string;
  try {
    text = format(value, row);
  } catch {
    // Intentional ignore: a source's format written for its own rows that cannot read a live or flattened one shows the plain value.
    return null;
  }
  // A report that prints a value under its row (a story's link) leaves its column blank; a view shows it.
  return text === "" && value != null && value !== "" ? null : text;
}

/**
 * A cell's text: the spec's transform when the column names one, else the
 * text the source draws the value with (the row's own section's format where
 * it has one, the text report's before the export's), else the plain value.
 * `base` and `decimals` are formatViewValue's.
 */
export function viewCellText(row: ViewRow, column: Pick<ViewCellColumn, "key" | "transform" | "source">, base?: number, decimals?: number): string {
  const value = row[column.key];
  if (!column.transform) {
    const own = (row as SourcedRow)[ROW_SOURCE];
    const written = own?.text?.[column.key];
    if (written !== undefined) return written;
    // A row with columns of its own never takes another section's format for a key they leave out.
    const source = own ? own.columns.get(column.key) : column.source;
    const text = source ? formattedText(source.textFormat, value, row) ?? formattedText(source.format, value, row) : null;
    if (text !== null) return text;
  }
  return formatViewValue(value, column.transform, base, decimals);
}

/**
 * The number a cell exports, for a column that shows it in its own unit:
 * CSV and `fn VIEW` keep the source's figure (123456789 for 123.46M) rather
 * than read it back from the text. A percent, an absolute value or an index
 * shows another number, which exports as it reads.
 */
export function viewCellExportValue(row: ViewRow, column: Pick<ViewCellColumn, "key" | "transform">): number | undefined {
  const value = row[column.key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return column.transform === undefined || column.transform === "raw" || column.transform === "compact" ? value : undefined;
}

/** Text no wider than this is a code, whatever it says: a ticker, a currency, an exchange, a short date. */
const CODE_WIDTH = 12;
/** The widest a column of names or sentences is set; past it, it takes what the pane has spare. */
const TEXT_WIDTH = 40;
/** The widest a column of codes or figures is set, so one odd value cannot take the pane. */
const FIGURE_WIDTH = 32;
/** The rows a column is measured on; a longer list is read that far. */
const MEASURED_ROWS = 500;

/** Most of what the cells say is letters: names and sentences, not dates, times or numbers with a unit. */
function isWording(texts: readonly string[]): boolean {
  let letters = 0;
  let characters = 0;
  for (const text of texts) {
    for (const character of text) {
      if (/\s/.test(character)) continue;
      characters += 1;
      if (/\p{L}/u.test(character)) letters += 1;
    }
  }
  return characters > 0 && letters * 2 >= characters;
}

/**
 * Sets each column's width from what it holds on `rows`, the source's rows
 * as loaded, so a live tick never moves a column. A column of numbers is
 * right-aligned unless the spec or source aligns it; it and a column of
 * codes are as wide as their widest text, a cell more for a figure that
 * streams (`live`), whose next tick can be a digit longer. A column of names
 * or sentences (the source's `shrink`, or text longer than a code that is
 * mostly letters) is set to its widest text up to TEXT_WIDTH and grows with
 * the pane, so a name gets the pane's spare width and a ticker does not. A
 * width the spec set is kept.
 */
export function sizeViewColumns(
  columns: readonly ViewCellColumn[],
  rows: readonly ViewRow[],
  text: (row: ViewRow, column: ViewCellColumn) => string,
  live: ReadonlySet<string> = new Set(),
): ViewTableColumn[] {
  const measured = rows.length > MEASURED_ROWS ? rows.slice(0, MEASURED_ROWS) : rows;
  return columns.map((column) => {
    const texts = measured.map((row) => text(row, column));
    const widest = texts.reduce((most, cell) => Math.max(most, displayWidth(cell)), 0);
    const values = measured.map((row) => row[column.key]).filter((value) => value !== null && value !== undefined && value !== "");
    const numeric = values.length > 0 && values.every((value) => typeof value === "number");
    const wording = !numeric && column.source?.shrink !== false
      && (column.source?.shrink === true || (widest > CODE_WIDTH && isWording(texts)));
    const width = column.width
      ?? (wording ? Math.min(widest, TEXT_WIDTH) : Math.min(widest + (numeric && live.has(column.key) ? 1 : 0), FIGURE_WIDTH));
    return {
      id: column.key,
      key: column.key,
      label: column.label,
      align: column.align ?? (numeric ? "right" : "left"),
      width: Math.max(1, width),
      ...(wording ? { flexGrow: 1 } : {}),
      ...(column.transform ? { transform: column.transform } : {}),
      ...(column.source ? { source: column.source } : {}),
    };
  });
}
