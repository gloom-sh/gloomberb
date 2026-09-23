import type { Quote } from "../../../types/financials";
import type { HeadlessPaneColumn } from "../../../types/headless";
import type { ViewRow } from "./view-spec";

export type LiveViewField = "price" | "changePercent" | "volume";

/** Rows a view streams at most; the rest keep the values they loaded with. */
export const LIVE_VIEW_ROW_LIMIT = 100;

/**
 * Columns a data function serializes as a listing's own last price, day change
 * in percent, or day volume, named the same way everywhere they appear
 * (movers, sectors, quote, peers). Matching on both key and header keeps out
 * look-alikes such as an entry price, a clean bond price, a basis-point change
 * or a change in some other unit.
 */
const LIVE_VIEW_COLUMNS: ReadonlyArray<{ key: string; headers: readonly string[]; field: LiveViewField }> = [
  { key: "price", headers: ["Last"], field: "price" },
  { key: "changePercent", headers: ["Change %", "1D"], field: "changePercent" },
  { key: "volume", headers: ["Volume"], field: "volume" },
];

export function liveViewColumns(columns: readonly HeadlessPaneColumn[]): Map<string, LiveViewField> {
  const fields = new Map<string, LiveViewField>();
  for (const column of columns) {
    const match = LIVE_VIEW_COLUMNS.find((candidate) => (
      candidate.key === column.key && candidate.headers.includes(column.header)
    ));
    if (match) fields.set(column.key, match.field);
  }
  return fields;
}

export function viewRowSymbol(row: ViewRow, symbolKey: string | null): string | null {
  if (!symbolKey) return null;
  const value = row[symbolKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The row with its live columns taken from the quote. A stale quote, or one in
 * another currency than the row reports, leaves the row as loaded.
 */
export function overlayViewRow(row: ViewRow, quote: Quote | null | undefined, fields: ReadonlyMap<string, LiveViewField>): ViewRow {
  if (!quote || quote.stale || fields.size === 0 || !(quote.price > 0) || !Number.isFinite(quote.price)) return row;
  const rowCurrency = typeof row.currency === "string" ? row.currency.trim() : "";
  if (rowCurrency && quote.currency && rowCurrency !== quote.currency) return row;
  let next: ViewRow | null = null;
  for (const [key, field] of fields) {
    const value = field === "price" ? quote.price : field === "changePercent" ? quote.changePercent : quote.volume;
    if (value == null || !Number.isFinite(value) || row[key] === value) continue;
    next ??= { ...row };
    next[key] = value;
  }
  return next ?? row;
}
