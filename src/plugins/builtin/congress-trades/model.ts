import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit, getTableWidth, markHiddenTableColumns } from "../../../components/ui/table-layout";
import { MISSING_VALUE, formatCompact } from "../../../utils/format";
import type { SortDirection } from "../../../utils/sort-values";
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
const CONGRESS_EARLIEST_YEAR = 2008;

export type CongressTab = "trades" | "members" | "tickers";
export type LoadStatus = "idle" | "loading" | "loaded" | "error";
export type DetailMode =
  | { kind: "trade"; tradeId: string }
  | { kind: "member"; memberId: string }
  | { kind: "ticker"; ticker: string }
  | null;

export type TradeColumnId =
  | "returnSinceTx"
  | "returnSinceFiling"
  | "excessSinceFiling"
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
  | "medianExcessSinceFiling"
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
    { id: "lastFilingDate", label: "LAST FILED", width: 11, align: "left" },
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

function dateValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatLag(value: number | null): string {
  return value == null ? MISSING_VALUE : `${value}d`;
}

/** A disclosure bracket's bound, as the filing's range names it ($1k-15k): a label, short even in a table column. */
function formatMoneyShort(value: number | null): string {
  if (value == null) return MISSING_VALUE;
  return `$${formatCompact(value, { fixedDecimals: false })}`;
}

export function formatAmountRange(low: number | null, high: number | null, raw?: string): string {
  if (low == null && high == null) return raw || MISSING_VALUE;
  if (low != null && high == null) return `>${formatMoneyShort(low)}`;
  if (low != null && high != null && low !== high) {
    return `${formatMoneyShort(low)}-${formatMoneyShort(high).replace(/^\$/, "")}`;
  }
  return formatMoneyShort(low ?? high);
}

function isoOptionDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) return value;
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
  return `${year}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

/** A Senate asset cell carries the asset's kind after its name ("MH Four Winds LLC Description: Partnership"). */
export function plainAssetName(name: string): string {
  return name.replace(/\s+Description:\s.*$/i, "").trim() || name;
}

/**
 * What a trade was held through, when the filing says ("Underlying Asset of
 * Summa I LLC"), as " via Summa I LLC": one partnership held through four
 * family LLCs files four rows that differ only there. The holder it is held
 * through in turn ("…, owned through …") stays in the description.
 */
function tradeVehicleSuffix(trade: Pick<CloudCongressTradePayload, "description">): string {
  const vehicle = tradeVehicle(trade);
  return vehicle ? ` via ${vehicle}` : "";
}

/** What a line was held through, when its filing says ("Underlying Asset of Summa I LLC" is Summa I LLC); null when it does not. */
export function tradeVehicle(trade: Pick<CloudCongressTradePayload, "description">): string | null {
  return /Underlying Asset of\s+(.+?)\s*(?:,\s*(?:owned|held)\b|·|$)/i.exec(trade.description ?? "")?.[1]?.trim() || null;
}

/**
 * Filings name an option by its underlying stock ("... Common Stock") and put
 * the contract terms in the description, so option rows lead with the terms.
 * Anything else is its name and what it was held through.
 */
export function tradeAssetLabel(trade: Pick<CloudCongressTradePayload, "assetName" | "assetType" | "description">): string {
  if (trade.assetType !== "OP") return `${plainAssetName(trade.assetName)}${tradeVehicleSuffix(trade)}`;
  const text = trade.description ?? "";
  const right = /\b(call|put)s?\b/i.exec(text)?.[1]?.toUpperCase() ?? "OPTION";
  const strike = /strike(?:\s+price)?(?:\s+of)?:?\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(text)?.[1];
  const expiry = /(?:expires?|expiration(?:\s+date)?(?:\s+of)?):?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text)?.[1];
  const terms = [
    right,
    strike ? `$${Number(strike.replace(/,/g, ""))}` : null,
    expiry ? `exp ${isoOptionDate(expiry)}` : null,
  ].filter(Boolean).join(" ");
  const underlying = trade.assetName.replace(/\s*(?:-\s*)?Common Stock\s*$/i, "").trim();
  return underlying ? `${terms} · ${underlying}` : terms;
}

/** A trades table row: one line of a filing, or the lines one filing reports alike (foldFilingLines). */
export interface CongressTradeRow extends CloudCongressTradePayload {
  /** The filing's lines the row stands for, two or more, in the order they came; absent on a row of one line. */
  lines?: CloudCongressTradePayload[];
}

/** The asset a line names, as alike lines share it: its ticker, kind and name (an option's terms), not what it was held through. */
function lineAssetKey(trade: CloudCongressTradePayload): string {
  const name = trade.assetType === "OP" ? tradeAssetLabel(trade) : plainAssetName(trade.assetName);
  return [trade.ticker ?? "", trade.assetType ?? "", name.toLowerCase()].join("\u0000");
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  return values.every((value) => value != null) ? values.reduce<number>((total, value) => total + value!, 0) : null;
}

/**
 * One filing can report a trade in one asset as many lines: a partnership
 * held through several family LLCs is a line for each LLC, alike but for
 * what it was held through, and they would fill the table. The lines of
 * one filing, transaction date, side and asset fold into one row with their
 * count and combined amount range; the row keeps them (`lines`) for its
 * detail and exports, which list each one.
 */
export function foldFilingLines(trades: readonly CloudCongressTradePayload[]): CongressTradeRow[] {
  const groups = new Map<string, CloudCongressTradePayload[]>();
  for (const trade of trades) {
    const key = [trade.filingId, trade.transactionDate ?? "", trade.side, lineAssetKey(trade)].join("\u0001");
    const group = groups.get(key);
    if (group) group.push(trade);
    else groups.set(key, [trade]);
  }
  return [...groups.values()].map((lines) => lines.length === 1 ? lines[0]! : foldedRow(lines));
}

function foldedRow(lines: CloudCongressTradePayload[]): CongressTradeRow {
  const first = lines[0]!;
  const shared = <K extends keyof CloudCongressTradePayload>(key: K) => lines.every((line) => line[key] === first[key]) ? first[key] : undefined;
  const owners = new Set(lines.map((line) => line.owner));
  const amountLow = sumOrNull(lines.map((line) => line.amountLow));
  const amountHigh = sumOrNull(lines.map((line) => line.amountHigh));
  return {
    ...first,
    id: `${first.id}:lines`,
    assetName: plainAssetName(first.assetName),
    // An option's terms are its description; another asset's differ by what each line was held through.
    description: first.assetType === "OP" ? first.description : shared("description") ?? null,
    owner: owners.size === 1 ? first.owner : `${owners.size} owners`,
    rawOwner: shared("rawOwner") ?? "",
    amount: amountLow == null && amountHigh == null ? MISSING_VALUE : formatAmountRange(amountLow, amountHigh),
    amountLow,
    amountHigh,
    capGainsOver200: shared("capGainsOver200") ?? null,
    filingStatus: shared("filingStatus") ?? null,
    subholdingOf: shared("subholdingOf") ?? null,
    returnSinceTx: shared("returnSinceTx") ?? null,
    returnSinceFiling: shared("returnSinceFiling") ?? null,
    spyReturnSinceTx: shared("spyReturnSinceTx") ?? null,
    spyReturnSinceFiling: shared("spyReturnSinceFiling") ?? null,
    excessSinceTx: shared("excessSinceTx") ?? null,
    excessSinceFiling: shared("excessSinceFiling") ?? null,
    lines,
  };
}

/** A row's asset cell: the asset as tradeAssetLabel names it, and the count of lines a folded row stands for (`· 32 lines`). */
export function congressRowAsset(row: Pick<CongressTradeRow, "assetName" | "assetType" | "description" | "lines">): string {
  return `${tradeAssetLabel(row)}${congressRowLineCount(row)}`;
}

/** A folded row's count (` · 8 lines`), which a narrow column keeps whole and cuts the name before. */
export function congressRowLineCount(row: Pick<CongressTradeRow, "lines">): string {
  return row.lines ? ` · ${row.lines.length} lines` : "";
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
    case "excessSinceFiling":
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
    case "medianExcessSinceFiling":
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

const VS_SPY_COLUMN: TradeColumn = { id: "excessSinceFiling", label: "VS SPY", width: 10, align: "right" };
const TRADE_MEMBER_MIN_WIDTH = 14;
/** Narrower than this cuts most member names, so other columns give way first. */
const MEMBER_READABLE_WIDTH = 18;

/**
 * Short of room, the trades give way in this order. The return since the
 * trade goes first: FILE RET% and VS SPY read over the same days, from the
 * filing a follower could act on. Then the dates lose their year, the lag
 * (it follows from the two dates), the owner and the trade date go, and VS
 * SPY outlasts FILE RET%. The detail keeps every figure.
 */
const TRADE_DROP_ORDER = ["returnSinceTx", "lag", "owner", "tx", "returnSinceFiling"] as const;

function tradeColumns(tickerView: boolean, dateWidth: number, memberWidth: number, assetWidth: number | null): TradeColumn[] {
  return [
    { id: "filed", label: "FILED", width: dateWidth, align: "left" },
    { id: "tx", label: "TX", width: dateWidth, align: "left" },
    { id: "lag", label: "LAG", width: 5, align: "right" },
    { id: "member", label: "MEMBER", width: memberWidth, align: "left" },
    { id: "side", label: "SIDE", width: 5, align: "left" },
    ...(!tickerView ? [{ id: "ticker" as const, label: "TICKER", width: 12, align: "left" as const, assetFallback: assetWidth == null }] : []),
    ...(assetWidth != null ? [{ id: "asset" as const, label: "ASSET", width: assetWidth, align: "left" as const }] : []),
    { id: "amount", label: "AMOUNT", width: 14, align: "right" },
    { id: "owner", label: "OWNER", width: 8, align: "left" },
    { id: "returnSinceTx", label: "TX RET%", width: 10, align: "right" },
    { id: "returnSinceFiling", label: "FILE RET%", width: 10, align: "right" },
    VS_SPY_COLUMN,
  ];
}

export function buildTradeColumns(width: number, tickerView = false): TradeColumn[] {
  // Full dates (02 Nov 2026) while dropping TX RET% is enough, then short ones (02 Nov) and the rest of the order.
  const long = dropColumnsToFit(tradeColumns(tickerView, 11, MEMBER_READABLE_WIDTH, null), width, TRADE_DROP_ORDER.slice(0, 1));
  const fitted = getTableWidth(long) <= width ? long : dropColumnsToFit(tradeColumns(tickerView, 7, MEMBER_READABLE_WIDTH, null), width, TRADE_DROP_ORDER);
  const shown = new Set(fitted.map((column) => column.id));
  const dateWidth = fitted[0]!.width;
  const layout = (memberWidth: number, assetWidth: number | null) => {
    const all = tradeColumns(tickerView, dateWidth, memberWidth, assetWidth);
    return markHiddenTableColumns(all, all.filter((column) => shown.has(column.id) || column.id === "asset"));
  };
  // What the other columns leave, as the table draws them, names the member and then the asset.
  const flexWidth = Math.max(TRADE_MEMBER_MIN_WIDTH, MEMBER_READABLE_WIDTH + width - getTableWidth(fitted));
  // Member names rarely pass 22 cells; the rest names the asset, which is the
  // only identification for trades without a ticker (bonds, T-bills, funds).
  const memberWidth = Math.min(22, Math.max(18, flexWidth - 13));
  const assetWidth = flexWidth - memberWidth - 1;
  return assetWidth >= 12 ? layout(memberWidth, assetWidth) : layout(flexWidth, null);
}

const MEMBER_TRADE_ASSET_MIN_WIDTH = 18;
/** As on the trades; the member row above also carries their average lag. */
const MEMBER_TRADE_DROP_ORDER = ["lag", "owner", "tx"] as const;

export function buildMemberTradeColumns(width: number): TradeColumn[] {
  const layout = (assetWidth: number): TradeColumn[] => [
    { id: "filed", label: "FILED", width: 7, align: "left" },
    { id: "tx", label: "TX", width: 7, align: "left" },
    { id: "side", label: "SIDE", width: 8, align: "left" },
    { id: "ticker", label: "TICKER", width: 12, align: "left" },
    { id: "amount", label: "AMOUNT", width: 14, align: "right" },
    { id: "asset", label: "ASSET", width: assetWidth, align: "left" },
    { id: "owner", label: "OWNER", width: 8, align: "left" },
    { id: "lag", label: "LAG", width: 5, align: "right" },
    VS_SPY_COLUMN,
  ];
  const fitted = dropColumnsToFit(layout(MEMBER_TRADE_ASSET_MIN_WIDTH), width, MEMBER_TRADE_DROP_ORDER);
  const shown = new Set(fitted.map((column) => column.id));
  const assetWidth = Math.max(MEMBER_TRADE_ASSET_MIN_WIDTH, MEMBER_TRADE_ASSET_MIN_WIDTH + width - getTableWidth(fitted));
  const all = layout(assetWidth);
  return markHiddenTableColumns(all, all.filter((column) => shown.has(column.id)));
}

/**
 * As on the trades, the median return since the trade gives way before the one
 * against SPY; then the average lag, the last filing, the district and the
 * buy hit rate, which the member's detail repeats.
 */
const MEMBER_DROP_ORDER = ["medianReturn", "lag", "last", "district", "buyHitRate"] as const;

export function buildMemberColumns(width: number): MemberColumn[] {
  const layout = (memberWidth: number): MemberColumn[] => [
    { id: "member", label: "MEMBER", width: memberWidth, align: "left" },
    { id: "district", label: "DIST", width: 6, align: "left" },
    { id: "party", label: "PARTY", width: 11, align: "left" },
    { id: "trades", label: "TRADES", width: 7, align: "right" },
    { id: "buys", label: "BUY", width: 5, align: "right" },
    { id: "sells", label: "SELL", width: 6, align: "right" },
    { id: "range", label: "EST RANGE", width: 17, align: "right" },
    { id: "last", label: "LAST", width: 7, align: "left" },
    { id: "lag", label: "AVG", width: 6, align: "right" },
    { id: "medianReturn", label: "MED RET%", width: 9, align: "right" },
    { id: "medianExcessSinceFiling", label: "MED VS SPY", width: 10, align: "right" },
    { id: "buyHitRate", label: "BUY HIT%", width: 9, align: "right" },
  ];
  const fitted = dropColumnsToFit(layout(MEMBER_READABLE_WIDTH), width, MEMBER_DROP_ORDER);
  const shown = new Set(fitted.map((column) => column.id));
  const memberWidth = Math.max(MEMBER_READABLE_WIDTH, MEMBER_READABLE_WIDTH + width - getTableWidth(fitted));
  const all = layout(memberWidth);
  return markHiddenTableColumns(all, all.filter((column) => shown.has(column.id)));
}

export function sortedTrades<T extends CloudCongressTradePayload>(
  trades: readonly T[],
  sort: { columnId: TradeColumnId; direction: SortDirection },
): T[] {
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

/** Percent to one decimal; a figure that rounds to zero reads 0.0%, never -0.0%. */
export function formatCongressReturn(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const shown = roundCongressReturn(value);
  return `${shown > 0 ? "+" : ""}${shown === 0 ? "0.0" : shown.toFixed(1)}%`;
}

/** The figure as shown, so its colour follows the digits: SPY at -0.04% is flat, not red. */
export function roundCongressReturn(value: number): number {
  return Math.round(value * 10) / 10 || 0;
}
