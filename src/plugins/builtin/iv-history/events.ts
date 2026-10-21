import type { MacroEventKind, MacroRelease } from "../macro-day/releases";
import type { DatedValue, IvHistoryModel } from "./model";

/** One past release and the readings a set number of sessions from it. */
interface ReleaseOffsetRow {
  kind: MacroEventKind;
  /** The release's New York calendar day. */
  releaseDate: string;
  /** Sessions from the release day: -6 is the sixth session before it, 0 the release day. */
  offset: number;
  /** The session the readings are of. */
  date: string;
  iv30: number | null;
  iv90: number | null;
  iv365: number | null;
  hv: number | null;
  spread: number | null;
  /** 25-delta put IV minus call IV, and the risk reversal, call minus put. */
  skew25d: number | null;
  rr25d: number | null;
}

export interface ReleaseOffsets {
  rows: ReleaseOffsetRow[];
  /** Releases whose session at the offset has not closed yet, newest last. */
  pending: string[];
  /** Releases since the IV history starts that the lookback leaves out. */
  beforeLookback: number;
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const byDay = (points: readonly DatedValue[]) => new Map(points.map((point) => [day(point.date), point.value]));

/**
 * One row per past release of `kind`, with the readings on the session
 * `offset` sessions from it (the "week before FOMC" analog is `-5` or `-6`),
 * oldest first. Sessions are the IV and price history's own, from the first
 * IV reading in the lookback; a release on a day with no session counts from the next one. A
 * release whose session at the offset falls before the lookback or has not
 * closed yet is left out.
 */
export function releaseOffsetRows(
  model: Pick<IvHistoryModel, "iv30" | "iv90" | "iv365" | "hv" | "spread" | "skew" | "since">,
  releases: readonly MacroRelease[],
  kind: MacroEventKind,
  offset: number,
): ReleaseOffsets {
  // Sessions from the first IV reading on: realized volatility alone, before it or without it, is no IV row.
  const first = model.iv30[0] ? day(model.iv30[0].date) : null;
  if (!first) return { rows: [], pending: [], beforeLookback: 0 };
  const sessions = [...new Set([...model.iv30, ...model.hv].map((point) => day(point.date)))].filter((session) => session >= first).sort();
  const iv30 = byDay(model.iv30), iv90 = byDay(model.iv90), iv365 = byDay(model.iv365);
  const hv = byDay(model.hv), spread = byDay(model.spread), skew = byDay(model.skew);
  const rows: ReleaseOffsetRow[] = [];
  const pending: string[] = [];
  let beforeLookback = 0;
  for (const release of releases) {
    if (release.kind !== kind) continue;
    const anchor = sessions.findIndex((session) => session >= release.date);
    if (anchor === 0 && release.date < sessions[0]!) {
      if (model.since && release.date >= model.since) beforeLookback += 1;
      continue;
    }
    // A release after the last session read has not happened in the history yet.
    if (anchor < 0) continue;
    const index = anchor + offset;
    if (index >= sessions.length) {
      pending.push(release.date);
      continue;
    }
    if (index < 0) {
      if (model.since && release.date >= model.since) beforeLookback += 1;
      continue;
    }
    const date = sessions[index]!;
    const skewValue = skew.get(date) ?? null;
    rows.push({
      kind, releaseDate: release.date, offset, date,
      iv30: iv30.get(date) ?? null, iv90: iv90.get(date) ?? null, iv365: iv365.get(date) ?? null,
      hv: hv.get(date) ?? null, spread: spread.get(date) ?? null,
      skew25d: skewValue, rr25d: skewValue == null ? null : -skewValue,
    });
  }
  return { rows, pending, beforeLookback };
}

/** "6 sessions before", "the release day", "1 session after". */
export function offsetText(offset: number): string {
  if (offset === 0) return "release day";
  const sessions = `${Math.abs(offset)} session${Math.abs(offset) === 1 ? "" : "s"}`;
  return offset < 0 ? `${sessions} before` : `${sessions} after`;
}
