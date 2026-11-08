import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import type { Quote } from "../../../types/financials";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { FUTURES_SECTOR_ORDER, futuresBoardCode, futuresGroupFilter, futuresNameKey, type FuturesContract, type FuturesSector } from "../../../market-data/futures-board";
import { CONTRACT_MONTH_NAME, futuresPriceUnit } from "../../../market-data/futures-contract";
import { contractMonthLabel } from "../../../utils/contract-month";
import { quoteDotMarketState } from "../../../market-data/market/status";
import { futuresQuoteFromSettle } from "../../../market-data/market/change-basis";
import { globexDayOpen } from "../../../market-data/market/globex-day";
import { periodBaseDay, periodBaseText, periodDayText } from "../../../market-data/market/period-return";
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
  | "return3m"
  | "return6m"
  | "return1y"
  | FuturesReturnBaseColumnId
  | "volume"
  | "prevClose"
  | "time";

/** The exports' column of the day a return's base close is from: `return1mFrom` beside `return1m`. */
export type FuturesReturnBaseColumnId = "return1wFrom" | "return1mFrom" | "returnYtdFrom" | "return3mFrom" | "return6mFrom" | "return1yFrom";

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

/**
 * The alias stays the row identity while its quoted contract rolls, so the
 * label is the catalog name plus the quoted contract's month ("30-Year T-Bond
 * Dec 2026"). Quote names arrive as "Crude Oil Nov 2026", "Crude Oil Nov 26",
 * "Corn Futures,Dec-2026" or cut off mid-month ("Futures,Dec-"); a month
 * without a year is dropped rather than guessed.
 */
export function futuresContractName(contract: FuturesContract, quote?: Quote | null): string {
  const month = quotedContractMonth(contract, quote);
  if (!month) return unplacedName(contract);
  return `${contract.name} ${contractMonthLabel(month.year, month.month)}`;
}

/** A row whose month is not known yet: the catalog name, a generic's with its place on the curve ("VIX Futures front month"). */
function unplacedName(contract: FuturesContract): string {
  return contract.generic ? `${contract.name} ${contract.generic.place}` : contract.name;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The delivery month the alias's quote names, month 0-11, or null when its name carries none. */
export function quotedContractMonth(
  contract: FuturesContract,
  quote?: Quote | null,
): { year: number; month: number } | null {
  if (quote?.symbol?.trim().toUpperCase() !== contract.symbol.toUpperCase()) return null;
  const match = CONTRACT_MONTH_NAME.exec(quote.name?.trim() ?? "");
  if (!match) return null;
  const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === match[1]!.toLowerCase());
  const written = match[2] ?? match[3]!;
  const year = written.length === 2 ? 2000 + Number(written) : Number(written);
  return { year, month };
}

/** "2026-10-20" as "20 Oct". */
function dayMonth(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/**
 * The row's headline: the contract its quote prices, as futuresContractName
 * words it: the root's front month until its roll date. Once the continuous
 * symbol has rolled while the nearer month still trades, a note gives that
 * month's last trade: "WTI Crude Oil Dec 2026, rolled (Nov expires 20 Oct)".
 * The label names only the contract whose price the row shows: the day's
 * most active month, beside the price, read as that month's price ("Cocoa
 * Dec 2026, Mar 2027 most active  5,119" was December's), so it stays in
 * `quote`'s contract lines. The terms only add the note when they name the
 * month the quote prices, so a roll between the two loads never mixes
 * months, and place the month when the quote's name carries none. A name
 * column too narrow for the note drops it.
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
  const agree = quoted == null || termsMonth == null || (quoted.year === termsMonth.year && quoted.month === termsMonth.month);
  // A quote whose name carries no month (or a cut one) is placed by its terms.
  const month = agree ? quoted ?? termsMonth : quoted;
  if (!month) return unplacedName(contract);
  const priced = `${month.year}-${String(month.month + 1).padStart(2, "0")}`;
  const plain = `${contract.name} ${contractMonthLabel(month.year, month.month)}`;
  if (!agree) return plain;
  const nearest = terms?.nearest;
  if (!nearest || nearest.deliveryMonth >= priced) return plain;
  const nearer = MONTH_NAMES[Number(nearest.deliveryMonth.slice(5, 7)) - 1];
  const expiry = nearest.lastTrade ? `expires ${dayMonth(nearest.lastTrade)}` : "still trading";
  // The month the quote prices leads, so a column that clips the tail still shows it; the note keeps its place
  // while the column fits at least its start.
  return width < plain.length + ", rolled".length ? plain : `${plain}, rolled (${nearer} ${expiry})`;
}

/**
 * What a row's price counts, as `quote` and the chart composer say it: the
 * exchange's unit from the contract terms ("USD / barrel"), the catalog's
 * where the server has none ("EUR / MWh"), else null.
 */
export function futuresUnitLabel(contract: FuturesContract, terms?: Pick<FuturesContractTermsPayload, "spec"> | null): string | null {
  return futuresPriceUnit(contract, terms);
}

/**
 * Whether a row answers a search: its code, symbol, name or everyday names,
 * a number marked as "No. 11" or "#11" alike ("SUGAR NO. 11", the CFTC's
 * name, is Sugar #11), or a sector or group word that holds it (softs,
 * grains, agriculture, metals, energy), which lists that group alone.
 */
function matchesFuturesSearch(contract: FuturesContract, query: string, quote?: Quote | null): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const group = futuresGroupFilter(normalized);
  if (group) return group(contract);
  const named = futuresNameKey(normalized);
  return (
    contract.code.toLowerCase().includes(normalized)
    || futuresNameKey(contract.name).includes(named)
    || futuresNameKey(futuresContractName(contract, quote)).includes(named)
    || contract.symbol.toLowerCase().includes(normalized)
    // Everyday names the board's own does not hold: natgas is Natural Gas.
    || (contract.aliases ?? []).some((alias) => alias.includes(normalized))
  );
}

