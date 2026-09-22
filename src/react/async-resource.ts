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
  options: { initialData?: () => T | null; clearOnError?: boolean | ((error: unknown) => boolean) } = {},
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
  const load = useCallback(async (force = false) => {
    const currentGeneration = ++generation.current;
    if (!loader) {
      setState({ owner: loader, data: null, loading: false, error: null, updatedAt: null });
      return;
    }
    setState((current) => current.owner === loader
      ? { ...current, loading: true, error: null }
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
  }, [loader]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  // Hide a previous resource during the render before the new loader's effect
  // runs, as well as throughout a failed request for the new security.
  const { data, loading, error, updatedAt } = state.owner === loader ? state
    : { data: null, loading: !!loader, error: null, updatedAt: null };
  const status = error !== null ? "error" : data !== null ? "loaded" : loading ? "loading" : "idle";
  return { data, loading, error, updatedAt, status, load, reload };
}
