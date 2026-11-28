import { logFailure } from "../../../utils/log-failure";
import { apiClient } from "../../../api-client";
import type { FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createPluginCache } from "../../../data/plugin-cache";
import { unansweredRefreshError, withSavedCopyMarkOf } from "../../../data/saved-copies";
import { isFuturesContractSpec } from "../../../market-data/futures-contract";
import { isCalendarDay, isIsoInstant, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isNullableIsoInstant, isPositiveNumber, isStringArray } from "../../../utils/guards";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import type { AssetDataProvider, DataProvider } from "../../../types/data-provider";
import type { TimeRange } from "../../../time-series/range";
import { archivedFuturesCurve, curveLookbackDate, curveSpot, normalizeCurveRoot, spotBarsFromHistory, unsupportedCurveRootMessage, withSettleChanges, withTradedExpirations, type CurveSpot, type SpotBar } from "./model";

export const futuresCurveCache = createPluginCache<FuturesCurvePayload>({
  kind: "futures-curve", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
});
const rank = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const optionalDate = (value: unknown) => value === undefined || isNullableCalendarDay(value);
/** Contract terms the pane computes with; a curve from before the server sent them has none. */
const validSpec = (spec: unknown) => spec === undefined || spec === null || isFuturesContractSpec(spec);
/** A contract's spot in its print's minute; absent from other roots and older servers. */
function validContractSpot(spot: unknown): boolean {
  if (spot === undefined || spot === null) return true;
  if (typeof spot !== "object") return false;
  const { symbol, price, minute } = spot as Record<string, unknown>;
  return typeof symbol === "string" && isPositiveNumber(price) && isIsoInstant(minute);
}

function validateFuturesCurve(data: FuturesCurvePayload, root: string): FuturesCurvePayload {
  if (!data || data.root !== root || !Array.isArray(data.contracts) || !Array.isArray(data.ghosts)
    || !isStringArray(data.gaps) || !data.catalogue || !data.slope || !isIsoInstant(data.fetchedAt)
    || !isNullableIsoInstant(data.asOf)
    || !["gloom", "cboe"].includes(data.source) || !["available", "partial", "unavailable"].includes(data.status)
    || !optionalDate(data.settlementDate) || !validSpec(data.spec)) {
    throw new Error("The server returned an invalid futures curve");
  }
  const symbols = new Set<string>();
  for (const row of data.contracts) {
    if (!row || typeof row.symbol !== "string" || !row.symbol || symbols.has(row.symbol)
      || typeof row.quoteUnit !== "string" || !row.quoteUnit
      || !isCalendarDay(row.expiration) || !isNullableFinite(row.price) || row.change !== undefined && !isNullableFinite(row.change)
      || typeof row.currency !== "string"
      || !rank(row.percentile) || !isNonNegativeInt(row.samples) || !isNullableIsoInstant(row.asOf)
      || ![row.volume, row.openInterest, row.delayMinutes].every((value) => isNullableFinite(value) && (value === null || value >= 0))
      || row.settlement !== undefined && !isNullableFinite(row.settlement) || !optionalDate(row.lastTrade) || !optionalDate(row.firstNotice) || !optionalDate(row.openInterestAsOf)
      || row.inDelivery !== undefined && typeof row.inDelivery !== "boolean" || !validContractSpot(row.spot)) {
      throw new Error("The server returned an invalid futures contract");
    }
    symbols.add(row.symbol);
  }
  for (const ghost of data.ghosts) {
    if (!["1W", "1M", "1Y"].includes(ghost.label) || !isCalendarDay(ghost.requestedDate)
      || !isNullableCalendarDay(ghost.asOf) || !Array.isArray(ghost.points)
      || ghost.points.some((point) => !point || !symbols.has(point.symbol) || !isCalendarDay(point.expiration)
        || !isNullableFinite(point.price) || !isNullableCalendarDay(point.asOf))) {
      throw new Error("The server returned invalid futures history");
    }
  }
  const slope = data.slope;
  if (![slope.value, slope.annualizedRollYield].every(isNullableFinite)
    || ![slope.percentile, slope.rollPercentile].every(rank) || !isNonNegativeInt(slope.samples)
    || !isNullableIsoInstant(slope.asOf)
    || slope.basis != null && slope.basis !== "last" && slope.basis !== "settle"
    || slope.thinSymbol != null && typeof slope.thinSymbol !== "string"
    || slope.skippedSymbols != null && !isStringArray(slope.skippedSymbols)) {
    throw new Error("The server returned an invalid futures spread");
  }
  return data;
}

/** A live curve as every reader takes it: expiring on last trading days, its changes against the settlement shown. */
const liveCurve = (data: FuturesCurvePayload) => withSettleChanges(withTradedExpirations(data));

async function fetchFuturesCurve(root: string, client: Pick<typeof apiClient, "getCloudFuturesCurve"> = apiClient): Promise<FuturesCurvePayload> {
  const normalized = normalizeCurveRoot(root);
  if (!normalized) throw new Error(unsupportedCurveRootMessage(root));
  try { return liveCurve(validateFuturesCurve(await client.getCloudFuturesCurve(normalized), normalized)); }
  catch (error) { throw unavailableOnServer(error, "Futures curves are not available yet."); }
}

export function getCachedFuturesCurve(root: string): FuturesCurvePayload | null {
  const cached = futuresCurveCache.get(root, { allowExpired: true });
  // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
  return cached?.data ? liveCurve(cached.data) : null;
}