/**
 * Why `fn FUT urea` lists nothing, for a search no contract matches: what
 * to type instead, never the board's own Clear search button.
 */
export function futuresNoMatchFailure(query: string): { message: string; details: string } {
  return {
    message: `No futures contract matches "${query.trim()}".`,
    details: "Try a code such as NG, CL or GC, or a name such as natural gas or gold: gloom fn FUT NG."
      + " Other boards: gloom fn FUT --tab inventories, positioning or crops.",
  };
}

export const FUTURES_RETURN_BASE_COLUMNS: Readonly<Record<FuturesReturnBaseColumnId, FuturesReturnHorizon>> = {
  return1wFrom: "1W",
  return1mFrom: "1M",
  returnYtdFrom: "YTD",
  return3mFrom: "3M",
  return6mFrom: "6M",
  return1yFrom: "1Y",
};

export const FUTURES_RETURN_COLUMNS: Readonly<Partial<Record<FuturesColumnId, FuturesReturnHorizon>>> = {
  return1w: "1W",
  return1m: "1M",
  returnYtd: "YTD",
  return3m: "3M",
  return6m: "6M",
  return1y: "1Y",
};

/**
 * What each drawn return is measured from, as the report and the column's
 * hover name it: `1M from Mon 5 Oct close`, the day every row's base close
 * is from, or the day each row's close is on or before when rows differ (a
 * venue closed on it). Null for a horizon no row has a return for.
 */
export function futuresReturnBaseText(
  horizon: FuturesReturnHorizon,
  returns: FrontReturnsMap,
  now = Date.now(),
): string | null {
  const days = new Set<string>();
  for (const state of returns.values()) {
    const day = state.bases?.[horizon];
    if (day) days.add(day);
  }
  if (days.size === 0) return null;
  if (days.size === 1) return `${horizon} ${periodBaseText([...days][0]!, now)}`;
  const asked = periodBaseDay(new Date(now).toISOString().slice(0, 10), horizon);
  return `${horizon} from each contract's close on or before ${periodDayText(asked, new Date(now).getUTCFullYear())}`;
}

/** Sectors whose contracts trade CME Globex's whole day, 17:00 to 16:00 Central; grains, softs, lumber and livestock keep shorter hours. */
const GLOBEX_DAY_SECTORS: ReadonlySet<FuturesSector> = new Set(["equity-index", "equity-sectors", "rates", "energy", "metals", "currencies"]);

/**
 * The row's quote in the session CME Globex's clock gives a contract that
 * trades its whole day (globexDayOpen): open from the 17:00 reopen, before a
 * delayed feed shows a trade of it, and closed in the daily break, whatever
 * its last print says. Any other row, and a day the calendar cannot vouch
 * for, keeps the state its quote reports.
 */
export function futuresSessionQuote(contract: FuturesContract, quote: Quote | null | undefined, now = Date.now()): Quote | null | undefined {
  if (!quote?.marketState || quote.delisting || !GLOBEX_DAY_SECTORS.has(contract.sector)) return quote;
  const open = globexDayOpen(contract.venue, now);
  if (open == null) return quote;
  const state = open ? "REGULAR" : "CLOSED";
  return quote.marketState === state ? quote : { ...quote, marketState: state };
}

/**
 * The board's quotes with each row's move measured as `quote` measures it
 * with the row's terms (futuresQuoteFromSettle): from the last confirmed
 * settlement while nothing confirms the source's reference, so a row never
 * flips between two references at the reopen. The same map while no row
 * changes.
 */
export function futuresBoardQuotes(quotes: BoardQuoteMap, terms: FuturesTermsMap): BoardQuoteMap {
  let next: BoardQuoteMap | null = null;
  for (const [symbol, state] of quotes) {
    const quote = futuresQuoteFromSettle(state.quote, terms.get(symbol)?.terms);
    if (quote === state.quote) continue;
    next ??= new Map(quotes);
    next.set(symbol, { ...state, quote });
  }
  return next ?? quotes;
}

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
      return quoteDotMarketState(futuresSessionQuote(contract, quote)) === "REGULAR" ? 0 : 1;
    case "code":
      return futuresBoardCode(contract);
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
    case "return3m":
    case "return6m":
    case "return1y":
      return returns?.get(contract.symbol)?.values[FUTURES_RETURN_COLUMNS[columnId]!] ?? null;
    case "return1wFrom":
    case "return1mFrom":
    case "returnYtdFrom":
    case "return3mFrom":
    case "return6mFrom":
    case "return1yFrom":
      return returns?.get(contract.symbol)?.bases?.[FUTURES_RETURN_BASE_COLUMNS[columnId]] ?? null;
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
