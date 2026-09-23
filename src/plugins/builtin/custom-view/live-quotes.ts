import { resolveEntryValue } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { normalizeSymbol } from "../../../utils/exchanges";
import type { ViewRow } from "./view-spec";

export type LiveViewField = "price" | "changePercent" | "volume";

/** Symbols a view streams at most, nearest the screen first. */
export const LIVE_VIEW_ROW_LIMIT = 100;

export interface ViewRowRange {
  start: number;
  /** Exclusive. */
  end: number;
}

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
 * The shared store's quote for a row, if it arrived after the view loaded. A
 * row scrolled out of the stream keeps its last live value this way, while a
 * quote older than the view's own reload is not newer than the row.
 */
export function viewRowQuote(entry: QueryEntry<Quote> | null | undefined, loadedAt: number | null): Quote | null {
  if (!entry || entry.fetchedAt == null) return null;
  if (loadedAt != null && entry.fetchedAt < loadedAt) return null;
  return resolveEntryValue(entry);
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

/**
 * What a view streams: the rows on screen and the cursor's row in the fast
 * lane, and about one more screen above and below in the background (about
 * once a second) so a short scroll lands on live values. Indexes are positions
 * in the displayed order. A symbol listed twice streams once.
 */
export function viewStreamTargets(
  symbols: readonly (string | null)[],
  range: ViewRowRange,
  selectedIndex: number,
): QuoteSubscriptionTarget[] {
  const count = symbols.length;
  const start = Math.min(count, Math.max(0, Math.floor(range.start)));
  const end = Math.min(count, Math.max(start, Math.floor(range.end)));
  const page = Math.max(1, end - start);
  const targets = new Map<string, QuoteSubscriptionTarget>();
  const add = (index: number, visible: boolean) => {
    if (targets.size >= LIVE_VIEW_ROW_LIMIT || index < 0 || index >= count) return;
    const raw = symbols[index];
    const symbol = raw ? normalizeSymbol(raw) : "";
    if (!symbol || targets.has(symbol)) return;
    const selected = index === selectedIndex;
    targets.set(symbol, {
      symbol,
      exchange: "",
      surface: "screener",
      visible: visible || selected,
      ...(selected ? { selected: true } : {}),
      weight: selected ? 80 : visible ? 60 : 20,
    });
  };
  add(selectedIndex, true);
  for (let index = start; index < end; index += 1) add(index, true);
  for (let distance = 1; distance <= page; distance += 1) {
    add(end - 1 + distance, false);
    add(start - distance, false);
  }
  return [...targets.values()];
}
