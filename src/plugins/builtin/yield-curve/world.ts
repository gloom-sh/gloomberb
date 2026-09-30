import { apiClient } from "../../../api-client";
import type { CloudCurvePoint, CloudWorldCurves } from "../../../api-client/yield-curves";
import { isCurveId, type CurveId } from "./curves";

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
  twosTensChange: number | null;
  /** The whole latest curve, for the chart. */
  points: CloudCurvePoint[];
}

const MARKETS: Record<string, string> = { us: "US", de: "Germany", gb: "UK", jp: "Japan", ca: "Canada", "eu-aaa": "Euro AAA" };

const valueAt = (points: readonly CloudCurvePoint[] | undefined, tenor: string) => {
  const value = points?.find((point) => point.tenor === tenor)?.yield;
  return value != null && Number.isFinite(value) ? value : null;
};
const minus = (left: number | null, right: number | null) => left == null || right == null ? null : left - right;

export function worldRows(payload: CloudWorldCurves): WorldRow[] {
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
      points: entry.points,
    }];
  });
}

export async function loadWorldRows(client: Pick<typeof apiClient, "getCloudWorldCurves"> = apiClient): Promise<WorldRow[]> {
  return worldRows(await client.getCloudWorldCurves());
}
