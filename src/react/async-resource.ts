import { useCallback, useEffect, useRef, useState } from "react";
import { connectionHealth, recoversDataRequests } from "../core/connection-health";
import { logFailure } from "../utils/log-failure";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

/**
 * A stable loader owns a resource; null disables it and discards pending results.
 *
 * `load(force?)` and `reload()` (`load(true)`) start a load and return
 * nothing: a failure lands in `error`. `reloadAndWait()` is the same reload
 * for a caller that waits on it, such as a Retry button that stays busy until
 * the answer is in. It settles once the answer or the failure is in state, and
 * never rejects.
 */
export function useAsyncResource<T>(
  loader: ((force: boolean) => Promise<T>) | null,
  options: {
    initialData?: () => T | null;
    clearOnError?: boolean | ((error: unknown) => boolean);
    /**
     * Leave the previous loader's data on screen, loading, until the new
     * loader answers, and through its failure as a failed refresh does.
     * Without it a new loader starts from no data. Null still clears.
     */
    keepPreviousData?: boolean;
  } = {},
) {
  const [state, setState] = useState<ResourceState<T> & { owner: typeof loader }>(() => ({
    owner: loader,
    data: options.initialData?.() ?? null,
    loading: !!loader,
    error: null,
    updatedAt: null,
  }));
  const generation = useRef(0);
  // Read at failure time so an inline predicate cannot recreate load and refetch every render.
  const clearOnErrorRef = useRef(options.clearOnError ?? false);
  clearOnErrorRef.current = options.clearOnError ?? false;
  const keepPreviousData = options.keepPreviousData === true;
  const settle = useCallback(async (force: boolean) => {
    const currentGeneration = ++generation.current;
    if (!loader) {
      setState({ owner: loader, data: null, loading: false, error: null, updatedAt: null });
      return;
    }
    setState((current) => current.owner === loader || keepPreviousData
      ? { ...current, owner: loader, loading: true, error: null }
      : { owner: loader, data: null, loading: true, error: null, updatedAt: null });
    try {
      const data = await loader(force);
      if (generation.current === currentGeneration) {
        setState({ owner: loader, data, loading: false, error: null, updatedAt: Date.now() });
      }
    } catch (error) {
      if (generation.current === currentGeneration) {
        const clearOnError = clearOnErrorRef.current;
        const discardData = typeof clearOnError === "function" ? clearOnError(error) : clearOnError;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({
          ...current,
          data: discardData ? null : current.data,
          updatedAt: discardData ? null : current.updatedAt,
          loading: false,
          error: message.trim() ? message : "Request failed",
        }));
      }
    }
  }, [keepPreviousData, loader]);
  // A load nobody waits on: its failures end in `error`, and anything else
  // that escapes is logged.
  const load = useCallback((force = false) => {
    settle(force).catch(logFailure("react.async-resource", "Resource load failed"));
  }, [settle]);

  useEffect(() => {
    load();
    return () => { generation.current += 1; };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const reloadAndWait = useCallback(() => settle(true), [settle]);
  // Hide a previous resource during the render before the new loader's effect
  // runs, as well as throughout a failed request for the new security.
  const { data, loading, error, updatedAt } = state.owner === loader ? state
    : keepPreviousData && loader ? { ...state, loading: true, error: null }
      : { data: null, loading: !!loader, error: null, updatedAt: null };

  // A load that failed is asked again once the data service (or the desktop
  // bridge) answers after an outage, so a pane recovers by itself instead of
  // keeping the failure.
  const failedRef = useRef(false);
  failedRef.current = !!loader && error !== null && !loading;
  useEffect(() => {
    if (!loader) return;
    return connectionHealth.subscribeRecovery((sourceId) => {
      if (recoversDataRequests(sourceId) && failedRef.current) load();
    });
  }, [load, loader]);
  const status = error !== null ? "error" : data !== null ? "loaded" : loading ? "loading" : "idle";
  return { data, loading, error, updatedAt, status, load, reload, reloadAndWait };
}
