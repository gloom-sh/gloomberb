import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  type ScannerFlowEvent,
  type ScannerFlowHistoryPage,
  type ScannerFlowHistoryQuery,
} from "../../../api-client";
import { mergeFlowRows } from "./flow-model";

export interface FlowHistoryState {
  /** The query the pages belong to; a filter change starts over. */
  key: string;
  events: ScannerFlowEvent[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export type FlowHistoryLoader = (
  query: ScannerFlowHistoryQuery,
  signal: AbortSignal,
) => Promise<ScannerFlowHistoryPage>;

const loadRecordedPrints: FlowHistoryLoader = (query, signal) =>
  apiClient.getScannerFlowHistory(query, signal);

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
) {
  const key = JSON.stringify(query);
  const [state, setState] = useState<FlowHistoryState>(() => emptyHistory(key));
  const current = state.key === key ? state : emptyHistory(key);
  const inFlight = useRef<AbortController | null>(null);

  // Pages for the previous filters are dropped along with their request.
  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, [key]);

  const loadMore = useCallback(() => {
    if (!enabled || current.loading || !current.hasMore || current.error) return;
    const before = nextFlowCursor(current.events, oldestLive);
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    setState({ ...current, loading: true });
    load({ ...query, ...(before ? { before } : {}) }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setState((previous) => previous.key !== key ? previous : {
          key,
          events: mergeFlowRows(previous.events, page.events),
          hasMore: page.hasMore && page.events.length > 0,
          loading: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => previous.key !== key ? previous : {
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [current, enabled, key, load, oldestLive, query]);

  const retry = useCallback(() => {
    setState((previous) => previous.key === key ? { ...previous, error: null } : previous);
  }, [key]);

  return { ...current, loadMore, retry };
}
