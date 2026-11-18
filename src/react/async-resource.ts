import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectionHealth, recoversDataRequests } from "../core/connection-health";
import { useSavedCopyFooter } from "../components/layout/pane/footer/registration";
import { isPermanentClientError, isTransientFailure } from "../api-client/errors";
import { deleteSavedCopy, readSavedCopy, savedCopyId, writeSavedCopy, type SavedCopy, type SavedCopyKey } from "../data/pane-saved-copies";
import { savedCopyAt } from "../data/saved-copies";
import { logFailure } from "../utils/log-failure";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  savedAt: number | null;
}

/**
 * A stable loader owns a resource; null disables it and discards pending results.
 *
 * `load(force?)` and `reload()` (`load(true)`) start a load and return
 * nothing: a failure lands in `error`. `reloadAndWait()` is the same reload
 * for a caller that waits on it, such as a Retry button that stays busy until
 * the answer is in. It settles once the answer or the failure is in state, and
 * never rejects.
 *
 * With `savedCopy`, the resource opens on what it last loaded under that key,
 * at once and of any age, and loads behind it: `data` is the saved copy and
 * `updatedAt` when it was loaded until the answer replaces both, and a failed
 * load keeps it as a failed refresh does (data/pane-saved-copies.ts).
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
    /**
     * The key what this loader answers is saved under: everything the answer
     * depends on, so a copy is only ever shown for the same question.
     */
    savedCopy?: SavedCopyKey | null;
  } = {},
) {
  const requestedKey = loader ? options.savedCopy ?? null : null;
  const savedId = requestedKey ? `${savedCopyId(requestedKey)}#${requestedKey.version ?? 1}` : null;
  const savedKey = useMemo(() => requestedKey, [savedId]);
  // Read once per key: the copy a new question opens on, synchronously, so its first frame has it.
  const saved = useMemo<SavedCopy<T> | null>(() => (savedKey ? readSavedCopy<T>(savedKey) : null), [savedId]);
  // `ownerKey`: the saved-copy key of the question the data answers. A new
  // loader for the same key (a session restored, a callback remade) asks the
  // same question, so the data stays while it loads.
  const [state, setState] = useState<ResourceState<T> & { owner: typeof loader; ownerKey: string | null }>(() => {
    const data = saved?.value ?? options.initialData?.() ?? null;
    const savedAt = saved?.fetchedAt ?? savedCopyAt(data);
    return {
      owner: loader,
      ownerKey: savedId,
      data,
      loading: !!loader,
      error: null,
      updatedAt: savedAt,
      savedAt,
    };
  });
  const generation = useRef(0);
  // Read at failure time so an inline predicate cannot recreate load and refetch every render.
  const clearOnErrorRef = useRef(options.clearOnError ?? false);
  clearOnErrorRef.current = options.clearOnError ?? false;
  const keepPreviousData = options.keepPreviousData === true;
  const settle = useCallback(async (force: boolean) => {
    const currentGeneration = ++generation.current;
    if (!loader) {
      setState({ owner: loader, ownerKey: null, data: null, loading: false, error: null, updatedAt: null, savedAt: null });
      return;
    }
    // The key of the question this load answers.
    const key = savedKey;
    const keyId = savedId;
    const opening = saved;
    setState((current) => (current.owner === loader && current.ownerKey === keyId) || (keepPreviousData && !opening) || (keyId !== null && current.ownerKey === keyId)
      ? { ...current, owner: loader, ownerKey: keyId, loading: true, error: null }
      : { owner: loader, ownerKey: keyId, data: opening?.value ?? null, loading: true, error: null, updatedAt: opening?.fetchedAt ?? null, savedAt: opening?.fetchedAt ?? null });
    try {
      const data = await loader(force);
      if (generation.current === currentGeneration) {
        const savedAt = savedCopyAt(data);
        const updatedAt = savedAt ?? Date.now();
        setState({ owner: loader, ownerKey: keyId, data, loading: false, error: null, updatedAt, savedAt });
        if (key && savedAt === null) writeSavedCopy(key, data, updatedAt);
      }
    } catch (error) {
      if (generation.current === currentGeneration) {
        const clearOnError = clearOnErrorRef.current;
        const discardData = (typeof clearOnError === "function" ? clearOnError(error) : clearOnError) || (key !== null && isPermanentClientError(error));
        const discardSaved = !isTransientFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        // What may no longer be shown is not opened on next time either.
        if (key && (discardData || (opening && discardSaved))) deleteSavedCopy(key);
        setState((current) => {
          const discard = discardData || (current.savedAt !== null && discardSaved);
          return {
            ...current,
            data: discard ? null : current.data,
            updatedAt: discard ? null : current.updatedAt,
            savedAt: discard ? null : current.savedAt,
            loading: false,
            error: message.trim() ? message : "Request failed",
          };
        });
      }
    }
  }, [keepPreviousData, loader, savedId, savedKey, saved]);
  // A load nobody waits on: its failures end in `error`, and anything else
  // that escapes is logged.
  const load = useCallback((force = false) => {
    settle(force).catch(logFailure("react.async-resource", "Resource load failed"));
  }, [settle]);

  const reload = useCallback(() => load(true), [load]);
  const reloadAndWait = useCallback(() => settle(true), [settle]);
  // Hide a previous resource during the render before the new loader's effect
  // runs, as well as throughout a failed request for the new security: the
  // new question's saved copy, if it has one, shows instead.
  const { data, loading, error, updatedAt, savedAt } = state.owner === loader && state.ownerKey === savedId ? state
    : ((keepPreviousData && !saved) || (savedId !== null && state.ownerKey === savedId)) && loader ? { ...state, loading: true, error: null }
      : { data: saved?.value ?? null, loading: !!loader, error: null, updatedAt: saved?.fetchedAt ?? null, savedAt: saved?.fetchedAt ?? null };
  useSavedCopyFooter(savedAt, loading);
  useEffect(() => {
    load(savedAt !== null);
    return () => { generation.current += 1; };
  }, [load]);

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
  return { data, loading: loading && savedAt === null, refreshing: loading && data !== null, error, updatedAt, status, load, reload, reloadAndWait };
}
