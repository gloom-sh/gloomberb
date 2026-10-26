// Published release days, not a rule engine: the dates each release came
// out, read from the publishers' own archives. A release cancelled or moved (the
// 2025 shutdown) is as published, and a scheduled date is not a release day
// until it is out. Dates are New York calendar days. Brazil's IPCA days come
// from Gloom Cloud only; the list the app ships with has the US releases.
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { MACRO_RELEASE_TABLE } from "./release-table";

/** The US releases the bundled list carries, and the ones HIVG reads around. */
export type UsMacroEventKind = "cpi" | "jobs" | "fomc";
export type MacroEventKind = UsMacroEventKind | "ipca";

export const US_MACRO_EVENT_KINDS: readonly UsMacroEventKind[] = ["cpi", "jobs", "fomc"];
export const MACRO_EVENT_KINDS: readonly MacroEventKind[] = [...US_MACRO_EVENT_KINDS, "ipca"];

export const MACRO_EVENT_LABELS: Record<MacroEventKind, string> = { cpi: "CPI", jobs: "Jobs", fomc: "FOMC", ipca: "IPCA" };

/** BLS news release archives for CPI and the Employment Situation, the Federal Reserve's meeting calendar, IBGE's calendar. */
export const MACRO_RELEASE_SOURCES: Record<MacroEventKind, string> = {
  cpi: "https://www.bls.gov/bls/news-release/cpi.htm",
  jobs: "https://www.bls.gov/bls/news-release/empsit.htm",
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  ipca: "https://www.ibge.gov.br/calendario-indicadores-novoportal.html",
};

/** A list more than this many days behind today says so: a release day may be missing from its end. */
export const MACRO_RELEASES_STALE_DAYS = 14;

/** Above the consensus (hot), below it (cool), at it (in-line). */
export type MacroSurprise = "hot" | "cool" | "in-line";
export const MACRO_SURPRISES: readonly MacroSurprise[] = ["hot", "cool", "in-line"];
export const MACRO_SURPRISE_LABELS: Record<MacroSurprise, string> = { hot: "Hot", cool: "Cool", "in-line": "In line" };

/** What a release day came out with: the headline, its print, the consensus before it and the figure before that. */
export interface MacroReleaseFigures {
  /** The headline the figures are for: "Inflation Rate YoY", "IPCA m/m". */
  event: string;
  actual: string | null;
  forecast: string | null;
  prior: string | null;
  surprise: MacroSurprise | null;
}

export interface MacroRelease { kind: MacroEventKind; date: string; figures?: MacroReleaseFigures }

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
  const releases = US_MACRO_EVENT_KINDS.flatMap((kind) => Object.entries(MACRO_RELEASE_TABLE.days[kind]).flatMap(([year, days]) =>
    days.map((day) => ({ kind, date: `${year}-${day}` }))));
  return { releases: releases.sort(byDate), coveredThrough: MACRO_RELEASE_TABLE.coveredThrough };
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** A day's figures as served, or undefined when they break the contract. */
function servedFigures(value: unknown): MacroReleaseFigures | undefined {
  const figures = value as Partial<Record<keyof MacroReleaseFigures, unknown>> | null;
  const event = text(figures?.event);
  if (!event) return undefined;
  const surprise = MACRO_SURPRISES.find((candidate) => candidate === figures?.surprise) ?? null;
  return { event, actual: text(figures?.actual), forecast: text(figures?.forecast), prior: text(figures?.prior), surprise };
}

/**
 * The served list extends the floor past its end; the floor keeps its own
 * days up to there. IPCA, which the floor does not carry, is the served list's
 * through its end, and left out when the server lists none. Every day takes
 * the figures the server has for it. A served list that breaks the contract,
 * or ends no later than the floor, adds nothing.
 */
export function mergeMacroReleases(floor: MacroReleaseList, served: unknown): MacroReleaseList {
  const payload = served as { coveredThrough?: unknown; releases?: Partial<Record<MacroEventKind, unknown>>;
    figures?: Partial<Record<MacroEventKind, Record<string, unknown>>> } | null;
  const coveredThrough = payload?.coveredThrough;
  if (!isDate(coveredThrough) || coveredThrough <= floor.coveredThrough) return floor;
  const later: MacroRelease[] = [];
  for (const kind of US_MACRO_EVENT_KINDS) {
    const dates = payload?.releases?.[kind];
    if (!Array.isArray(dates) || !dates.every(isDate)) return floor;
    for (const date of new Set(dates)) {
      if (date > floor.coveredThrough && date <= coveredThrough) later.push({ kind, date });
    }
  }
  const ipca = payload?.releases?.ipca;
  if (Array.isArray(ipca) && ipca.every(isDate)) {
    for (const date of new Set(ipca)) if (date <= coveredThrough) later.push({ kind: "ipca", date });
  }
  const figuresOf = (release: MacroRelease): MacroRelease => {
    const figures = servedFigures(payload?.figures?.[release.kind]?.[release.date]);
    return figures ? { ...release, figures } : release;
  };
  return { releases: [...floor.releases, ...later].map(figuresOf).sort(byDate), coveredThrough };
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
