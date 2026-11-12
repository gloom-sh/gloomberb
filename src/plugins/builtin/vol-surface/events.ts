import { MISSING_VALUE } from "../../../utils/format";
import type { apiClient as cloudApiClient } from "../../../api-client";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { DataProvider } from "../../../types/data-provider";
import { zonedDateKey, zonedDateTimeParts } from "../../../utils/zoned-date-time";
import { lookupScheduledDates } from "../alerts/scheduled";
import { fetchCpiBoard } from "../cpi/client";
import { fetchRatePath } from "../rate-path/client";
import { loadMacroDayHistory, loadMacroReleases } from "../macro-day/client";
import { projectMacroDays } from "../macro-day/model";
import { MACRO_EVENT_LABELS } from "../macro-day/releases";
import type { SurfaceExpiry } from "./model";

/** The scheduled releases the term structure is read around. */
type SurfaceEventKind = "fomc" | "cpi";
const SURFACE_EVENT_KINDS: readonly SurfaceEventKind[] = ["fomc", "cpi"];
/** New York's time of each release, in minutes after midnight: CPI at 08:30, an FOMC decision at 14:00. */
const RELEASE_MINUTES: Record<SurfaceEventKind, number> = { cpi: 8 * 60 + 30, fomc: 14 * 60 };
const NEW_YORK = "America/New_York";

export interface SurfaceEvent {
  kind: SurfaceEventKind;
  /** New York's date of the release: CPI at 08:30, an FOMC decision at 14:00, both before that day's options close. */
  date: string;
  /** MDAY's average absolute close-to-close move of the underlying on this release's days, decimal, and how many. */
  history: { meanAbs: number | null; count: number } | null;
}

export interface SurfaceEvents {
  events: SurfaceEvent[];
  /** Why an event is missing or has no history beside it. */
  notes: string[];
}

/** The expiry's ISO date: a stamp at its settlement or at UTC midnight of the day both read as that day. */
export const expiryDay = (expiration: number) => new Date(expiration * 1000).toISOString().slice(0, 10);

/**
 * The listed expiries either side of an event: the last one that settles
 * before it and the first that settles after it. A release before the close
 * (CPI at 08:30, an FOMC decision at 14:00) falls inside its own day's
 * expiry, so that expiry is the one after. With nothing live before it, the
 * expiry after `after` stands in for an ordinary day's vol. Null on a side
 * the catalogue does not reach.
 */
export function eventBrackets(catalogue: readonly number[], date: string): { before: number | null; after: number | null; next: number | null } {
  const sorted = [...new Set(catalogue)].sort((a, b) => a - b);
  const afterIndex = sorted.findIndex((expiration) => expiryDay(expiration) >= date);
  return {
    before: sorted.filter((expiration) => expiryDay(expiration) < date).at(-1) ?? null,
    after: afterIndex < 0 ? null : sorted[afterIndex]!,
    next: afterIndex < 0 ? null : sorted[afterIndex + 1] ?? null,
  };
}

/** The expiries a surface keeps so each event has its two sides, whatever the expiry limit thins. */
export function eventExpiries(catalogue: readonly number[], events: readonly Pick<SurfaceEvent, "date">[]): number[] {
  return [...new Set(events.flatMap((event) => {
    const { before, after, next } = eventBrackets(catalogue, event.date);
    return [before ?? next, after].filter((expiration): expiration is number => expiration != null);
  }))];
}

export interface SurfaceEventReading {
  /** The releases between the same two expiries, in date order: one row reads them together. */
  events: SurfaceEvent[];
  /** The last expiry before the releases; null when the first live one is already past them, read from now. */
  before: number | null;
  /** The first expiry after them; null when none is listed after them. */
  after: number | null;
  /** ATM IV over the stretch between the two expiries (from now with no expiry before), from their total variances; decimal annualized. */
  forwardVol: number | null;
  /**
   * The release days' expected absolute move together, decimal and
   * approximate: the variance between the two expiries less an ordinary
   * day's on each of the stretch's other calendar days, read as a normal
   * move's mean absolute size, sqrt(2/pi) sigma, so it compares with MDAY's
   * average absolute move. An ordinary day's vol is the earlier expiry's ATM
   * IV, or with no expiry before, the forward vol past the later one. Null
   * when the stretch prices no more than its ordinary days.
   */
  impliedMove: number | null;
}

