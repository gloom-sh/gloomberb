import type { DataTableColumn, StatItem } from "../../../components";
import type { HiringCompanyMoves, HiringMove, HiringMoveExclusion, HiringMovePosting, HiringMovesBoard, HiringMovesFilter } from "../../../api-client/hiring";
import { formatNumber } from "../../../utils/format";
import { countOf, freePreviewNote } from "../shared/free-preview";
import { humanLabel } from "../shared/research-cells";
import type { AttentionRow } from "./model";

/**
 * HIRE's Moves tab: each covered company's new roles in the latest complete
 * UTC week against its own measured weeks and its peers' (docs/hiring.md in
 * the server, Hiring moves). The board lists the moves; a company shows its
 * weeks, what drove the move and the postings behind it.
 */
export type MovesView = "weeks" | "drivers" | "titles" | "added" | "closed";
export const MOVES_VIEWS: ReadonlyArray<{ value: MovesView; label: string }> = [
  { value: "weeks", label: "Weeks" }, { value: "drivers", label: "Role families" }, { value: "titles", label: "Titles" },
  { value: "added", label: "New postings" }, { value: "closed", label: "Closed postings" },
];
export const MOVES_FILTERS: ReadonlyArray<{ value: HiringMovesFilter; label: string }> = [
  { value: "moves", label: "Moves" }, { value: "accelerating", label: "Accelerating" }, { value: "slowing", label: "Slowing" }, { value: "all", label: "All measured" },
];
export const isMovesView = (value: string): value is MovesView => MOVES_VIEWS.some((view) => view.value === value);
export const isMovesFilter = (value: string): value is HiringMovesFilter => MOVES_FILTERS.some((filter) => filter.value === value);

/** What changed in the collection that week, so its new roles say nothing about hiring. */
const EXCLUSION_LABELS: Record<HiringMoveExclusion, string> = {
  first_read: "First read", source_added: "Board added later", identity_reset: "Identity repaired", catch_up: "Catch-up step",
  retired: "Board retired", truncated: "Truncated read", rediscovered: "Board rediscovered", recipe_restored: "Recipe restored",
  careers_url_dropped: "Careers address dropped", read_gap: "Gap between reads", collapsed: "Board collapsed", no_read: "No read",
  vendor_wide: "Vendor-wide change",
};
const exclusionText = (reasons: readonly HiringMoveExclusion[]) => reasons.map((reason) => EXCLUSION_LABELS[reason] ?? humanLabel(reason)).join(", ");

