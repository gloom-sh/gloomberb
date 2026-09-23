import type { DataTableColumn } from "../../../components";
import { formatCompact } from "../../../utils/format";

export { truncateWithEllipsis as truncate } from "../../../utils/text-wrap";
import type {
  CloudCongressHousePayload,
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
  CloudCongressTickerPayload,
} from "../../../api-client";
import type { CloudCongressHouseParams } from "../../../api-client/paths";

export const CONGRESS_TRADES_PANE_ID = "congress-trades";
export const CONGRESS_TRADE_LIMIT = 200;
export const CONGRESS_FILING_LIMIT = 60;
export const CONGRESS_MEMBER_TRADE_LIMIT = 2000;
export const CONGRESS_MEMBER_FILING_LIMIT = 500;
export const CONGRESS_EARLIEST_YEAR = 2008;

export type CongressTab = "trades" | "members" | "tickers";
export type LoadStatus = "idle" | "loading" | "loaded" | "error";
export type SortDirection = "asc" | "desc";
export type DetailMode =
  | { kind: "trade"; tradeId: string }
  | { kind: "member"; memberId: string }
  | { kind: "ticker"; ticker: string }
  | null;

export type TradeColumnId =
  | "returnSinceTx"
  | "returnSinceFiling"
  | "filed"
  | "tx"
  | "lag"
  | "member"
  | "side"
  | "ticker"
  | "amount"
  | "asset"
  | "owner";
export type TradeColumn = DataTableColumn & {
  id: TradeColumnId;
  /** Ticker column without an asset column beside it: name the asset when there is no ticker. */
  assetFallback?: boolean;
};
export type MemberColumnId =
  | "party"
  | "medianReturn"
  | "buyHitRate"
  | "member"
  | "district"
  | "trades"
  | "buys"
  | "sells"
  | "range"
  | "last"
  | "lag";
export type MemberColumn = DataTableColumn & { id: MemberColumnId };

export type TickerColumnId = "ticker" | "buyCount" | "sellCount" | "memberCount" | "range" | "lastFilingDate";
export type TickerColumn = DataTableColumn & { id: TickerColumnId };

export function buildTickerColumns(width: number): TickerColumn[] {
  return [
    { id: "ticker", label: "TICKER", width: Math.max(12, width - 68), align: "left" },
    { id: "buyCount", label: "BUY", width: 6, align: "right" },
    { id: "sellCount", label: "SELL", width: 6, align: "right" },
    { id: "memberCount", label: "MEMBERS", width: 8, align: "right" },
    { id: "range", label: "EST RANGE", width: 25, align: "right" },
    { id: "lastFilingDate", label: "LAST FILED", width: 10, align: "left" },
  ];
}

export function sortedTickers(tickers: CloudCongressTickerPayload[], sort: { columnId: TickerColumnId; direction: SortDirection }) {
  return [...tickers].sort((a, b) => {
    const key = sort.columnId;
    const comparison = key === "ticker" || key === "lastFilingDate"
      ? (a[key] ?? "").localeCompare(b[key] ?? "")
      : key === "range" ? (a.estimatedLow ?? -1) - (b.estimatedLow ?? -1) : a[key] - b[key];
    return (sort.direction === "asc" ? comparison : -comparison) || a.ticker.localeCompare(b.ticker);
  });
}

