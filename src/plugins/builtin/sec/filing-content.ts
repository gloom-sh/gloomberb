import { useEffect, useMemo, useState } from "react";
import { useResolvedEntryValue, useSecFilingContent } from "../../../market-data/hooks";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { documentContentTarget, isInlineExhibitDocument } from "./filing-documents";

interface ScopedFilingContentCache {
  scopeKey: string;
  values: Map<string, string | null>;
}

const EMPTY_CONTENT_CACHE = new Map<string, string | null>();

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
  }));
  const contentCache = state.scopeKey === scopeKey ? state.values : EMPTY_CONTENT_CACHE;

  useEffect(() => {
    setState((current) => current.scopeKey === scopeKey
      ? current
      : { scopeKey, values: new Map() });
  }, [scopeKey]);

  const nextTarget = useMemo(
    () => nextUncachedFilingContentTarget(targets, contentCache),
    [contentCache, targets],
  );
  const contentEntry = useSecFilingContent(nextTarget);
  const resolvedContent = useResolvedEntryValue(contentEntry);

  useEffect(() => {
    if (!nextTarget) return;
    const phase = contentEntry?.phase;
    const settled = phase === "ready"
      || phase === "error"
      || (phase === "refreshing" && resolvedContent !== null);
    if (!settled) return;
    const key = nextTarget.accessionNumber;
    const content = phase === "error" ? null : resolvedContent;
    setState((current) => {
      if (current.scopeKey !== scopeKey || current.values.has(key)) return current;
      return {
        scopeKey,
        values: new Map(current.values).set(key, content),
      };
    });
  }, [contentEntry?.phase, nextTarget, resolvedContent, scopeKey]);

  const pendingCount = useMemo(() => {
    const pending = new Set<string>();
    for (const target of targets) {
      if (!contentCache.has(target.accessionNumber)) pending.add(target.accessionNumber);
    }
    return pending.size;
  }, [contentCache, targets]);

  return {
    contentCache,
    loadingKey: nextTarget?.accessionNumber ?? null,
    pendingCount,
  };
}
