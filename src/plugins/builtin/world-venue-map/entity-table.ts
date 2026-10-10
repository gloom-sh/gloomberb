/** The entity table: the layer's own columns fitted to the width, plus the linked ticker. */
import type { GeoColumn, GeoColumnFormat, GeoEntityRow } from "../../../api-client/geo";
import type { DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { columnValue, formatGeoValue, isChangeColumn, plainGeoValue } from "./layers";

export const TICKER_COLUMN_ID = "__ticker";

export type EntityColumn = DataTableColumn & {
  geo: GeoColumn | null;
};

const FORMAT_WIDTH: Record<GeoColumnFormat, number> = {
  text: 10,
  int: 6,
  decimal1: 6,
  percent1: 6,
  datetime: 7,
  knots: 7,
  km: 8,
};

const TICKER_WIDTH = 6;
const MIN_LABEL_WIDTH = 14;

/** A right-aligned text column is a code (an MMSI, an IMO number): kept only when there is room left. */
function isIdentifier(column: GeoColumn): boolean {
  return column.align === "right" && (column.format ?? "text") === "text";
}

/**
 * The label first and the ticker last, then the layer's columns in its order
 * while they fit, codes after everything else; a narrow pane keeps the label
 * and the ticker.
 */
export function entityColumns(columns: readonly GeoColumn[], width: number): EntityColumn[] {
  const [first, ...rest] = columns.length ? columns : [{ key: "label", label: "Name" } satisfies GeoColumn];
  const label: EntityColumn = { id: first!.key, label: first!.label, width: MIN_LABEL_WIDTH, flexGrow: 1, align: "left", geo: first! };
  const ticker: EntityColumn = { id: TICKER_COLUMN_ID, label: "Ticker", width: TICKER_WIDTH, align: "left", geo: null };
  const fits = (candidate: EntityColumn[]) => getTableWidth(candidate) <= width;
  const tail = fits([label, ticker]) ? [ticker] : [];
  const picked = new Set<GeoColumn>();
  const inOrder = () => rest.filter((column) => picked.has(column)).map((column): EntityColumn => ({
    id: column.key, label: column.label, width: FORMAT_WIDTH[column.format ?? "text"], align: column.align ?? "left", geo: column,
  }));
  for (const column of [...rest.filter((entry) => !isIdentifier(entry)), ...rest.filter(isIdentifier)]) {
    picked.add(column);
    if (!fits([label, ...inOrder(), ...tail])) picked.delete(column);
  }
  const middle = inOrder();
  const spare = Math.max(0, width - getTableWidth([label, ...middle, ...tail]));
  return [{ ...label, width: MIN_LABEL_WIDTH + spare }, ...middle, ...tail];
}

/** A cell's text and the plain value an export writes. */
export function entityCellText(row: GeoEntityRow, column: GeoColumn, now: number): { text: string; value: number | string | null } {
  const raw = columnValue(row, column);
  return { text: formatGeoValue(raw, column.format, now, isChangeColumn(column)), value: plainGeoValue(raw) };
}