export function formatShortDate(value: string | null): string {
  if (!value) return "--";
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return "--";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function dateValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatLag(value: number | null): string {
  return value == null ? "--" : `${value}d`;
}

function formatMoneyShort(value: number | null): string {
  if (value == null) return "--";
  return `$${formatCompact(value)}`;
}

export function formatAmountRange(low: number | null, high: number | null, raw?: string): string {
  if (low == null && high == null) return raw || "--";
  if (low != null && high == null) return `>${formatMoneyShort(low)}`;
  if (low != null && high != null && low !== high) {
    return `${formatMoneyShort(low)}-${formatMoneyShort(high).replace(/^\$/, "")}`;
  }
  return formatMoneyShort(low ?? high);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en-US", { sensitivity: "base" });
}

function compareOptionalNumber(left: number | null | undefined, right: number | null | undefined): number {
  if (left == null) return right == null ? 0 : -1;
  if (right == null) return 1;
  return left - right;
}

function compareTrade(
  left: CloudCongressTradePayload,
  right: CloudCongressTradePayload,
  columnId: TradeColumnId,
): number {
  switch (columnId) {
    case "returnSinceTx":
    case "returnSinceFiling":
      return compareOptionalNumber(left[columnId], right[columnId]);
    case "filed":
      return dateValue(left.filingDate) - dateValue(right.filingDate);
    case "tx":
      return dateValue(left.transactionDate) - dateValue(right.transactionDate);
    case "lag":
      return (left.lagDays ?? -1) - (right.lagDays ?? -1);
    case "member":
      return compareText(left.memberName, right.memberName);
    case "side":
      return compareText(left.side, right.side);
    case "ticker":
      return compareText(left.ticker ?? "", right.ticker ?? "");
    case "amount":
      return (left.amountHigh ?? left.amountLow ?? 0) - (right.amountHigh ?? right.amountLow ?? 0);
    case "asset":
      return compareText(left.assetName, right.assetName);
    case "owner":
      return compareText(left.owner, right.owner);
  }
}

function compareMember(
  left: CloudCongressMemberPayload,
  right: CloudCongressMemberPayload,
  columnId: MemberColumnId,
): number {
  switch (columnId) {
    case "party":
      return compareText(left.party ?? "", right.party ?? "");
    case "medianReturn":
    case "buyHitRate":
      return compareOptionalNumber(left[columnId], right[columnId]);
    case "member":
      return compareText(left.memberName, right.memberName);
    case "district":
      return compareText(left.stateDistrict, right.stateDistrict);
    case "trades":
      return left.tradeCount - right.tradeCount;
    case "buys":
      return left.buyCount - right.buyCount;
    case "sells":
      return left.sellCount - right.sellCount;
    case "range":
      return (left.estimatedHigh ?? left.estimatedLow ?? 0) - (right.estimatedHigh ?? right.estimatedLow ?? 0);
    case "last":
      return dateValue(left.lastFilingDate) - dateValue(right.lastFilingDate);
    case "lag":
      return (left.avgLagDays ?? -1) - (right.avgLagDays ?? -1);
  }
}

export function nextSort<TColumn extends string>(
  current: { columnId: TColumn; direction: SortDirection },
  columnId: TColumn,
  defaultDirection: SortDirection,
): { columnId: TColumn; direction: SortDirection } {
  if (current.columnId !== columnId) {
    return { columnId, direction: defaultDirection };
  }
  return {
    columnId,
    direction: current.direction === "asc" ? "desc" : "asc",
  };
}

export function buildTradeColumns(width: number, tickerView = false): TradeColumn[] {
  const filedWidth = 10;
  const txWidth = 10;
  const lagWidth = 5;
  const sideWidth = 5;
  const tickerWidth = tickerView ? 0 : 12;
  const amountWidth = 14;
  const ownerWidth = 8;
  const flexWidth = Math.max(
    14,
    width - filedWidth - txWidth - lagWidth - sideWidth - tickerWidth - amountWidth - ownerWidth - 36,
  );
  // Member names rarely pass 22 cells; the rest names the asset, which is the
  // only identification for trades without a ticker (bonds, T-bills, funds).
  const memberWidth = Math.min(22, Math.max(18, flexWidth - 13));
  const assetWidth = flexWidth - memberWidth - 1;
  const showAsset = assetWidth >= 12;
  return [
    { id: "filed", label: "FILED", width: filedWidth, align: "left" },
    { id: "tx", label: "TX", width: txWidth, align: "left" },
    { id: "lag", label: "LAG", width: lagWidth, align: "right" },
    { id: "member", label: "MEMBER", width: showAsset ? memberWidth : flexWidth, align: "left" },
    { id: "side", label: "SIDE", width: sideWidth, align: "left" },
    ...(!tickerView ? [{ id: "ticker" as const, label: "TICKER", width: tickerWidth, align: "left" as const, assetFallback: !showAsset }] : []),
    ...(showAsset ? [{ id: "asset" as const, label: "ASSET", width: assetWidth, align: "left" as const }] : []),
    { id: "amount", label: "AMOUNT", width: amountWidth, align: "right" },
    { id: "owner", label: "OWNER", width: ownerWidth, align: "left" },
    { id: "returnSinceTx", label: "TX RET%", width: 10, align: "right" },
    { id: "returnSinceFiling", label: "FILE RET%", width: 10, align: "right" },
  ];
}

export function buildMemberTradeColumns(width: number): TradeColumn[] {
  const filedWidth = 7;
  const txWidth = 7;
  const sideWidth = 8;
  const tickerWidth = 12;
  const amountWidth = 14;
  const ownerWidth = 8;
  const lagWidth = 5;
  const assetWidth = Math.max(
    18,
    width - filedWidth - txWidth - sideWidth - tickerWidth - amountWidth - ownerWidth - lagWidth - 9,
  );
  return [
    { id: "filed", label: "FILED", width: filedWidth, align: "left" },
    { id: "tx", label: "TX", width: txWidth, align: "left" },
    { id: "side", label: "SIDE", width: sideWidth, align: "left" },
    { id: "ticker", label: "TICKER", width: tickerWidth, align: "left" },
    { id: "amount", label: "AMOUNT", width: amountWidth, align: "right" },
    { id: "asset", label: "ASSET", width: assetWidth, align: "left" },
    { id: "owner", label: "OWNER", width: ownerWidth, align: "left" },
    { id: "lag", label: "LAG", width: lagWidth, align: "right" },
  ];
}

export function buildMemberColumns(width: number): MemberColumn[] {
  const districtWidth = 6;
  const tradesWidth = 7;
  const buysWidth = 5;
  const sellsWidth = 6;
  const rangeWidth = 17;
  const lastWidth = 7;
  const lagWidth = 6;
  const memberWidth = Math.max(
    18,
    width - districtWidth - tradesWidth - buysWidth - sellsWidth - rangeWidth - lastWidth - lagWidth - 47,
  );
  return [
    { id: "member", label: "MEMBER", width: memberWidth, align: "left" },
    { id: "district", label: "DIST", width: districtWidth, align: "left" },
    { id: "party", label: "PARTY", width: 11, align: "left" },
    { id: "trades", label: "TRADES", width: tradesWidth, align: "right" },
    { id: "buys", label: "BUY", width: buysWidth, align: "right" },
    { id: "sells", label: "SELL", width: sellsWidth, align: "right" },
    { id: "range", label: "EST RANGE", width: rangeWidth, align: "right" },
    { id: "last", label: "LAST", width: lastWidth, align: "left" },
    { id: "lag", label: "AVG", width: lagWidth, align: "right" },
    { id: "medianReturn", label: "MED RET%", width: 9, align: "right" },
    { id: "buyHitRate", label: "BUY HIT%", width: 9, align: "right" },
  ];
}

export function sortedTrades(
  trades: CloudCongressTradePayload[],
  sort: { columnId: TradeColumnId; direction: SortDirection },
): CloudCongressTradePayload[] {
  return [...trades].sort((left, right) => {
    const comparison = compareTrade(left, right, sort.columnId);
    if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;
    return dateValue(right.filingDate) - dateValue(left.filingDate);
  });
}

export function sortedMembers(
  members: CloudCongressMemberPayload[],
  sort: { columnId: MemberColumnId; direction: SortDirection },
): CloudCongressMemberPayload[] {
  return [...members].sort((left, right) => {
    const comparison = compareMember(left, right, sort.columnId);
    if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;
    return left.memberName.localeCompare(right.memberName);
  });
}

export function selectedIndexById<T extends { id: string }>(rows: T[], selectedId: string | null): number {
  const index = rows.findIndex((row) => row.id === selectedId);
  return index >= 0 ? index : rows.length > 0 ? 0 : -1;
}

function congressFilingOffset(payload: CloudCongressHousePayload): number {
  return payload.filingOffset ?? 0;
}

function congressHasMoreFilings(payload: CloudCongressHousePayload): boolean {
  if (payload.hasMoreFilings === true) return true;
  if (payload.hasMoreFilings === false) return false;
  return congressFilingOffset(payload) + payload.filingsScanned < payload.filingCount;
}

export function canLoadMoreCongress(payload: CloudCongressHousePayload): boolean {
  return nextCongressPage(payload) != null;
}

/**
 * The next page a scroll may load on its own.
 *
 * Paging stops at the year boundary: each new filing window is a source read,
 * so crossing into an earlier year is an explicit request, never the result of
 * someone scrolling past the end of the table.
 */
export function nextCongressPage(payload: CloudCongressHousePayload): CloudCongressHouseParams | null {
  if (payload.hasMore) {
    return {
      year: payload.year,
      offset: payload.nextOffset ?? 0,
      filingOffset: congressFilingOffset(payload),
    };
  }
  if (congressHasMoreFilings(payload)) {
    return {
      year: payload.year,
      offset: 0,
      filingOffset: payload.nextFilingOffset ?? congressFilingOffset(payload) + payload.filingsScanned,
    };
  }
  return null;
}

/** The first page of the year before this one, for an explicit "earlier year". */
export function previousCongressYearPage(
  payload: CloudCongressHousePayload,
): CloudCongressHouseParams | null {
  if (payload.year <= CONGRESS_EARLIEST_YEAR) return null;
  return { year: payload.year - 1, offset: 0, filingOffset: 0 };
}

/**
 * What the pane says when a window came back incomplete. Filings the source
 * could not give us are named rather than silently missing from the table.
 */
export function congressScanNotice(payload: CloudCongressHousePayload): string | null {
  const pending = payload.filingsPending ?? 0;
  const failed = payload.filingsFailed ?? 0;
  const paper = payload.filingsPaper ?? 0;
  const notices = [
    pending > 0 ? `${pending + failed} filings not read yet, retrying later` : failed > 0 ? `${failed} filings unavailable` : null,
    paper > 0 ? `${paper} Senate paper ${paper === 1 ? "filing" : "filings"} not read` : null,
    payload.senateUnavailable ? "Senate filings unavailable, showing House only" : null,
  ].filter((notice): notice is string => !!notice);
  return notices.length ? notices.join(" · ") : null;
}

export function mergeCongressPages(
  current: CloudCongressHousePayload,
  next: CloudCongressHousePayload,
): CloudCongressHousePayload {
  const byTradeId = new Map(current.trades.map((trade) => [trade.id, trade]));
  for (const trade of next.trades) {
    byTradeId.set(trade.id, trade);
  }
  const members = [...current.members];
  const seenMembers = new Set(current.members.map((member) => member.id));
  for (const member of next.members) {
    if (seenMembers.has(member.id)) continue;
    seenMembers.add(member.id);
    members.push(member);
  }
  return { ...next, trades: [...byTradeId.values()], members };
}

export function formatCongressReturn(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
