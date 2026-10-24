import type { InstrumentRef } from "../../../market-data/request-types";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessPaneFreshness } from "../../../types/plugin";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { numberErrorMessage, wholeNumberOptionMessage } from "../../../utils/decimal-comma";
import { errorMessage } from "../../../utils/errors";
import { expirationHint, expiredExpiryText, expiryIsoDate, isLiveOptionExpiry, readOptionExpiration } from "../../../utils/option-expiry";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { ivRankReason, loadIvScreen, type ImpliedVolatilityApi, type IvScreenRow } from "../iv-history/client";
import { quoteObservation } from "../shared/report-freshness";
import { loadScenarioMarket, scenarioPositionFromSettings, scenarioSpotBasis, type ScenarioLoaderDependencies, type ScenarioMarketSnapshot } from "./client";
import { cashSecuredPut, loadNextEarningsDates, type CashSecuredPut } from "./csp";
import { seededLegQuotes } from "./hedge";
import { scenarioValue } from "./model";

/**
 * A cash-secured put screen (docs/research-data.md#cash-secured-put-screen):
 * for each name, the put OSA's `--strategy csp --delta` seed sells on the
 * listed expiry nearest the target, read by the same `cashSecuredPut`, ranked
 * by its annualised yield at the bid.
 */
export interface CspScreenCriteria {
  /** The absolute put delta each name's put is nearest, such as 0.30. */
  delta: number;
  /** Calendar days out the expiry is nearest, when no date is given. */
  days: number;
  /** The date the expiry is nearest, in Unix seconds, in place of `days`; null when none is given. */
  expiration: number | null;
  /** A spread over this percent of the midpoint marks the put wide. */
  maxSpreadPercent: number;
}

export const CSP_SCREEN_DEFAULTS: Readonly<Omit<CspScreenCriteria, "expiration">> = { delta: 0.3, days: 30, maxSpreadPercent: 10 };
/** The most names one screen reads: each is two chain requests. */
export const CSP_SCREEN_LIMIT = 20;
const DAY_MS = 86_400_000;
const CONCURRENCY = 4;

export interface CspScreenRow {
  symbol: string;
  /** 1 for the highest yield at the bid; null for a name with no put to rank. */
  rank: number | null;
  csp: CashSecuredPut | null;
  /** The put's delta per share, negative, at the IV its midpoint implies. */
  delta: number | null;
  /** 30-day IV rank, 0 to 100, against the prior 52 weeks; null when IV history has none. */
  ivRank: number | null;
  /** Its spread is over the screen's `maxSpreadPercent` of the midpoint. */
  wideSpread: boolean;
  /** Why the name has no put to rank. */
  note: string | null;
}

export interface CspScreen {
  rows: CspScreenRow[];
  criteria: CspScreenCriteria;
  /** Names IV history has no rank for, with why when it can say, such as `XYZ (no options history)`; a bare symbol has no reason to give. */
  missingRanks: string[];
  /** The IV rank request failed for every name. */
  ivRankError: string | null;
  freshness: HeadlessPaneFreshness;
}

const supplied = (value: unknown) => value != null && value !== "";

function readNumber(value: unknown, flag: string, example: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/%$/, "") : "";
  const number = Number(text);
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(number)) {
    throw new Error(numberErrorMessage(`Invalid --${flag} "${String(value)}". Use ${example}.`, text));
  }
  return number;
}

/** `--days`: whole calendar days. A decimal is told the whole numbers beside it, never a decimal to type. */
function readDays(value: unknown): number {
  const decimal = wholeNumberOptionMessage("--days", "days", value);
  if (decimal) throw new Error(decimal);
  const days = readNumber(value, "days", "whole calendar days, such as 30");
  if (!Number.isInteger(days) || days < 1) throw new Error(`Invalid --days "${String(value)}". Use whole calendar days, such as 30.`);
  return days;
}

/** The screen's criteria from `fn CSP` options or the pane's settings, each default where not set. */
export function readCspScreenCriteria(options: Record<string, unknown>): CspScreenCriteria {
  const delta = supplied(options.delta) ? Math.abs(readNumber(options.delta, "delta", "a put's delta between 0 and 1, such as 0.30")) : CSP_SCREEN_DEFAULTS.delta;
  if (!(delta > 0 && delta < 1)) throw new Error(`Invalid --delta "${String(options.delta)}". Use a put's delta between 0 and 1, such as 0.30.`);
  const days = supplied(options.days) ? readDays(options.days) : CSP_SCREEN_DEFAULTS.days;
  const maxSpreadPercent = supplied(options.maxSpread)
    ? readNumber(options.maxSpread, "max-spread", "a percent of the midpoint above 0, such as 10") : CSP_SCREEN_DEFAULTS.maxSpreadPercent;
  if (!(maxSpreadPercent > 0)) throw new Error(`Invalid --max-spread "${String(options.maxSpread)}". Use a percent of the midpoint above 0, such as 10.`);
  const expiration = supplied(options.expiration) ? readOptionExpiration(options.expiration) : null;
  if (supplied(options.expiration) && expiration == null) throw new Error(`Invalid --expiration "${String(options.expiration)}". Use a date such as 2026-11-20.${expirationHint(String(options.expiration))}`);
  if (expiration != null && supplied(options.days)) throw new Error("--days and --expiration each pick the expiry; give one of them");
  return { delta, days, expiration, maxSpreadPercent };
}

