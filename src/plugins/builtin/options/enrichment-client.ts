import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain } from "../../../types/financials";
import { createSurfaceDependencies, type SurfaceLoaderDependencies } from "../vol-surface/client";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { optionsEnrichmentNeighbour, optionsEnrichmentSelectionIssue, projectOptionsEnrichment,
  type OptionsEnrichmentSelection, type OptionsEnrichmentSnapshot } from "./enrichment-model";

export interface OptionsEnrichmentRequest extends OptionsEnrichmentSelection {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  onSnapshot?: (snapshot: OptionsEnrichmentSnapshot) => void;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortError(): Error { return new DOMException("Options enrichment was cancelled", "AbortError"); }

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** OMON supplies its selected cached slice. Only the adjacent slice can need another chain request. */
export async function loadOptionsEnrichment(
  request: OptionsEnrichmentRequest,
  dependencies: SurfaceLoaderDependencies = createSurfaceDependencies(),
): Promise<OptionsEnrichmentSnapshot> {
  if (request.signal?.aborted) throw abortError();
  const now = dependencies.now?.() ?? Date.now();
  const neighbourExpiration = optionsEnrichmentNeighbour(request.catalogue, request.expiration, now);
  let curve: YieldPoint[] = [];
  let curveLoading = true;
  let treasuryError: string | null = null;
  let neighbourEntry: QueryEntry<OptionsChain> | null = null;
  let neighbourLoading = neighbourExpiration != null;
  let neighbourError: string | null = null;
  const snapshot = () => projectOptionsEnrichment({ ...request, now, curve, curveLoading, treasuryError,
    neighbourEntry, neighbourLoading, neighbourError });
  const publish = () => { if (!request.signal?.aborted) request.onSnapshot?.(snapshot()); };
  if (optionsEnrichmentSelectionIssue(request, now)) {
    const result = snapshot();
    request.onSnapshot?.(result);
    return result;
  }
  // The first snapshot already has the quoted straddle even while rates are pending.
  publish();
  const treasury = Promise.resolve().then(() => {
    if (request.signal?.aborted) throw abortError();
    return dependencies.loadYieldCurve();
  }).then((value) => { curve = value; })
    .catch((error) => { treasuryError = message(error); }).finally(() => { curveLoading = false; publish(); });
  const adjacent = neighbourExpiration == null ? Promise.resolve() : Promise.resolve()
    .then(() => {
      if (request.signal?.aborted) throw abortError();
      return dependencies.loadOptions({ instrument: request.instrument, expirationDate: neighbourExpiration },
        { forceRefresh: request.forceRefresh });
    })
    .then((entry) => { neighbourEntry = entry; })
    .catch((error) => { neighbourError = message(error); }).finally(() => { neighbourLoading = false; publish(); });
  await abortable(Promise.all([treasury, adjacent]), request.signal);
  if (request.signal?.aborted) throw abortError();
  return snapshot();
}
