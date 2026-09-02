/**
 * App-state hooks a plugin pane legitimately needs.
 *
 * These exist so plugins do not import `state/app/context` directly. That module
 * is the app's internal store: exposing it would let a plugin read and dispatch
 * anything, and would make every refactor of app state a breaking change for
 * plugins. Each hook here is a narrow, named read.
 */
import { useEffect } from "react";

import {
  useAppDispatch,
  useAppSelector,
  usePaneCollection as usePaneCollectionInternal,
  usePaneInstanceId as usePaneInstanceIdInternal,
  usePaneTicker as usePaneTickerInternal,
} from "../state/app/context";
import type { AppConfig } from "../types/config";
import type { AppState } from "../state/app/context";

export function useAppConfig(): AppConfig {
  return useAppSelector((state) => state.config);
}

export function useBrokerAccounts(): AppState["brokerAccounts"] {
  return useAppSelector((state) => state.brokerAccounts);
}

export function useTickers(): AppState["tickers"] {
  return useAppSelector((state) => state.tickers);
}

/**
 * Escape hatches for panes that need state this module has not named yet.
 * Prefer a named hook above: these expose the app store directly, so anything
 * built on them is coupled to its shape.
 */
export { AppContext, PaneInstanceProvider, useAppDispatch, useAppSelector } from "../state/app/context";

export const usePaneInstanceId = usePaneInstanceIdInternal;
export const usePaneCollection = usePaneCollectionInternal;
export const usePaneTicker = usePaneTickerInternal;

/**
 * Declares that this pane owns keyboard input while `captured` is true, so the
 * app stops routing keys to global shortcuts. Released automatically on unmount.
 */
export function useInputCapture(captured: boolean): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (!captured) return;
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    return () => {
      dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
    };
  }, [captured, dispatch]);
}
