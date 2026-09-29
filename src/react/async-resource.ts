import { useCallback, useEffect, useRef, useState } from "react";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
}

/** A stable loader owns a resource; null disables it and discards pending results. */
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
  const load = useCallback(async (force = false) => {
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

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  // Hide a previous resource during the render before the new loader's effect
  // runs, as well as throughout a failed request for the new security.
  const { data, loading, error, updatedAt } = state.owner === loader ? state
    : keepPreviousData && loader ? { ...state, loading: true, error: null }
      : { data: null, loading: !!loader, error: null, updatedAt: null };
  const status = error !== null ? "error" : data !== null ? "loaded" : loading ? "loading" : "idle";
  return { data, loading, error, updatedAt, status, load, reload };
}
