import type { PaneFooterSegment } from "../../../components";
import type { QueryBarSelectFilter } from "../../../components/ui/query-bar";
import { formatCompact } from "../../../utils/format";

/** No minimum: every row, with or without a float. */
export const ANY_FLOAT = "any";
/** The minimums the pane's menu offers; `--min-float` takes any other. */
const PRESETS = ["1M", "5M", "10M", "20M", "50M", "100M"] as const;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Shares in `text` (10M, 500k, 2.5M, 25000000), or null when it is not a share count. */
function parseShares(text: string): number | null {
  const match = /^((?:\d+(?:\.\d*)?|\.\d+))([kmb])?$/i.exec(text.trim().replace(/[_,]/g, ""));
  if (!match) return null;
  const value = Number(match[1]) * (match[2] ? SCALE[match[2].toLowerCase()]! : 1);
  return Number.isFinite(value) ? value : null;
}

/** The minimum a saved or typed value sets, in shares; null for none (`any`, 0 or a value that is not a count). */
export function minFloatShares(value: string | null | undefined): number | null {
  if (!value || value.trim().toLowerCase() === ANY_FLOAT) return null;
  const shares = parseShares(value);
  return shares != null && shares > 0 ? shares : null;
}

/** `--min-float` as the pane keeps it: `10M` for 10m or 10000000, `any` for none. Throws on a value that is not a share count. */
export function normalizeMinFloat(value: string): string {
  if (value.trim().toLowerCase() === ANY_FLOAT) return ANY_FLOAT;
  const shares = parseShares(value);
  if (shares == null) throw new Error(`--min-float takes a share count such as 10M or 500k, or any; got "${value}".`);
  return shares > 0 ? formatCompact(shares) : ANY_FLOAT;
}

/** A row passes with a float at or above the minimum; a row whose float is not known does not. */
export function meetsMinFloat(floatShares: number | null | undefined, minimum: number | null): boolean {
  return minimum == null || (floatShares != null && floatShares >= minimum);
}

/** The pane's Min float menu: Any and the presets, with a minimum set from the CLI kept as its own choice. */
export function minFloatFilter(value: string, onChange: (value: string) => void): QueryBarSelectFilter {
  const current = minFloatShares(value) == null ? ANY_FLOAT : value;
  const presets: string[] = [...PRESETS];
  const options = [ANY_FLOAT, ...(presets.includes(current) || current === ANY_FLOAT ? [] : [current]), ...presets]
    .map((option) => ({ value: option, label: option === ANY_FLOAT ? "Any" : option }));
  return {
    id: "min-float",
    label: "Min float",
    title: "Minimum float",
    value: current,
    defaultValue: ANY_FLOAT,
    options,
    onChange,
  };
}

/** What a list says under its Float column while a shown float is partial. */
export const PARTIAL_FLOAT_NOTE = "Float is partial: the source does not say when it measured it.";

/** Whether any row's float is partial, which the list then says once. */
export function hasPartialFloat(rows: readonly { floatShares?: number | null; floatSharesState?: string }[]): boolean {
  return rows.some((row) => row.floatShares != null && row.floatSharesState === "partial");
}

/** The footer's word for a FLOAT column of partial floats, or none. */
export function partialFloatFooter(shown: boolean, rows: readonly { floatShares?: number | null; floatSharesState?: string }[]): PaneFooterSegment[] {
  return shown && hasPartialFloat(rows)
    ? [{ id: "float-partial", parts: [{ text: "FLOAT", tone: "label" }, { text: "partial, undated", tone: "muted" }] }]
    : [];
}

/** The empty list's title while a minimum hides every row. */
export function minFloatEmptyTitle(value: string): string {
  return `No movers with a float of ${value} or more.`;
}
