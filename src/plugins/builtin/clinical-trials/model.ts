import type { DataTableColumn } from "../../../components";
import { blendHex, type ThemeColors } from "../../../theme/colors";
import type { PaneReportOptionDef } from "../../../types/plugin";
import type { StudiesQuery } from "./client";

/**
 * Where a study stands, as a reader of the list sorts it: open to patients,
 * about to open, running closed to new patients, done, stopped, or not known.
 * Each has its own colour; the words always stay, so colour is never the only
 * signal.
 */
export type TrialStatusTone = "recruiting" | "upcoming" | "running" | "done" | "paused" | "stopped" | "unknown";

interface StatusInfo {
  /** The registry's wording. */
  label: string;
  /** The same, short enough for the status column of a narrow pane. */
  short: string;
  tone: TrialStatusTone;
}

/** Every overall status the registry uses, in the order a study lives them. */
const STATUSES: ReadonlyArray<[code: string, info: StatusInfo]> = [
  ["NOT_YET_RECRUITING", { label: "Not yet recruiting", short: "Not yet", tone: "upcoming" }],
  ["RECRUITING", { label: "Recruiting", short: "Recruiting", tone: "recruiting" }],
  ["ENROLLING_BY_INVITATION", { label: "Enrolling by invitation", short: "By invite", tone: "running" }],
  ["ACTIVE_NOT_RECRUITING", { label: "Active, not recruiting", short: "Active", tone: "running" }],
  ["COMPLETED", { label: "Completed", short: "Completed", tone: "done" }],
  ["SUSPENDED", { label: "Suspended", short: "Suspended", tone: "paused" }],
  ["TERMINATED", { label: "Terminated", short: "Terminated", tone: "stopped" }],
  ["WITHDRAWN", { label: "Withdrawn", short: "Withdrawn", tone: "stopped" }],
  ["UNKNOWN", { label: "Unknown status", short: "Unknown", tone: "unknown" }],
  // Expanded access programs.
  ["AVAILABLE", { label: "Available", short: "Available", tone: "recruiting" }],
  ["TEMPORARILY_NOT_AVAILABLE", { label: "Temporarily not available", short: "Unavailable", tone: "paused" }],
  ["NO_LONGER_AVAILABLE", { label: "No longer available", short: "Unavailable", tone: "done" }],
  ["APPROVED_FOR_MARKETING", { label: "Approved for marketing", short: "Approved", tone: "done" }],
  ["WITHHELD", { label: "Withheld", short: "Withheld", tone: "unknown" }],
];
const STATUS_BY_CODE = new Map(STATUSES);

function humanize(code: string): string {
  const words = code.trim().toLowerCase().replace(/_+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A status code in the registry's words, with its tone; a code it adds later still reads as words. */
export function trialStatus(code: string): StatusInfo {
  const known = STATUS_BY_CODE.get(code.trim().toUpperCase());
  if (known) return known;
  const label = humanize(code) || "Unknown status";
  return { label, short: label, tone: "unknown" };
}

/** Theme colours only: a study that recruits reads as go, a stopped one as a warning, a finished one recedes. */
export function trialStatusColor(tone: TrialStatusTone, colors: ThemeColors): string {
  switch (tone) {
    case "recruiting": return colors.positive;
    // About to recruit: the recruiting hue, paler on a dark theme and deeper on a light one.
    case "upcoming": return blendHex(colors.positive, colors.text, 0.45);
    // Running, closed to new patients: the readouts ahead are here, so it reads bright, without a hue
    // that could pass for a warning (the accent is orange in some themes).
    case "running": return colors.textBright;
    case "done": return colors.textDim;
    case "paused": return colors.warning;
    case "stopped": return colors.negative;
    case "unknown": return colors.textMuted;
  }
}

/** Tones strong enough to keep on the selected row; the quiet ones take the selection colour. */
export function keepsToneWhenSelected(tone: TrialStatusTone): boolean {
  return tone === "recruiting" || tone === "paused" || tone === "stopped";
}

const PHASES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "EARLY_PHASE1", label: "Early phase 1" },
  { value: "PHASE1", label: "Phase 1" },
  { value: "PHASE2", label: "Phase 2" },
  { value: "PHASE3", label: "Phase 3" },
  { value: "PHASE4", label: "Phase 4" },
  { value: "NA", label: "Not applicable" },
];

