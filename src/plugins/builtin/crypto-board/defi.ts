import type { DefiTvlChain, DefiTvlPayload, DefiTvlProtocol } from "../../../api-client/crypto-markets";
import type { DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { formatUtcTime } from "../../../utils/utc-time";
import { formatCryptoPercent, utcCloseAsOfText } from "./model";
import { SUPPLY_RANGES, type SupplyRangeId } from "./supply";

const DAY_MS = 86_400_000;

/** What the DeFi tab ranks: protocols (their versions together) or chains. */
export type DefiList = "protocol" | "chain";

export const DEFI_LISTS: ReadonlyArray<{ value: DefiList; label: string }> = [
  { value: "protocol", label: "Protocols" },
  { value: "chain", label: "Chains" },
];

/** One row of the DeFi table; the fields a list has no figure for are null. */
export interface DefiRow {
  id: string;
  rank: number;
  name: string;
  /** A protocol's category; a chain's gas token. */
  detail: string | null;
  tvl: number;
  change1dPercent: number | null;
  change7d: number | null;
  change7dPercent: number | null;
  change30d: number | null;
  change30dPercent: number | null;
  /** A chain's percent of the total DeFi TVL; null for a protocol, whose TVL double counts across protocols. */
  share: number | null;
  /** How many chains a protocol is on; null for a chain. */
  chains: number | null;
  /** A protocol's fees and revenue, USD over 24 hours, 7 and 30 days; null for a chain and where the source has none. */
  fees24h: number | null;
  fees7d: number | null;
  fees30d: number | null;
  revenue24h: number | null;
  revenue7d: number | null;
  revenue30d: number | null;
}

const NO_INCOME = { fees24h: null, fees7d: null, fees30d: null, revenue24h: null, revenue7d: null, revenue30d: null } as const;

const protocolRow = (protocol: DefiTvlProtocol, index: number): DefiRow => ({
  id: `protocol:${protocol.name}`,
  rank: index + 1,
  name: protocol.name,
  detail: protocol.category,
  tvl: protocol.tvl,
  change1dPercent: protocol.change1dPercent,
  change7d: protocol.change7d,
  change7dPercent: protocol.change7dPercent,
  change30d: protocol.change30d,
  change30dPercent: protocol.change30dPercent,
  share: null,
  chains: protocol.chains,
  fees24h: protocol.fees24h ?? null,
  fees7d: protocol.fees7d ?? null,
  fees30d: protocol.fees30d ?? null,
  revenue24h: protocol.revenue24h ?? null,
  revenue7d: protocol.revenue7d ?? null,
  revenue30d: protocol.revenue30d ?? null,
});

const chainRow = (chain: DefiTvlChain, index: number): DefiRow => ({
  id: `chain:${chain.name}`,
  rank: index + 1,
  name: chain.name,
  detail: chain.tokenSymbol,
  tvl: chain.tvl,
  change1dPercent: null,
  change7d: chain.change7d,
  change7dPercent: chain.change7dPercent,
  change30d: chain.change30d,
  change30dPercent: chain.change30dPercent,
  share: chain.share,
  chains: null,
  ...NO_INCOME,
});

const rowsByPayload = new WeakMap<DefiTvlPayload, Record<DefiList, DefiRow[]>>();

/** The list's rows in the source's order, largest first; the same array for the same payload. */
export function buildDefiRows(payload: DefiTvlPayload | null | undefined, list: DefiList): DefiRow[] {
  if (!payload) return [];
  let rows = rowsByPayload.get(payload);
  if (!rows) {
    rows = { protocol: payload.protocols.map(protocolRow), chain: payload.chains.map(chainRow) };
    rowsByPayload.set(payload, rows);
  }
  return rows[list];
}

/**
 * When the list's figures are from: a chain's are its daily chart's on the
 * board's as-of day, a protocol's the source's latest at the read.
 */
export function defiListAsOf(payload: DefiTvlPayload | null | undefined, list: DefiList): string | null {
  if (!payload) return null;
  if (list === "chain") return payload.asOf;
  return payload.protocolsAsOf ? formatUtcTime(payload.protocolsAsOf) : payload.asOf;
}

/** The first day the total's history has a value, the day `All` reaches back to. */
export function defiHistoryStart(payload: DefiTvlPayload | null | undefined): string | null {
  const history = payload?.history;
  if (!history) return null;
  const first = history.total.findIndex((value) => value != null);
  return first < 0 ? null : new Date(Date.parse(`${history.start}T00:00:00Z`) + first * DAY_MS).toISOString().slice(0, 10);
}

/** The total's days in `range`, counted back from its newest, for the chart. */
export function defiHistory(
  payload: DefiTvlPayload | null | undefined,
  range: SupplyRangeId,
): { dates: Date[]; values: Array<number | null> } | null {
  const history = payload?.history;
  if (!history || history.total.length < 2) return null;
  const last = history.total.findLastIndex((value) => value != null);
  if (last < 1) return null;
  const days = SUPPLY_RANGES.find((option) => option.value === range)?.days ?? null;
  const first = days == null ? 0 : Math.max(0, last - days);
  const startMs = Date.parse(`${history.start}T00:00:00Z`);
  return {
    dates: Array.from({ length: last - first + 1 }, (_, index) => new Date(startMs + (first + index) * DAY_MS)),
    values: history.total.slice(first, last + 1).map((value) => value ?? null),
  };
}

/** The total's daily history as dated rows, oldest first, for an export. */
export function defiHistoryRows(payload: DefiTvlPayload): Array<{ date: string; tvl: number | null }> {
  const history = defiHistory(payload, "ALL");
  if (!history) return [];
  return history.dates.map((date, index) => ({ date: date.toISOString().slice(0, 10), tvl: history.values[index] ?? null }));
}

const change = (amount: number | null, percent: number | null) =>
  amount == null ? "—" : `${formatCompactAmount(amount, { signed: true })} (${formatCryptoPercent(percent)})`;

/**
 * How the total's days are dated: each by the UTC day it closes, which
 * DefiLlama stamps 00:00 UTC the day after (Gloom's 4 Nov is its 5 Nov).
 */
export const DEFI_DAY_CONVENTION = "UTC daily closes";

/**
 * `Total DeFi TVL 92.39B · 7D +2.01B (+2.23%) · 30D -1.06B (-1.14%) · as of
 * 2026-10-21 UTC close · DefiLlama, daily since 2018-02-12`, as the CLI states it.
 */
export function defiSummaryLine(payload: DefiTvlPayload): string | null {
  const total = payload.total;
  if (!total) return null;
  const since = defiHistoryStart(payload);
  return [
    `Total DeFi TVL ${formatCompact(total.tvl, { fixedDecimals: true })}`,
    `7D ${change(total.change7d, total.change7dPercent)}`,
    `30D ${change(total.change30d, total.change30dPercent)}`,
    ...(payload.asOf ? [utcCloseAsOfText(payload.asOf)] : []),
    `${payload.source.name}${since ? `, daily since ${since}` : ""}`,
  ].join(" · ");
}

/** A DeFi TVL failure as one sentence: what failed, named once, when the message does not name it. */
export function defiFailure(message: string): string {
  const named = /\bdefi tvl\b/i.test(message) ? message : `DeFi TVL: ${message}`;
  return /[.!?]$/.test(named) ? named : `${named}.`;
}

// Sorting ---------------------------------------------------------------------

type DefiColumnId =
  | "rank"
  | "name"
  | "detail"
  | "tvl"
  | "change1dPercent"
  | "change7d"
  | "change7dPercent"
  | "change30d"
  | "change30dPercent"
  | "share"
  | "chains"
  | "fees24h"
  | "fees7d"
  | "fees30d"
  | "revenue24h"
  | "revenue7d"
  | "revenue30d";

export type DefiColumn = DataTableColumn & { id: DefiColumnId };

export interface DefiSortPreference {
  columnId: DefiColumnId | null;
  direction: SortDirection;
}

export const DEFAULT_DEFI_SORT: DefiSortPreference = { columnId: null, direction: "asc" };

const TEXT_COLUMNS = new Set<DefiColumnId>(["rank", "name", "detail"]);

/** Numbers open largest-first; names open A-Z. */
export function nextDefiSort(current: DefiSortPreference, columnId: string): DefiSortPreference {
  const id = columnId as DefiColumnId;
  return nextHeaderSort(current, id, { firstDirection: TEXT_COLUMNS.has(id) ? "asc" : "desc", resetTo: DEFAULT_DEFI_SORT });
}

export function sortDefiRows(rows: DefiRow[], sort: DefiSortPreference): DefiRow[] {
  const columnId = sort.columnId;
  if (!columnId) return rows;
  return [...rows].sort((left, right) => compareSortValues(left[columnId], right[columnId], sort.direction));
}

// Columns ---------------------------------------------------------------------

type DefiColumnSpec = DefiColumn & { optional?: number };

const PROTOCOL_COLUMNS: DefiColumnSpec[] = [
  { id: "rank", label: "#", width: 3, align: "right" },
  { id: "name", label: "PROTOCOL", width: 14, align: "left" },
  { id: "detail", label: "CATEGORY", width: 14, align: "left", optional: 2 },
  { id: "tvl", label: "TVL", width: 8, align: "right" },
  { id: "change1dPercent", label: "1D%", width: 8, align: "right", optional: 5 },
  { id: "change7d", label: "7D", width: 8, align: "right", optional: 3 },
  { id: "change7dPercent", label: "7D%", width: 8, align: "right" },
  { id: "change30d", label: "30D", width: 8, align: "right", optional: 4 },
  { id: "change30dPercent", label: "30D%", width: 8, align: "right", optional: 1 },
  { id: "chains", label: "CHAINS", width: 6, align: "right", optional: 6 },
  // Fees and revenue, USD, in pairs: the 30-day figures stay longest, the 7-day ones leave first.
  { id: "fees24h", label: "FEES 24H", width: 8, align: "right", optional: 8 },
  { id: "fees7d", label: "FEES 7D", width: 8, align: "right", optional: 9 },
  { id: "fees30d", label: "FEES 30D", width: 8, align: "right", optional: 7 },
  { id: "revenue24h", label: "REV 24H", width: 8, align: "right", optional: 8 },
  { id: "revenue7d", label: "REV 7D", width: 8, align: "right", optional: 9 },
  { id: "revenue30d", label: "REV 30D", width: 8, align: "right", optional: 7 },
];

const CHAIN_COLUMNS: DefiColumnSpec[] = [
  { id: "rank", label: "#", width: 3, align: "right" },
  { id: "name", label: "CHAIN", width: 14, align: "left" },
  { id: "detail", label: "TOKEN", width: 6, align: "left", optional: 2 },
  { id: "tvl", label: "TVL", width: 8, align: "right" },
  { id: "change7d", label: "7D", width: 8, align: "right", optional: 3 },
  { id: "change7dPercent", label: "7D%", width: 8, align: "right" },
  { id: "change30d", label: "30D", width: 8, align: "right", optional: 4 },
  { id: "change30dPercent", label: "30D%", width: 8, align: "right", optional: 1 },
  { id: "share", label: "SHARE", width: 7, align: "right" },
];

const MAX_NAME_WIDTH = 26;

const INCOME_COLUMNS = new Set<DefiColumnId>(["fees24h", "fees7d", "fees30d", "revenue24h", "revenue7d", "revenue30d"]);

/** Whether the board carries the protocols' fees and revenue: a server before them, or a read that failed, has none to show. */
export function defiHasIncome(payload: DefiTvlPayload | null | undefined): boolean {
  return !!payload?.incomeAsOf;
}

/**
 * Optional columns leave in a fixed order as the pane narrows: a protocol's
 * fees and revenue first, in pairs (7D, 24H, then 30D), then dollar changes before
 * percents as on the stablecoin list (the chain count and the day's move, the
 * 30D then 7D dollar change, the category, the 30D percent); the name takes
 * what width is left.
 */
export function buildDefiColumns(width: number, list: DefiList, income = false): DefiColumn[] {
  const specs = list === "chain" ? CHAIN_COLUMNS : income ? PROTOCOL_COLUMNS : PROTOCOL_COLUMNS.filter((column) => !INCOME_COLUMNS.has(column.id));
  const optional = specs.flatMap((column) => column.optional ?? []).sort((a, b) => b - a);
  const dropped = new Set<number>();
  const visible = () => specs.filter((column) => !column.optional || !dropped.has(column.optional));
  for (const priority of optional) {
    if (getTableWidth(visible()) <= width) break;
    dropped.add(priority);
  }
  const columns = visible();
  const spare = Math.max(0, width - getTableWidth(columns));
  return columns.map(({ optional: _optional, ...column }) =>
    column.id === "name" ? { ...column, width: Math.min(MAX_NAME_WIDTH, column.width + spare) } : column);
}