const DAY_YEARS = 1 / 365;

/** The ATM IV at the forward, as the term structure reads it. */
const atm = (expiry: SurfaceExpiry | undefined) => expiry?.skew.atm ?? expiry?.atmIV ?? null;

/**
 * The releases read off the fitted expiries either side of them, in the
 * calendar days the surface counts. Releases between the same two expiries
 * (FOMC on 9 Dec and CPI on 10 Dec, both between 4 and 11 Dec) share one
 * reading: the stretch's variance is theirs together, so read apart each
 * would count the other's.
 */
export function surfaceEventReadings(expiries: readonly SurfaceExpiry[], catalogue: readonly number[],
  events: readonly SurfaceEvent[]): SurfaceEventReading[] {
  const byExpiration = new Map(expiries.map((expiry) => [expiry.expiration, expiry]));
  const groups = new Map<string, { brackets: ReturnType<typeof eventBrackets>; events: SurfaceEvent[] }>();
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const brackets = eventBrackets(catalogue, event.date);
    const key = `${brackets.before}:${brackets.after}`;
    const group = groups.get(key) ?? { brackets, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ brackets, events: grouped }) => {
    const empty = { events: grouped, before: brackets.before, after: brackets.after, forwardVol: null, impliedMove: null };
    const late = brackets.after == null ? undefined : byExpiration.get(brackets.after);
    const sigma2 = atm(late);
    if (!late || sigma2 == null) return empty;
    let startYears = 0, startVariance = 0, ordinary: number | null;
    if (brackets.before != null) {
      const early = byExpiration.get(brackets.before);
      const sigma1 = atm(early);
      if (!early || sigma1 == null || !(late.years > early.years)) return empty;
      startYears = early.years;
      startVariance = sigma1 ** 2 * early.years;
      ordinary = sigma1;
    } else {
      const following = brackets.next == null ? undefined : byExpiration.get(brackets.next);
      const sigma3 = atm(following);
      const span = following ? following.years - late.years : 0;
      const variance = following && sigma3 != null ? sigma3 ** 2 * following.years - sigma2 ** 2 * late.years : 0;
      ordinary = span > 0 && variance > 0 ? Math.sqrt(variance / span) : null;
    }
    const span = late.years - startYears;
    const variance = sigma2 ** 2 * late.years - startVariance;
    const forwardVol = span > 0 && variance > 0 ? Math.sqrt(variance / span) : null;
    // Every release day is taken out of the ordinary days, not just one.
    const eventVariance = ordinary == null ? 0 : variance - ordinary ** 2 * Math.max(0, span - grouped.length * DAY_YEARS);
    return { ...empty, forwardVol, impliedMove: eventVariance > 0 ? Math.sqrt(eventVariance) * Math.sqrt(2 / Math.PI) : null };
  });
}

const percent = (value: number | null | undefined, digits = 2) => value == null ? MISSING_VALUE : `${(value * 100).toFixed(digits)}%`;
/** The implied move is an estimate: "≈1.01%". */
export const approximatePercent = (value: number | null | undefined) => value == null ? MISSING_VALUE : `≈${percent(value)}`;

/** MDAY's average absolute move on each release's days: "1.01%", or "1.01/0.98%" for two releases read together. */
export function surfaceEventHistory(events: readonly SurfaceEvent[]): string {
  const moves = events.map((event) => event.history?.meanAbs);
  if (moves.every((move) => move == null)) return MISSING_VALUE;
  return moves.length === 1 ? percent(moves[0]) : `${moves.map((move) => move == null ? MISSING_VALUE : (move * 100).toFixed(2)).join("/")}%`;
}