/**
 * `Phase 2/3` from `["PHASE2", "PHASE3"]`; `Ph 2/3` when `compact`. `N/A` is
 * the registry's "not applicable" (a device or behavioural study), `--` a
 * study with no phase at all (observational).
 */
export function trialPhaseLabel(phases: readonly string[], compact = false): string {
  const codes = phases.map((phase) => phase.trim().toUpperCase()).filter(Boolean);
  if (codes.length === 0) return "--";
  if (codes.every((code) => code === "NA")) return "N/A";
  if (codes.length === 1 && codes[0] === "EARLY_PHASE1") return compact ? "Early 1" : "Early phase 1";
  const numbers = [...new Set(codes
    .filter((code) => code !== "NA")
    .map((code) => code.replace("EARLY_PHASE", "").replace("PHASE", "").trim())
    .filter(Boolean))]
    .sort();
  return `${compact ? "Ph" : "Phase"} ${numbers.join("/")}`;
}

/** The phase as the detail view says it. */
export function trialPhaseDetail(phases: readonly string[]): string {
  const label = trialPhaseLabel(phases);
  return label === "--" ? "None" : label === "N/A" ? "Not applicable" : label;
}

const SPONSOR_CLASSES: ReadonlyArray<{ value: string; label: string; short?: string; description?: string }> = [
  { value: "INDUSTRY", label: "Industry" },
  { value: "NIH", label: "NIH" },
  { value: "FED", label: "U.S. federal", description: "U.S. federal agencies other than NIH" },
  { value: "OTHER_GOV", label: "Other government", short: "Government", description: "State, local and non-U.S. governments" },
  { value: "NETWORK", label: "Network", description: "Research networks and cooperative groups" },
  { value: "INDIV", label: "Individual", description: "An investigator sponsoring the study" },
  { value: "OTHER", label: "Other", description: "Universities, hospitals, foundations and other organizations" },
];

/** `INDUSTRY` reads `Industry`; the registry's catch-all `OTHER` reads `Other`. */
export function sponsorClassLabel(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!upper) return "";
  if (upper === "AMBIG") return "Ambiguous";
  return SPONSOR_CLASSES.find((entry) => entry.value === upper)?.label ?? humanize(upper);
}

/** One choice per filter; `all` narrows nothing. */
export interface TrialFilters {
  status: string;
  phase: string;
  sponsorClass: string;
}

export const ALL = "all";

const STATUS_FILTER_CODES = STATUSES.slice(0, 9).map(([code]) => code);

export interface TrialFilterOption {
  value: string;
  label: string;
  short?: string;
  description?: string;
  /** The status's colour, so the menu reads like the column. */
  tone?: TrialStatusTone;
}

export const STATUS_FILTER_OPTIONS: readonly TrialFilterOption[] = [
  { value: ALL, label: "All" },
  ...STATUS_FILTER_CODES.map((code) => {
    const info = trialStatus(code);
    return { value: code, label: info.label, short: info.short, tone: info.tone };
  }),
];
export const PHASE_FILTER_OPTIONS: readonly TrialFilterOption[] = [
  { value: ALL, label: "All" },
  // The bar already says "Phase", so the chip reads "Phase 3", not "Phase Phase 3".
  ...PHASES.map((phase) => ({ ...phase, short: phase.value === "NA" ? "N/A" : phase.value === "EARLY_PHASE1" ? "Early 1" : phase.value.replace("PHASE", "") })),
];
export const SPONSOR_FILTER_OPTIONS: readonly TrialFilterOption[] = [{ value: ALL, label: "All" }, ...SPONSOR_CLASSES];

function pick(options: readonly TrialFilterOption[], value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return options.find((option) => option.value !== ALL && option.value === code)?.value ?? ALL;
}

