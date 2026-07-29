import { useEffect, useRef } from "react";
import type { AppSessionStorePort } from "../../core/app-service-ports";
import {
  buildAppSessionSnapshot,
  type AppSessionSnapshot,
} from "../../core/state/session-persistence";
import type { AppState } from "../app/context";
import { measurePerf } from "../../utils/perf-marks";
import {
  createPersistScheduler,
  SESSION_SAVE_DEBOUNCE_MS,
} from "../persist-scheduler";

export function usePersistSessionSnapshot(
  sessionStore: AppSessionStorePort | undefined,
  state: AppState,
  sessionId: string,
  schemaVersion: number,
): void {
  const latestRef = useRef({
    sessionStore,
    state,
    sessionId,
    schemaVersion,
  });
  latestRef.current = {
    sessionStore,
    state,
    sessionId,
    schemaVersion,
  };

  const schedulerRef = useRef<ReturnType<typeof createPersistScheduler<AppSessionSnapshot>> | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = createPersistScheduler<AppSessionSnapshot>({
      delayMs: SESSION_SAVE_DEBOUNCE_MS,
      save: (snapshot) => {
        const {
          sessionStore: currentStore,
          sessionId: currentSessionId,
          schemaVersion: currentSchemaVersion,
        } = latestRef.current;
        if (!currentStore) return;
        measurePerf("persist.session.save", () => {
          currentStore.set(currentSessionId, snapshot, currentSchemaVersion);
        }, { sessionId: currentSessionId });
      },
    });
  }

  const buildSnapshot = (): AppSessionSnapshot | null => {
    const {
      state: currentState,
    } = latestRef.current;

    if (!currentState.initialized && currentState.tickers.size === 0) return null;

    try {
      return buildAppSessionSnapshot({
        config: currentState.config,
        paneState: currentState.paneState,
        focusedPaneId: currentState.focusedPaneId,
        activePanel: currentState.activePanel,
        statusBarVisible: currentState.statusBarVisible,
        recentTickers: currentState.recentTickers,
        tickers: currentState.tickers,
        exchangeRates: currentState.exchangeRates,
      }) satisfies AppSessionSnapshot;
    } catch {
      // Snapshot persistence is best-effort during teardown.
      return null;
    }
  };

  useEffect(() => {
    if (!sessionStore) return;
    if (!state.initialized && state.tickers.size === 0) return;
    const snapshot = buildSnapshot();
    if (snapshot) schedulerRef.current?.schedule(snapshot);
  }, [
    sessionStore,
    sessionId,
    schemaVersion,
    state.initialized,
    state.tickers,
    state.config,
    state.paneState,
    state.focusedPaneId,
    state.activePanel,
    state.statusBarVisible,
    state.recentTickers,
  ]);

  useEffect(() => {
    return () => {
      void schedulerRef.current?.flush();
    };
  }, []);
}
