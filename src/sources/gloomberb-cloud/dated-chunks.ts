import type { PricePoint } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import { getPricePointTimestamp } from "../../utils/price-history";
import { HistoryCoverageError } from "../history-coverage";
import { canonicalHistoryInterval } from "../history-retention";

const DAY_MS = 86_400_000;

/**
 * Days of bars one dated Gloom Cloud request covers whole, by bar size. The
 * service serves at most 5,000 bars for a request and cuts a longer window
 * to its newest ones, so a request of daily bars from 1990 came back
 * starting in 2006. Twelve years of days stay under that for a coin, which
 * trades every day; weekly bars fit ninety years. Calendar months and
 * intraday bars are never cut so.
 */
const CHUNK_DAYS: Readonly<Record<string, number>> = { "1day": 12 * 365, "1week": 90 * 365 };

/** The most bars the service answers one request with, the newest of a longer window. */
const MAX_BARS_PER_REQUEST = 5_000;

/** Where the newest request of a window starts: the window's own start when one request holds it. */
export function newestDatedChunkStart(interval: string, start: Date, end: Date): Date {
  const days = CHUNK_DAYS[canonicalHistoryInterval(interval) ?? ""];
  if (!days || end.getTime() - start.getTime() <= days * DAY_MS) return start;
  return new Date(end.getTime() - days * DAY_MS);
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Bars of both answers in date order, a date the two share kept once, the newer answer's. */
function joinedPoints(older: readonly PricePoint[], newer: readonly PricePoint[]): PricePoint[] {
  const newest = new Set(newer.map(getPricePointTimestamp));
  return [...older.filter((point) => !newest.has(getPricePointTimestamp(point))), ...newer]
    .sort((left, right) => getPricePointTimestamp(left) - getPricePointTimestamp(right));
}

/**
 * The bars of a window too long for one request, from `newest` (the answer
 * for the window's newest chunk, which started at `newestStart`) back to
 * `start`, read a chunk at a time from the newest to the oldest. Reading
 * stops where the bars begin: a chunk that comes back empty or below the
 * source's coverage. A chunk whose first bar is well inside it is read past
 * all the same, so a suspension (a listing halted for months) never cuts the
 * history. A chunk that fails otherwise leaves the bars as read so far, with
 * `truncatedBefore` naming the first day they are whole from, so a cut is
 * never silent.
 */
export async function withOlderDatedChunks(
  newest: PriceHistoryResult,
  interval: string,
  start: Date,
  newestStart: Date,
  readChunk: (from: Date, to: Date) => Promise<PriceHistoryResult | "empty">,
): Promise<PriceHistoryResult> {
  const canonical = canonicalHistoryInterval(interval) ?? "";
  const days = CHUNK_DAYS[canonical];
  if (!days || newestStart.getTime() <= start.getTime()) return newest;
  let result = newest;
  let to = newestStart.getTime();
  while (to > start.getTime()) {
    const from = Math.max(start.getTime(), to - days * DAY_MS);
    let older: PriceHistoryResult | "empty";
    try {
      older = await readChunk(new Date(from), new Date(to));
    } catch (error) {
      if (error instanceof HistoryCoverageError) {
        result = { ...result, coverageStart: error.coverageStart };
        break;
      }
      return { ...result, truncatedBefore: isoDay(to) };
    }
    if (older === "empty" || older.points.length === 0) break;
    result = {
      ...result,
      points: joinedPoints(older.points, result.points),
      ...(older.coverageStart ? { coverageStart: older.coverageStart, ...(older.coverageNote ? { coverageNote: older.coverageNote } : {}) } : {}),
      ...(older.nonPositiveCloseDates || result.nonPositiveCloseDates
        ? { nonPositiveCloseDates: [...older.nonPositiveCloseDates ?? [], ...result.nonPositiveCloseDates ?? []] } : {}),
    };
    to = from;
  }
  return result;
}

/**
 * Where the rest of a window is read back from after one request over all of
 * it (`whole`, a listing that stopped trading before the window's newest
 * chunk): its first bar when the service cut the answer to its newest bars,
 * else `start`, the answer being the whole window.
 */
export function wholeWindowChunkStart(whole: PriceHistoryResult, start: Date): Date {
  const first = whole.points.length > 0 ? getPricePointTimestamp(whole.points[0]!) : Number.NaN;
  return whole.points.length >= MAX_BARS_PER_REQUEST && Number.isFinite(first) && first > start.getTime() ? new Date(first) : start;
}
