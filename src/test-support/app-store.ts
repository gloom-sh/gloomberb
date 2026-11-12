import type { Dispatch } from "react";
import { appReducer, type AppAction, type AppContextStoreValue, type AppState } from "../state/app/context";

const ignoreAction: Dispatch<AppAction> = () => {};
const noUnsubscribe = () => {};

/**
 * An `AppContext` value holding one fixed state, for rendering app hooks
 * without an `AppProvider`. It never notifies: the suite owns its state and
 * renders again with a new store to show a new one.
 */
export function createStaticAppStore(
  state: AppState,
  dispatch: Dispatch<AppAction> = ignoreAction,
): AppContextStoreValue {
  return {
    dispatch,
    getState: () => state,
    subscribe: () => noUnsubscribe,
  };
}

/**
 * An `AppContext` value that runs the app's reducer on every dispatch and
 * notifies its subscribers, for a suite that checks what the app's own
 * actions did to the state (a pane setting written, a layout saved).
 */
export function createReducerAppStore(state: AppState): AppContextStoreValue {
  let current = state;
  const listeners = new Set<() => void>();
  return {
    dispatch: (action) => {
      current = appReducer(current, action);
      for (const listener of listeners) listener();
    },
    getState: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
