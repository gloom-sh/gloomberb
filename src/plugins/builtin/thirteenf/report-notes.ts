import type { CrowdingRow, TickerHolderRow } from "./signals";
import { formatMoneyCompact } from "./format";
import type { ThirteenFFilingGap, ThirteenFOtherManager } from "./types";

/**
 * Summary lines for the 13F text reports. Each says which quarters the rows
 * compare, that values are as filed, and, whenever rows are cut, how many
 * are shown and the option that shows the rest.
 */

/** The largest `--limit` the 13F report accepts. */
export const THIRTEENF_MAX_LIMIT = 200;

export const AS_FILED_VALUE = "Value (USD) as reported at period end, not today's price";

/** What a 13F filing leaves out and how late it arrives; the text reports' note and the catalog's limitation. */
export const THIRTEENF_LIMITS = "Long US-listed equity positions only: shorts, cash and most foreign stocks are absent. Filed up to 45 days after quarter end.";

/** The value basis of option rows, for exports. */
export const THIRTEENF_OPTIONS_NOTE = "CALL/PUT rows: Value and Shares are the underlying stock's (notional), not the option premium.";

/** The marker the text reports put on an option row's type, explained by `OPTION_ROWS_NOTE`. */
const OPTION_MARK = "*";
export const OPTION_ROWS_NOTE = `${OPTION_MARK} ${THIRTEENF_OPTIONS_NOTE}`;

export function isOptionType(type: unknown): boolean {
  const text = typeof type === "string" ? type.trim().toUpperCase() : "";
  return text === "CALL" || text === "PUT";
}

/** A position type as the text report prints it: `CALL*` for an option, which `OPTION_ROWS_NOTE` explains. */
export function markedPositionType(type: unknown): string {
  const text = typeof type === "string" && type ? type : "--";
  return isOptionType(type) ? `${text}${OPTION_MARK}` : text;
}

const count = (value: number) => value.toLocaleString("en-US");

function periodText(period: string | null | undefined, previousPeriod?: string | null): string {
  if (!period) return "";
  return previousPeriod ? `Period ${period} vs ${previousPeriod}` : `Period ${period}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

function calendarDay(date: string | null | undefined): Date | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const day = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(day.getTime()) ? day : null;
}

/** "30 Jun 2026", or "30 Jun" in `omitYear`. */
export function filingDayText(date: string, omitYear?: number): string {
  const day = calendarDay(date);
  if (!day) return date;
  const text = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  return day.getUTCFullYear() === omitYear ? text : `${text} ${day.getUTCFullYear()}`;
}

/** Whole days from a quarter end to the filing, or null when either date is unreadable. */
export function filingLagDays(period: string | null | undefined, filed: string | null | undefined): number | null {
  const end = calendarDay(period);
  const day = calendarDay(filed);
  return end && day ? Math.round((day.getTime() - end.getTime()) / DAY_MS) : null;
}

/**
 * "Period 30 Jun · filed 14 Aug 2026 (45 days after quarter end) | QoQ vs 31 Mar":
 * when the positions date from and when they became public. A date in the
 * filing's year leaves its year out.
 */
export function filedPeriodText(
  period: string | null | undefined,
  filed: string | null | undefined,
  previousPeriod?: string | null,
): string {
  if (!period) return "";
  const filedDay = calendarDay(filed);
  if (!filed || !filedDay) return periodText(period, previousPeriod);
  const year = filedDay.getUTCFullYear();
  const lag = filingLagDays(period, filed);
  const after = lag != null && lag >= 0 ? ` (${count(lag)} ${lag === 1 ? "day" : "days"} after quarter end)` : "";
  return [
    `Period ${filingDayText(period, year)} · filed ${filingDayText(filed)}${after}`,
    previousPeriod ? `QoQ vs ${filingDayText(previousPeriod, year)}` : "",
  ].filter(Boolean).join(" | ");
}

/**
 * The quarters whose filings Gloom Cloud restated to dollars, in its own words:
 * "Values restated from thousands: 30 Jun 2026". Empty when none was.
 */
export function restatedValuesText(forms: readonly { periodOfReport: string; valueNote?: string }[]): string {
  const noted = forms.filter((form) => form.valueNote);
  if (noted.length === 0) return "";
  const note = noted[0]!.valueNote!;
  const periods = [...new Set(noted.map((form) => form.periodOfReport))].sort().reverse();
  return `${note[0]!.toUpperCase()}${note.slice(1)}: ${periods.map((period) => filingDayText(period)).join(", ")}`;
}

/** A filer this many quarters behind the reporting cycle has missed a filing, not just filed late. */
export function isStaleFiling(quartersBehind: number | null | undefined): quartersBehind is number {
  return quartersBehind != null && quartersBehind > 1;
}

export function quartersOldText(quarters: number): string {
  return `${count(quarters)} quarters old`;
}

const NOTHING_LATER = "nothing filed for a later quarter";

export function staleFilingText(quarters: number): string {
  return `Latest filing is ${quartersOldText(quarters)}; ${NOTHING_LATER}`;
}

/** The funds in a list whose latest filing is stale, the first few by name. */
export function staleFundsText(funds: readonly { name: string; quarters: number }[], shown = 3): string {
  if (funds.length === 0) return "";
  if (funds.length === 1) return `${funds[0]!.name}: latest filing is ${quartersOldText(funds[0]!.quarters)}; ${NOTHING_LATER}`;
  const named = funds.slice(0, shown).map((fund) => `${fund.name} (${quartersOldText(fund.quarters)})`).join(", ");
  return `Latest filing 2+ quarters old: ${named}${funds.length > shown ? ` and ${count(funds.length - shown)} more` : ""}`;
}

/** "Q2 2026" for the quarter ending 30 Jun 2026. */
function quarterText(period: string): string {
  const day = calendarDay(period);
  return day ? `Q${Math.floor(day.getUTCMonth() / 3) + 1} ${day.getUTCFullYear()}` : period;
}

/** The fund to open for a manager: its CIK, else its quoted name. */
function openCommand(manager: ThirteenFOtherManager): string {
  return manager.cik ? `fn 13F ${manager.cik}` : `fn 13F "${manager.name}"`;
}

/**
 * What a fund filed for the newest quarter past its deadline instead of a
 * holdings report: "13F-NT for Q2 2026, filed 14 Aug; holdings reported by
 * PERSHING SQUARE INC. | open: fn 13F 0002026053", or "No 13F for Q2 2026,
 * due 14 Aug". `command: false` names the CIK instead of the command, for the
 * pane.
 */
export function filingGapText(gap: ThirteenFFilingGap, { command = true }: { command?: boolean } = {}): string {
  const quarter = quarterText(gap.period);
  const year = Number(gap.due.slice(0, 4));
  const filing = gap.filing;
  if (filing?.form.startsWith("13F-NT")) {
    const [first, ...others] = filing.otherManagers ?? [];
    const filed = `13F-NT for ${quarter}, filed ${filingDayText(filing.filed, year)}`;
    if (!first) return `${filed}; another manager reported its holdings`;
    const more = others.length ? ` and ${count(others.length)} more` : "";
    return command
      ? `${filed}; holdings reported by ${first.name}${more} | open: ${openCommand(first)}`
      : `${filed}; holdings reported by ${first.name}${first.cik ? ` (CIK ${first.cik})` : ""}${more}`;
  }
  if (filing) return `${filing.form} for ${quarter} filed ${filingDayText(filing.filed, year)}; its holdings are not loaded yet`;
  return `No 13F for ${quarter}, due ${filingDayText(gap.due, year)}`;
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