/** One line for a narrow pane: "fwd 17.0% · move ≈1.01% · MDAY 1.01%". */
export function surfaceEventSummary(reading: SurfaceEventReading): string {
  if (reading.after == null) return "no listed expiry after it";
  return `fwd ${percent(reading.forwardVol, 1)} · move ${approximatePercent(reading.impliedMove)} · MDAY ${surfaceEventHistory(reading.events)}`;
}

/** "FOMC 12-09". */
const surfaceEventLabel = (event: Pick<SurfaceEvent, "kind" | "date">) => `${MACRO_EVENT_LABELS[event.kind]} ${event.date.slice(5)}`;
/** "FOMC 12-09 + CPI 12-10". */
export const surfaceReadingLabel = (reading: Pick<SurfaceEventReading, "events">) => reading.events.map(surfaceEventLabel).join(" + ");
/** For a narrow row: "FOMC 12-09", or "FOMC+CPI" for releases read together, which the chart dates. */
export const surfaceReadingShortLabel = (reading: Pick<SurfaceEventReading, "events">) => reading.events.length === 1
  ? surfaceEventLabel(reading.events[0]!) : reading.events.map((event) => MACRO_EVENT_LABELS[event.kind]).join("+");

/**
 * The first New York day whose release of `kind` is still to come at `now`:
 * today until the release's time (CPI at 08:30, an FOMC decision at 14:00),
 * then tomorrow, so a release that has come out drops from the list.
 */
export function releaseSearchDay(kind: SurfaceEventKind, now: number): string {
  const today = zonedDateKey(now, NEW_YORK);
  const { hour, minute } = zonedDateTimeParts(now, NEW_YORK);
  if (hour * 60 + minute < RELEASE_MINUTES[kind]) return today;
  return new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The next scheduled FOMC decision and CPI release, as HIVG and the scheduled
 * alerts read them (WIRP's meetings, the CPI board's calendar), each with
 * MDAY's average absolute move of the underlying on that release's days over
 * five years. A release whose date cannot be read is left out with a note.
 */
export async function loadSurfaceEvents(
  instrument: InstrumentRef,
  options: { apiClient: Pick<typeof cloudApiClient, "getCloudMacroReleaseDays" | "getCloudCpiBoard" | "getCloudRatePath">;
    marketData?: DataProvider; signal?: AbortSignal; now?: number },
): Promise<SurfaceEvents> {
  const now = options.now ?? Date.now();
  const sources = {
    earnings: async () => [],
    cpi: () => fetchCpiBoard(options.apiClient),
    fomc: async () => (await fetchRatePath(options.apiClient)).meetings,
  };
  // Each release is looked up from the first day it is still to come.
  const [dates, releases, history] = await Promise.all([
    Promise.all(SURFACE_EVENT_KINDS.map((event) => lookupScheduledDates([{ kind: "macro", event }], sources, releaseSearchDay(event, now), now)))
      .then((found) => new Map(found.flatMap((entries) => [...entries]))),
    loadMacroReleases({}, () => options.apiClient.getCloudMacroReleaseDays()),
    loadMacroDayHistory({ instrument, signal: options.signal }, options.marketData),
  ]);
  const model = history.history.length
    ? projectMacroDays(history.history, { symbol: instrument.symbol, lookbackYears: 5, releases: releases.releases, coveredThrough: releases.coveredThrough })
    : null;
  const notes: string[] = [];
  const events = SURFACE_EVENT_KINDS.flatMap((kind): SurfaceEvent[] => {
    const found = dates.get(`macro:${kind}`);
    const label = MACRO_EVENT_LABELS[kind];
    if (!found || !("date" in found) || !found.date) {
      notes.push(found && "error" in found ? `The next ${label} date could not be read (${found.error}).` : `No ${label} date is scheduled here.`);
      return [];
    }
    const stats = model?.byKind[kind];
    return [{ kind, date: found.date, history: stats ? { meanAbs: stats.meanAbs, count: stats.count } : null }];
  });
  if (!model && history.error) notes.push(`MDAY's moves on release days are unavailable: ${history.error}.`);
  return { events: events.sort((a, b) => a.date.localeCompare(b.date)), notes };
}
