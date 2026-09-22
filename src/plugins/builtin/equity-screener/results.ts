import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  ScreenDefinition,
  ScreenPayload,
} from "../../../api-client/equity-screener";
import { fetchScreen } from "./client";
import { appendScreenPage } from "./model";

/** Query changes and pagination cannot exchange data across immutable snapshots. */
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
  const load = useCallback(async () => {
    controller.current?.abort();
    moreController.current?.abort();
    moreController.current = null;
    const request = new AbortController();
    controller.current = request;
    setState((current) => ({
      identity,
      data: current.identity === identity ? current.data : null,
      error: null,
      loading: true,
      loadingMore: false,
      updatedAt: current.identity === identity ? current.updatedAt : null,
    }));
    try {
      const data = await fetcher(definition, null, request.signal);
      if (request.signal.aborted || activeIdentity.current !== identity) return;
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
      const denied =
        error instanceof ApiRequestError &&
        [401, 403].includes(error.status ?? 0);
      setState((current) => ({
        ...current,
        data: denied ? null : current.data,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : "Screen unavailable.",
      }));
    }
  }, [identity, fetcher]);
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      moreController.current?.abort();
    };
  }, [load]);
  const loadMore = useCallback(async () => {
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
