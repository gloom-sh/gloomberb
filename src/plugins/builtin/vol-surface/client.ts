import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef, OptionsRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain } from "../../../types/financials";
import { daysToExpiryFrom } from "../options-calculator/model";
import type { YieldPoint } from "../yield-curve/treasury-data";
import {
  buildSurfaceExpiry, normalizeSurfaceSettings, pendingSurfaceExpiry, surfaceCalendarWarnings, withSurfaceTermSlopes,
  type SurfaceExpiry, type SurfaceFailure, type SurfaceSettings, type SurfaceSnapshot,
} from "./model";

export const DEFAULT_SURFACE_EXPIRY_LIMIT = 18;
export const SURFACE_LOAD_CONCURRENCY = 4;
/** Each kept expiry must be at least this much further out than the previous one. */
export const SURFACE_TENOR_RATIO = 1.35;

/**
 * Daily and weekly listings are thinned geometrically so a bounded request spans
 * the term structure instead of the front month. Every expiry within the limit is
 * still loaded when the catalogue is short; a larger limit adds the skipped
 * expiries starting from the longest tenor.
 */
export function selectSurfaceExpiries(catalogue: readonly number[], limit: number, now: number): number[] {
  const sorted = [...new Set(catalogue)].sort((a, b) => a - b);
  const kept: number[] = [];
  const skipped: number[] = [];
  let lastDays = 0;
  for (const expiration of sorted) {
    const days = daysToExpiryFrom(expiration, now);
    if (kept.length === 0 || days >= lastDays * SURFACE_TENOR_RATIO) {
      kept.push(expiration);
      lastDays = days;
    } else skipped.push(expiration);
  }
  return [...kept, ...skipped.reverse()].slice(0, Math.max(0, limit)).sort((a, b) => a - b);
}

export interface SurfaceLoaderDependencies {
  loadOptions(request: OptionsRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<OptionsChain>>;
  loadYieldCurve(): Promise<YieldPoint[]>;
  now?: () => number;
}

/** The pane and headless path both use the existing coordinator's option-chain loader. */
export function createSurfaceDependencies(
  marketData?: DataProvider,
  cloudApi: { getCloudYieldCurve(): Promise<YieldPoint[]> } = apiClient,
): SurfaceLoaderDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return {
    loadOptions: (request, options) => coordinator
      ? coordinator.loadOptions(request, options)
      : Promise.reject(new Error("Market data coordinator unavailable")),
    loadYieldCurve: () => cloudApi.getCloudYieldCurve(),
  };
}

/** The Treasury curve is published daily; repeated live reloads read it once per window. */
export const TREASURY_CURVE_REUSE_MS = 30 * 60_000;

/**
 * Dependencies whose Treasury curve is loaded once and reused for `reuseMs`,
 * shared by concurrent callers. A failed load is not kept, so the next reload
 * retries it.
 */
export function withReusedYieldCurve(
  dependencies: SurfaceLoaderDependencies,
  reuseMs = TREASURY_CURVE_REUSE_MS,
): SurfaceLoaderDependencies {
  let held: { at: number; curve: Promise<YieldPoint[]> } | null = null;
  return {
    ...dependencies,
    loadYieldCurve: () => {
      const now = Date.now();
      if (held && now - held.at < reuseMs) return held.curve;
      const curve = dependencies.loadYieldCurve();
      const entry = { at: now, curve };
      held = entry;
      curve.catch(() => { if (held === entry) held = null; });
      return curve;
    },
  };
}

