import type { DataTableColumn, StatItem } from "../../../components";
import type { HiringBuildingBoard, HiringBuildingFilter, HiringBuildingHold, HiringBuildingShift, HiringBuildingSkip, HiringCompanyBuilding, HiringMixRow, HiringMovePosting } from "../../../api-client/hiring";
import { formatNumber } from "../../../utils/format";
import { countOf, freePreviewNote, previewCantFilter } from "../shared/free-preview";
import { humanLabel } from "../shared/research-cells";
import type { AttentionRow } from "./model";

/**
 * HIRE's Building tab (docs/hiring-app-attention.md): what each company is
 * building, read from the mix of its new roles. A role family's or a theme's
 * share of the company's new roles in its recent weeks against its own weeks
 * before; a shift is one that at least doubled and held every recent week.
 * Themes are what a role's title says its work is on, as the decision model
 * confirmed them, never a word match alone.
 */
export type BuildingView = "families" | "themes" | "shifts" | "postings";
export const BUILDING_VIEWS: ReadonlyArray<{ value: BuildingView; label: string }> = [
  { value: "families", label: "Role families" }, { value: "themes", label: "Themes" }, { value: "shifts", label: "Shifts" }, { value: "postings", label: "Postings" },
];
export const isBuildingView = (value: string): value is BuildingView => BUILDING_VIEWS.some((view) => view.value === value);
export const BUILDING_FILTERS: ReadonlyArray<{ value: HiringBuildingFilter; label: string }> = [{ value: "all", label: "All" }, { value: "function", label: "Role families" }, { value: "theme", label: "Themes" }];
export const isBuildingFilter = (value: string): value is HiringBuildingFilter => BUILDING_FILTERS.some((filter) => filter.value === value);