/** The date each name's expiry is nearest, YYYY-MM-DD: the typed date, else `days` out from today in New York. */
export function cspTargetDate(criteria: Pick<CspScreenCriteria, "days" | "expiration">, now: number): string {
  if (criteria.expiration != null) return expiryIsoDate(criteria.expiration);
  return new Date(Date.parse(`${zonedDateKey(now, "America/New_York")}T00:00:00Z`) + criteria.days * DAY_MS).toISOString().slice(0, 10);
}

/** The listed expiry whose date is nearest `target` (YYYY-MM-DD), the earlier on a tie; undefined when none is listed. */
export function nearestListedExpiry(expirations: readonly number[], target: string): number | undefined {
  const targetTime = Date.parse(`${target}T00:00:00Z`);
  let best: { expiration: number; distance: number } | undefined;
  for (const expiration of [...expirations].sort((a, b) => a - b)) {
    const distance = Math.abs(Date.parse(`${expiryIsoDate(expiration)}T00:00:00Z`) - targetTime);
    if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { expiration, distance };
  }
  return best?.expiration;
}

const bidYield = (row: CspScreenRow) => row.csp?.quote?.bidAnnualizedYield ?? null;

/**
 * Highest annualised yield at the bid first; a wide spread is ranked with the
 * rest and flagged, never left out. A put with no yield to rank (it expires
 * today) follows, then the names with no put, by symbol.
 */
export function rankCspScreen(rows: readonly Omit<CspScreenRow, "rank">[]): CspScreenRow[] {
  const tier = (row: Omit<CspScreenRow, "rank">) => bidYield(row as CspScreenRow) != null ? 0 : row.csp ? 1 : 2;
  const sorted = [...rows].sort((left, right) => tier(left) - tier(right)
    || (bidYield(right as CspScreenRow) ?? 0) - (bidYield(left as CspScreenRow) ?? 0)
    || left.symbol.localeCompare(right.symbol));
  let rank = 0;
  return sorted.map((row) => ({ ...row, rank: tier(row) === 0 ? ++rank : null }));
}

/** Whether a put's spread is over the screen's limit. */
function cspWideSpread(csp: CashSecuredPut | null, maxSpreadPercent: number): boolean {
  return csp?.quote != null && csp.quote.spreadOfMid * 100 > maxSpreadPercent;
}

export interface CspScreenDependencies {
  scenario: ScenarioLoaderDependencies;
  /** The earnings calendar's source. */
  earnings: DataProvider | null | undefined;
  /** Gloom Cloud's IV history; the app's client when omitted. */
  ivApi?: ImpliedVolatilityApi;
}

interface ScreenedPut { csp: CashSecuredPut; delta: number | null; market: ScenarioMarketSnapshot }

/** One name's put: OSA's csp seed at `--delta` on the listed expiry nearest the target, read as OSA reads it. */
async function screenPut(
  instrument: InstrumentRef, criteria: CspScreenCriteria, dependencies: ScenarioLoaderDependencies, target: string,
  earningsDate: string | null, signal: AbortSignal | undefined,
): Promise<ScreenedPut> {
  const first = await loadScenarioMarket({ instrument, signal }, dependencies);
  // A typed date whose last session has closed is not stood in for by the next one: it says so, and names it.
  const now = dependencies.now?.() ?? Date.now();
  if (criteria.expiration != null && !isLiveOptionExpiry(criteria.expiration, now, instrument.exchange)) {
    throw new Error(`Expiry ${expiryIsoDate(criteria.expiration)} `
      + expiredExpiryText(criteria.expiration, first.expirationDates, now, { exchange: instrument.exchange, flag: "expiration" }));
  }
  const expiration = nearestListedExpiry(first.expirationDates, target);
  if (expiration == null) {
    throw new Error(first.warnings.find((warning) => warning.startsWith("Options chain")) ?? "No listed option expiries");
  }
  const loaded = first.chain ? [...first.chain.puts, ...first.chain.calls][0]?.expiration : undefined;
  const market = loaded != null && expiryIsoDate(loaded) === expiryIsoDate(expiration)
    ? first : await loadScenarioMarket({ instrument, expiration, signal }, dependencies);
  const settings = { symbol: instrument.symbol, exchange: instrument.exchange, strategy: "csp", delta: criteria.delta };
  const position = scenarioPositionFromSettings(settings, market);
  const leg = position?.legs[0];
  if (!position || !leg) throw new Error("No put to sell on this chain");
  const quote = seededLegQuotes(position, market.chain).get(leg.id);
  const csp = cashSecuredPut(position, scenarioSpotBasis(settings, position, market), earningsDate, quote);
  if (!csp) throw new Error("No put to sell on this chain");
  const shares = leg.quantity * leg.multiplier;
  const delta = scenarioValue(position, position.spot, position.asOf).delta / shares;
  return { csp, delta: Number.isFinite(delta) ? delta : null, market };
}

