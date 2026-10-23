import type { DataTableColumn, StatItem } from "../../../components";
import type { HiringCompanySignals, HiringMovePosting, HiringSignalFlag, HiringSignalGroup, HiringSignalHold, HiringSignalKind, HiringSignalSkip, HiringSignalsBoard, HiringSignalsFilter, HiringWeekSignal } from "../../../api-client/hiring";
import { formatNumber } from "../../../utils/format";
import { countOf, freePreviewNote, previewCantFilter } from "../shared/free-preview";
import { humanLabel } from "../shared/research-cells";
import type { AttentionRow } from "./model";

/**
 * HIRE's Expansion and Anomalies tabs (docs/hiring-app-attention.md):
 * a company's first roles in a country or city, one place or role family far
 * above its own weeks, and role families it never posted, in the latest
 * complete week. "Never" goes back to the company's first read: a first is
 * the first seen since then, never the first ever, and every row says since when.
 */
export type SignalsView = "signals" | "postings";
export const SIGNALS_VIEWS: ReadonlyArray<{ value: SignalsView; label: string }> = [{ value: "signals", label: "Signals" }, { value: "postings", label: "Postings" }];
export const isSignalsView = (value: string): value is SignalsView => SIGNALS_VIEWS.some((view) => view.value === value);
export const SIGNAL_GROUPS: readonly HiringSignalGroup[] = ["expansion", "anomalies"];
export const isSignalGroup = (value: string): value is HiringSignalGroup => (SIGNAL_GROUPS as readonly string[]).includes(value);
export const SIGNAL_FILTERS: Record<HiringSignalGroup, ReadonlyArray<{ value: HiringSignalsFilter; label: string }>> = {
  expansion: [{ value: "all", label: "All" }, { value: "new_country", label: "New countries" }, { value: "new_city", label: "New cities" }],
  anomalies: [{ value: "all", label: "All" }, { value: "location_spike", label: "Place spikes" }, { value: "function_spike", label: "Role family spikes" }, { value: "new_role_type", label: "New role families" }],
};
export const isSignalsFilter = (group: HiringSignalGroup, value: string): value is HiringSignalsFilter => SIGNAL_FILTERS[group].some((filter) => filter.value === value);

const KIND_LABELS: Record<HiringSignalKind, string> = {
  new_country: "New country", new_city: "New city", location_spike: "Place spike", function_spike: "Family spike", new_role_type: "New family",
};
/** Shown, ranked last: the count may not keep to its week. */
const FLAG_LABELS: Record<HiringSignalFlag, string> = { few_reads: "Few reads", one_day_batch: "One-day batch" };
const HOLD_LABELS: Record<HiringSignalHold, string> = {
  unmeasured: "Week not measured: the collection changed",
  short_watch: "Read for under three weeks before it",
  recounted: "Postings well above its new roles (re-listed roles)",
};
const SKIP_LABELS: Record<HiringSignalSkip, string> = {
  thin_history: "Under 6 weeks of reads or 100 earlier postings",
  unplaced_history: "Under 90% of earlier postings placed",
  unplaced_cities: "Under 90% of earlier postings naming a city",
  unclassified_history: "Under 90% of earlier postings with a role family",
  reformatted: "Its boards wrote their places anew",
  posted_before_watch: "Roles dated before its first read",
  similar_city: "A new city named like a known one",
  one_day: "A spike mostly posted on one day",
};
const kindText = (kind: HiringSignalKind) => KIND_LABELS[kind] ?? humanLabel(kind);
const flagText = (signal: Pick<HiringWeekSignal, "flags">) => signal.flags.map((flag) => FLAG_LABELS[flag] ?? humanLabel(flag)).join(", ") || null;
export const holdText = (hold: HiringSignalHold) => HOLD_LABELS[hold] ?? humanLabel(hold);
const skipText = (skips: readonly HiringSignalSkip[]) => skips.map((skip) => SKIP_LABELS[skip] ?? humanLabel(skip)).join(", ");
const isFirst = (signal: Pick<HiringWeekSignal, "kind">) => signal.kind === "new_country" || signal.kind === "new_city" || signal.kind === "new_role_type";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 12": a week's Monday or a first read's day. */
function dayLabel(value: string | null | undefined, year = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}${year ? `, ${match[1]}` : ""}` : "--";
}
const pace = (value: number | null | undefined) => value == null ? "--" : `${formatNumber(value, Math.abs(value) >= 10 ? 0 : 1)}x`;
const count = (value: number | null | undefined) => value == null ? "--" : formatNumber(value, 0);
const average = (value: number) => formatNumber(value, value < 10 ? 1 : 0);
const signed = (value: number, decimals = 0) => `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;
const percent = (value: number | null) => value == null ? "--" : `${Math.round(value * 100)}%`;

