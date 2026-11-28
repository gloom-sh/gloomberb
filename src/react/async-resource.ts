import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectionHealth, recoversDataRequests } from "../core/connection-health";
import { useSavedCopyFooter } from "../components/layout/pane/footer/registration";
import { isPermanentClientError, isTransientFailure } from "../api-client/errors";
import { afterSavedCopyFrame, deleteSavedCopy, readSavedCopy, savedCopyId, writeSavedCopy, type SavedCopyKey } from "../data/pane-saved-copies";
import { retrievedAtOf, savedCopyAt } from "../data/saved-copies";
import { reuseSavedData } from "../data/reuse-saved-data";
import { logFailure } from "../utils/log-failure";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  savedAt: number | null;
  placeholder?: boolean;
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
     * A matching saved copy wins. Use a stable, non-secret access identity
     * instead of true when data must not carry over across account or plan
     * changes. A null loader still clears.
     */
    keepPreviousData?: boolean | string | null;
    /**
     * The key what this loader answers is saved under: everything the answer
     * depends on, so a copy is only ever shown for the same question.
     */
    savedCopy?: SavedCopyKey | null;
    /** A pane with multiple resources can label its own section-specific saved data. */
    showSavedCopyFooter?: boolean;
    shouldSave?: (data: T) => boolean;
    /** The request is identified, but its live inputs are not ready yet. */
    deferLoad?: boolean;
    /** Load only on explicit calls, not on mount or connection recovery. */
    manual?: boolean;
  } = {},
) {
  const requestedKey = loader ? options.savedCopy ?? null : null;
  const savedId = requestedKey ? `${savedCopyId(requestedKey)}#${requestedKey.version ?? 1}` : null;
  const savedKey = useMemo(() => requestedKey, [savedId]);
  const deferLoad = options.deferLoad === true;
  const manual = options.manual === true;
  const retainWithin = options.keepPreviousData || null;
  const open = (): ResourceState<T> & { owner: typeof loader; ownerKey: string | null; retainWithin: typeof retainWithin } => {
    const saved = savedKey ? readSavedCopy<T>(savedKey) : null;
    const data = loader ? saved?.value ?? options.initialData?.() ?? null : null;
    const savedAt = saved?.fetchedAt ?? savedCopyAt(data);
    return { owner: loader, ownerKey: savedId, retainWithin, data, savedAt, updatedAt: savedAt ?? retrievedAtOf(data), loading: !!loader && !manual, error: null };
  };
  // `ownerKey`: the saved-copy key of the question the data answers. A new
  // loader for the same key (a session restored, a callback remade) asks the
  // same question, so the data stays while it loads.
  const [state, setState] = useState(open);
  let view = state;
  if (state.owner !== loader || state.ownerKey !== savedId || state.retainWithin !== retainWithin) {
    const sameQuestion = savedId !== null && state.ownerKey === savedId && state.retainWithin === retainWithin;
    view = sameQuestion ? { ...state, owner: loader, loading: true, error: null } : open();
    if (loader && retainWithin !== null && state.retainWithin === retainWithin && state.data !== null && view.data === null) {
      view = { ...state, owner: loader, ownerKey: savedId, loading: true, error: null, placeholder: true };
    }
    setState(view);
  }
  const generation = useRef(0);
  // Read at failure time so an inline predicate cannot recreate load and refetch every render.
  const clearOnErrorRef = useRef(options.clearOnError ?? false);
  clearOnErrorRef.current = options.clearOnError ?? false;
  const shouldSaveRef = useRef(options.shouldSave);
  shouldSaveRef.current = options.shouldSave;
  const currentView = useRef(view);
  currentView.current = view;
  const settle = useCallback(async (force: boolean) => {
    const currentGeneration = ++generation.current;
    if (deferLoad) return;
    if (!loader) {
      return;
    }
    // The key of the question this load answers.
    const key = savedKey;
    const keyId = savedId;
    const isCurrent = () => generation.current === currentGeneration && currentView.current.owner === loader
      && currentView.current.ownerKey === keyId && currentView.current.retainWithin === retainWithin;
    const opening = currentView.current.savedAt !== null && !currentView.current.placeholder;
    setState((current) => current.owner === loader && current.ownerKey === keyId && (!current.loading || current.error !== null)
      ? { ...current, loading: true, error: null } : current);
    try {
      const data = await loader(force);
      if (isCurrent()) {
        const savedAt = savedCopyAt(data);
        // A copy read earlier and served again is as old as that read, not this load.
        const updatedAt = savedAt ?? retrievedAtOf(data) ?? Date.now();
        const current = currentView.current;
        setState({
          owner: loader, ownerKey: keyId, retainWithin, loading: false, error: null, updatedAt, savedAt,
          data: key && opening && savedAt === null && savedCopyAt(current.data) === null
            ? reuseSavedData(current.data, data) : data,
        });
        if (key && savedAt === null && (shouldSaveRef.current?.(data) ?? true)) writeSavedCopy(key, data, updatedAt);
      }
    } catch (error) {
      if (isCurrent()) {
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
            savedAt: discard ? null : current.savedAt ?? (!discardSaved && !current.placeholder && current.data !== null ? current.updatedAt : null),
            loading: false,
            error: message.trim() ? message : "Request failed",
          };
        });
      }
    }
  }, [deferLoad, loader, retainWithin, savedId, savedKey]);
  // A load nobody waits on: its failures end in `error`, and anything else
  // that escapes is logged.
  const load = useCallback((force = false) => {
    settle(force).catch(logFailure("react.async-resource", "Resource load failed"));
  }, [settle]);

  const reload = useCallback(() => load(true), [load]);
  const reloadAndWait = useCallback(() => settle(true), [settle]);
  const { data, error, updatedAt, savedAt } = view;
  const loading = view.loading && !deferLoad;
  useSavedCopyFooter(options.showSavedCopyFooter === false ? null : savedAt, loading || deferLoad);
  useEffect(() => {
    if (deferLoad || !loader) return;
    const invalidate = () => { generation.current += 1; };
    if (manual) return invalidate;
    const restored = savedAt !== null && !view.placeholder;
    const frame = restored ? afterSavedCopyFrame() : undefined;
    const openingGeneration = generation.current;
    if (frame) {
      void frame.then(() => {
        if (generation.current === openingGeneration) load(true);
      }).catch(logFailure("react.async-resource", "Refresh after the saved copy failed"));
    } else load(restored);
    return invalidate;
  }, [deferLoad, load, loader, manual]);

  // A load that failed is asked again once the data service (or the desktop
  // bridge) answers after an outage, so a pane recovers by itself instead of
  // keeping the failure.
  const recoveryRef = useRef<{ refresh: boolean } | null>(null);
  recoveryRef.current = loader && !loading && (error !== null || savedCopyAt(data) !== null) ? { refresh: savedAt !== null } : null;
  useEffect(() => {
    if (manual || !loader) return;
    return connectionHealth.subscribeRecovery((sourceId) => {
      if (recoversDataRequests(sourceId) && recoveryRef.current) load(recoveryRef.current.refresh);
    });
  }, [load, loader, manual]);
  const status: "error" | "loaded" | "loading" | "idle" = error !== null ? "error" : data !== null ? "loaded" : loading ? "loading" : "idle";
  return { data, loading: loading && savedAt === null, refreshing: loading && data !== null, error, updatedAt, savedAt, status, load, reload, reloadAndWait };
}