export async function loadFuturesCurve(root: string, force = false,
  client: Pick<typeof apiClient, "getCloudFuturesCurve"> = apiClient): Promise<FuturesCurvePayload> {
  const normalized = normalizeCurveRoot(root);
  if (!normalized) throw new Error(unsupportedCurveRootMessage(root));
  const result = await loadCloudResource(futuresCurveCache, normalized, () => fetchFuturesCurve(normalized, client), { force });
  const { payload, stale } = result;
  const error = unansweredRefreshError(result);
  return withSavedCopyMarkOf({ ...liveCurve(payload), stale: stale || payload.stale,
    gaps: [...payload.gaps, ...error ? [error] : []] }, result);
}

/** The archived curve on a past date with the curves a week and a month before it. */
export async function loadFuturesCurveAsOf(root: string, date: string,
  client: Pick<typeof apiClient, "getCloudFuturesCurveAsOf"> = apiClient): Promise<FuturesCurvePayload> {
  const normalized = normalizeCurveRoot(root);
  if (!normalized) throw new Error(unsupportedCurveRootMessage(root));
  try {
    const [curve, week, month] = await Promise.all([
      client.getCloudFuturesCurveAsOf(normalized, date),
      client.getCloudFuturesCurveAsOf(normalized, curveLookbackDate(date, 7)).catch(logFailure("futures-curve.client", "Load week comparison curve failed", null)),
      client.getCloudFuturesCurveAsOf(normalized, curveLookbackDate(date, 30)).catch(logFailure("futures-curve.client", "Load month comparison curve failed", null)),
    ]);
    if (!curve || curve.root !== normalized || !Array.isArray(curve.contracts) || !Array.isArray(curve.gaps)
      || curve.notes !== undefined && (!Array.isArray(curve.notes) || curve.notes.some((note) => typeof note !== "string"))
      || curve.contracts.some((row) => !row || typeof row.symbol !== "string" || !Number.isFinite(row.price)
        || row.settled !== undefined && typeof row.settled !== "boolean" || !optionalDate(row.firstNotice) || !optionalDate(row.lastTrade))
      || !validSpec(curve.spec)) {
      throw new Error("The server returned an invalid past futures curve");
    }
    return archivedFuturesCurve(normalized, curve, { "1W": week, "1M": month }, new Date().toISOString());
  } catch (error) { throw unavailableOnServer(error, "Past futures curves are not available yet."); }
}

/**
 * The spot behind a crypto curve's basis, read through the same quote path every pane uses.
 * A failed read is a missing spot, never a failed report: the curve stands without its basis.
 */
export async function loadCurveSpot(symbol: string, provider: Pick<DataProvider, "getQuote">, now = Date.now()): Promise<CurveSpot> {
  return curveSpot(symbol, await provider.getQuote(symbol, "").catch(logFailure("futures-curve.client", "Load curve spot quote failed", null)), now);
}

/**
 * A month of the spot index's daily closes, read through the same history path
 * the charts use, which the front premium takes its settlement session's close
 * from. A failed read has none: the curve stands, its premium saying why.
 */
export async function loadCurveSpotCloses(symbol: string,
  provider: Pick<AssetDataProvider, "getPriceHistoryForResolutionWithMetadata" | "getPriceHistoryForResolution">, force = false): Promise<{ date: Date; close: number }[]> {
  const context = force ? { cacheMode: "refresh" as const } : undefined;
  try {
    if (provider.getPriceHistoryForResolutionWithMetadata) {
      const history = await provider.getPriceHistoryForResolutionWithMetadata(symbol, "", "1M", "1d", context);
      return history.resolution && history.resolution !== "1d" ? [] : history.points;
    }
    return provider.getPriceHistoryForResolution ? await provider.getPriceHistoryForResolution(symbol, "", "1M", "1d", context) : [];
  } catch (error) {
    return logFailure("futures-curve.client", "Load curve spot closes failed", [] as { date: Date; close: number }[])(error);
  }
}

/** The last day of one-minute bars: the reach of a curve's trades a basis is read for, the far months' older ones aside. */
const SPOT_BAR_RANGE: TimeRange = "1D";

/**
 * The spot pair's one-minute bars over the last day, read through the same
 * history path the charts use, which the basis pairs each trade with by
 * minute. Bars of any other size pair nothing, and a failed read has none:
 * the curve stands without its basis, each blank saying why.
 */
export async function loadCurveSpotBars(symbol: string,
  provider: Pick<AssetDataProvider, "getPriceHistoryForResolutionWithMetadata" | "getPriceHistoryForResolution">, force = false): Promise<SpotBar[]> {
  const context = force ? { cacheMode: "refresh" as const } : undefined;
  try {
    if (provider.getPriceHistoryForResolutionWithMetadata) {
      const history = await provider.getPriceHistoryForResolutionWithMetadata(symbol, "", SPOT_BAR_RANGE, "1m", context);
      return history.resolution && history.resolution !== "1m" ? [] : spotBarsFromHistory(history.points);
    }
    return provider.getPriceHistoryForResolution
      ? spotBarsFromHistory(await provider.getPriceHistoryForResolution(symbol, "", SPOT_BAR_RANGE, "1m", context)) : [];
  } catch (error) {
    return logFailure("futures-curve.client", "Load curve spot bars failed", [] as SpotBar[])(error);
  }
}