const PACE_COLUMNS = new Set(["pace", "companyPace"]);
export const SIGNALS_SIGNED_COLUMNS = new Set(["z"]);
/** A signals column's number as the pane and the report print it. */
export function signalsNumber(columnId: string, value: number): string {
  if (PACE_COLUMNS.has(columnId)) return pace(value);
  if (columnId === "z") return signed(value, 1);
  if (columnId === "mean") return average(value);
  return count(value);
}

/** How far back "never" goes for this company: "Sep 17, 2026, none of 703 earlier postings (98% placed)". */
function neverText(signal: HiringWeekSignal): string {
  const what = signal.dimension === "function" ? "with a role family" : signal.dimension === "city" ? "naming a city" : "placed";
  return `${dayLabel(signal.history.watchedSince, true)}, none of ${count(signal.history.priorPostings)} earlier postings (${percent(signal.history.priorShare)} ${what})`;
}

/** A signal's numbers, as its detail lists them with the sentence that says why. */
export function signalFacts(signal: HiringWeekSignal): Array<{ label: string; value: string }> {
  const baseline = signal.baseline;
  return [
    { label: "Signal", value: kindText(signal.kind) },
    { label: signal.dimension === "function" ? "Role family" : signal.dimension === "city" ? "City" : "Country", value: signal.label },
    { label: "New roles", value: `${count(signal.newRoles)} under ${countOf(signal.titles, "title")}, week of ${dayLabel(signal.week, true)}` },
    ...(isFirst(signal) ? [{ label: "First seen since", value: neverText(signal) }] : []),
    ...(baseline ? [
      { label: "Average before", value: `${average(baseline.mean)} a week over ${countOf(baseline.weeks, "measured week")}${baseline.values.length ? `: ${baseline.values.map((row) => count(row.newRoles)).join(", ")}` : ""}` },
      { label: "Pace", value: `${pace(signal.ratio)} its average${signal.zScore == null ? "" : `, z ${signed(signal.zScore, 1)}`}` },
      { label: "Company pace", value: `${pace(signal.companyRatio)}, ${signal.dimension === "function" ? "its roles with a role family" : signal.dimension === "city" ? "its roles placed in a city" : "its placed roles"}` },
    ] : []),
    ...(signal.flags.length ? [{ label: "Check", value: `${flagText(signal)}${signal.reads != null ? `, ${countOf(signal.reads, "read")} that week` : ""}` }] : []),
    ...(signal.places.length ? [{ label: signal.dimension === "country" ? "Cities" : "Where", value: signal.places.map((row) => `${row.label} (${count(row.count)})`).join(", ") }] : []),
    ...(signal.topTitles.length ? [{ label: "Top titles", value: signal.topTitles.map((row) => `${row.title.trim()} (${count(row.count)})`).join(", ") }] : []),
    { label: "Boards", value: signal.sourceTickers.join(", ") },
    { label: "First computed", value: signal.firstComputedAt },
  ];
}

export interface SignalsRow extends AttentionRow {
  signal?: HiringWeekSignal;
  jobPosting?: HiringMovePosting;
}
export interface SignalsSection {
  columns: DataTableColumn[];
  rows: SignalsRow[];
  empty: string;
  locked: number;
}
export interface SignalsModel {
  asOf: string | null;
  week: string | null;
  preview: boolean;
  figures: StatItem[];
  sections: Partial<Record<SignalsView | "board", SignalsSection>>;
  /** Why a company's week gives none, for its report. */
  held: string | null;
}

const column = (id: string, label: string, width: number, numeric = false, flex = false): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flex ? { flexGrow: 1 } : {}) });
const CHECK_COLUMN = column("check", "Check", 14);
const EXPANSION_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 20, false, true), column("kind", "Signal", 12), column("label", "Where", 24),
  column("newRoles", "New roles", 10, true), column("titles", "Titles", 7, true), column("prior", "Earlier", 9, true), column("since", "Since", 8), column("title", "Top title", 26)];
