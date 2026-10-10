// Published US release days, not a rule engine: the dates each release came
// out, read from the publishers' own archives. A release cancelled or moved (the
// 2025 shutdown) is as published, and a scheduled date is not a release day
// until it is out. Dates are New York calendar days.
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { MACRO_RELEASE_TABLE } from "./release-table";

export type MacroEventKind = "cpi" | "jobs" | "fomc";

export const MACRO_EVENT_KINDS: readonly MacroEventKind[] = ["cpi", "jobs", "fomc"];

export const MACRO_EVENT_LABELS: Record<MacroEventKind, string> = { cpi: "CPI", jobs: "Jobs", fomc: "FOMC" };

/** BLS news release archives for CPI and the Employment Situation, and the Federal Reserve's meeting calendar. */
export const MACRO_RELEASE_SOURCES: Record<MacroEventKind, string> = {
  cpi: "https://www.bls.gov/bls/news-release/cpi.htm",
  jobs: "https://www.bls.gov/bls/news-release/empsit.htm",
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
};

/** A list more than this many days behind today says so: a release day may be missing from its end. */
export const MACRO_RELEASES_STALE_DAYS = 14;

export interface MacroRelease { kind: MacroEventKind; date: string }

export interface MacroReleaseList {
  /** Oldest first. */
  releases: MacroRelease[];
  /** The last day the list is complete for: later sessions are left out, release day or not. */
  coveredThrough: string;
}

const DAY_MS = 86_400_000;
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const byDate = (left: MacroRelease, right: MacroRelease) => left.date.localeCompare(right.date) || left.kind.localeCompare(right.kind);

/** The list the app ships with: the floor whenever the server's list is missing or older. */
export function bundledMacroReleases(): MacroReleaseList {
  const releases = MACRO_EVENT_KINDS.flatMap((kind) => Object.entries(MACRO_RELEASE_TABLE.days[kind]).flatMap(([year, days]) =>
    days.map((day) => ({ kind, date: `${year}-${day}` }))));
  return { releases: releases.sort(byDate), coveredThrough: MACRO_RELEASE_TABLE.coveredThrough };
}

/**
 * The served list extends the floor past its end; the floor keeps its own
 * days up to there. A served list that breaks the contract, or ends no later
 * than the floor, adds nothing.
 */
export function mergeMacroReleases(floor: MacroReleaseList, served: unknown): MacroReleaseList {
  const payload = served as { coveredThrough?: unknown; releases?: Partial<Record<MacroEventKind, unknown>> } | null;
  const coveredThrough = payload?.coveredThrough;
  if (!isDate(coveredThrough) || coveredThrough <= floor.coveredThrough) return floor;
  const later: MacroRelease[] = [];
  for (const kind of MACRO_EVENT_KINDS) {
    const dates = payload?.releases?.[kind];
    if (!Array.isArray(dates) || !dates.every(isDate)) return floor;
    for (const date of new Set(dates)) {
      if (date > floor.coveredThrough && date <= coveredThrough) later.push({ kind, date });
    }
  }
  return { releases: [...floor.releases, ...later].sort(byDate), coveredThrough };
}

/** Whole days from the list's last covered day to today in New York. */
export function macroReleasesBehind(coveredThrough: string, now = Date.now()): number {
  const today = zonedDateKey(now, "America/New_York");
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${coveredThrough}T00:00:00Z`)) / DAY_MS);
}

/** The pane footer and the report notes say so once the list is old enough to miss a release day. */
export function staleMacroReleasesNotice(list: MacroReleaseList, now = Date.now()): string | null {
  return macroReleasesBehind(list.coveredThrough, now) > MACRO_RELEASES_STALE_DAYS
    ? `Release days are listed through ${list.coveredThrough}; later sessions are left out.`
    : null;
}
