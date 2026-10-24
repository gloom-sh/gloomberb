import { apiClient } from "../../../api-client";
import type { HolderData, HolderRecord } from "../../../types/financials";
import type { TickerHoldings } from "../thirteenf/signals";
import { nonUsHolderCaveat } from "./report-header";

/**
 * A US listing's 13F holders from the SEC 13F holder index, the list `fn 13F`
 * pages through: every filer that reported the security for the latest
 * quarter, largest first, 25 to a page. HDS shows them in the units of the
 * source's own short list (each position at the latest price, the stake as a
 * share of the class that list divides by), and keeps that short list for a
 * listing abroad and whenever the index cannot be read.
 */

/** The most holder rows `fn HDS` and `holders` print. */
export const HOLDER_ROWS_MAX = 200;

/** One filer's position in the security, summed over the ticker's CUSIPs. */
export interface IndexedHolder {
  cik: string;
  name: string;
  shares: number;
  /** Shares at the prior quarter end: 0 for a new position, undefined when unknown. */
  previousShares?: number;
}

/** The index's holders loaded so far. */
export interface IndexedHolderList {
  rows: IndexedHolder[];
  /** The report period the positions are as of. */
  period: string;
  /** Every filer that holds the security at the period end. */
  holderCount: number;
  hasMore: boolean;
  nextOffset: number;
}

const usTicker = /^[A-Z0-9]{1,10}(\.[A-Z]{1,2})?$/;

/**
 * The ticker to ask the index for, or null when the listing is not a US
 * line: a venue abroad (typed `SAN:EPA` or given apart), another currency,
 * or a home line whose list the service priced from the filings.
 */
export function indexHolderTicker(
  symbol: string | null | undefined,
  exchange = "",
  data?: Pick<HolderData, "exchange" | "currency" | "valueBasis"> | null,
): string | null {
  const [bare = "", typed = ""] = (symbol ?? "").trim().toUpperCase().split(":");
  const ticker = bare.replace(/[/-]/g, ".");
  if (!usTicker.test(ticker)) return null;
  if (nonUsHolderCaveat(typed || exchange, null) != null) return null;
  if (data && (data.valueBasis === "period_end_price" || nonUsHolderCaveat(data.exchange, data.currency ?? "USD") != null)) return null;
  return ticker;
}

/**
 * One page of the index's holders. Rows that exited during the quarter, and
 * option or principal positions, are not holders of the shares; the pages
 * list the period's holders before its exits, so the list ends where the
 * holder count does.
 */
export function indexedHolderPage(holdings: TickerHoldings): IndexedHolderList {
  const byCik = new Map<string, IndexedHolder & { previousKnown: boolean }>();
  for (const row of holdings.rows) {
    const type = row.type.trim().toUpperCase();
    if (row.action === "exit" || (type && type !== "SH")) continue;
    if (row.shares == null || !(row.shares > 0)) continue;
    const previous = typeof row.previousShares === "number" ? row.previousShares : null;
    const current = byCik.get(row.cik);
    if (!current) {
      byCik.set(row.cik, {
        cik: row.cik,
        name: row.fund,
        shares: row.shares,
        previousShares: previous ?? undefined,
        previousKnown: previous != null,
      });
      continue;
    }
    // Two CUSIPs under one ticker (a re-issued one) are one position.
    current.shares += row.shares;
    current.previousKnown &&= previous != null;
    current.previousShares = current.previousKnown ? (current.previousShares ?? 0) + previous! : undefined;
  }
  return {
    rows: [...byCik.values()].map(({ previousKnown: _known, ...row }) => row),
    period: holdings.period,
    holderCount: holdings.holderCount,
    hasMore: holdings.hasMore && holdings.nextOffset < holdings.holderCount,
    nextOffset: holdings.nextOffset,
  };
}

/** The client the pages come through; headless reports pass their own. */
export type IndexedHolderClient = Pick<typeof apiClient, "getCloudSec13F">;

/** One page of 25, as `fn 13F` asks for it, so the two share the service's copy. */
export async function loadIndexedHolderPage(
  ticker: string,
  offset: number,
  signal?: AbortSignal,
  client: IndexedHolderClient = apiClient,
): Promise<IndexedHolderList> {
  signal?.throwIfAborted();
  const holdings = await client.getCloudSec13F("ticker-holdings", { tickers: ticker, offset, limit: 25 }, { signal }) as TickerHoldings;
  signal?.throwIfAborted();
  if (!Array.isArray(holdings?.rows) || typeof holdings.period !== "string") throw new Error(`13F holders of ${ticker} are unreadable`);
  return indexedHolderPage(holdings);
}