const ANOMALY_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 20, false, true), column("kind", "Signal", 13), column("label", "What", 24),
  column("newRoles", "New roles", 10, true), column("mean", "Avg / week", 11, true), column("pace", "Pace", 7, true), column("z", "Z-score", 9, true), column("companyPace", "Company", 8, true)];

/** The row's place for a flag: a country code, or a city's. */
const placeCountry = (signal: HiringWeekSignal) => signal.dimension === "function" ? null : signal.country;
const topTitle = (signal: HiringWeekSignal) => signal.topTitles[0]?.title.trim() ?? signal.postings[0]?.title.trim() ?? null;
const signalRow = (signal: HiringWeekSignal, withWeek = false): SignalsRow => ({
  id: `${signal.symbol}:${signal.week}:${signal.kind}:${signal.key}`, symbol: signal.symbol, signal, date: signal.week,
  values: { ...(withWeek ? { week: signal.week } : {}), symbol: signal.symbol, name: signal.name, kind: kindText(signal.kind), label: signal.label, country: placeCountry(signal),
    newRoles: signal.newRoles, titles: signal.titles, prior: isFirst(signal) ? signal.history.priorPostings : null, since: isFirst(signal) ? dayLabel(signal.history.watchedSince) : null,
    title: topTitle(signal), mean: signal.baseline?.mean ?? null, pace: signal.ratio, z: signal.zScore, companyPace: signal.companyRatio, check: flagText(signal) },
});

const columnsFor = (group: HiringSignalGroup, signals: readonly HiringWeekSignal[]) => {
  const base = group === "expansion" ? EXPANSION_COLUMNS : ANOMALY_COLUMNS;
  return signals.some((signal) => signal.flags.length) ? [...base, CHECK_COLUMN] : base;
};

function boardFigures(board: HiringSignalsBoard): StatItem[] {
  const { coverage } = board;
  const counts = (kind: HiringSignalKind) => count(coverage.counts[kind] ?? 0);
  const held = Object.values(coverage.held).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const own = board.group === "expansion"
    ? [{ label: "New countries", value: counts("new_country") }, { label: "New cities", value: counts("new_city") }]
    : [{ label: "Place spikes", value: counts("location_spike") }, { label: "Family spikes", value: counts("function_spike") }, { label: "New families", value: counts("new_role_type") }];
  return board.week ? [
    ...own,
    { label: "Measured", value: count(coverage.measured), detail: `week of ${dayLabel(board.week)}`, detailVariants: [`wk ${dayLabel(board.week)}`, ""] },
    // How far back "never" goes: the first reads of the companies measured.
    ...(board.group === "expansion" || coverage.watchedFrom ? [{ label: "First seen since", value: dayLabel(coverage.watchedFrom), detail: "first reads", detailVariants: [""] }] : []),
    { label: "Held", value: count(held), detail: "week not comparable", detailVariants: [""] },
  ] : [];
}

export function signalsBoardModel(board: HiringSignalsBoard, filter: HiringSignalsFilter): SignalsModel {
  const label = board.group === "expansion" ? "No company posted its first roles in a new country or city this week." : "No place or role family stood out from a company's own weeks this week.";
  return {
    asOf: board.coverage.computedAt,
    week: board.week,
    preview: board.preview,
    figures: boardFigures(board),
    held: null,
    sections: { board: { columns: columnsFor(board.group, board.signals), rows: board.signals.map((signal) => signalRow(signal)), locked: board.preview ? board.locked : 0,
      empty: !board.week ? "No week has been computed yet." : filter === "all" ? label : "None of this kind this week." } },
  };
}

