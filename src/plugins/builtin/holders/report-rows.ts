import type { HeadlessPaneColumn } from "../../../types/plugin";
import type { HolderData, ShareBasis } from "../../../types/financials";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import {
  displayDate,
  formatMoneyCompact,
  formatPercentHeld,
  formatSignedCompact,
  holderPercent,
  holderValueCurrency,
  resolveHolderOwnershipPercent,
} from "./format";
import {
  holderListPeriod,
  holderPeriodsDiffer,
  holderShareBasisMarker,
  holderShareBasisNote,
  holderValueBasis,
  holdersHeaderLine,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "./report-header";
import { buildRows, DEFAULT_SORT, sortRows } from "./table-model";
import type { HolderColumnId, SortPreference } from "./types";

/**
 * A holder as `holders` and `fn HDS` report it; the keys are the JSON
 * contract. `value` is in `currency`, the values' own currency; the percents
 * are in percent (0.59 is 0.59% of the shares outstanding, 13.15 a 13.15%
 * change on the quarter). A figure the source did not give is null.
 */
export interface HolderReportRow {
  name: string;
  ownerType: string;
  value: number | null;
  shares: number | null;
  changeShares: number | null;
  changePercent: number | null;
  percentHeld: number | null;
  reportDate: string | null;
  currency: string;
  shareBasis: ShareBasis | null;
  [key: string]: unknown;
}

/** Columns a source fills only when it reports the quarter's change. */
const CHANGE_COLUMN_KEYS = new Set(["changeShares", "changePercent"]);
/** Shown only when some row is held as depositary receipts, as on a home line abroad. */
const BASIS_COLUMN_KEY = "shareBasis";
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The HDS report's columns, which `holders --csv` and `--json` share. CSV
 * reads `format`, so a value drawn as a plain figure exports its full number
 * under a header naming the unit (`Mkt value (USD)`, `Held (%)`); the text
 * report draws `textFormat`, with the currency sign and `<0.01%`.
 */
export const HOLDER_REPORT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Holder" },
  { key: "ownerType", header: "Type" },
  {
    key: "value",
    header: "Mkt value",
    align: "right",
    format: (value) => num(value) == null ? "-" : formatCompact(num(value)!),
    textFormat: (value, row) => formatMoneyCompact(num(value) ?? undefined, String(row.currency ?? "USD")),
  },
  {
    key: "shares",
    header: "Amount",
    align: "right",
    format: (value) => num(value) == null ? "-" : formatCompact(num(value)!),
  },
  {
    key: BASIS_COLUMN_KEY,
    header: "Basis",
    format: (_value, row) => holderShareBasisMarker(row),
  },
  {
    key: "changeShares",
    header: "Chg",
    align: "right",
    format: (value) => formatSignedCompact(num(value) ?? undefined),
  },
  {
    key: "changePercent",
    header: "Chg%",
    align: "right",
    format: (value) => num(value) == null ? "-" : formatPercentRaw(num(value)!),
  },
  {
    key: "percentHeld",
    header: "Held",
    align: "right",
    format: (value) => num(value) == null ? "-" : `${num(value)!.toFixed(2)}%`,
    textFormat: (value) => formatPercentHeld(num(value)),
  },
  {
    key: "reportDate",
    header: "Period",
    format: (value) => displayDate(typeof value === "string" ? value : undefined),
  },
];

/** `--sort` values, the same for `holders` and `fn HDS`. */
export const HOLDER_SORT_KEYS: Record<string, HolderColumnId> = {
  holder: "holder",
  value: "value",
  shares: "shares",
  change: "changeShares",
  "change-percent": "changePercent",
  held: "percentHeld",
  date: "reportDate",
};

/**
 * Every holder of the list, largest value first unless another sort is
 * asked for, with the stake and change in percent. A holder without a value
 * sorts after those with one, whichever the direction. `ownerTypes` keeps
 * only those kinds (`insider`, `13f`).
 */
export function holderReportRows(
  data: HolderData,
  {
    marketCap,
    sort = DEFAULT_SORT,
    ownerTypes,
  }: { marketCap?: number; sort?: SortPreference; ownerTypes?: ReadonlySet<string> } = {},
): HolderReportRow[] {
  const holders = ownerTypes ? data.holders.filter((holder) => ownerTypes.has(holder.ownerType)) : data.holders;
  // The values' own currency: dollars from the 13F filings on a London line.
  const currency = holderValueCurrency(data, "USD")!;
  return sortRows(buildRows({ ...data, holders }), sort, marketCap).map((row) => ({
    name: row.name,
    ownerType: row.ownerType,
    value: row.value ?? null,
    shares: row.shares ?? null,
    changeShares: row.changeShares ?? null,
    changePercent: holderPercent(row.changePercent),
    percentHeld: holderPercent(resolveHolderOwnershipPercent(row, marketCap)),
    reportDate: row.reportDate ?? null,
    currency,
    shareBasis: row.shareBasis ?? null,
  }));
}

