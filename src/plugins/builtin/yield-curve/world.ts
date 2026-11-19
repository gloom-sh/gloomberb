import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
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

/**
 * What a board as of a date says of the markets it has no row for, those with
 * no session near enough the date: `No session on or in the 10 days before
 * 2001-01-02: Mexico and Brazil.` Null for the latest board, and when every
 * market has a row.
 */
export function worldMissingNote(rows: readonly Pick<WorldRow, "id">[], requestedDate: string): string | null {
  if (!requestedDate) return null;
  const missing = Object.entries(MARKETS).filter(([id]) => !rows.some((row) => row.id === id)).map(([, name]) => name);
  if (missing.length === 0) return null;
  const names = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]!;
  return `No session on or in the ${SESSION_WINDOW_DAYS} days before ${requestedDate}: ${names}.`;
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
 * 1D look-back has it; null when it has none on or within ten days before.
 */
async function curveOnOrBefore(client: Pick<typeof apiClient, "getCloudCurve">, id: CloudCurveId, date: string): Promise<WorldCurve | null> {
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
    throw error;
  }
}

/**
 * Each market's latest curve, or with `requestedDate` its last session on or
 * before that day (within ten days). Never a session after the date: a market
 * a server answers with a later one (one older than dated reads, which sends
 * the latest) is read as of the date from its own curve instead, and a market
 * with no session near enough is left out.
 */
export async function loadWorldRows(
  client: Pick<typeof apiClient, "getCloudWorldCurves" | "getCloudCurve"> = apiClient,
  requestedDate = "",
): Promise<WorldRow[]> {
  const payload = await client.getCloudWorldCurves(requestedDate || null);
  if (!requestedDate) return worldRows(payload);
  const curves = await Promise.all(payload.curves.map((entry) => entry.asOf <= requestedDate
    ? entry : curveOnOrBefore(client, entry.curve.id, requestedDate)));
  return worldRows({ curves: curves.filter((entry): entry is WorldCurve => entry !== null) });
}
