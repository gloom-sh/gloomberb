import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSecFilingContent } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { documentContentTarget, isInlineExhibitDocument } from "./filing-documents";

interface ScopedFilingContentCache {
  scopeKey: string;
  values: Map<string, string | null>;
  errors: Map<string, string>;
  retryingKey: string | null;
}

const EMPTY_CONTENT_CACHE = new Map<string, string | null>();
const EMPTY_ERRORS = new Map<string, string>();

/** What a finished content entry holds, or null while it is still loading. */
function settledFilingContent(
  entry: QueryEntry<string | null> | null | undefined,
): { content: string | null; error: string | null } | null {
  if (!entry) return null;
  const resolved = resolveEntryValue(entry);
  const settled = entry.phase === "ready"
    || entry.phase === "error"
    || (entry.phase === "refreshing" && resolved !== null);
  if (!settled) return null;
  return {
    content: entry.phase === "error" ? null : resolved,
    error: entry.error?.reasonCode === "NO_DATA" ? null : entry.error?.message ?? null,
  };
}

export function buildInlineFilingContentTargets(
  filing: SecFilingItem | null | undefined,
  documents: readonly SecFilingDocument[],
): SecFilingItem[] {
  if (!filing) return [];
  return documents
    .filter(isInlineExhibitDocument)
    .map((document) => documentContentTarget(filing, document));
}

export function nextUncachedFilingContentTarget(
  targets: readonly SecFilingItem[],
  cache: ReadonlyMap<string, string | null>,
): SecFilingItem | null {
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.accessionNumber;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cache.has(key)) return target;
  }
  return null;
}

export function useSecFilingContentCache({
  scopeKey,
  targets,
}: {
  scopeKey: string;
  targets: readonly SecFilingItem[];
}) {
  const [state, setState] = useState<ScopedFilingContentCache>(() => ({
    scopeKey,
    values: new Map(),
    errors: new Map(),
    retryingKey: null,
  }));
  const contentCache = state.scopeKey === scopeKey ? state.values : EMPTY_CONTENT_CACHE;
  const contentErrors = state.scopeKey === scopeKey ? state.errors : EMPTY_ERRORS;
  const retryGeneration = useRef(0);
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;

  useEffect(() => {
    setState((current) => current.scopeKey === scopeKey
      ? current
      : { scopeKey, values: new Map(), errors: new Map(), retryingKey: null });
    return () => { retryGeneration.current += 1; };
  }, [scopeKey]);

  const nextTarget = useMemo(
    () => nextUncachedFilingContentTarget(targets, contentCache),
    [contentCache, targets],
  );
  const contentEntry = useSecFilingContent(nextTarget);

  useEffect(() => {
    if (!nextTarget) return;
    const first = settledFilingContent(contentEntry);
    if (!first) return;
    const coordinator = getSharedMarketDataCoordinator();
    setState((current) => {
      if (current.scopeKey !== scopeKey) return current;
      let values = current.values;
      let errors = current.errors;
      const record = (key: string, settled: { content: string | null; error: string | null }) => {
        if (values === current.values) values = new Map(values);
        values.set(key, settled.content);
        if (!settled.error) return;
        if (errors === current.errors) errors = new Map(errors);
        errors.set(key, settled.error);
      };
      if (!values.has(nextTarget.accessionNumber)) record(nextTarget.accessionNumber, first);
      // Content the coordinator already holds (a pane reopened, a ticker
      // visited again) is taken in this same update. Taken one target per
      // render, each one would expose the next, and a few dozen filings chain
      // that many renders in a row, past React's limit of 50 nested updates.
      for (const target of targets) {
        if (values.has(target.accessionNumber)) continue;
        const settled = settledFilingContent(coordinator?.getSecContentEntry(target.accessionNumber));
        if (settled) record(target.accessionNumber, settled);
      }
      return values === current.values ? current : { ...current, values, errors };
    });
  }, [contentEntry, nextTarget, scopeKey, targets]);

  // Successful accession content is immutable. Retry only selected documents
  // that failed or had no readable content, preserving the sequential queue.
  const retry = useCallback(async () => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || state.scopeKey !== scopeKey || state.retryingKey) return;
    const generation = ++retryGeneration.current;
    const seen = new Set<string>();
    for (const target of targets) {
      const key = target.accessionNumber;
      if (seen.has(key) || !contentCache.has(key) || (contentCache.get(key) && !contentErrors.has(key))) continue;
      seen.add(key);
      if (activeScope.current !== scopeKey || generation !== retryGeneration.current) return;
      setState((current) => current.scopeKey === scopeKey ? { ...current, retryingKey: key } : current);
      const entry = await coordinator.loadSecFilingContent(target, { forceRefresh: true });
      if (activeScope.current !== scopeKey || generation !== retryGeneration.current) return;
      setState((current) => {
        if (current.scopeKey !== scopeKey) return current;
        const errors = new Map(current.errors);
        if (entry.error && entry.error.reasonCode !== "NO_DATA") errors.set(key, entry.error.message);
        else errors.delete(key);
        return { ...current, values: new Map(current.values).set(key, resolveEntryValue(entry)), errors, retryingKey: null };
      });
    }
  }, [contentCache, contentErrors, scopeKey, state.retryingKey, state.scopeKey, targets]);

  const pendingCount = useMemo(() => {
    const pending = new Set<string>();
    for (const target of targets) {
      if (!contentCache.has(target.accessionNumber)) pending.add(target.accessionNumber);
    }
    return pending.size;
  }, [contentCache, targets]);

  return {
    contentCache,
    contentErrors,
    retry,
    loadingKey: state.scopeKey === scopeKey ? state.retryingKey ?? nextTarget?.accessionNumber ?? null : nextTarget?.accessionNumber ?? null,
    pendingCount: pendingCount + (state.scopeKey === scopeKey && state.retryingKey ? 1 : 0),
  };
}