const HOLD_LABELS: Record<HiringBuildingHold, string> = {
  shared_board: "Its board is another covered company's",
  unmeasured: "Week not measured: the collection changed",
  recounted: "Postings well above its new roles (re-listed roles)",
  rescoped: "Its boards changed inside the weeks compared",
  short_watch: "Too few measured weeks to compare",
  thin: "Too few roles to compare shares",
};
const SKIP_LABELS: Record<HiringBuildingSkip, string> = {
  unclassified: "Under 80% of roles with a role family",
  unread_titles: "Some theme titles not read yet",
};
const buildingHoldText = (hold: HiringBuildingHold) => HOLD_LABELS[hold] ?? humanLabel(hold);
const skipText = (skips: readonly HiringBuildingSkip[]) => skips.map((skip) => SKIP_LABELS[skip] ?? humanLabel(skip)).join(", ");
const kindText = (shift: Pick<HiringBuildingShift, "dimension">) => shift.dimension === "theme" ? "Theme" : "Role family";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 12": a week's Monday. */
function dayLabel(value: string | null | undefined, year = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}${year ? `, ${match[1]}` : ""}` : "--";
}
const count = (value: number | null | undefined) => value == null ? "--" : formatNumber(value, 0);
/** A share: whole percents from 10%, a tenth under it. */
const share = (value: number | null | undefined) => value == null ? "--" : value <= 0 ? "0%" : `${formatNumber(value * 100, value < 0.1 ? 1 : 0)}%`;
/** A change of share in points, as it rounds: "+23 pts", "+5.2 pts", "0 pts". */
const pointsRounded = (value: number) => Number((value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0));
const points = (value: number) => {
  const rounded = pointsRounded(value);
  return rounded === 0 ? "0 pts" : `${rounded > 0 ? "+" : ""}${formatNumber(rounded, Math.abs(value) < 0.1 ? 1 : 0)} pts`;
};
/** The sign a change shows, so one that rounds to nothing is not coloured. */
export const buildingSign = (columnId: string, value: number) => columnId === "change" ? pointsRounded(value) : value;
const signed = (value: number, decimals = 1) => `${value > 0 ? "+" : ""}${formatNumber(value, decimals)}`;
const pace = (value: number | null) => value == null ? "from none" : `${formatNumber(value, value >= 10 ? 0 : 1)}x`;

const SHARE_COLUMNS = new Set(["share", "now", "before"]);
export const BUILDING_SIGNED_COLUMNS = new Set(["change", "z"]);
/** A building column's number as the pane and the report print it. */
export function buildingNumber(columnId: string, value: number): string {
  if (SHARE_COLUMNS.has(columnId)) return share(value);
  if (columnId === "change") return points(value);
  if (columnId === "z") return signed(value);
  return count(value);
}

const weeksText = (value: number) => countOf(value, "week");
const ofText = (shift: HiringBuildingShift) => shift.dimension === "function" ? "new roles with a role family" : "new roles";

/** A shift's numbers, as its detail lists them with the sentence that says why. */
export function shiftFacts(shift: HiringBuildingShift): Array<{ label: string; value: string }> {
  const weekly = (values: HiringBuildingShift["recent"]["values"]) => values.map((row) => `${dayLabel(row.week)}: ${count(row.roles)} of ${count(row.total)}`).join(", ");
  return [
    { label: "Shift", value: kindText(shift) },
    { label: shift.dimension === "theme" ? "Theme" : "Role family", value: shift.label },
    { label: "Now", value: `${share(shift.recent.share)} of ${ofText(shift)}, ${count(shift.recent.roles)} of ${count(shift.recent.total)} over the last ${weeksText(shift.recent.weeks)}` },
    { label: "Before", value: `${share(shift.before.share)}, ${count(shift.before.roles)} of ${count(shift.before.total)} over the ${weeksText(shift.before.weeks)} before` },
    { label: "Change", value: `${points(shift.change)}, ${pace(shift.ratio)} its share, z ${signed(shift.zScore)}` },
    ...(shift.recent.values.length ? [{ label: "Recent weeks", value: weekly(shift.recent.values) }] : []),
    ...(shift.before.values.length ? [{ label: "Weeks before", value: weekly(shift.before.values) }] : []),
    { label: "Titles", value: count(shift.titles) },
    ...(shift.topTitles.length ? [{ label: "Top titles", value: shift.topTitles.map((row) => `${row.title.trim()} (${count(row.count)})`).join(", ") }] : []),
    { label: "Boards", value: shift.sourceTickers.join(", ") },
    { label: "Week of", value: dayLabel(shift.week, true) },
    { label: "First computed", value: shift.firstComputedAt },
  ];
}

export interface BuildingRow extends AttentionRow {
  shift?: HiringBuildingShift;
  mix?: HiringMixRow;
  jobPosting?: HiringMovePosting;
}
export interface BuildingSection {
  columns: DataTableColumn[];
  rows: BuildingRow[];
  empty: string;
  locked: number;
}
export interface BuildingModel {
  asOf: string | null;
  week: string | null;
  preview: boolean;
  figures: StatItem[];
  sections: Partial<Record<BuildingView | "board", BuildingSection>>;
  /** Why a company has no mix, for its report. */
  held: string | null;
}

const column = (id: string, label: string, width: number, numeric = false, flex = false): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flex ? { flexGrow: 1 } : {}) });
// What moved and by how much first, so a narrow pane keeps them; the kind and the evidence after.
const BOARD_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 20, false, true), column("label", "What", 22),
  column("now", "Now", 7, true), column("before", "Before", 8, true), column("change", "Change", 10, true), column("roles", "Roles", 7, true), column("kind", "Kind", 12), column("weeks", "Weeks", 8), column("z", "Z-score", 9, true), column("title", "Top title", 26)];
const SHIFT_COLUMNS = [column("week", "Week of", 12), ...BOARD_COLUMNS.filter((entry) => entry.id !== "symbol" && entry.id !== "name" && entry.id !== "title"), column("title", "Top title", 30, false, true)];
const mixColumns = (label: string) => [column("label", label, 22, false, true), column("share", "Now", 18, true), column("before", "Before", 8, true), column("change", "Change", 10, true),
  column("roles", "Roles now", 10, true), column("beforeRoles", "Roles before", 13, true), column("note", "Note", 14)];
const POSTING_COLUMNS = [column("title", "Role", 32, false, true), column("location", "Location", 24), column("function", "Role family", 16), column("date", "First seen", 12), column("shift", "Shift", 28)];

const topTitle = (shift: HiringBuildingShift) => shift.topTitles[0]?.title.trim() ?? shift.postings[0]?.title.trim() ?? null;
const shiftRow = (shift: HiringBuildingShift, withWeek = false): BuildingRow => ({
  id: `${shift.symbol}:${shift.week}:${shift.dimension}:${shift.key}`, symbol: shift.symbol, shift, date: shift.week,
  values: { ...(withWeek ? { week: shift.week } : {}), symbol: shift.symbol, name: shift.name, kind: kindText(shift), label: shift.label, now: shift.recent.share, before: shift.before.share,
    change: shift.change, roles: shift.recent.roles, weeks: `${shift.recent.weeks} vs ${shift.before.weeks}`, z: shift.zScore, title: topTitle(shift) },
});

function boardFigures(board: HiringBuildingBoard): StatItem[] {
  const { coverage } = board;
  const held = Object.values(coverage.held).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const titles = coverage.themeTitles;
  return board.week ? [
    { label: "Role families", value: count(coverage.counts.function ?? 0) },
    { label: "Themes", value: count(coverage.counts.theme ?? 0) },
    { label: "Compared", value: count(coverage.measured), detail: `week of ${dayLabel(board.week)}`, detailVariants: [`wk ${dayLabel(board.week)}`, ""] },
    { label: "Held", value: count(held), detail: "no mix to compare", detailVariants: [""] },
    ...(titles && titles.titles ? [{ label: "Theme titles read", value: share(titles.read / titles.titles), detail: `${count(titles.read)} of ${count(titles.titles)}`, detailVariants: [""] }] : []),
  ] : [];
}

export function buildingBoardModel(board: HiringBuildingBoard, filter: HiringBuildingFilter): BuildingModel {
  return {
    asOf: board.coverage.computedAt,
    week: board.week,
    preview: board.preview,
    figures: boardFigures(board),
    held: null,
    sections: { board: { columns: BOARD_COLUMNS, rows: board.shifts.map((shift) => shiftRow(shift)), locked: board.preview ? board.locked : 0,
      empty: !board.week ? "No week has been computed yet." : filter === "all" ? "No company's mix shifted against its own weeks this week." : "None of this kind this week." } },
  };
}

const mixRow = (shifted: ReadonlySet<string>) => (row: HiringMixRow): BuildingRow => ({
  id: `${row.dimension}:${row.key}`, mix: row,
  values: { label: row.label, share: row.recentShare, before: row.beforeShare, change: row.read ? row.change : null, roles: row.recentRoles, beforeRoles: row.beforeRoles,
    note: !row.read ? "Reading titles" : shifted.has(`${row.dimension}:${row.key}`) ? "Shift" : null },
});
const roleFamily = (value: string | null) => value === "data_ai" ? "Data / AI" : value ? humanLabel(value) : null;
const postingRow = (shift: HiringBuildingShift) => (posting: HiringMovePosting): BuildingRow => ({
  id: `${shift.dimension}:${shift.key}:${posting.id}`, url: posting.url, jobPosting: posting, shift,
  values: { title: posting.title.trim(), location: posting.location ?? posting.country, country: posting.country, shift: `${kindText(shift)}: ${shift.label}`,
    function: roleFamily(posting.jobFunction), date: posting.firstSeenAt.slice(0, 10) },
  details: [{ label: "Posting title", value: posting.title.trim() }, { label: "Location", value: posting.location ?? "--" }, { label: "Country", value: posting.country ?? "Unknown" },
    { label: "Role family", value: roleFamily(posting.jobFunction) ?? "Unclassified" }, { label: "Shift", value: `${kindText(shift)}: ${shift.label}` },
    { label: "First seen", value: posting.firstSeenAt }, { label: "Board", value: posting.sourceTicker }],
});

/** A company's mix by role family and by theme, its shifts this week and earlier, and the postings behind this week's. */
export function companyBuildingModel(data: HiringCompanyBuilding): BuildingModel {
  const held = data.held ? buildingHoldText(data.held) : null;
  const window = data.window;
  const recentWeeks = window?.recent.length ?? 0;
  const beforeWeeks = window?.before.length ?? 0;
  const roles = (rows: ReadonlyArray<{ roles: number }>) => rows.reduce((sum, row) => sum + row.roles, 0);
  const shifted = new Set(data.shifts.map((shift) => `${shift.dimension}:${shift.key}`));
  const lockedShifts = data.preview ? data.locked.shifts + data.locked.history : 0;
  const figures: StatItem[] = data.week ? [
    { label: "Shifts", value: count(data.shifts.length), detail: `week of ${dayLabel(data.week)}`, detailVariants: [`wk ${dayLabel(data.week)}`, ""] },
    ...(data.preview && lockedShifts ? [{ label: "In Pro", value: count(lockedShifts), detail: "this week and earlier", detailVariants: [""] }] : []),
    ...(window ? [
      { label: "Weeks", value: `${recentWeeks} vs ${beforeWeeks}`, detail: "recent vs before", detailVariants: [""] },
      { label: "Roles", value: `${count(roles(window.recent))} vs ${count(roles(window.before))}`, detail: "recent vs before", detailVariants: [""] },
    ] : []),
    ...(held ? [{ label: "No mix", value: held, wide: true }] : data.skipped.length ? [{ label: "In part", value: skipText(data.skipped), wide: true }] : []),
  ] : [];
  const empty = held ? `No mix to compare this week: ${held.toLowerCase()}.` : "No mix computed for this company yet.";
  const shiftsEmpty = held ? empty : lockedShifts ? "This company's shifts are in Pro." : "No role family or theme shifted against this company's own weeks.";
  return {
    asOf: data.shifts[0]?.computedAt ?? data.history[0]?.computedAt ?? null,
    week: data.week,
    preview: data.preview,
    figures,
    held,
    sections: {
      families: { columns: mixColumns("Role family"), rows: data.functions.map(mixRow(shifted)), locked: data.preview ? data.locked.functions : 0,
        empty: held ? empty : data.skipped.includes("unclassified") ? "Too few roles carry a role family to compare." : empty },
      themes: { columns: mixColumns("Theme"), rows: data.themes.map(mixRow(shifted)), locked: data.preview ? data.locked.themes : 0,
        empty: held ? empty : "No role names a theme in the weeks compared." },
      shifts: { columns: SHIFT_COLUMNS, rows: [...data.shifts.map((shift) => shiftRow(shift, true)), ...data.history.map((shift) => shiftRow(shift, true))], locked: lockedShifts, empty: shiftsEmpty },
      // Behind one shift, every row would name it.
      postings: { columns: data.shifts.length > 1 ? POSTING_COLUMNS : POSTING_COLUMNS.filter((entry) => entry.id !== "shift"), rows: data.shifts.flatMap((shift) => shift.postings.map(postingRow(shift))), locked: 0,
        empty: data.shifts.length ? "No posting is listed behind this week's shifts." : shiftsEmpty },
    },
  };
}

/**
 * The lock line of a free Building read: what free shows and what Pro adds.
 * Null when nothing is held back. A free board is the same three whatever
 * `filter` asked for.
 */
export function buildingPreviewNote(data: HiringBuildingBoard | HiringCompanyBuilding, filter?: HiringBuildingFilter): string | null {
  if (!data.preview) return null;
  if ("filter" in data) {
    const shows = `${data.shifts.length} of ${count(data.total)} shifts${filter && filter !== "all" ? `: ${previewCantFilter(["dimension"])}` : ""}`;
    return data.locked > 0 ? freePreviewNote({ shows, adds: `the other ${count(data.locked)} and every posting behind them` }) : null;
  }
  const { functions, themes, shifts, history } = data.locked;
  const adds = [functions + themes > 0 ? countOf(functions + themes, "more family or theme", "more families and themes") : "", shifts > 0 ? countOf(shifts, "shift") : "", history > 0 ? countOf(history, "earlier shift") : ""].filter(Boolean);
  return adds.length ? freePreviewNote({ shows: "the three largest families and themes, and the shifts the free board shows", adds: adds.join(", ") }) : null;
}