/** Later pages after the first; a page of another period starts the list over. */
function appendIndexedHolders(current: IndexedHolderList, page: IndexedHolderList): IndexedHolderList {
  if (current.period !== page.period) return page;
  const seen = new Set(current.rows.map((row) => row.cik));
  return { ...page, rows: [...current.rows, ...page.rows.filter((row) => !seen.has(row.cik))] };
}

/** The largest `limit` holders, paging as far as that takes. */
export async function loadIndexedHolders(
  ticker: string,
  limit: number,
  signal?: AbortSignal,
  client: IndexedHolderClient = apiClient,
): Promise<IndexedHolderList> {
  let list = await loadIndexedHolderPage(ticker, 0, signal, client);
  while (list.hasMore && list.rows.length < limit) {
    list = appendIndexedHolders(list, await loadIndexedHolderPage(ticker, list.nextOffset, signal, client));
  }
  return list;
}

/** How the source's own rows value and divide a position, which the index's rows take on. */
export interface IndexedHolderUnits {
  /** The price a position's shares are valued at. */
  price?: number;
  /**
   * The share count a stake is a share of. The source divides by the class
   * the line trades (PBR's receipts stand for the common shares alone), not
   * by every share the company has.
   */
  classShares?: number;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The units of the source's list: its rows' price (shares times the latest
 * price), else the quote's, and the count its stakes divide by. The stakes
 * are rounded to four places, so the count is taken over all of them, where
 * the largest weigh most.
 */
export function indexedHolderUnits(data: HolderData | null | undefined, quotePrice?: number | null): IndexedHolderUnits {
  const rows = (data?.holders ?? []).filter((row) => row.ownerType === "institution" && row.shares != null && row.shares > 0);
  const price = median(rows.flatMap((row) => (row.value != null && row.value > 0 ? [row.value / row.shares!] : [])))
    ?? (quotePrice != null && Number.isFinite(quotePrice) && quotePrice > 0 ? quotePrice : undefined);
  const staked = rows.filter((row) => row.percentHeld != null && row.percentHeld > 0);
  const held = staked.reduce((sum, row) => sum + row.percentHeld!, 0);
  const classShares = held > 0 ? staked.reduce((sum, row) => sum + row.shares!, 0) / held : undefined;
  return {
    ...(price != null ? { price } : {}),
    ...(classShares != null && Number.isFinite(classShares) ? { classShares } : {}),
  };
}

/** The source's rows of the period by their shares, where only one row has that many. */
function sourceRowsByShares(source: readonly HolderRecord[], period: string): Map<number, HolderRecord> {
  const counts = new Map<number, number>();
  for (const row of source) if (row.reportDate === period && row.shares != null) counts.set(row.shares, (counts.get(row.shares) ?? 0) + 1);
  return new Map(source.flatMap((row) => row.reportDate === period && row.shares != null && counts.get(row.shares) === 1 ? [[row.shares, row]] : []));
}

/**
 * The index's filers as holder rows. A filer whose position is exactly one of
 * the source's rows keeps that row's value and stake, so the largest holders
 * read as they did; the others are valued and divided in the same units.
 */
function indexedHolderRecords(
  rows: readonly IndexedHolder[],
  period: string,
  units: IndexedHolderUnits,
  source: readonly HolderRecord[] = [],
): HolderRecord[] {
  const known = sourceRowsByShares(source, period);
  return rows.map((row) => {
    const change = row.previousShares == null ? undefined : row.shares - row.previousShares;
    const same = known.get(row.shares);
    const value = same?.value ?? (units.price != null ? Math.round(row.shares * units.price) : undefined);
    const percentHeld = same?.percentHeld ?? (units.classShares != null ? row.shares / units.classShares : undefined);
    return {
      ownerType: "institution",
      name: row.name,
      cik: row.cik,
      reportDate: period,
      shares: row.shares,
      ...(value != null ? { value } : {}),
      ...(percentHeld != null ? { percentHeld } : {}),
      ...(change != null ? { changeShares: change } : {}),
      // A fraction of the prior position, as every holder record carries it; a new one has none.
      ...(change != null && row.previousShares! > 0
        ? { changePercent: Math.round((change / row.previousShares!) * 1e6) / 1e6 }
        : {}),
    };
  });
}

/**
 * The holder list with the index's filers in place of the source's few: the
 * listing's facts and units as the source gave them, the index's period and
 * count.
 */
export function withIndexedHolders(
  data: HolderData | null | undefined,
  symbol: string,
  list: IndexedHolderList,
  units: IndexedHolderUnits,
): HolderData {
  return {
    ...(data ?? { symbol, currency: "USD" }),
    asOf: list.period,
    holders: indexedHolderRecords(list.rows, list.period, units, data?.holders),
    summary: { ...data?.summary, institutionsCount: list.holderCount },
    ...(units.price != null ? { valueBasis: "latest_price" as const } : {}),
  };
}
