import type { CrowdingRow, TickerHolderRow } from "./signals";
import { formatMoneyCompact } from "./format";

/**
 * Summary lines for the 13F text reports. Each says which quarters the rows
 * compare, that values are as filed, and, whenever rows are cut, how many
 * are shown and the option that shows the rest.
 */

/** The largest `--limit` the 13F report accepts. */
export const THIRTEENF_MAX_LIMIT = 200;

export const AS_FILED_VALUE = "Value (USD) as reported at period end, not today's price";

const count = (value: number) => value.toLocaleString("en-US");

export function periodText(period: string | null | undefined, previousPeriod?: string | null): string {
  if (!period) return "";
  return previousPeriod ? `Period ${period} vs ${previousPeriod}` : `Period ${period}`;
}

/** "showing 50 of 374" from the start of the list, "showing 51-100 of 374" past it. */
function shownRangeText(offset: number, end: number, total: number): string {
  return offset > 0
    ? `showing ${count(offset + 1)}-${count(end)} of ${count(total)}`
    : `showing ${count(end)} of ${count(total)}`;
}

/** "showing 50 of 104 positions | more: --limit 104"; empty when nothing is cut. */
export function cutText(total: number, limit: number, noun: string): string {
  if (total <= limit) return "";
  return [
    `showing ${count(limit)} of ${count(total)} ${noun}`,
    limit < THIRTEENF_MAX_LIMIT ? `more: --limit ${Math.min(THIRTEENF_MAX_LIMIT, total)}` : "",
  ].filter(Boolean).join(" | ");
}

export interface TickerHoldingsSummary {
  notices: string[];
  /** Funds in the list: holders, then the funds that exited. */
  total: number;
  /** The fund offset where the next page starts. */
  nextOffset: number;
  /** Funds with rows shown. */
  shownFunds: number;
  /** Rows follow the ones shown. */
  truncated: boolean;
  /** Reported value of the positions shown, exits excluded. */
  shownValue: number | null;
}

/**
 * The ticker-holdings list ranks a quarter's holders by size, then the funds
 * that exited. A fund can have several rows (shares, calls, puts), so pages
 * are counted in funds.
 */
export function summarizeTickerHoldings(input: {
  period: string;
  previousPeriod?: string | null;
  holderCount: number;
  newCount?: number | null;
  exitCount?: number | null;
  offset: number;
  limit: number;
  /** Rows of the pages loaded from `offset`, in list order. */
  loaded: readonly Pick<TickerHolderRow, "cik" | "value" | "action">[];
  /** The source has pages after the loaded ones, from `nextOffset`. */
  hasMore: boolean;
  nextOffset: number;
}): TickerHoldingsSummary {
  const shownRows = input.loaded.slice(0, input.limit);
  const funds = [...new Set(shownRows.map((row) => row.cik))];
  const cut = input.loaded.length > shownRows.length;
  const lastCut = cut && input.loaded[shownRows.length]?.cik === shownRows.at(-1)?.cik;
  // A fund whose holdings could not be read keeps its place in the source's
  // list without rows, so a cut page restarts after the funds shown whole:
  // that can repeat a few, never skip one.
  const nextOffset = cut ? input.offset + Math.max(1, funds.length - (lastCut ? 1 : 0)) : input.nextOffset;
  const truncated = cut || input.hasMore;
  const partial = truncated || input.offset > 0;
  const compared = !!input.previousPeriod;
  const exits = compared ? input.exitCount ?? 0 : 0;
  const listed = input.holderCount + exits;
  // The source's next offset steps a whole page, past the end of the list on the last one.
  const total = truncated ? Math.max(listed, nextOffset + 1) : Math.max(listed, input.offset + funds.length);
  const end = !truncated ? total : cut ? input.offset + funds.length : nextOffset;
  const shownValue = shownRows
    .filter((row) => row.action !== "exit")
    .reduce<number | null>((sum, row) => (sum != null && row.value != null ? sum + row.value : null), 0);
  const holders = [
    `${count(input.holderCount)} holders`,
    compared && input.newCount != null ? ` (${count(input.newCount)} new)` : "",
    compared && input.exitCount != null ? `, ${count(input.exitCount)} exited` : "",
    !partial && shownValue ? `, total ${formatMoneyCompact(shownValue)}` : "",
  ].join("");
  const notices = [[periodText(input.period, input.previousPeriod), holders, AS_FILED_VALUE].filter(Boolean).join(" | ")];
  if (partial) {
    const shown = [
      `${shownRangeText(input.offset, end, total)} funds`,
      exits > 0 ? ", exits last" : "",
      shownValue ? `; the ${count(funds.length)} shown hold ${formatMoneyCompact(shownValue)}` : "",
    ].join("");
    // The limit counts rows and a fund can have several, so the larger page is the safe suggestion.
    const more = truncated
      ? `more: --offset ${nextOffset}${input.limit < THIRTEENF_MAX_LIMIT ? ` or --limit ${THIRTEENF_MAX_LIMIT}` : ""}`
      : null;
    notices.push([`${shown[0]!.toUpperCase()}${shown.slice(1)}`, more].filter(Boolean).join(" | "));
  }
  return { notices, total, nextOffset, shownFunds: funds.length, truncated, shownValue };
}

type CrowdingRank = "new" | "exits" | "increases" | "decreases";

const RANK_LABELS: Record<CrowdingRank, string> = {
  new: "new holders",
  exits: "exits",
  increases: "weight increase",
  decreases: "weight decrease",
};

export function compareCrowding(rank: string, left: CrowdingRow, right: CrowdingRow): number {
  if (rank === "new") return right.newCount - left.newCount;
  if (rank === "exits") return right.exitCount - left.exitCount;
  if (left.weightChange == null) return right.weightChange == null ? 0 : 1;
  if (right.weightChange == null) return -1;
  return (left.weightChange - right.weightChange) * (rank === "decreases" ? 1 : -1);
}

/**
 * One ticker's place in the crowding ranking. Ties share a rank, so the
 * number is how many securities rank strictly ahead, plus one.
 */
export function crowdingForTicker(
  ranked: readonly CrowdingRow[],
  ticker: string,
  rank: string,
): { rows: Array<CrowdingRow & { rank: number }>; notice: string } {
  const label = RANK_LABELS[rank as CrowdingRank] ?? rank;
  const rows = ranked
    .filter((row) => row.ticker.toUpperCase() === ticker)
    .map((row) => ({ ...row, rank: 1 + ranked.filter((other) => compareCrowding(rank, other, row) < 0).length }));
  const of = `of ${count(ranked.length)} securities by ${label}`;
  const notice = rows.length === 0
    ? `${ticker} is not in this ranking | full ranking: fn 13F --view crowding | its 13F holders: fn 13F ${ticker}`
    : rows.length === 1
      ? `${ticker} ranks ${count(rows[0]!.rank)} ${of} | full ranking: fn 13F --view crowding`
      : `${ticker} ranks ${rows.map((row) => `${count(row.rank)} (${row.type})`).join(", ")} ${of} | full ranking: fn 13F --view crowding`;
  return { rows, notice };
}
