import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { logFailure } from "../../../utils/log-failure";
import type { CloudCurveId, CloudCurvePoint, CloudWorldCurves } from "../../../api-client/yield-curves";
import { isCurveId, type CurveId } from "./curves";
import type { CurveBasis } from "./forward";

export interface WorldRow {
  id: CurveId;
  market: string;
  /** Each market's own session: publishers print on different days. */
  asOf: string;
  previousAsOf: string | null;
  twoYear: number | null;
  tenYear: number | null;
  thirtyYear: number | null;
  /** Moves since the market's session before, percentage points. */
  twoYearChange: number | null;
  tenYearChange: number | null;
  thirtyYearChange: number | null;
  /** 10Y minus 2Y. */
  twosTens: number | null;
  /** The basis the publisher printed: par, zero, benchmark, or spread. */
  basis: CurveBasis;
  twosTensChange: number | null;
  /** The whole latest curve, for the chart. */
  points: CloudCurvePoint[];
}

const MARKETS: Record<string, string> = {
  us: "US", de: "Germany", gb: "UK", jp: "Japan", ca: "Canada", "eu-aaa": "Euro AAA", mx: "Mexico", br: "Brazil",
};

/** How far before a date asked for a market's last session still answers it, as Gloom Cloud reads a curve. */
const SESSION_WINDOW_DAYS = 10;

/** The world grid as read: a row per market, and by name the markets a read as of a date could not get. */
export interface WorldBoard {
  rows: WorldRow[];
  /** Markets whose own curve failed to load as of the date (a server error, no network): left out, and named. */
  unread: string[];
}

const andList = (names: readonly string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;

/**
 * What a board as of a date says of the markets it has no row for: those
 * with no session near enough the date (`No session on or in the 10 days
 * before 2001-01-02: Mexico and Brazil.`) and those whose curve could not be
 * read (`Could not be read as of 2026-11-13: Japan.`). Null for the latest
 * board, and when every market has a row.
 */
export function worldMissingNote(board: WorldBoard, requestedDate: string): string | null {
  if (!requestedDate) return null;
  const missing = Object.entries(MARKETS)
    .filter(([id, name]) => !board.rows.some((row) => row.id === id) && !board.unread.includes(name)).map(([, name]) => name);
  const notes = [
    missing.length ? `No session on or in the ${SESSION_WINDOW_DAYS} days before ${requestedDate}: ${andList(missing)}.` : null,
    board.unread.length ? `Could not be read as of ${requestedDate}: ${andList(board.unread)}.` : null,
  ].filter((note): note is string => !!note);
  return notes.length ? notes.join(" ") : null;
}

const valueAt = (points: readonly CloudCurvePoint[] | undefined, tenor: string) => {
  const value = points?.find((point) => point.tenor === tenor)?.yield;
  return value != null && Number.isFinite(value) ? value : null;
};
const minus = (left: number | null, right: number | null) => left == null || right == null ? null : left - right;

function worldRows(payload: CloudWorldCurves): WorldRow[] {
  return payload.curves.flatMap((entry): WorldRow[] => {
    if (!isCurveId(entry.curve.id)) return [];
    const now = (tenor: string) => valueAt(entry.points, tenor);
    const before = (tenor: string) => valueAt(entry.previous?.points, tenor);
    const twosTens = minus(now("10Y"), now("2Y"));
    return [{
      id: entry.curve.id, market: MARKETS[entry.curve.id] ?? entry.curve.label,
      asOf: entry.asOf, previousAsOf: entry.previous?.asOf ?? null,
      twoYear: now("2Y"), tenYear: now("10Y"), thirtyYear: now("30Y"),
      twoYearChange: minus(now("2Y"), before("2Y")), tenYearChange: minus(now("10Y"), before("10Y")),
      thirtyYearChange: minus(now("30Y"), before("30Y")),
      twosTens, twosTensChange: minus(twosTens, minus(before("10Y"), before("2Y"))),
      basis: entry.curve.basis,
      points: entry.points,
    }];
  });
}

type WorldCurve = CloudWorldCurves["curves"][number];

/**
 * One market as of a date from its own curve, with the session before as its
 * 1D look-back has it; null when it has none on or within ten days before,
 * and `unread` when the read failed any other way.
 */
async function curveOnOrBefore(client: Pick<typeof apiClient, "getCloudCurve">, id: CloudCurveId, date: string): Promise<WorldCurve | null | "unread"> {
  try {
    const view = await client.getCloudCurve(id, date);
    if (view.asOf > date) return null;
    const day = view.lookbacks.find((lookback) => lookback.id === "1D");
    return {
      curve: view.curve, asOf: view.asOf, points: view.points, checkedAt: view.checkedAt,
      previous: day?.asOf && day.points ? { asOf: day.asOf, points: day.points } : null,
    };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    // One market that fails leaves the others standing; the board names it.
    return logFailure("yield-curve.world", "Read a market's curve as of a date failed", "unread" as const)(error);
  }
}

/**
 * Each market's latest curve, or with `requestedDate` its last session on or
 * before that day (within ten days). Never a session after the date: a market
 * a server answers with a later one (one older than dated reads, which sends
 * the latest) is read as of the date from its own curve instead. A market
 * with no session near enough is left out, and so is one whose own read
 * fails, named in `unread`: one market's server error never empties the board.
 */
export async function loadWorldBoard(
  client: Pick<typeof apiClient, "getCloudWorldCurves" | "getCloudCurve"> = apiClient,
  requestedDate = "",
): Promise<WorldBoard> {
  const payload = await client.getCloudWorldCurves(requestedDate || null);
  if (!requestedDate) return { rows: worldRows(payload), unread: [] };
  const read = await Promise.all(payload.curves.map(async (entry) => ({
    entry, curve: entry.asOf <= requestedDate ? entry : await curveOnOrBefore(client, entry.curve.id, requestedDate),
  })));
  return {
    rows: worldRows({ curves: read.flatMap(({ curve }) => curve && curve !== "unread" ? [curve] : []) }),
    unread: read.flatMap(({ entry, curve }) => curve === "unread" ? [MARKETS[entry.curve.id] ?? entry.curve.label] : []),
  };
}
