import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import type { Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { FUTURES_SECTOR_ORDER, type FuturesContract, type FuturesSector } from "../../../market-data/futures-board";
import type { FuturesReturnHorizon } from "./returns";
import type { FuturesTermsMap } from "./use-board-terms";
import type { FrontReturnsMap } from "./use-front-returns";

export type FuturesTableRow =
  | { type: "header"; sector: FuturesSector }
  | { type: "row"; contract: FuturesContract };

export type FuturesColumnId =
  | "status"
  | "code"
  | "name"
  | "price"
  | "unit"
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

/** "2026-10-20" as "20 Oct". */
function dayMonth(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/**
 * The row's headline: the contract its quote prices, as futuresContractName
 * words it. While the continuous symbol has rolled to the most active month
 * and a nearer one still trades, the headline says so, with the nearer one's
 * last trade: "WTI Crude Oil Dec 26, most active (Nov expires 20 Oct)". The
 * terms only add that note when they name the month the quote prices, so a
 * roll between the two loads never mixes months, and place the month when the
 * quote's name carries none. A name column too narrow for the note keeps the
 * plain name.
 */
export function futuresContractHeadline(
  contract: FuturesContract,
  quote?: Quote | null,
  terms?: Pick<FuturesContractTermsPayload, "deliveryMonth" | "nearest"> | null,
  width = Number.POSITIVE_INFINITY,
): string {
  const quoted = quotedContractMonth(contract, quote);
  const termsMonth = terms?.deliveryMonth && /^\d{4}-\d{2}$/.test(terms.deliveryMonth)
    ? { year: Number(terms.deliveryMonth.slice(0, 4)), month: Number(terms.deliveryMonth.slice(5, 7)) - 1 }
    : null;
  const nearest = terms?.nearest;
  const agree = quoted == null || termsMonth == null || (quoted.year === termsMonth.year && quoted.month === termsMonth.month);
  // A quote whose name carries no month (or a cut one) is placed by its terms.
  const month = agree ? quoted ?? termsMonth : quoted;
  if (!month) return contract.name;
  const active = `${MONTH_NAMES[month.month]} ${String(month.year).slice(-2)}`;
  const plain = `${contract.name} ${active}`;
  if (!nearest || !agree || nearest.deliveryMonth >= `${month.year}-${String(month.month + 1).padStart(2, "0")}`) return plain;
  const nearer = MONTH_NAMES[Number(nearest.deliveryMonth.slice(5, 7)) - 1];
  const expiry = nearest.lastTrade ? `expires ${dayMonth(nearest.lastTrade)}` : "still trading";
  // The month the quote prices leads, so a column that clips the tail still shows it; one too narrow for
  // "most active" shows the plain name.
  const note = `, most active (${nearer} ${expiry})`;
  return width >= plain.length + MOST_ACTIVE_MIN.length ? `${plain}${note}` : plain;
}

/** The least of the note a name column must fit to carry it. */
const MOST_ACTIVE_MIN = ", most active";

/**
 * What a row's price counts, as `quote` says it: the exchange's unit from the
 * contract terms ("USD / barrel"), the catalog's where the server has none
 * ("EUR / MWh"), else null.
 */
export function futuresUnitLabel(contract: FuturesContract, terms?: Pick<FuturesContractTermsPayload, "spec"> | null): string | null {
  return terms?.spec?.unit ?? contract.unit ?? null;
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
  terms?: FuturesTermsMap,
): string | number | null {
  const quote = quotes.get(contract.symbol)?.quote;
  switch (columnId) {
    case "unit":
      return futuresUnitLabel(contract, terms?.get(contract.symbol)?.terms);
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
  terms?: FuturesTermsMap,
): FuturesContract[] {
  const columnId = sortPreference.columnId;
  if (!columnId) return contracts;
  return [...contracts].sort((left, right) => compareSortValues(
    getSortValue(columnId, left, quotes, returns, terms),
    getSortValue(columnId, right, quotes, returns, terms),
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
  /** Each row's contract terms, for sorting on the unit. */
  terms?: FuturesTermsMap;
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
    const contracts = sortContracts(contractsBySector.get(sector) ?? [], sortPreference, quotes, options?.returns, options?.terms)
      .filter((contract) => matchesFuturesSearch(contract, query, quotes.get(contract.symbol)?.quote));
    if (contracts.length === 0) continue;
    rows.push({ type: "header", sector });
    if (collapsed.has(sector)) continue;
    for (const contract of contracts) rows.push({ type: "row", contract });
  }
  return rows;
}
