import { httpFetch } from "../../../utils/http-transport";
import { isoDateOrNull, numericOrNull, recordOrNull, textOrNull } from "../../../utils/guards";
import {
  boardAsOf,
  buildDealerRows,
  newestSeriesBreak,
  sumSeries,
  type DealerRow,
  type SeriesPoint,
} from "./model";

const API = "https://markets.newyorkfed.org/api/pd";
const FETCH_TIMEOUT_MS = 15_000;
/** The release is weekly; a series read is kept this long so moving through the board never asks twice. */
const HISTORY_TTL_MS = 30 * 60_000;

export interface DealerBoard {
  seriesBreak: string;
  positions: DealerRow[];
  fails: DealerRow[];
  asOf: string | null;
}

/** A row's weekly history: the sum of the series behind it, oldest first. */
export interface DealerHistory {
  rowId: string;
  points: SeriesPoint[];
}

function timeseriesRows(payload: unknown): unknown[] {
  const root = recordOrNull(payload);
  const pd = recordOrNull(root?.pd);
  return Array.isArray(pd?.timeseries) ? pd.timeseries : Array.isArray(root?.timeseries) ? root.timeseries : [];
}

function parseSeriesBreaks(payload: unknown): Array<{ seriesBreak: string; startDate: string }> {
  const root = recordOrNull(payload);
  const pd = recordOrNull(root?.pd);
  const rows = Array.isArray(pd?.seriesbreaks) ? pd.seriesbreaks : [];
  const breaks: Array<{ seriesBreak: string; startDate: string }> = [];
  for (const raw of rows) {
    const row = recordOrNull(raw);
    const seriesBreak = textOrNull(row?.seriesbreak) ?? textOrNull(row?.seriesBreak);
    const startDate = isoDateOrNull(row?.startdate) ?? isoDateOrNull(row?.startDate);
    if (seriesBreak && startDate) breaks.push({ seriesBreak, startDate });
  }
  return breaks;
}

/** The newest observation of every series that has a figure (the release writes `*` for a suppressed one). */
function parseLatest(payload: unknown): Map<string, SeriesPoint> {
  const latest = new Map<string, SeriesPoint>();
  for (const raw of timeseriesRows(payload)) {
    const row = recordOrNull(raw);
    const keyid = textOrNull(row?.keyid) ?? textOrNull(row?.keyId);
    const asOf = isoDateOrNull(row?.asofdate) ?? isoDateOrNull(row?.asOfDate);
    const value = numericOrNull(row?.value);
    if (!keyid || !asOf || value == null) continue;
    const known = latest.get(keyid);
    if (!known || asOf > known.asOf) latest.set(keyid, { asOf, value });
  }
  return latest;
}

/** Every observation of one series, oldest first. */
function parseSeriesPoints(payload: unknown): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const raw of timeseriesRows(payload)) {
    const row = recordOrNull(raw);
    const asOf = isoDateOrNull(row?.asofdate) ?? isoDateOrNull(row?.asOfDate);
    const value = numericOrNull(row?.value);
    if (asOf && value != null) points.push({ asOf, value });
  }
  return points.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

async function readJson(url: string): Promise<unknown> {
  const response = await httpFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "gloomberb" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

/** The series break changes about every two years; one read serves the session. */
let seriesBreakRead: Promise<string> | null = null;

function currentSeriesBreak(force: boolean): Promise<string> {
  if (!seriesBreakRead || force) {
    const read = readJson(`${API}/list/seriesbreaks.json`).then((payload) => {
      const seriesBreak = newestSeriesBreak(parseSeriesBreaks(payload));
      if (!seriesBreak) throw new Error("No series break was listed.");
      return seriesBreak;
    });
    seriesBreakRead = read;
    // A failed read is not kept, so the next one asks again.
    read.catch(() => { if (seriesBreakRead === read) seriesBreakRead = null; });
  }
  return seriesBreakRead;
}

/**
 * The board in two reads: the break the release is in now, and the latest
 * figure of every series in it together with each one's change from the week
 * before. History is not read here; see `loadDealerHistory`.
 */
export async function fetchPrimaryDealers(): Promise<DealerBoard> {
  const seriesBreak = await currentSeriesBreak(false);
  const rows = buildDealerRows(parseLatest(await readJson(`${API}/latest/${encodeURIComponent(seriesBreak)}.json`)));
  if (rows.length === 0) throw new Error("No positions were recognized.");
  return {
    seriesBreak,
    positions: rows.filter((row) => row.tab === "positions"),
    fails: rows.filter((row) => row.tab === "fails"),
    asOf: boardAsOf(rows),
  };
}

interface SeriesRead {
  at: number;
  read: Promise<SeriesPoint[]>;
  points: SeriesPoint[] | null;
}

const seriesReads = new Map<string, SeriesRead>();

function seriesRead(seriesBreak: string, key: string, force: boolean): Promise<SeriesPoint[]> {
  const id = `${seriesBreak}:${key}`;
  const known = seriesReads.get(id);
  if (known && !force && Date.now() - known.at < HISTORY_TTL_MS) return known.read;
  const url = `${API}/get/${encodeURIComponent(seriesBreak)}/timeseries/${encodeURIComponent(key)}.json`;
  const entry: SeriesRead = {
    at: Date.now(),
    points: null,
    read: readJson(url).then((payload) => {
      entry.points = parseSeriesPoints(payload);
      return entry.points;
    }),
  };
  seriesReads.set(id, entry);
  // A failed read is not kept, so the next one asks again.
  entry.read.catch(() => { if (seriesReads.get(id) === entry) seriesReads.delete(id); });
  return entry.read;
}

/** A row's history, one read per series behind it, each kept for the session. */
export async function loadDealerHistory(
  seriesBreak: string,
  row: Pick<DealerRow, "id" | "keys">,
  force = false,
): Promise<DealerHistory> {
  const series = await Promise.all(row.keys.map((key) => seriesRead(seriesBreak, key, force)));
  return { rowId: row.id, points: sumSeries(series) };
}

/** The points of every series behind the row when they are all in hand and fresh. */
function heldSeries(seriesBreak: string, row: Pick<DealerRow, "keys">): SeriesPoint[][] | null {
  const series: SeriesPoint[][] = [];
  for (const key of row.keys) {
    const known = seriesReads.get(`${seriesBreak}:${key}`);
    if (!known?.points || Date.now() - known.at >= HISTORY_TTL_MS) return null;
    series.push(known.points);
  }
  return series;
}

/** Whether the row's history is in hand, so a chart can follow the selection at once. */
export function hasDealerHistory(seriesBreak: string, row: Pick<DealerRow, "keys">): boolean {
  return heldSeries(seriesBreak, row) != null;
}

/** The history when every series behind the row is already in hand, so a chart can draw before any read. */
export function cachedDealerHistory(seriesBreak: string, row: Pick<DealerRow, "id" | "keys">): DealerHistory | null {
  const series = heldSeries(seriesBreak, row);
  return series ? { rowId: row.id, points: sumSeries(series) } : null;
}

/** Forgets what was read, for a test or a refresh that must see the release again. */
export function resetPrimaryDealersCache(): void {
  seriesBreakRead = null;
  seriesReads.clear();
}
