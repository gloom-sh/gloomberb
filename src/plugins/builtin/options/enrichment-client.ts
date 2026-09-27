import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain } from "../../../types/financials";
import { createSurfaceDependencies, type SurfaceLoaderDependencies } from "../vol-surface/client";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { optionsEnrichmentNeighbour, optionsEnrichmentSelectionIssue, projectOptionsEnrichment,
  type OptionsEnrichmentCache, type OptionsEnrichmentProjection, type OptionsEnrichmentSelection,
  type OptionsEnrichmentSnapshot } from "./enrichment-model";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

export interface OptionsEnrichmentRequest extends OptionsEnrichmentSelection {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  /** A Treasury curve already loaded for this selection; the daily curve is not refetched. */
  curve?: YieldPoint[];
  /** Models reused between projections of the same selection. */
  cache?: OptionsEnrichmentCache;
  onSnapshot?: (snapshot: OptionsEnrichmentSnapshot) => void;
  /** Every published snapshot's inputs, so a caller can re-project live quotes without reloading. */
  onProjection?: (projection: OptionsEnrichmentProjection) => void;
}

const CANCELLED = "Options enrichment was cancelled";

/** OMON supplies its selected cached slice. Only the adjacent slice can need another chain request. */
export async function loadOptionsEnrichment(
  request: OptionsEnrichmentRequest,
  dependencies: SurfaceLoaderDependencies = createSurfaceDependencies(),
): Promise<OptionsEnrichmentSnapshot> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = dependencies.now?.() ?? Date.now();
  const neighbourExpiration = optionsEnrichmentNeighbour(request.catalogue, request.expiration, now);
  let curve: YieldPoint[] = request.curve ?? [];
  let curveLoading = !request.curve;
  let treasuryError: string | null = null;
  let neighbourEntry: QueryEntry<OptionsChain> | null = null;
  let neighbourLoading = neighbourExpiration != null;
  let neighbourError: string | null = null;
  const snapshot = () => {
    const { signal: _signal, forceRefresh: _force, curve: _curve, cache, onSnapshot: _onSnapshot, onProjection, ...selection } = request;
    const projection: OptionsEnrichmentProjection = { ...selection, now, curve, curveLoading, treasuryError,
      neighbourEntry, neighbourLoading, neighbourError };
    onProjection?.(projection);
    return projectOptionsEnrichment(projection, cache);
  };
  const publish = () => { if (!request.signal?.aborted) request.onSnapshot?.(snapshot()); };
  if (optionsEnrichmentSelectionIssue(request, now)) {
    const result = snapshot();
    request.onSnapshot?.(result);
    return result;
  }
  // The first snapshot already has the quoted straddle even while rates are pending.
  publish();
  const treasury = request.curve ? Promise.resolve() : Promise.resolve().then(() => {
    if (request.signal?.aborted) throw abortError(CANCELLED);
    return dependencies.loadYieldCurve();
  }).then((value) => { curve = value; })
    .catch((error) => { treasuryError = errorMessage(error); }).finally(() => { curveLoading = false; publish(); });
  const adjacent = neighbourExpiration == null ? Promise.resolve() : Promise.resolve()
    .then(() => {
      if (request.signal?.aborted) throw abortError(CANCELLED);
      return dependencies.loadOptions({ instrument: request.instrument, expirationDate: neighbourExpiration },
        { forceRefresh: request.forceRefresh });
    })
    .then((entry) => { neighbourEntry = entry; })
    .catch((error) => { neighbourError = errorMessage(error); }).finally(() => { neighbourLoading = false; publish(); });
  await abortable(Promise.all([treasury, adjacent]), request.signal, CANCELLED);
  if (request.signal?.aborted) throw abortError(CANCELLED);
  return snapshot();
}