export interface SurfaceLoadRequest {
  instrument: InstrumentRef;
  spot: number;
  spotAsOf?: string | number | null;
  settings?: Partial<SurfaceSettings>;
  limit?: number;
  /** Listed expiries required by a selection, added to the representative sample. */
  requiredExpiries?: readonly number[];
  /**
   * Load exactly these listed expiries instead of a representative sample.
   * The catalogue is then read from cache and only these slices refresh.
   */
  expiries?: readonly number[];
  signal?: AbortSignal;
  onSnapshot?: (snapshot: SurfaceSnapshot) => void;
  forceRefresh?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  return new DOMException("Surface load was cancelled", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Publishes immutable partial snapshots as each expiry completes. Cancellation
 * stops queued work and emissions, but does not abort a shared OMON request.
 * Increasing limit reuses the same coordinator keys for already-loaded expiries.
 */
export async function loadVolatilitySurface(
  request: SurfaceLoadRequest,
  dependencies: SurfaceLoaderDependencies = createSurfaceDependencies(),
): Promise<SurfaceSnapshot> {
  const now = dependencies.now?.() ?? Date.now();
  const settings = normalizeSurfaceSettings(request.settings);
  const limit = Number.isFinite(request.limit) ? Math.max(1, Math.floor(request.limit!)) : DEFAULT_SURFACE_EXPIRY_LIMIT;
  const symbol = request.instrument.symbol.trim().toUpperCase();
  const entries = new Map<number, QueryEntry<OptionsChain>>();
  const errors = new Map<number, string>();
  const models = new Map<number, { entry: QueryEntry<OptionsChain>; curve: readonly YieldPoint[]; value: SurfaceExpiry }>();
  let catalogue: number[] = [];
  let selected: number[] = [];
  let curve: YieldPoint[] = [];
  let curvePending = true;
  let cataloguePending = true;
  let catalogueError: string | null = null;
  let catalogueReason: string | undefined;
  let requiredFailures: SurfaceFailure[] = [];
  let catalogueExpiration: number | null = null;
  let treasuryError: string | null = null;
  let finished = false;
  const checkAbort = () => { if (request.signal?.aborted) throw abortError(); };
  const snapshot = (): SurfaceSnapshot => {
    const failures: SurfaceFailure[] = [];
    if (catalogueError) failures.push({ expiration: null, message: catalogueError, ...catalogueReason ? { reasonCode: catalogueReason } : {} });
    failures.push(...requiredFailures);
    if (treasuryError) failures.push({ expiration: null, message: treasuryError });
    const projected = selected.map((expiration) => {
      const entry = entries.get(expiration);
      const error = errors.get(expiration) ?? entry?.error?.message ?? null;
      if (error) failures.push({ expiration, message: error });
      const chain = entry ? resolveEntryValue(entry) : null;
      if (!entry || !chain) {
        const empty = pendingSurfaceExpiry(expiration, now);
        if (entry || error) { empty.state = "error"; empty.error = error ?? "Options chain unavailable"; }
        return empty;
      }
      const cached = models.get(expiration);
      if (cached?.entry === entry && cached.curve === curve) return cached.value;
      const value = buildSurfaceExpiry({ chain, expiration, spot: request.spot, curve, settings, now,
        source: entry.source, stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now), error });
      models.set(expiration, { entry, curve, value });
      return value;
    });
    const expiries = withSurfaceTermSlopes(projected);
    const loaded = selected.filter((expiration) => entries.has(expiration) || errors.has(expiration)).length;
    const failed = failures.filter((failure) => failure.expiration != null).length;
    const ready = expiries.some((expiry) => expiry.fit != null);
    const pending = cataloguePending || curvePending || loaded < selected.length;
    const phase = pending && !finished ? (loaded > 0 ? "partial" : "loading")
      : failures.length > 0 ? (ready ? "partial" : "error") : "ready";
    const dates = [...new Set(expiries.flatMap((expiry) => expiry.rateAsOf))];
    return {
      symbol, spot: request.spot, spotAsOf: request.spotAsOf ?? null, phase, settings, catalogue: [...catalogue],
      requested: selected.length, loaded, failed, expiries, failures,
      warnings: [...new Set([...expiries.flatMap((expiry) => expiry.warnings), ...surfaceCalendarWarnings(expiries)])],
      rateAsOf: dates.length === 1 ? dates[0]! : null, fetchedAt: now,
    };
  };
  const publish = () => {
    if (!request.signal?.aborted) request.onSnapshot?.(snapshot());
  };
  checkAbort();
  publish();
  const treasury = Promise.resolve().then(() => dependencies.loadYieldCurve()).then((value) => {
    if (request.signal?.aborted) return;
    curve = value;
  }).catch((error) => { treasuryError = `Treasury: ${errorMessage(error)}`; }).finally(() => {
    curvePending = false;
    publish();
  });

  try {
    const initial = await abortable(dependencies.loadOptions({ instrument: request.instrument },
      { forceRefresh: request.expiries ? false : request.forceRefresh }), request.signal);
    checkAbort();
    const chain = resolveEntryValue(initial);
    const initialContracts = chain ? [...chain.calls, ...chain.puts] : [];
    const representedExpiry = initialContracts[0]?.expiration;
    if (representedExpiry != null && initialContracts.every((contract) => contract.expiration === representedExpiry)
      && chain?.expirationDates.includes(representedExpiry)) catalogueExpiration = representedExpiry;
    catalogueError = initial.error?.message ?? null;
    catalogueReason = initial.error?.reasonCode;
    if (!chain) catalogueError ??= "Options expiry catalogue unavailable";
    catalogue = [...new Set((chain?.expirationDates ?? []).filter((expiration) =>
      Number.isFinite(expiration) && expiration > 0 && daysToExpiryFrom(expiration, now) > 0))].sort((a, b) => a - b);
    const required = [...new Set([...(request.requiredExpiries ?? []), ...(request.expiries ?? [])]
      .filter((expiration) => Number.isFinite(expiration) && expiration > 0))];
    const listed = new Set(catalogue);
    selected = [...new Set([...request.expiries ? [] : selectSurfaceExpiries(catalogue, limit, now),
      ...required.filter((expiration) => listed.has(expiration))])].sort((a, b) => a - b);
    requiredFailures = required.filter((expiration) => !listed.has(expiration)).map((expiration) => ({
      expiration, message: "Selected expiration unavailable in the current option catalogue",
    }));
    if (chain && catalogue.length === 0) catalogueError ??= "No unexpired option expiries available";
  } catch (error) {
    if (request.signal?.aborted) throw abortError();
    catalogueError = errorMessage(error);
    catalogueReason = undefined;
  } finally {
    cataloguePending = false;
    publish();
  }

  let next = 0;
  const worker = async () => {
    while (!request.signal?.aborted && next < selected.length) {
      const expiration = selected[next++]!;
      try {
        // The catalogue response already refreshed its own slice, unless it came from cache.
        const entry = await dependencies.loadOptions({ instrument: request.instrument, expirationDate: expiration },
          { forceRefresh: !!request.forceRefresh && (!!request.expiries || expiration !== catalogueExpiration) });
        if (request.signal?.aborted) return;
        entries.set(expiration, entry);
        if (!resolveEntryValue(entry) && !entry.error) errors.set(expiration, "Options chain unavailable");
      } catch (error) {
        if (request.signal?.aborted) return;
        errors.set(expiration, errorMessage(error));
      }
      publish();
    }
  };
  await abortable(Promise.all([treasury, ...Array.from({ length: Math.min(SURFACE_LOAD_CONCURRENCY, selected.length) }, worker)]), request.signal);
  checkAbort();
  finished = true;
  const result = snapshot();
  request.onSnapshot?.(result);
  return result;
}
