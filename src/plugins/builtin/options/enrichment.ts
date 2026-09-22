import { useEffect, useRef, useState } from "react";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildOptionsKey } from "../../../market-data/selectors";
import type { OptionsChain } from "../../../types/financials";
import { loadOptionsEnrichment } from "./enrichment-client";
import type { OptionsEnrichmentSnapshot } from "./enrichment-model";

/** Chain response changes drive analytics; streaming spot ticks do not refetch chains. */
export function useOptionsEnrichment(input: {
  instrument: InstrumentRef | null;
  expiration: number | undefined;
  selectedEntry: QueryEntry<OptionsChain> | null;
  catalogue: readonly number[];
  spot: number | undefined;
  spotAsOf?: string | number | null;
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
  const [result, setResult] = useState<{ key: string; entryKey: string; catalogueKey: string; loading: boolean; snapshot: OptionsEnrichmentSnapshot | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!eligible || !key) return;
    const controller = new AbortController();
    const request = current.current;
    const identity = { key, entryKey, catalogueKey };
    setResult({ ...identity, loading: true, snapshot: null, error: null });
    void loadOptionsEnrichment({
      instrument: request.instrument!, expiration: request.expiration!, selectedEntry: request.selectedEntry!,
      catalogue: request.catalogue, spot: request.spot!, spotAsOf: request.spotAsOf, signal: controller.signal,
      onSnapshot: (snapshot) => {
        if (!controller.signal.aborted) setResult({ ...identity, loading: true, snapshot, error: null });
      },
    }).then((snapshot) => {
      if (!controller.signal.aborted) setResult({ ...identity, loading: false, snapshot, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ ...identity, loading: false, snapshot: null,
        error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [key, eligible, entryKey, catalogueKey]);
  const active = eligible && result?.key === key && result.entryKey === entryKey
    && result.catalogueKey === catalogueKey ? result : null;
  return { snapshot: active?.snapshot ?? null, error: active?.error ?? null,
    loading: eligible && (!active || active.loading) };
}
