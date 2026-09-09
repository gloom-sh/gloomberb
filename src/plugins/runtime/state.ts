import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import {
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
  useOptionalPaneInstanceId,
} from "../../state/app/context";
import { usePluginRenderContext } from "./context";

const DEFAULT_PLUGIN_PANE_STATE_COMMIT_DELAY_MS = 300;

import { getPluginPaneStateValue } from "../pane-state";
export { deletePluginPaneStateValue, getPluginPaneStateValue, setPluginPaneStateValue } from "../pane-state";

export function usePluginPaneState<T>(key: string, fallback: T, paneId?: string): [T, (value: SetStateAction<T>) => void] {
  const { pluginId } = usePluginRenderContext();
  const contextPaneId = useOptionalPaneInstanceId();
  const scopedPaneId = paneId ?? contextPaneId;
  if (!scopedPaneId) throw new Error("usePluginPaneState requires a pane id or PaneInstanceProvider");
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const value = useAppSelector((state) => (
    getPluginPaneStateValue(state.paneState[scopedPaneId], pluginId, key, fallback)
  ));

  const setValue = useCallback((nextValue: SetStateAction<T>) => {
    const currentPaneState = stateRef.current.paneState[scopedPaneId];
    const currentValue = getPluginPaneStateValue(
      currentPaneState,
      pluginId,
      key,
      fallbackRef.current,
    );
    const resolved = typeof nextValue === "function"
      ? (nextValue as (previousValue: T) => T)(currentValue)
      : nextValue;

    if (Object.is(resolved, currentValue)) {
      return;
    }

    dispatch({
      type: "UPDATE_PLUGIN_PANE_STATE",
      paneId: scopedPaneId,
      pluginId,
      key,
      value: resolved,
    });
  }, [dispatch, key, pluginId, scopedPaneId, stateRef]);

  return [value, setValue];
}

export function useDebouncedPluginPaneState<T>(
  key: string,
  fallback: T,
  delayMs = DEFAULT_PLUGIN_PANE_STATE_COMMIT_DELAY_MS,
  paneId?: string,
): [
  T,
  (value: SetStateAction<T>, options?: { immediate?: boolean }) => void,
  () => void,
] {
  const [committedValue, setCommittedValue] = usePluginPaneState<T>(key, fallback, paneId);
  const [localValue, setLocalValueState] = useState(committedValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPendingCommitRef = useRef(false);
  const pendingValueRef = useRef(committedValue);
  const appliedValueRef = useRef(committedValue);
  const localValueRef = useRef(committedValue);

  const clearPendingCommit = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    hasPendingCommitRef.current = false;
  }, []);

  const commitValue = useCallback((nextValue?: T) => {
    const targetValue = nextValue ?? pendingValueRef.current;
    clearPendingCommit();
    pendingValueRef.current = targetValue;

    if (Object.is(appliedValueRef.current, targetValue)) {
      return;
    }

    appliedValueRef.current = targetValue;
    setCommittedValue(targetValue);
  }, [clearPendingCommit, setCommittedValue]);

  const setLocalValue = useCallback((
    nextValue: SetStateAction<T>,
    options?: { immediate?: boolean },
  ) => {
    const currentValue = localValueRef.current;
    const resolved = typeof nextValue === "function"
      ? (nextValue as (previousValue: T) => T)(currentValue)
      : nextValue;

    if (Object.is(resolved, currentValue)) {
      if (options?.immediate) {
        commitValue(resolved);
      }
      return;
    }

    localValueRef.current = resolved;
    pendingValueRef.current = resolved;
    setLocalValueState((current) => (Object.is(current, resolved) ? current : resolved));

    if (options?.immediate) {
      commitValue(resolved);
      return;
    }

    clearPendingCommit();
    if (Object.is(appliedValueRef.current, resolved)) {
      return;
    }

    hasPendingCommitRef.current = true;
    timerRef.current = setTimeout(() => {
      commitValue();
    }, delayMs);
  }, [clearPendingCommit, commitValue, delayMs]);

  useEffect(() => {
    if (hasPendingCommitRef.current && Object.is(committedValue, pendingValueRef.current)) {
      clearPendingCommit();
    }

    if (!hasPendingCommitRef.current) {
      appliedValueRef.current = committedValue;
      pendingValueRef.current = committedValue;
      localValueRef.current = committedValue;
      setLocalValueState((current) => (Object.is(current, committedValue) ? current : committedValue));
    }
  }, [clearPendingCommit, committedValue]);

  useEffect(() => () => {
    const pending = hasPendingCommitRef.current;
    const pendingValue = pendingValueRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pending && !Object.is(appliedValueRef.current, pendingValue)) {
      setCommittedValue(pendingValue);
    }
  }, [setCommittedValue]);

  return [localValue, setLocalValue, commitValue];
}

export function usePluginState<T>(key: string, fallback: T, options?: { schemaVersion?: number }): [T, (value: SetStateAction<T>) => void] {
  const { pluginId, runtime } = usePluginRenderContext();
  const schemaVersion = options?.schemaVersion;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const subscribe = useCallback((listener: () => void) => (
    runtime.subscribeResumeState(pluginId, key, listener)
  ), [key, pluginId, runtime]);

  const getSnapshot = useCallback(() => (
    runtime.getResumeState<T>(pluginId, key, schemaVersion) ?? fallback
  ), [fallback, key, pluginId, runtime, schemaVersion]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback((nextValue: SetStateAction<T>) => {
    const currentValue =
      runtime.getResumeState<T>(pluginId, key, schemaVersion) ??
      fallbackRef.current;
    const resolved = typeof nextValue === "function"
      ? (nextValue as (previousValue: T) => T)(currentValue)
      : nextValue;
    if (Object.is(resolved, currentValue)) {
      return;
    }
    runtime.setResumeState(pluginId, key, resolved, schemaVersion);
  }, [key, pluginId, runtime, schemaVersion]);

  return [value, setValue];
}

export function usePluginConfigState<T>(key: string, fallback: T): [T, (value: SetStateAction<T>) => void] {
  const { pluginId, runtime } = usePluginRenderContext();
  const stateRef = useAppStateRef();
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const value = useAppSelector((state) => (
    (state.config.pluginConfig[pluginId]?.[key] as T | undefined) ?? fallback
  ));

  const setValue = useCallback((nextValue: SetStateAction<T>) => {
    const currentValue =
      (stateRef.current.config.pluginConfig[pluginId]?.[key] as T | undefined) ??
      fallbackRef.current;
    const resolved = typeof nextValue === "function"
      ? (nextValue as (previousValue: T) => T)(currentValue)
      : nextValue;
    if (Object.is(resolved, currentValue)) {
      return;
    }
    void runtime.setConfigState(pluginId, key, resolved);
  }, [key, pluginId, runtime, stateRef]);

  return [value, setValue];
}

export function useSetPluginConfigStates(): (values: Record<string, unknown>) => void {
  const { pluginId, runtime } = usePluginRenderContext();

  return useCallback((values: Record<string, unknown>) => {
    if (Object.keys(values).length === 0) {
      return;
    }
    void runtime.setConfigStates(pluginId, values);
  }, [pluginId, runtime]);
}