const POSTING_COLUMNS = [column("title", "Role", 32, false, true), column("location", "Location", 24), column("signal", "Signal", 22), column("function", "Role family", 16), column("date", "First seen", 12)];
const roleFamily = (value: string | null) => value === "data_ai" ? "Data / AI" : value ? humanLabel(value) : null;
const postingRow = (signal: HiringWeekSignal) => (posting: HiringMovePosting): SignalsRow => ({
  id: `${signal.kind}:${signal.key}:${posting.id}`, url: posting.url, jobPosting: posting, signal,
  values: { title: posting.title.trim(), location: posting.location ?? posting.country, country: posting.country, signal: `${kindText(signal.kind)}: ${signal.label}`,
    function: roleFamily(posting.jobFunction), date: posting.firstSeenAt.slice(0, 10) },
  details: [{ label: "Posting title", value: posting.title.trim() }, { label: "Location", value: posting.location ?? "--" }, { label: "Country", value: posting.country ?? "Unknown" },
    { label: "Role family", value: roleFamily(posting.jobFunction) ?? "Unclassified" }, { label: "Signal", value: `${kindText(signal.kind)}: ${signal.label}` },
    { label: "First seen", value: posting.firstSeenAt }, { label: "Board", value: posting.sourceTicker }],
});

/** A company's signals of one group: this week's, then earlier weeks', and the postings behind this week's. */
export function companySignalsModel(data: HiringCompanySignals, group: HiringSignalGroup): SignalsModel {
  const current = data.signals.filter((signal) => signal.group === group);
  const earlier = data.history.filter((signal) => signal.group === group);
  const held = data.held ? holdText(data.held) : null;
  // A free read counts what it holds back by tab; a server before that, both tabs together.
  const lockedRows = !data.preview ? 0 : data.locked[group] ?? data.locked.signals + data.locked.history;
  const figures: StatItem[] = data.week ? [
    { label: "Signals", value: count(current.length), detail: `week of ${dayLabel(data.week)}`, detailVariants: [`wk ${dayLabel(data.week)}`, ""] },
    ...(data.preview && lockedRows ? [{ label: "In Pro", value: count(lockedRows), detail: "this week and earlier", detailVariants: [""] }] : []),
    ...(data.watchedSince ? [{ label: "First seen since", value: dayLabel(data.watchedSince), detail: "its first read", detailVariants: [""] }] : []),
    ...(held ? [{ label: "No signal", value: held, wide: true }] : data.skipped.length ? [{ label: "Not looked for", value: skipText(data.skipped), wide: true }] : []),
  ] : [];
  const empty = held ? `No signal this week: ${held.toLowerCase()}.` : lockedRows ? `This company's ${group === "expansion" ? "expansion" : "anomaly"} signals are in Pro.`
    : group === "expansion" ? "No first in a new country or city this week." : "Nothing stood out from this company's own weeks this week.";
  return {
    asOf: current[0]?.computedAt ?? data.history[0]?.computedAt ?? null,
    week: data.week,
    preview: data.preview,
    figures,
    held,
    sections: {
      // A company's rows have room for the title that leads them.
      signals: { columns: [column("week", "Week of", 12), ...columnsFor(group, [...current, ...earlier]).filter((entry) => entry.id !== "symbol" && entry.id !== "name" && entry.id !== "title"), column("title", "Top title", 30, false, true)],
        rows: [...current, ...earlier].map((signal) => signalRow(signal, true)), locked: lockedRows, empty },
      postings: { columns: POSTING_COLUMNS, rows: current.flatMap((signal) => signal.postings.map(postingRow(signal))), locked: 0,
        empty: current.length ? "No posting is listed behind this week's signals." : empty },
    },
  };
}

/**
 * The lock line of a free signals read: what free shows and what Pro adds.
 * Null when nothing is held back. A free board is the same three whatever
 * `filter` asked for.
 */
export function signalsPreviewNote(data: HiringSignalsBoard | HiringCompanySignals, filter?: HiringSignalsFilter): string | null {
  if (!data.preview) return null;
  if ("group" in data) {
    const shows = `${data.signals.length} of ${count(data.total)} ${data.group === "expansion" ? "expansion" : "anomaly"} signals${filter && filter !== "all" ? `: ${previewCantFilter(["kind"])}` : ""}`;
    return data.locked > 0 ? freePreviewNote({ shows, adds: `the other ${count(data.locked)} and every posting behind them` }) : null;
  }
  const { signals, history } = data.locked;
  if (signals + history <= 0) return null;
  const adds = [signals > 0 ? countOf(signals, "signal") : "", history > 0 ? `${countOf(history, "earlier signal")}` : ""].filter(Boolean);
  return freePreviewNote({ shows: "the signals the free boards show", adds: adds.join(" and ") });
}
