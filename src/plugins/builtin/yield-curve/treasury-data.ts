import { apiClient } from "../../../api-client";

export interface YieldPoint {
  maturity: string;      // "1M", "3M", "6M", "1Y", "2Y", "5Y", "7Y", "10Y", "20Y", "30Y"
  maturityYears: number; // 0.083, 0.25, 0.5, 1, 2, 5, 7, 10, 20, 30
  yield: number | null;  // percent, e.g., 4.29
  asOf?: string | null;  // FRED observation date, absent on older servers
}

export const TREASURY_MATURITIES: Array<{ maturity: string; years: number; seriesId: string }> = [
  { maturity: "1M",  years: 1/12,  seriesId: "DGS1MO" },
  { maturity: "3M",  years: 0.25,  seriesId: "DGS3MO" },
  { maturity: "6M",  years: 0.5,   seriesId: "DGS6MO" },
  { maturity: "1Y",  years: 1,     seriesId: "DGS1" },
  { maturity: "2Y",  years: 2,     seriesId: "DGS2" },
  { maturity: "5Y",  years: 5,     seriesId: "DGS5" },
  { maturity: "7Y",  years: 7,     seriesId: "DGS7" },
  { maturity: "10Y", years: 10,    seriesId: "DGS10" },
  { maturity: "20Y", years: 20,    seriesId: "DGS20" },
  { maturity: "30Y", years: 30,    seriesId: "DGS30" },
];

export async function loadYieldCurve(): Promise<YieldPoint[]> {
  return apiClient.getCloudYieldCurve();
}

export function parseYieldPoints(points: YieldPoint[]): YieldPoint[] {
  return points
    .filter((p) => p.yield !== null)
    .sort((a, b) => a.maturityYears - b.maturityYears);
}

/**
 * The newest observation date across the curve. Treasury series publish
 * together, but a single stale series must not date the whole curve forward,
 * so this reports the latest date actually present.
 */
export function curveAsOf(points: readonly YieldPoint[]): string | null {
  let latest: string | null = null;
  for (const point of points) {
    const asOf = point.asOf;
    if (!asOf) continue;
    if (!latest || asOf > latest) latest = asOf;
  }
  return latest;
}

export function isInverted(points: YieldPoint[]): boolean {
  const y2 = points.find((p) => p.maturity === "2Y")?.yield;
  const y10 = points.find((p) => p.maturity === "10Y")?.yield;
  return y2 != null && y10 != null && y2 > y10;
}
