import { useEffect, useMemo, useRef, useState } from "react";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildOptionsKey } from "../../../market-data/selectors";
import type { OptionsChain } from "../../../types/financials";
import { useThrottledValue } from "../shared/volatility/live-session";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { loadOptionsEnrichment } from "./enrichment-client";
import { projectOptionsEnrichment, type OptionsEnrichmentCache, type OptionsEnrichmentProjection,
  type OptionsEnrichmentSnapshot } from "./enrichment-model";

/** Live quotes refit the selected smile at most this often. */
export const OPTIONS_LIVE_ANALYTICS_INTERVAL_MS = 1_000;
/** A dense chain's refit is slower; its cadence stretches so the refit never takes more than this share of the time. */
const LIVE_ANALYTICS_MAX_LOAD = 0.05;
/** The Treasury curve is daily; a refreshed chain reuses the one it already loaded. */
const TREASURY_REUSE_MS = 30 * 60_000;

interface EnrichmentResult {
  key: string;
  entryKey: string;
  catalogueKey: string;
  loading: boolean;
  /** The previous chain's analytics, kept on screen while a refreshed chain is projected. */
  carried: boolean;
  snapshot: OptionsEnrichmentSnapshot | null;
  projection: OptionsEnrichmentProjection | null;
  error: string | null;
}

/**
 * Chain response changes drive analytics; streaming spot ticks do not refetch
 * chains. Streamed quotes for the selected expiry (`liveChain`) refit its smile
 * at most once a second against the inputs the last load already resolved.
 */
export function useOptionsEnrichment(input: {
  instrument: InstrumentRef | null;
  expiration: number | undefined;
  selectedEntry: QueryEntry<OptionsChain> | null;
  catalogue: readonly number[];
  spot: number | undefined;
  spotAsOf?: string | number | null;
  /** The selected chain with streamed quotes applied, when any streamed. */
  liveChain?: OptionsChain | null;
}) {
  const key = input.instrument && input.expiration != null
    ? buildOptionsKey({ instrument: input.instrument, expirationDate: input.expiration }) : null;
  const eligible = key != null && input.selectedEntry != null && input.spot != null
    && Number.isFinite(input.spot) && input.spot > 0 && input.catalogue.includes(input.expiration!);
  const catalogueKey = [...new Set(input.catalogue)].sort((left, right) => left - right).join(",");
  // Coordinator reads can return a fresh projection object on every render.
  // Track the accepted response and health, never that object's identity.
  const entry = input.selectedEntry;
  // Starting a refresh is not a new observation; wait for response or health to change.
  const entryKey = JSON.stringify([entry?.responseSequence, entry?.fetchedAt,
    entry?.staleAt, entry?.error, entry?.data?.asOf, entry?.lastGoodData?.asOf,
    entry?.data != null, entry?.lastGoodData != null,
    entry?.staleAt != null && entry.staleAt <= Date.now()]);
  const current = useRef(input);
  current.current = input;
  // Per selection: the adjacent model and the Treasury curve outlive a chain refresh.
  const store = useRef<{ key: string | null; cache: OptionsEnrichmentCache; curve: { value: YieldPoint[]; at: number } | null }>(
    { key: null, cache: {}, curve: null });
  if (store.current.key !== key) store.current = { key, cache: {}, curve: null };
  const [result, setResult] = useState<EnrichmentResult | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => {
    if (!eligible || !key) return;
    const controller = new AbortController();
    const request = current.current;
    const identity = { key, entryKey, catalogueKey };
    const selection = store.current;
    const curve = selection.curve && Date.now() - selection.curve.at < TREASURY_REUSE_MS ? selection.curve.value : undefined;
    let projection: OptionsEnrichmentProjection | null = null;
    // A refresh of the same expiry swaps in its analytics complete, never
    // through a partial projection that would blank the strip for a moment.
    const previous = resultRef.current;
    const carried = !!previous?.snapshot && previous.key === key && previous.catalogueKey === catalogueKey;
    setResult(carried
      ? { ...previous!, ...identity, loading: true, carried: true, error: null }
      : { ...identity, loading: true, carried: false, snapshot: null, projection: null, error: null });
    void loadOptionsEnrichment({
      instrument: request.instrument!, expiration: request.expiration!, selectedEntry: request.selectedEntry!,
      catalogue: request.catalogue, spot: request.spot!, spotAsOf: request.spotAsOf, signal: controller.signal,
      cache: selection.cache, ...(curve ? { curve } : {}),
      onProjection: (next) => { projection = next; },
      onSnapshot: (snapshot) => {
        if (!controller.signal.aborted && !carried) {
          setResult({ ...identity, loading: true, carried: false, snapshot, projection, error: null });
        }
      },
    }).then((snapshot) => {
      if (controller.signal.aborted) return;
      if (projection && !projection.curveLoading && !projection.treasuryError && projection.curve?.length && !curve) {
        selection.curve = { value: [...projection.curve], at: Date.now() };
      }
      setResult({ ...identity, loading: false, carried: false, snapshot, projection, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ ...identity, loading: false, carried: false, snapshot: null, projection: null,
        error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [key, eligible, entryKey, catalogueKey]);
  const active = eligible && result?.key === key && result.entryKey === entryKey
    && result.catalogueKey === catalogueKey ? result : null;
  const refitMs = useRef(0);
  const liveChain = useThrottledValue(eligible ? input.liveChain ?? null : null,
    Math.max(OPTIONS_LIVE_ANALYTICS_INTERVAL_MS, refitMs.current / LIVE_ANALYTICS_MAX_LOAD), key);
  const projection = active?.projection ?? null;
  const liveSnapshot = useMemo(() => {
    if (!liveChain || !projection || !key) return null;
    const expiration = liveChain.calls[0]?.expiration ?? liveChain.puts[0]?.expiration;
    if (expiration !== projection.expiration) return null;
    const { spot, spotAsOf } = current.current;
    if (spot == null || !(spot > 0)) return null;
    const started = performance.now();
    const snapshot = projectOptionsEnrichment({ ...projection, selectedEntry: { ...projection.selectedEntry, data: liveChain },
      spot, spotAsOf: spotAsOf ?? null, now: Date.now() }, store.current.cache);
    refitMs.current = performance.now() - started;
    return snapshot;
  }, [key, liveChain, projection]);
  return { snapshot: liveSnapshot ?? active?.snapshot ?? null, error: active?.error ?? null,
    loading: eligible && (!active || (active.loading && !active.carried)) };
}
