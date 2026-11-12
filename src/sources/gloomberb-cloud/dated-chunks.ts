import type { PricePoint } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import { getPricePointTimestamp } from "../../utils/price-history";
import { HistoryCoverageError } from "../history-coverage";
import { canonicalHistoryInterval } from "../history-retention";

const DAY_MS = 86_400_000;

/**
 * The most bars Gloom Cloud answers one dated request with: it cuts a longer
 * window to its newest bars, so daily bars from 1976 came back starting in
 * 2006, with nothing to say so but their count.
 */
const MAX_BARS_PER_REQUEST = 5_000;

/**
 * Days of bars one older request covers whole, by bar size: twelve years of
 * days stay under MAX_BARS_PER_REQUEST for a coin, which trades every day,
 * and ninety years of weeks. Months fit in one request whatever the span.
 */
const CHUNK_DAYS: Readonly<Record<string, number>> = { "1day": 12 * 365, "1week": 90 * 365 };

/** Older requests asked at once: the thirty years under a capped fifty-year daily window go out together. */
const CHUNKS_AT_ONCE = 3;

/** How far after a window's start its first bar can sit and still be at that start: a weekend and holidays, a week, a month. */
const AT_START_DAYS: Readonly<Record<string, number>> = { "1day": 7, "1week": 14, "1month": 45 };

function firstBarTime(result: PriceHistoryResult): number {
  return result.points.reduce((first, point) => {
    const time = getPricePointTimestamp(point);
    return Number.isFinite(time) && time < first ? time : first;
  }, Number.POSITIVE_INFINITY);
}

/** An answer's first bar, null with none. */
export function firstBarDate(result: PriceHistoryResult): Date | null {
  const first = firstBarTime(result);
  return Number.isFinite(first) ? new Date(first) : null;
}

/**
 * Where an answer for a window from `start` was cut by the service's bar
 * cap (`cap` bars, MAX_BARS_PER_REQUEST for a dated request): its first bar,
 * when it holds that many and starts after `start`. Null for an answer that
 * is the whole window, which then costs no other request.
 */
export function cappedAnswerStart(result: PriceHistoryResult, start: Date, cap = MAX_BARS_PER_REQUEST): Date | null {
  const first = firstBarTime(result);
  return result.points.length >= cap && Number.isFinite(first) && first > start.getTime() ? new Date(first) : null;
}

/**
 * Whether an answer's bars begin at the start of the window asked
 * (`start`), so the listing's history may go further back than the window:
 * KO's monthly bars of ALL begin with ALL's first month, 1976-12.
 */
export function reachesWindowStart(result: PriceHistoryResult, start: Date, interval: string): boolean {
  const slack = (AT_START_DAYS[canonicalHistoryInterval(interval) ?? ""] ?? 7) * DAY_MS;
  const first = firstBarTime(result);
  return Number.isFinite(first) && first <= start.getTime() + slack;
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

/** The chunks from `from` to `to`, newest first, each ending where the next newer one starts. */
function chunksBack(interval: string, from: number, to: number): Array<{ from: number; to: number }> {
  const days = CHUNK_DAYS[canonicalHistoryInterval(interval) ?? ""];
  if (!days) return to > from ? [{ from, to }] : [];
  const chunks: Array<{ from: number; to: number }> = [];
  for (let end = to; end > from; end -= days * DAY_MS) chunks.push({ from: Math.max(from, end - days * DAY_MS), to: end });
  return chunks;
}

/**
 * `result` with the bars from `from` up to `to` beneath it, when an answer
 * said there are more (cappedAnswerStart, reachesWindowStart). They are read
 * in chunks a request holds whole, a few at once, newest first. Reading
 * stops where the bars begin: after a round whose oldest chunk comes back
 * empty, or below the source's coverage, or at a chunk that fails beneath
 * one whose bars begin well after its start (the service answers a window
 * wholly before a listing's first bar with a failure: KO's daily bars of
 * 1940 to 1952, its first being 1962-01-02). An empty chunk with bars older
 * than it is a suspension, read past. Any other chunk that fails leaves the
 * bars newer than it, with `truncatedBefore` naming the first day they are
 * whole from, so a cut is never silent.
 */
export async function withOlderBars(
  result: PriceHistoryResult,
  interval: string,
  from: Date,
  to: Date,
  readChunk: (from: Date, to: Date) => Promise<PriceHistoryResult | "empty">,
): Promise<PriceHistoryResult> {
  const chunks = chunksBack(interval, from.getTime(), to.getTime());
  const slack = (AT_START_DAYS[canonicalHistoryInterval(interval) ?? ""] ?? 7) * DAY_MS;
  let joined = result;
  // Whether the chunk just newer than the one read has bars beginning well after its start: the listing's first.
  let newerBeginsLate = false;
  for (let index = 0; index < chunks.length; index += CHUNKS_AT_ONCE) {
    const round = chunks.slice(index, index + CHUNKS_AT_ONCE);
    const answers = await Promise.allSettled(round.map((chunk) => readChunk(new Date(chunk.from), new Date(chunk.to))));
    for (const [position, answer] of answers.entries()) {
      if (answer.status === "rejected") {
        if (answer.reason instanceof HistoryCoverageError) return { ...joined, coverageStart: answer.reason.coverageStart };
        return newerBeginsLate ? joined : { ...joined, truncatedBefore: isoDay(round[position]!.to) };
      }
      const older = answer.value;
      const first = older === "empty" ? Number.NaN : firstBarTime(older);
      newerBeginsLate = Number.isFinite(first) && first > round[position]!.from + slack;
      if (older === "empty" || older.points.length === 0) continue;
      joined = {
        ...joined,
        points: joinedPoints(older.points, joined.points),
        ...(older.coverageStart ? { coverageStart: older.coverageStart, ...(older.coverageNote ? { coverageNote: older.coverageNote } : {}) } : {}),
        ...(older.nonPositiveCloseDates || joined.nonPositiveCloseDates
          ? { nonPositiveCloseDates: [...older.nonPositiveCloseDates ?? [], ...joined.nonPositiveCloseDates ?? []] } : {}),
      };
    }
    const oldest = answers.at(-1);
    if (oldest?.status === "fulfilled" && (oldest.value === "empty" || oldest.value.points.length === 0)) break;
  }
  return joined;
}