/** The report dates of the rows, newest first: one when the list is of one quarter. */
export function holderReportDates(rows: readonly HolderReportRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.reportDate ? [row.reportDate] : []))].sort().reverse();
}

/** What the JSON rows' numbers are in, for `metadata.units`. */
export function holderReportUnits(valueCurrency: string): Record<string, string> {
  return { value: valueCurrency, changePercent: "%", percentHeld: "%" };
}

/** Whether any holder carries the quarter's change; many sources report none. */
function holderChangeReported(rows: readonly HolderReportRow[]): boolean {
  return rows.some((row) => row.changeShares != null || row.changePercent != null);
}

/**
 * The report's columns for these rows: the change columns only when a row
 * has a change, the basis column only when a row is held as receipts, and
 * the value column named with its currency.
 */
export function holderReportColumns(rows: readonly HolderReportRow[], valueCurrency: string | null | undefined): HeadlessPaneColumn[] {
  const changeReported = holderChangeReported(rows);
  const marked = rows.some((row) => holderShareBasisMarker(row));
  return HOLDER_REPORT_COLUMNS
    .filter((column) => changeReported || !CHANGE_COLUMN_KEYS.has(column.key))
    .filter((column) => marked || column.key !== BASIS_COLUMN_KEY)
    .map((column) => column.key === "value" ? { ...column, header: moneyColumnHeader(column.header, valueCurrency) } : column);
}

/**
 * The lines above the HDS table, which `holders --csv` also closes with: the
 * listing, unit and count, how a value was reached (and where the change is
 * when the source gives none), and what the positions and shares are.
 */
export function holderReportNotices({
  data,
  requested,
  shown,
  reported,
  total,
  sort = DEFAULT_SORT,
}: {
  data: HolderData;
  /** The symbol as asked for, which `fn 13F` takes. */
  requested: string;
  shown: readonly HolderReportRow[];
  /** Holders on the list before a limit. */
  reported: number;
  total: number | null;
  sort?: SortPreference;
}): { notices: string[]; valueBasis: string; positionsBasis: string | null; changeReported: boolean } {
  const valueCurrency = holderValueCurrency(data, "USD")!;
  const changeReported = holderChangeReported(shown);
  const valueBasis = holderValueBasis(sharedReportDate(shown), data.valueBasis, valueCurrency);
  const positionsBasis = shown.length > 0 ? nonUsHolderCaveat(data.exchange, data.currency ?? "USD") : null;
  // The title names the ticker and the closing line carries the as-of date,
  // which is one date only when every row has it.
  const header = holdersHeaderLine({
    name: data.name,
    symbol: data.symbol && data.symbol !== requested ? data.symbol : null,
    exchange: data.exchange,
    currency: valueCurrency,
    listingCurrency: data.currency,
    period: holderPeriodsDiffer(shown) ? holderListPeriod(shown) : null,
    shown: shown.length,
    reported,
    total,
    ranked: !positionsBasis,
  });
  const basis = shown.length === 0 ? null : [
    `Mkt value = ${valueBasis}.`,
    changeReported ? "" : `Change vs prior quarter: not reported by this source; see fn 13F ${requested}`,
  ].filter(Boolean).join(" ");
  return {
    notices: [header, basis, positionsBasis, holderShareBasisNote(data, shown), unvaluedHoldersNote(shown, sort)]
      .filter((line): line is string => !!line),
    valueBasis,
    positionsBasis,
    changeReported,
  };
}

/**
 * Holders the list gives no value for (a home line's position its filing
 * could not tie to a priced security) sort after every valued one, and a
 * value-ordered report says so rather than ranking them silently.
 */
export function unvaluedHoldersNote(rows: readonly HolderReportRow[], sort: SortPreference = DEFAULT_SORT): string | null {
  if (sort.columnId !== "value") return null;
  const unvalued = rows.filter((row) => row.value == null).length;
  if (unvalued === 0 || unvalued === rows.length) return null;
  return `${unvalued} ${unvalued === 1 ? "holder has" : "holders have"} no value and ${unvalued === 1 ? "is" : "are"} listed last.`;
}