/** A measured week with no move is in line with its own weeks. */
function signalLabel(signal: HiringMove["signal"]): string {
  return signal === "accelerating" ? "Accelerating" : signal === "slowing" ? "Slowing" : signal === "with_peers" ? "With peers" : "In line";
}
export const SIGNAL_TONE: Record<string, "positive" | "negative" | "muted"> = { Accelerating: "positive", Slowing: "negative", "With peers": "muted", "In line": "muted" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 12": the Monday a UTC week starts on. */
function weekLabel(week: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(week ?? "");
  return match ? `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}` : "--";
}
/** 3.4x, 0.4x, 74x: a pace against an average. */
const pace = (value: number | null | undefined) => value == null ? "--" : `${formatNumber(value, Math.abs(value) >= 10 ? 0 : 1)}x`;
const count = (value: number | null | undefined) => value == null ? "--" : formatNumber(value, 0);
/** An average of a few weeks keeps a decimal while it is small: 6.7 a week, not 7. */
const average = (value: number) => formatNumber(value, value < 10 ? 1 : 0);
const signed = (value: number, decimals = 0) => `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;

const PACE_COLUMNS = new Set(["pace", "peers", "relative"]);
export const MOVES_SIGNED_COLUMNS = new Set(["z", "change"]);
/** A moves column's number as the pane and the report print it. */
export function movesNumber(columnId: string, value: number): string {
  if (PACE_COLUMNS.has(columnId)) return pace(value);
  if (columnId === "z") return signed(value, 1);
  if (columnId === "change") return signed(Math.round(value));
  if (columnId === "mean") return average(value);
  return count(value);
}

/** The role family that moved most in the move's direction: "Operations +209". */
function driverText(move: Pick<HiringMove, "drivers">): string | null {
  const driver = move.drivers[0];
  return driver ? `${driver.label} ${signed(Math.round(driver.newRoles - driver.baselineMean))}` : null;
}

const peerGroup = (move: HiringMove) => move.peers.group === "universe" ? `All covered companies (${count(move.peers.companies)})`
  : `${move.peers.label} ${move.peers.group} (${count(move.peers.companies)})`;

/** A move's numbers, as its detail lists them with the sentence that says why; the detail's title names the week. */
export function moveFacts(move: HiringMove): Array<{ label: string; value: string }> {
  const baseline = `${average(move.baseline.mean)} a week over ${countOf(move.baseline.weeks, "measured week")}`;
  return [
    { label: "Signal", value: signalLabel(move.signal) },
    { label: "New roles", value: count(move.newRoles) },
    { label: "Average before", value: move.baseline.values.length ? `${baseline}: ${move.baseline.values.map((row) => count(row.newRoles)).join(", ")}` : baseline },
    { label: "Pace", value: `${pace(move.ratio)} its average, z ${signed(move.zScore, 1)}` },
    { label: "Peers", value: `${pace(move.peers.medianRatio)}, ${peerGroup(move)}` },
    { label: "Against peers", value: pace(move.peerRelative) },
    ...(move.drivers.length ? [{ label: "Role families", value: move.drivers.map((row) => `${row.label} ${count(row.newRoles)} (${average(row.baselineMean)} a week)`).join(", ") }] : []),
    ...(move.topTitles.length ? [{ label: "Top titles", value: move.topTitles.map((row) => `${row.title.trim()} (${count(row.count)})`).join(", ") }] : []),
    { label: "Roles closed", value: count(move.closedRoles) },
    { label: "Open roles", value: count(move.openRoles) },
    { label: "Boards", value: move.sourceTickers.join(", ") },
    { label: "First computed", value: move.firstComputedAt },
  ];
}

export interface MovesRow extends AttentionRow {
  move?: HiringMove;
  posting?: HiringMovePosting;
}
export interface MovesSection {
  columns: DataTableColumn[];
  rows: MovesRow[];
  empty: string;
  /** Rows the free preview holds back. */
  locked: number;
}
export interface MovesModel {
  asOf: string | null;
  week: string | null;
  preview: boolean;
  figures: StatItem[];
  /** The board's one section, or a company's views. */
  sections: Partial<Record<MovesView | "board", MovesSection>>;
  /** A company's latest move, for its detail and its sentence. */
  latest: HiringMove | null;
}

const column = (id: string, label: string, width: number, numeric = false, flex = false): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flex ? { flexGrow: 1 } : {}) });
const BOARD_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 22, false, true), column("signal", "Signal", 13), column("newRoles", "New roles", 10, true),
  column("mean", "Avg / week", 11, true), column("pace", "Pace", 7, true), column("z", "Z-score", 9, true), column("peers", "Peers", 7, true), column("driver", "Driver", 24)];

const moveRow = (move: HiringMove): MovesRow => ({ id: move.symbol, symbol: move.symbol, move, values: { symbol: move.symbol, name: move.name, signal: signalLabel(move.signal), newRoles: move.newRoles,
  mean: move.baseline.mean, pace: move.ratio, z: move.zScore, peers: move.peers.medianRatio, driver: driverText(move) } });

export function movesBoardModel(board: HiringMovesBoard, filter: HiringMovesFilter): MovesModel {
  const { coverage } = board;
  return {
    asOf: coverage.computedAt,
    week: board.week,
    preview: board.preview,
    figures: board.week ? [
      { label: "Accelerating", value: count(coverage.signals.accelerating), tone: coverage.signals.accelerating ? "positive" : "muted" },
      { label: "Slowing", value: count(coverage.signals.slowing), tone: coverage.signals.slowing ? "negative" : "muted" },
      { label: "With peers", value: count(coverage.signals.withPeers) },
      { label: "Measured", value: count(coverage.measured), detail: `week of ${weekLabel(board.week)}`, detailVariants: [`wk ${weekLabel(board.week)}`, ""] },
      { label: "Not measured", value: count(coverage.unmeasured), detail: "collection changed", detailVariants: [""] },
    ] : [],
    sections: { board: { columns: BOARD_COLUMNS, rows: board.moves.map(moveRow), locked: board.preview ? board.locked : 0,
      empty: !board.week ? "No week has been measured yet." : filter === "all" ? "No company was measured this week." : "No company moved against its own weeks this week." } },
    latest: null,
  };
}

const POSTING_COLUMNS = (date: string) => [column("title", "Role", 32, false, true), column("location", "Location", 24), column("function", "Role family", 16), column("seniority", "Seniority", 12), column("date", date, 12)];
const roleFamily = (value: string | null) => value === "data_ai" ? "Data / AI" : value ? humanLabel(value) : null;
const postingRow = (closed: boolean) => (posting: HiringMovePosting): MovesRow => ({
  id: `${closed ? "closed" : "added"}:${posting.id}`, url: posting.url, posting,
  values: { title: posting.title.trim(), location: posting.location ?? posting.country, country: posting.country, function: roleFamily(posting.jobFunction), seniority: posting.seniority ? humanLabel(posting.seniority) : null,
    date: (closed ? posting.closedAt ?? posting.firstSeenAt : posting.firstSeenAt).slice(0, 10) },
  details: [{ label: "Posting title", value: posting.title.trim() }, { label: "Location", value: posting.location ?? "--" }, { label: "Country", value: posting.country ?? "Unknown" },
    { label: "Role family", value: roleFamily(posting.jobFunction) ?? "Unclassified" }, { label: "Seniority", value: posting.seniority ? humanLabel(posting.seniority) : "Unclassified" },
    { label: "First seen", value: posting.firstSeenAt }, ...(posting.closedAt ? [{ label: "Closed", value: posting.closedAt }] : []), { label: "Board", value: posting.sourceTicker }],
});

export function companyMovesModel(data: HiringCompanyMoves): MovesModel {
  const latest = data.latest;
  const moves = new Map(data.history.map((row) => [row.week, row]));
  // A free read keeps the latest week; the rest are history.
  const weeks = data.weeks.length ? data.weeks : data.week ? [data.week] : [];
  const tone = (signal: HiringMove["signal"]) => signal === "accelerating" ? "positive" as const : signal === "slowing" ? "negative" as const : undefined;
  const figures: StatItem[] = latest ? [
    { label: "New roles", value: count(latest.newRoles), detail: `week of ${weekLabel(latest.week)}`, detailVariants: [`wk ${weekLabel(latest.week)}`, ""] },
    { label: "Average", value: average(latest.baseline.mean), detail: `a week, ${latest.baseline.weeks} before`, detailVariants: ["a week", ""] },
    { label: "Pace", value: pace(latest.ratio), detail: `z ${signed(latest.zScore, 1)}`, tone: tone(latest.direction) },
    { label: "Peers", value: pace(latest.peers.medianRatio), detail: latest.peers.group === "universe" ? "all covered" : latest.peers.label, detailVariants: [""] },
    { label: "Signal", value: signalLabel(latest.signal), detail: driverText(latest) ?? undefined, detailVariants: [""], tone: tone(latest.signal) },
  ] : data.week && !data.week.measured ? [
    { label: "New roles", value: count(data.week.newRoles), detail: `week of ${weekLabel(data.week.week)}`, detailVariants: [`wk ${weekLabel(data.week.week)}`, ""] },
    { label: "Not measured", value: exclusionText(data.week.excluded) || "--", wide: true },
  ] : [];
  const historyLocked = data.preview ? Math.max(0, data.locked.history - weeks.length) : 0;
  return {
    asOf: latest?.computedAt ?? data.history[0]?.computedAt ?? null,
    week: latest?.week ?? data.week?.week ?? null,
    preview: data.preview,
    figures,
    latest,
    sections: {
      weeks: {
        columns: [column("week", "Week of", 12), column("newRoles", "New roles", 10, true), column("closedRoles", "Closed", 9, true), column("openRoles", "Open", 9, true),
          column("pace", "Pace", 7, true), column("z", "Z-score", 9, true), column("signal", "Signal", 12), column("excluded", "Not measured", 24, false, true)],
        rows: weeks.map((week): MovesRow => {
          const full = latest?.week === week.week ? latest : undefined;
          // A free read has no history but keeps the latest move.
          const move = moves.get(week.week) ?? full;
          return { id: week.week, date: week.week, ...(full ? { move: full } : {}), values: { week: week.week, newRoles: week.newRoles, closedRoles: week.closedRoles, openRoles: week.openRoles,
            pace: move?.ratio ?? null, z: move?.zScore ?? null, signal: move ? signalLabel(move.signal) : null, excluded: week.measured ? null : exclusionText(week.excluded) } };
        }),
        locked: historyLocked,
        empty: "No week of this company's postings has been read yet.",
      },
      drivers: {
        columns: [column("label", "Role family", 24, false, true), column("newRoles", "New roles", 10, true), column("mean", "Avg / week", 11, true), column("change", "Change", 9, true)],
        rows: (latest?.drivers ?? []).map((row): MovesRow => ({ id: row.id, values: { label: row.label, newRoles: row.newRoles, mean: row.baselineMean, change: row.newRoles - row.baselineMean } })),
        locked: 0,
        empty: latest ? "No role family stands out in this week." : "No measured move for this company yet.",
      },
      titles: {
        columns: [column("title", "Title", 40, false, true), column("count", "New roles", 10, true)],
        rows: (latest?.topTitles ?? []).map((row): MovesRow => ({ id: row.title, values: { title: row.title.trim(), count: row.count } })),
        locked: 0,
        empty: latest ? "No title repeats in this week's new roles." : "No measured move for this company yet.",
      },
      added: { columns: POSTING_COLUMNS("First seen"), rows: data.evidence.added.map(postingRow(false)), locked: data.preview ? data.locked.added : 0, empty: "No posting was first seen this week." },
      closed: { columns: POSTING_COLUMNS("Closed"), rows: data.evidence.closed.map(postingRow(true)), locked: data.preview ? data.locked.closed : 0, empty: "No posting closed this week." },
    },
  };
}

/** The lock line of a free moves read: what free shows and what Pro adds. Null when nothing is held back. */
export function movesPreviewNote(data: HiringMovesBoard | HiringCompanyMoves): string | null {
  if (!data.preview) return null;
  if ("moves" in data) {
    return data.locked > 0 ? freePreviewNote({ shows: `${data.moves.length} of ${count(data.total)} moves`, adds: `the other ${count(data.locked)}` }) : null;
  }
  const { history, added, closed } = data.locked;
  if (history + added + closed <= 0) return null;
  const adds = [history > 0 ? `${countOf(history, "week")} of history` : "", added + closed > 0 ? `${countOf(added + closed, "more posting")}` : ""].filter(Boolean);
  return freePreviewNote({ shows: "the latest week and three postings each way", adds: adds.join(" and ") });
}
