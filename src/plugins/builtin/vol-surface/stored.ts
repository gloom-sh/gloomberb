import type { OptionContract } from "../../../types/financials";
import { logForwardMoneyness, type ExpectedMove, type SkewMetrics, type SmileFit } from "../shared/volatility";
import { ivSymbol, loadStoredSurface, loadSurfaceDates, type ImpliedVolatilityApi, type StoredSurfacePayload } from "../iv-history/client";
import { ApiRequestError } from "../../../api-client/errors";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../../../api-client/plan-rules";
import { evaluateSurfaceSmile, normalizeSurfaceSettings, type SurfaceExpiry, type SurfaceFilterCounts, type SurfaceSnapshot } from "./model";
import { isFiniteNumber } from "../../../utils/guards";
import { dateOptionError, readCalendarDate } from "../../../utils/calendar-date";

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

interface StoredSurfaceInfo { sessionDate: string; capturedAt: string }
export type DatedSurfaceSnapshot = SurfaceSnapshot & { stored?: StoredSurfaceInfo };

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
    if (!isFiniteNumber(strike) || !isFiniteNumber(iv) || !isFiniteNumber(mid) || !(mid > 0) || !isFiniteNumber(entry.forward)) continue;
    const side = sideCode === 1 ? "call" as const : "put" as const;
    const contract: OptionContract = { contractSymbol, strike, currency: "USD", lastPrice: mid, change: 0, percentChange: 0,
      openInterest: isFiniteNumber(openInterest) ? openInterest : undefined, bid: bid ?? 0, ask: ask ?? 0, impliedVolatility: iv,
      inTheMoney: side === "call" ? strike < spot : strike > spot, expiration: entry.expiration, lastTradeDate: Math.floor(capturedAt / 1000) };
    const spread = isFiniteNumber(bid) && isFiniteNumber(ask) ? ask - bid : 0;
    expiry.points.push({ contract, side, strike, moneyness: strike / spot, logMoneyness: logForwardMoneyness(strike, entry.forward)!,
      mid, price: mid, spread, spreadRatio: spread / mid, openInterest: isFiniteNumber(openInterest) ? openInterest : null, providerIV: null, volatility: iv, fitResidual: null });
  }
  expiry.points.sort((a, b) => a.strike - b.strike);
  for (const point of expiry.points) point.fitResidual = point.volatility - (evaluateSurfaceSmile(expiry, point.strike) ?? point.volatility);
  return expiry;
}

const CAPTURE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** A capture's New York clock time, "15:47", as the pane and the report both say it. */
export function formatCaptureTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? CAPTURE_TIME.format(time) : "--";
}

/** A session date as `--date` takes it: YYYY-MM-DD, a day the calendar has. */
export function storedSurfaceDate(value: string, now = new Date()): string {
  const date = readCalendarDate(value);
  if (!date) throw new Error(dateOptionError(value, "--date", { now, subject: "a session date" }));
  return date;
}

/** Past this many stored dates, a miss names the nearest ones and the span. */
const LISTED_DATES = 30;
const NEAREST_DATES = 10;

/**
 * Why there is no stored surface to show for `date`. A date on the stored
 * list that still did not load is a capture not shown yet: without real-time
 * data a capture shows 15 minutes after it is taken, which is not a missing
 * date. Otherwise the stored dates are named, newest first.
 */
export function storedSurfaceMiss(symbol: string, date: string, dates: readonly string[]): string {
  if (dates.includes(date)) {
    return `The ${symbol} ${date} close capture is not shown yet: without real-time data a capture shows ${CLOUD_QUOTE_DELAY_MINUTES} minutes after it is taken.`;
  }
  const stored = [...new Set(dates)].sort().reverse();
  if (!stored.length) return `No stored ${symbol} close surface for ${date}: ${symbol} has none stored.`;
  if (stored.length <= LISTED_DATES) return `No stored ${symbol} close surface for ${date}. Stored dates: ${stored.join(", ")}.`;
  const target = Date.parse(`${date}T00:00:00Z`);
  const distance = (entry: string) => Math.abs(Date.parse(`${entry}T00:00:00Z`) - target);
  const nearest = [...stored].sort((a, b) => distance(a) - distance(b) || b.localeCompare(a)).slice(0, NEAREST_DATES).sort().reverse();
  return `No stored ${symbol} close surface for ${date}. Nearest stored dates: ${nearest.join(", ")}; `
    + `${stored.length} stored from ${stored.at(-1)} to ${stored[0]}.`;
}

/**
 * The stored close surface of one session, for `fn OVDV --date`. The date
 * list and the surface are asked for together; the list only matters when
 * the surface is not there.
 */
export async function loadDatedSurface(symbol: string, date: string, options: { signal?: AbortSignal; api?: ImpliedVolatilityApi } = {}): Promise<DatedSurfaceSnapshot> {
  const bare = ivSymbol(symbol);
  const request = { ...options.signal ? { signal: options.signal } : {} };
  const [surface, dates] = await Promise.allSettled([loadStoredSurface(bare, date, request, options.api),
    loadSurfaceDates(bare, request, options.api)]);
  if (surface.status === "fulfilled") return storedSurfaceSnapshot(surface.value);
  if (!(surface.reason instanceof ApiRequestError && surface.reason.status === 404)) throw surface.reason;
  if (dates.status === "rejected") throw dates.reason;
  throw new Error(storedSurfaceMiss(bare, date, dates.value.dates));
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
