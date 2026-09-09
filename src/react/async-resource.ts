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
  options: { initialData?: () => T | null; clearOnError?: boolean } = {},
) {
  const [state, setState] = useState<ResourceState<T>>(() => ({
    data: options.initialData?.() ?? null,
    loading: !!loader,
    error: null,
    updatedAt: null,
  }));
  const generation = useRef(0);
  const clearOnError = options.clearOnError ?? false;
  const load = useCallback(async (force = false) => {
    const currentGeneration = ++generation.current;
    if (!loader) {
      setState({ data: null, loading: false, error: null, updatedAt: null });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader(force);
      if (generation.current === currentGeneration) {
        setState({ data, loading: false, error: null, updatedAt: Date.now() });
      }
    } catch (error) {
      if (generation.current === currentGeneration) {
        setState((current) => ({
          ...current,
          data: clearOnError ? null : current.data,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }, [clearOnError, loader]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const status = state.error !== null ? "error" : state.data !== null ? "loaded" : state.loading ? "loading" : "idle";
  return { ...state, status, load, reload };
}
