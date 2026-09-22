import { apiClient } from "../../../api-client";
import { isYieldObservationDate } from "../yield-curve/treasury-data";
import type { TreasuryBenchmarkPoint } from "./math";

export interface BondBenchmark { points: TreasuryBenchmarkPoint[]; notices: string[] }

/** Older or partially deployed GC endpoints must not stop local bond math. */
export function parseBondBenchmark(payload: unknown): BondBenchmark {
  if (!Array.isArray(payload)) throw new Error("Treasury curve response is unavailable");
  const points: TreasuryBenchmarkPoint[] = [];
  const notices = new Set<string>();
  for (const row of payload) {
    if (!row || typeof row !== "object" || typeof row.maturityYears !== "number" || !Number.isFinite(row.maturityYears)
      || row.maturityYears <= 0 || (row.yield !== null && (typeof row.yield !== "number" || !Number.isFinite(row.yield)))) {
      notices.add("Some Treasury points have an invalid response shape.");
      continue;
    }
    if (row.stale) notices.add("Treasury curve includes cached observations after a source failure.");
    if (row.error) notices.add("Some Treasury observations are unavailable.");
    if (row.yield != null && !isYieldObservationDate(row.asOf)) notices.add("Some Treasury observation dates are missing or invalid.");
    points.push({ maturityYears: row.maturityYears, yieldPercent: row.yield, asOf: isYieldObservationDate(row.asOf) ? row.asOf : null });
  }
  return { points, notices: [...notices] };
}

export async function loadBondBenchmark(loader: () => Promise<unknown> = () => apiClient.getCloudYieldCurve()): Promise<BondBenchmark> {
  return parseBondBenchmark(await loader());
}