async function loadIvRanks(symbols: readonly string[], signal: AbortSignal | undefined, api: ImpliedVolatilityApi | undefined) {
  try {
    const payload = await loadIvScreen(symbols, { signal }, api);
    return { rows: new Map<string, IvScreenRow>(payload.rows.map((row) => [row.symbol.toUpperCase(), row])), error: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { rows: new Map<string, IvScreenRow>(), error: errorMessage(error) ?? "no response" };
  }
}

/**
 * How current the screen is: each name's underlying quote dates its row, and
 * the chains' feed (delayed when any is) says how far behind they run.
 */
function screenFreshness(markets: readonly ScenarioMarketSnapshot[], now: number): HeadlessPaneFreshness {
  const chains = markets.flatMap((market) => market.chain ? [market.chain] : []);
  const delayed = chains.some((chain) => chain.dataSource === "delayed");
  const live = chains.length > 0 && chains.every((chain) => chain.dataSource === "live");
  const delayMinutes = Math.max(0, ...chains.map((chain) => chain.delayMinutes ?? 0));
  const observations = markets.flatMap((market) => market.underlyingQuote ? [{ ...quoteObservation(market.underlyingQuote, now) }] : []);
  return {
    ...(delayed ? { status: "delayed" as const } : live ? { status: "live" as const } : {}),
    ...(delayed && delayMinutes ? { delayMinutes } : {}),
    ...(observations.length ? { observations } : markets[0] ? { asOf: markets[0].asOf } : {}),
  };
}

/**
 * Each name's cash-secured put, ranked: one IV rank request, one earnings
 * calendar request and one Treasury curve for all of them.
 */
export async function loadCspScreen(
  instruments: readonly InstrumentRef[], criteria: CspScreenCriteria, dependencies: CspScreenDependencies, signal?: AbortSignal,
): Promise<CspScreen> {
  const now = dependencies.scenario.now?.() ?? Date.now();
  // Every name reads the same curve, up to twice (the catalogue, then its expiry): asked for once, when the first name needs it.
  let curve: ReturnType<ScenarioLoaderDependencies["loadYieldCurve"]> | null = null;
  const scenario: ScenarioLoaderDependencies = { ...dependencies.scenario, loadYieldCurve: () => curve ??= dependencies.scenario.loadYieldCurve() };
  const symbols = instruments.map((instrument) => instrument.symbol.trim().toUpperCase());
  const [ivRanks, earnings] = await Promise.all([
    loadIvRanks(symbols, signal, dependencies.ivApi),
    loadNextEarningsDates(dependencies.earnings, symbols, zonedDateKey(now, "America/New_York")),
  ]);
  signal?.throwIfAborted();
  const target = cspTargetDate(criteria, now);
  const markets: ScenarioMarketSnapshot[] = [];
  const missingRanks: string[] = [];
  const rows = await mapWithConcurrency(instruments, CONCURRENCY, async (instrument, index): Promise<Omit<CspScreenRow, "rank">> => {
    const symbol = symbols[index]!;
    const ivRow = ivRanks.rows.get(symbol);
    const rank = ivRow?.iv30?.rank;
    const ivRank = rank != null && Number.isFinite(rank) ? rank : null;
    try {
      const screened = await screenPut(instrument, criteria, scenario, target, earnings.get(symbol) ?? null, signal);
      markets.push(screened.market);
      if (ivRank == null && !ivRanks.error) {
        const reason = ivRankReason(ivRow);
        missingRanks.push(reason ? `${symbol} (${reason})` : symbol);
      }
      return { symbol, csp: screened.csp, delta: screened.delta, ivRank, wideSpread: cspWideSpread(screened.csp, criteria.maxSpreadPercent), note: null };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { symbol, csp: null, delta: null, ivRank, wideSpread: false, note: errorMessage(error) ?? "No put to sell" };
    }
  });
  return { rows: rankCspScreen(rows), criteria, missingRanks: missingRanks.sort(), ivRankError: ivRanks.error,
    freshness: screenFreshness(markets, now) };
}

/** `nearest 0.30 delta · expiry nearest 2026-11-21 (30 days)`: what each name's put is. */
export function cspScreenCriteriaText(criteria: CspScreenCriteria, now: number): string {
  return `nearest ${criteria.delta.toFixed(2)} delta · expiry nearest ${cspTargetDate(criteria, now)}`
    + (criteria.expiration == null ? ` (${criteria.days} days)` : "");
}

/** `before 2026-11-04`, `after 2027-01-19`, `unknown`: whether the next report falls before the put expires, and its date. */
export function cspEarningsText(csp: CashSecuredPut | null): string {
  if (!csp) return "--";
  const { beforeExpiry, date } = csp.earnings;
  return beforeExpiry == null ? "unknown" : `${beforeExpiry ? "before" : "after"} ${date}`;
}

