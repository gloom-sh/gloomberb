import { useCallback, useEffect, useRef, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type {
  ScreenDefinition,
  ScreenPayload,
} from "../../../api-client/equity-screener";
import { logFailure } from "../../../utils/log-failure";
import { fetchScreen } from "./client";
import { appendScreenPage } from "./model";

/** A refresh re-reads what a long list holds, up to this many rows, so it does not walk an endless one. */
const REFRESH_ROW_LIMIT = 1_000;

/**
 * Query changes and pagination cannot exchange data across immutable snapshots.
 * A refresh of a screen already loaded replaces its rows in place: the first
 * page of the new snapshot, then as many more as the list held, swapped in
 * together so the table keeps its length and its scroll position. A refresh
 * that finds the same snapshot keeps the pages as they are.
 */
export function useScreenResults(
  definition: ScreenDefinition,
  sessionKey: string,
  fetcher: typeof fetchScreen = fetchScreen,
) {
  const identity = `${sessionKey}:${JSON.stringify(definition)}`;
  const [state, setState] = useState<{
    identity: string;
    data: ScreenPayload | null;
    error: string | null;
    loading: boolean;
    loadingMore: boolean;
    updatedAt: number | null;
  }>({
    identity,
    data: null,
    error: null,
    loading: true,
    loadingMore: false,
    updatedAt: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const controller = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const fetchFirst = useCallback(async () => {
    controller.current?.abort();
    moreController.current?.abort();
    moreController.current = null;
    const request = new AbortController();
    controller.current = request;
    const held = stateRef.current.identity === identity ? stateRef.current.data : null;
    setState((current) => ({
      identity,
      data: current.identity === identity ? current.data : null,
      error: null,
      loading: true,
      loadingMore: false,
      updatedAt: current.identity === identity ? current.updatedAt : null,
    }));
    try {
      let data = await fetcher(definition, null, request.signal);
      if (request.signal.aborted || activeIdentity.current !== identity) return;
      if (held?.snapshot && data.snapshot?.id === held.snapshot.id) {
        data = held;
      } else if (held) {
        const wanted = Math.min(held.rows.length, REFRESH_ROW_LIMIT);
        while (data.nextCursor && data.rows.length < wanted) {
          const page = await fetcher(definition, data.nextCursor, request.signal);
          if (request.signal.aborted || activeIdentity.current !== identity) return;
          data = appendScreenPage(data, page);
        }
      }
      setState({
        identity,
        data,
        error: null,
        loading: false,
        loadingMore: false,
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (request.signal.aborted || activeIdentity.current !== identity) return;
      const denied = isAccessDenied(error);
      setState((current) => ({
        ...current,
        data: denied ? null : current.data,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : "Screen unavailable.",
      }));
    }
  }, [identity, fetcher]);
  // Loads nobody waits on: their failures end in `error`, and anything else
  // that escapes is logged.
  const load = useCallback(() => {
    fetchFirst().catch(logFailure("equity-screener.results", "Screen load failed"));
  }, [fetchFirst]);
  useEffect(() => {
    load();
    return () => {
      controller.current?.abort();
      moreController.current?.abort();
    };
  }, [load]);
  const fetchMore = useCallback(async () => {
    const current = stateRef.current;
    if (
      current.identity !== identity ||
      current.loading ||
      current.loadingMore ||
      !current.data?.nextCursor ||
      moreController.current
    )
      return;
    const request = new AbortController();
    moreController.current = request;
    setState((value) => ({ ...value, loadingMore: true }));
    try {
      const page = await fetcher(
        definition,
        current.data.nextCursor,
        request.signal,
      );
      if (request.signal.aborted || activeIdentity.current !== identity) return;
      const data = appendScreenPage(current.data, page);
      setState((value) => ({
        ...value,
        data,
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      if (request.signal.aborted || activeIdentity.current !== identity) return;
      setState((value) => ({
        ...value,
        loadingMore: false,
        error:
          error instanceof Error ? error.message : "More results unavailable.",
        data: value.data ? { ...value.data, nextCursor: null } : null,
      }));
    } finally {
      if (moreController.current === request) moreController.current = null;
    }
  }, [identity, fetcher]);
  const loadMore = useCallback(() => {
    fetchMore().catch(logFailure("equity-screener.results", "Screen next page failed"));
  }, [fetchMore]);
  return {
    ...(state.identity === identity
      ? state
      : {
          data: null,
          error: null,
          loading: true,
          loadingMore: false,
          updatedAt: null,
        }),
    load,
    loadMore,
  };
}