/** Filters from pane state or settings, dropping anything the registry does not use. */
export function normalizeTrialFilters(value: unknown): TrialFilters {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    status: pick(STATUS_FILTER_OPTIONS, record.status),
    phase: pick(PHASE_FILTER_OPTIONS, record.phase),
    sponsorClass: pick(SPONSOR_FILTER_OPTIONS, record.sponsorClass),
  };
}

export function trialFiltersNarrow(filters: TrialFilters): boolean {
  return filters.status !== ALL || filters.phase !== ALL || filters.sponsorClass !== ALL;
}

/** What the registry is asked for, so paging walks only matching studies. */
export function trialFiltersQuery(filters: TrialFilters): Pick<StudiesQuery, "statuses" | "phases" | "sponsorClasses"> {
  const only = (value: string) => (value === ALL ? undefined : [value]);
  return {
    statuses: only(filters.status),
    phases: only(filters.phase),
    sponsorClasses: only(filters.sponsorClass),
  };
}

/** `TRIAL obesity --status recruiting --phase 3 --sponsor industry` sets the pane's filters. */
export const TRIAL_REPORT_OPTIONS: readonly PaneReportOptionDef[] = [
  {
    key: "status",
    type: "enum",
    placeholder: "status",
    description: "Only studies with this overall status",
    values: STATUS_FILTER_CODES.map((value) => ({ value, aliases: value === "ACTIVE_NOT_RECRUITING" ? ["active"] : value === "NOT_YET_RECRUITING" ? ["not-yet"] : [] })),
    example: "--status recruiting",
  },
  {
    key: "phase",
    type: "enum",
    placeholder: "phase",
    description: "Only studies in this phase",
    values: PHASES.map(({ value }) => ({
      value,
      aliases: value === "EARLY_PHASE1" ? ["early1", "0"] : value === "NA" ? ["none", "not-applicable"] : [value.replace("PHASE", "")],
    })),
    example: "--phase 3",
  },
  {
    key: "sponsorClass",
    aliases: ["sponsor"],
    type: "enum",
    placeholder: "class",
    description: "Only studies whose lead sponsor is of this class",
    values: SPONSOR_CLASSES.map(({ value }) => ({ value, aliases: value === "INDIV" ? ["individual"] : value === "FED" ? ["federal"] : [] })),
    example: "--sponsor industry",
  },
];

type TrialColumnId = "time" | "phase" | "status" | "title" | "sponsor" | "ticker";
export type TrialColumn = DataTableColumn & { id: TrialColumnId };

export interface TrialLayout {
  columns: TrialColumn[];
  /** Status and phase in their short forms. */
  compact: boolean;
  /** The ticker column has room for a listing's venue. */
  showVenue: boolean;
}

/** The gap after each column plus the table's padding, as the terminal table draws them. */
const TABLE_CHROME = 1 + 2;

/**
 * The title takes what is left; status, phase and ticker stay narrow and the
 * sponsor keeps a readable width. Status reads in full, and the sponsor and
 * ticker widen, only once the title has room of its own. The columns add up
 * to the pane, so nothing scrolls sideways.
 */
export function trialLayout(width: number): TrialLayout {
  const compact = width < 90;
  const wide = width >= 140;
  const fixed: TrialColumn[] = [
    { id: "time", label: "Time", width: compact ? 7 : 8, align: "left" },
    { id: "phase", label: "Phase", width: compact ? 7 : 9, align: "left" },
    { id: "status", label: "Status", width: wide ? 23 : 11, align: "left" },
    { id: "sponsor", label: "Sponsor", width: wide ? 30 : compact ? 15 : 22, align: "left" },
    { id: "ticker", label: "Ticker", width: wide ? 11 : 6, align: "left" },
  ];
  const used = fixed.reduce((sum, column) => sum + column.width + 1, 0) + TABLE_CHROME;
  const title: TrialColumn = { id: "title", label: "Title", width: Math.max(12, width - used - 1), align: "left", flexGrow: 1 };
  return { compact, showVenue: wide, columns: [fixed[0]!, fixed[1]!, fixed[2]!, title, fixed[3]!, fixed[4]!] };
}
