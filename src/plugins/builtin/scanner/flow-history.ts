import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiClient,
  type ScannerFlowEvent,
  type ScannerFlowHistoryPage,
  type ScannerFlowHistoryQuery,
} from "../../../api-client";
import { isPermanentClientError } from "../../../api-client/errors";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy } from "../../../data/pane-saved-copies";
import { signalWithTimeout } from "../../../utils/async-deadline";
import { flowHistorySearch, mergeFlowRows } from "./flow-model";

export interface FlowHistoryState {
  /** The query the pages belong to; a filter change starts over. */
  key: string;
  events: ScannerFlowEvent[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  savedAt?: number;
}

export type FlowHistoryLoader = (
  query: ScannerFlowHistoryQuery,
  signal: AbortSignal,
) => Promise<ScannerFlowHistoryPage>;

const loadRecordedPrints: FlowHistoryLoader = (query, signal) =>
  apiClient.getScannerFlowHistory(flowHistorySearch(query), signalWithTimeout(signal, 20_000));

function emptyHistory(key: string): FlowHistoryState {
  return { key, events: [], hasMore: true, loading: false, error: null };
}

/** Where the next page starts: below the last page, or below the oldest live print. */
export function nextFlowCursor(
  pages: readonly ScannerFlowEvent[],
  oldestLive: { at: number; id: string } | null,
): { at: number; id: string } | undefined {
  const last = pages.at(-1);
  if (last) return { at: last.at, id: last.id };
  return oldestLive ?? undefined;
}

/**
 * Recorded prints below everything the pane already holds, one page at a
 * time. The first page starts under the oldest live print the pane has kept,
 * so the two never overlap or leave a gap; later pages continue from the last.
 */
export function useFlowHistory(
  query: ScannerFlowHistoryQuery,
  oldestLive: { at: number; id: string } | null,
  enabled: boolean,
  load: FlowHistoryLoader = loadRecordedPrints,
  { identity = "", cacheScope = null }: { identity?: string; cacheScope?: string | null } = {},
) {
  const key = JSON.stringify([identity, query]);
  const savedKey = useMemo(() => cacheScope && enabled && load === loadRecordedPrints ? { key: ["scanner-flow-prints", cacheScope, key] } : null,
    [cacheScope, enabled, key, load]);
  const owner = enabled ? JSON.stringify([cacheScope, key]) : "";
  const open = () => {
    const saved = savedKey ? readSavedCopy<ScannerFlowHistoryPage>(savedKey) : null;
    return saved ? { ...emptyHistory(owner), ...saved.value, savedAt: saved.fetchedAt } : emptyHistory(owner);
  };
  const [state, setState] = useState<FlowHistoryState>(open);
  const current = state.key === owner ? state : open();
  if (current !== state) setState(current);
  const inFlight = useRef<AbortController | null>(null);

  // Pages for the previous filters are dropped along with their request.
  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, [owner]);

  const requestPage = useCallback((current: FlowHistoryState, refresh: boolean) => {
    const before = nextFlowCursor(refresh ? [] : current.events, oldestLive);
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    setState({ ...current, loading: true });
    load({ ...query, ...(before ? { before } : {}) }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        const events = mergeFlowRows(refresh ? [] : current.events, page.events);
        const hasMore = page.hasMore && page.events.length > 0;
        if (savedKey) writeSavedCopy(savedKey, events.length ? { events, hasMore } : null);
        setState({ key: owner, events, hasMore, loading: false, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        const discard = !!savedKey && isPermanentClientError(error);
        if (discard) deleteSavedCopy(savedKey);
        setState({ ...(discard ? emptyHistory(owner) : current), loading: false,
          error: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [load, oldestLive, owner, query, savedKey]);

  useEffect(() => {
    if (enabled && current.savedAt != null && !current.error && !inFlight.current) requestPage(current, true);
  }, [current, enabled, requestPage]);

  useSavedCopyFooter(current.savedAt, current.loading);

  const loadMore = useCallback(() => {
    if (!enabled || inFlight.current || current.loading || !current.hasMore || current.error) return;
    requestPage(current, current.savedAt != null);
  }, [current, enabled, requestPage]);

  const retry = useCallback(() => {
    setState((previous) => previous.key === owner ? { ...previous, error: null } : previous);
  }, [owner]);

  return { ...current, loadMore, retry };
}
