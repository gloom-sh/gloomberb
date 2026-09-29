import type { Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { FUTURES_SECTOR_ORDER, type FuturesContract, type FuturesSector } from "./contracts";
import type { FuturesReturnHorizon } from "./returns";
import type { FrontReturnsMap } from "./use-front-returns";

export type FuturesTableRow =
  | { type: "header"; sector: FuturesSector }
  | { type: "row"; contract: FuturesContract };

export type FuturesColumnId =
  | "status"
  | "code"
  | "name"
  | "price"
  | "change"
  | "changePercent"
  | "return1w"
  | "return1m"
  | "returnYtd"
  | "volume"
  | "prevClose"
  | "time";

export interface FuturesSortPreference {
  columnId: FuturesColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_FUTURES_SORT: FuturesSortPreference = {
  columnId: null,
  direction: "asc",
};

export function futuresRowId(row: FuturesTableRow): string {
  return row.type === "header" ? `header-${row.sector}` : row.contract.symbol;
}

const CONTRACT_MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -](\d{4}|\d{2})$/i;

/**
 * The alias stays the row identity while its quoted contract rolls, so the
 * label is the catalog name plus the quoted contract's month ("30-Year T-Bond
 * Dec 26"). Quote names arrive as "Crude Oil Nov 26", "Corn Futures,Dec-2026"
 * or cut off mid-month ("Futures,Dec-"); a month without a year is dropped
 * rather than guessed.
 */
export function futuresContractName(contract: FuturesContract, quote?: Quote | null): string {
  const month = quotedContractMonth(contract, quote);
  if (!month) return contract.name;
  return `${contract.name} ${MONTH_NAMES[month.month]} ${String(month.year).slice(-2)}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The delivery month the alias's quote names, month 0-11, or null when its name carries none. */
export function quotedContractMonth(
  contract: FuturesContract,
  quote?: Quote | null,
): { year: number; month: number } | null {
  if (quote?.symbol?.trim().toUpperCase() !== contract.symbol.toUpperCase()) return null;
  const match = CONTRACT_MONTH.exec(quote.name?.trim() ?? "");
  if (!match) return null;
  const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === match[1]!.toLowerCase());
  const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return { year, month };
}

function matchesFuturesSearch(contract: FuturesContract, query: string, quote?: Quote | null): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    contract.code.toLowerCase().includes(normalized)
    || contract.name.toLowerCase().includes(normalized)
    || futuresContractName(contract, quote).toLowerCase().includes(normalized)
    || contract.symbol.toLowerCase().includes(normalized)
  );
}

export const FUTURES_RETURN_COLUMNS: Readonly<Partial<Record<FuturesColumnId, FuturesReturnHorizon>>> = {
  return1w: "1W",
  return1m: "1M",
  returnYtd: "YTD",
};

function getSortValue(
  columnId: FuturesColumnId,
  contract: FuturesContract,
  quotes: BoardQuoteMap,
  returns?: FrontReturnsMap,
): string | number | null {
  const quote = quotes.get(contract.symbol)?.quote;
  switch (columnId) {
    case "status":
      return quote?.marketState === "REGULAR" ? 0 : 1;
    case "code":
      return contract.code;
    case "name":
      return futuresContractName(contract, quote);
    case "price":
      return quote?.price ?? null;
    case "change":
      return quote?.change ?? null;
    case "changePercent":
      return quote?.changePercent ?? null;
    case "return1w":
    case "return1m":
    case "returnYtd":
      return returns?.get(contract.symbol)?.values[FUTURES_RETURN_COLUMNS[columnId]!] ?? null;
    case "volume":
      return quote?.volume ?? null;
    case "prevClose":
      return quote?.previousClose ?? null;
    case "time":
      return quote?.lastUpdated ?? null;
  }
}

function sortContracts(
  contracts: FuturesContract[],
  sortPreference: FuturesSortPreference,
  quotes: BoardQuoteMap,
  returns?: FrontReturnsMap,
): FuturesContract[] {
  const columnId = sortPreference.columnId;
  if (!columnId) return contracts;
  return [...contracts].sort((left, right) => compareSortValues(
    getSortValue(columnId, left, quotes, returns),
    getSortValue(columnId, right, quotes, returns),
    sortPreference.direction,
  ));
}

export interface BuildFuturesRowsOptions {
  /** Free-text query matched against contract code, symbol, and name. */
  query?: string;
  /** Sectors whose contracts are hidden under their header. */
  collapsed?: ReadonlySet<FuturesSector>;
  /** Front-contract returns, for sorting on a returns column. */
  returns?: FrontReturnsMap;
}

const NO_COLLAPSED_SECTORS: ReadonlySet<FuturesSector> = new Set();

/**
 * A search that hides its own matches is useless, so a live query outranks
 * collapsed sectors. The pane draws its carets from this too, otherwise a
 * sector would show ▶ above the rows it is supposedly hiding.
 */
export function effectiveCollapsedSectors(
  collapsed: ReadonlySet<FuturesSector> | undefined,
  query: string | undefined,
): ReadonlySet<FuturesSector> {
  if (query?.trim()) return NO_COLLAPSED_SECTORS;
  return collapsed ?? NO_COLLAPSED_SECTORS;
}

export function buildFuturesRows(
  contractsBySector: Map<FuturesSector, FuturesContract[]>,
  sortPreference: FuturesSortPreference,
  quotes: BoardQuoteMap,
  options?: BuildFuturesRowsOptions,
): FuturesTableRow[] {
  const rows: FuturesTableRow[] = [];
  const query = options?.query ?? "";
  const collapsed = effectiveCollapsedSectors(options?.collapsed, query);
  for (const sector of FUTURES_SECTOR_ORDER) {
    const contracts = sortContracts(contractsBySector.get(sector) ?? [], sortPreference, quotes, options?.returns)
      .filter((contract) => matchesFuturesSearch(contract, query, quotes.get(contract.symbol)?.quote));
    if (contracts.length === 0) continue;
    rows.push({ type: "header", sector });
    if (collapsed.has(sector)) continue;
    for (const contract of contracts) rows.push({ type: "row", contract });
  }
  return rows;
}
