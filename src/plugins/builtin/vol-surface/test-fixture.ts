import type { StoredSurfacePayload } from "../iv-history/client";
import type { SurfaceExpiry } from "./model";

/** Gloom Cloud's compaction of a captured surface, including its rounding. */
const round = (value: number | null | undefined, digits: number) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const compact = (expiry: SurfaceExpiry) => ({
  expiration: expiry.expiration, years: round(expiry.years, 8), rate: round(expiry.rate, 6), rateMethod: expiry.rateMethod,
  rateAsOf: expiry.rateAsOf, forward: round(expiry.forward, 4), dividendYield: round(expiry.dividendYield, 6),
  atmIV: round(expiry.atmIV, 6), termSlope: round(expiry.termSlope, 6), skew: expiry.skew, expectedMove: expiry.expectedMove,
  fit: expiry.fit, filterCounts: expiry.filterCounts, warnings: expiry.warnings, asOf: expiry.asOf,
  points: expiry.points.map((point) => [point.strike, point.side === "call" ? 1 : 0, round(point.volatility, 6), round(point.mid, 4),
    round(point.contract.bid, 4), round(point.contract.ask, 4), point.openInterest, point.contract.contractSymbol]),
});

/** What `/cloud/iv/surface` returns for a close capture of these fitted expiries. */
export function storedSurfacePayload(input: {
  symbol: string; sessionDate: string; capturedAt: string; spot: number; expiries: readonly SurfaceExpiry[]; failures?: string[];
}): StoredSurfacePayload {
  return { version: 1, symbol: input.symbol, sessionDate: input.sessionDate, capturedAt: input.capturedAt, spot: input.spot,
    surface: { version: 1, symbol: input.symbol, spot: input.spot, spotAsOf: input.capturedAt, capturedAt: input.capturedAt, source: null,
      expiries: JSON.parse(JSON.stringify(input.expiries.map(compact))), failures: input.failures ?? [] } };
}
