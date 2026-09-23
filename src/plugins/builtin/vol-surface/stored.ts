import type { OptionContract } from "../../../types/financials";
import { logForwardMoneyness, type ExpectedMove, type SkewMetrics, type SmileFit } from "../shared/volatility";
import type { StoredSurfacePayload } from "../iv-history/client";
import { evaluateSurfaceSmile, normalizeSurfaceSettings, type SurfaceExpiry, type SurfaceFilterCounts, type SurfaceSnapshot } from "./model";

/** The platform's compact expiry: fit, forward, rate and the quoted OTM points of one close capture. */
interface StoredExpiry {
  expiration: number;
  years: number;
  rate: number | null;
  rateMethod: SurfaceExpiry["rateMethod"];
  rateAsOf: string[];
  forward: number | null;
  dividendYield: number | null;
  atmIV: number | null;
  termSlope: number | null;
  skew: SkewMetrics;
  expectedMove: ExpectedMove;
  fit: SmileFit | null;
  filterCounts: SurfaceFilterCounts;
  warnings: string[];
  asOf: string | null;
  /** [strike, side (0 put, 1 call), iv, mid, bid, ask, open interest, contract] */
  points: [number, 0 | 1, number | null, number | null, number | null, number | null, number | null, string][];
}
interface StoredSurface {
  version: 1;
  symbol: string;
  spot: number;
  spotAsOf: string | null;
  capturedAt: string;
  source: string | null;
  expiries: StoredExpiry[];
  failures: string[];
}

export interface StoredSurfaceInfo { sessionDate: string; capturedAt: string }
export type DatedSurfaceSnapshot = SurfaceSnapshot & { stored?: StoredSurfaceInfo };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function storedExpiry(entry: StoredExpiry, spot: number, capturedAt: number, source: string | null): SurfaceExpiry {
  const expiry: SurfaceExpiry = {
    expiration: entry.expiration, years: entry.years, state: "ready", asOf: entry.asOf, source: source ?? "stored close capture",
    dataSource: null, feed: null, realtimeEligible: null, delayMinutes: null, stale: false,
    rate: entry.rate, rateMethod: entry.rateMethod, rateAsOf: entry.rateAsOf ?? [], forward: entry.forward, dividendYield: entry.dividendYield,
    // Parity pairs are not stored; the forward and yield they produced are.
    parity: { forward: entry.forward, dividendYield: entry.dividendYield, pairs: [], method: entry.forward == null ? "unavailable" : "put-call-parity", warnings: [] },
    points: [], fit: entry.fit, atmIV: entry.atmIV, expectedMove: entry.expectedMove, skew: entry.skew, filterCounts: entry.filterCounts,
    warnings: entry.warnings ?? [], error: null, termSlope: entry.termSlope,
  };
  for (const [strike, sideCode, iv, mid, bid, ask, openInterest, contractSymbol] of entry.points ?? []) {
    if (!finite(strike) || !finite(iv) || !finite(mid) || !(mid > 0) || !finite(entry.forward)) continue;
    const side = sideCode === 1 ? "call" as const : "put" as const;
    const contract: OptionContract = { contractSymbol, strike, currency: "USD", lastPrice: mid, change: 0, percentChange: 0,
      openInterest: openInterest ?? undefined, bid: bid ?? 0, ask: ask ?? 0, impliedVolatility: iv,
      inTheMoney: side === "call" ? strike < spot : strike > spot, expiration: entry.expiration, lastTradeDate: Math.floor(capturedAt / 1000) };
    const spread = finite(bid) && finite(ask) ? ask - bid : 0;
    expiry.points.push({ contract, side, strike, moneyness: strike / spot, logMoneyness: logForwardMoneyness(strike, entry.forward)!,
      mid, price: mid, spread, spreadRatio: spread / mid, openInterest: openInterest ?? 0, providerIV: null, volatility: iv, fitResidual: null });
  }
  expiry.points.sort((a, b) => a.strike - b.strike);
  for (const point of expiry.points) point.fitResidual = point.volatility - (evaluateSurfaceSmile(expiry, point.strike) ?? point.volatility);
  return expiry;
}

/** A stored close surface in the shape the live OVDV views render: mid quotes, recomputed IV. */
export function storedSurfaceSnapshot(payload: StoredSurfacePayload): DatedSurfaceSnapshot {
  const surface = payload.surface as unknown as StoredSurface;
  if (!surface || surface.version !== 1 || !Array.isArray(surface.expiries)) throw new Error("Unsupported stored surface format");
  const capturedAt = Date.parse(payload.capturedAt);
  const expiries = surface.expiries.map((entry) => storedExpiry(entry, payload.spot, capturedAt, surface.source))
    .filter((entry) => entry.points.length > 0).sort((a, b) => a.expiration - b.expiration);
  const rateDates = expiries.flatMap((entry) => entry.rateAsOf).sort();
  return {
    symbol: payload.symbol, spot: payload.spot, spotAsOf: surface.spotAsOf ?? payload.capturedAt, phase: "ready",
    settings: normalizeSurfaceSettings({}), catalogue: expiries.map((entry) => entry.expiration),
    requested: expiries.length, loaded: expiries.length, failed: surface.failures?.length ?? 0, expiries,
    failures: (surface.failures ?? []).map((message) => ({ expiration: null, message })), warnings: [],
    rateAsOf: rateDates.at(-1) ?? null, fetchedAt: capturedAt,
    stored: { sessionDate: payload.sessionDate, capturedAt: payload.capturedAt },
  };
}
