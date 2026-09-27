import type { Dispatch } from "react";
import type { AppAction, AppContextStoreValue, AppState } from "../state/app/context";

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
