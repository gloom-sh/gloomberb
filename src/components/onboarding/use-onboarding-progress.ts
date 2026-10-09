import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import { recordResearchActivity } from "../../api-client/research-activity";
import { apiClient } from "../../api-client";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { AppConfig, OnboardingProgress } from "../../types/config";
import type { useAppDispatch, useAppStateRef } from "../../state/app/context";
import { t } from "../../i18n";
import type { PluginRegistry } from "../../plugins/registry";
import { resolvePlanAccess } from "../../api-client/plan-access";
import type { PortfolioSub } from "./onboarding-steps";
import type { useOnboardingPositions } from "./wizard-positions";
import { applyFirstRunLayout, buildFirstRunLayout, planFirstRunWatchlist } from "./first-run-workspace";
import { buildDesk, getDesk, isDeskKey, isDeskStock, pickDeskCompany, type DeskKey } from "../../layout/desks";
import { debugLog } from "../../utils/debug-log";
import {
  getOnboardingProgress,
  pickLargestBrokerPosition,
  pickLargestPosition,
  withOnboardingProgress,
  type BrokerOption,
} from "./wizard-model";

const onboardingLog = debugLog.createLogger("onboarding");

export function useOnboardingProgress({
  stateRef, dispatch,
}: {
  stateRef: ReturnType<typeof useAppStateRef>;
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finishingRef = useRef(false);

  const persistProgress = useCallback(async (
    patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
    baseConfig?: AppConfig,
  ): Promise<AppConfig> => {
    if (finishingRef.current) return stateRef.current.config;
    setPersistenceError(null);
    const operation = progressSaveQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (finishingRef.current) return stateRef.current.config;
        const nextConfig = withOnboardingProgress(baseConfig ?? stateRef.current.config, patch);
        try {
          await saveConfigImmediately(nextConfig);
          dispatch({
            type: "SET_ONBOARDING_STATE",
            complete: false,
            progress: nextConfig.onboardingProgress,
          });
          return nextConfig;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setPersistenceError(message || t("Unable to save onboarding progress."));
          throw error;
        }
      });
    progressSaveQueueRef.current = operation.then(() => {}, () => {});
    return operation;
  }, [dispatch, stateRef]);

  const saveProgressInBackground = useCallback((
    patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
    baseConfig?: AppConfig,
  ) => {
    void persistProgress(patch, baseConfig).catch(() => {});
  }, [persistProgress]);

  return {
    persistenceError, setPersistenceError, isFinishing, setIsFinishing, progressSaveQueueRef, finishingRef,
    persistProgress, saveProgressInBackground,
  };
}

export function useOnboardingWorkspace({
  stateRef, pluginRegistry, dispatch, positions, setEditingField, saveProgressInBackground,
  setPersistenceError, finishingRef, brokerOptions, selectedBrokerId, setPortfolioSub,
}: {
  stateRef: ReturnType<typeof useAppStateRef>;
  pluginRegistry: PluginRegistry;
  dispatch: ReturnType<typeof useAppDispatch>;
  positions: ReturnType<typeof useOnboardingPositions>;
  setEditingField: Dispatch<SetStateAction<boolean>>;
  saveProgressInBackground: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig | undefined) => void;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
  finishingRef: RefObject<boolean>;
  brokerOptions: BrokerOption[];
  selectedBrokerId: string | null;
  setPortfolioSub: Dispatch<SetStateAction<PortfolioSub>>;
}) {
  const [chosenDesks, setChosenDesks] = useState<DeskKey[]>([]);
  const [deskCursor, setDeskCursor] = useState(0);
  const [buildingDesks, setBuildingDesks] = useState(false);
  const buildingDesksRef = useRef(false);

  /**
   * Seeds the watchlist and swaps Home for the first-run workspace built
   * around `symbol`, with the picked desks as tabs right after it. The config
   * comes back for the caller to persist with its own progress patch.
   */
  const buildFirstRunWorkspace = useCallback(async (
    baseConfig: AppConfig,
    symbol: string,
    portfolioId: string,
    desks: readonly DeskKey[],
  ): Promise<AppConfig> => {
    let config = baseConfig;
    let watchlistId = config.watchlists[0]?.id;
    if (!watchlistId) {
      watchlistId = "watchlist";
      config = { ...config, watchlists: [{ id: watchlistId, name: "Watchlist" }] };
    }
    const plan = planFirstRunWatchlist(stateRef.current.tickers, watchlistId, portfolioId);
    for (const metadata of plan.create) {
      try {
        const ticker = await pluginRegistry.tickerRepository.createTicker(metadata);
        dispatch({ type: "UPDATE_TICKER", ticker });
        pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
      } catch (error) {
        onboardingLog.error("First-run watchlist seed failed", { symbol: metadata.ticker, error: String(error) });
      }
    }
    for (const ticker of plan.update) {
      try {
        await pluginRegistry.tickerRepository.saveTicker(ticker);
        dispatch({ type: "UPDATE_TICKER", ticker });
      } catch (error) {
        onboardingLog.error("First-run watchlist update failed", { symbol: ticker.metadata.ticker, error: String(error) });
      }
    }
    const home = buildFirstRunLayout({
      symbol,
      portfolioId,
      watchlistId,
      hasPane: (paneId) => pluginRegistry.panes?.has(paneId) ?? false,
    });
    const workspace = applyFirstRunLayout(config, home);
    if (desks.length === 0) return workspace;
    const { tickers, financials } = stateRef.current;
    const held = [...tickers.values()]
      .filter((ticker) => ticker.metadata.portfolios.includes(portfolioId))
      .map((ticker) => ticker.metadata.ticker);
    const company = pickDeskCompany([symbol, ...held], (candidate) => (
      isDeskStock(tickers.get(candidate), financials.get(candidate))
    ));
    const pro = resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess;
    // A desk that fails to build is left out; it never holds up the first run.
    const deskTabs = await Promise.all(desks.map((key) => (
      buildDesk(getDesk(key), { catalog: pluginRegistry, config: workspace, company, pro }).catch((error) => {
        onboardingLog.error("Desk build failed", { desk: key, error: String(error) });
        return null;
      })
    )));
    const tabs = deskTabs.filter((tab) => tab !== null);
    return { ...workspace, layouts: [workspace.layouts[0]!, ...tabs, ...workspace.layouts.slice(1)] };
  }, [dispatch, pluginRegistry, stateRef]);

  const commitWorkspaceProgress = useCallback(async (
    nextConfig: AppConfig,
    patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
  ) => {
    const withProgress = withOnboardingProgress(nextConfig, patch);
    await saveConfigImmediately(withProgress);
    dispatch({ type: "SET_CONFIG", config: withProgress });
    pluginRegistry.events.emit("config:changed", { config: withProgress });
  }, [dispatch, pluginRegistry.events]);

  const continueFromPositions = useCallback(() => {
    const largest = pickLargestPosition(positions.positions);
    if (!largest) {
      positions.focusField(0);
      return;
    }
    setEditingField(false);
    saveProgressInBackground({
      stage: "desks",
      path: "manual",
      portfolioId: positions.portfolioId,
      tickerSymbol: largest.symbol,
      positionsImported: positions.positions.length,
      brokerName: undefined,
    });
  }, [positions, saveProgressInBackground]);

  /**
   * Leaves "What do you trade?": builds the workspace with the picked desks as
   * tabs (none when skipped, which is today's workspace) and moves on.
   */
  const finishDesks = useCallback((desks: readonly DeskKey[]) => {
    if (buildingDesksRef.current) return;
    const { tickerSymbol, portfolioId } = getOnboardingProgress(stateRef.current.config);
    if (!tickerSymbol) {
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    buildingDesksRef.current = true;
    setBuildingDesks(true);
    setPersistenceError(null);
    void (async () => {
      try {
        const nextConfig = await buildFirstRunWorkspace(
          stateRef.current.config,
          tickerSymbol,
          portfolioId ?? positions.portfolioId,
          desks,
        );
        if (finishingRef.current) return;
        await commitWorkspaceProgress(nextConfig, { stage: "research", desks: [...desks] });
      } catch (error) {
        setPersistenceError(error instanceof Error ? error.message : String(error));
      } finally {
        buildingDesksRef.current = false;
        setBuildingDesks(false);
      }
    })();
  }, [buildFirstRunWorkspace, commitWorkspaceProgress, positions.portfolioId, saveProgressInBackground, stateRef]);

  const handleBrokerSynced = useCallback(async (
    result: SyncBrokerInstanceResult,
    syncedConfig: AppConfig,
  ) => {
    if (finishingRef.current) return;
    const tickerSymbol = pickLargestBrokerPosition(result.positions)?.ticker
      ?? result.addedTickers[0]?.metadata.ticker
      ?? result.updatedTickers[0]?.metadata.ticker;
    const brokerName = brokerOptions.find((option) => option.id === selectedBrokerId)?.name;
    const portfolioId = tickerSymbol ? (result.portfolioIds[0] ?? "main") : "main";
    dispatch({ type: "SET_TICKERS", tickers: result.tickers });
    // The workspace is built once the desks are picked.
    await commitWorkspaceProgress(syncedConfig, {
      stage: tickerSymbol ? "desks" : "portfolio",
      path: "broker",
      portfolioId,
      tickerSymbol,
      brokerName,
      positionsImported: result.positions.length,
    });
    setEditingField(false);
    setPortfolioSub("positions");
  }, [brokerOptions, commitWorkspaceProgress, dispatch, selectedBrokerId]);

  return {
    chosenDesks, setChosenDesks, deskCursor, setDeskCursor, buildingDesks, continueFromPositions,
    finishDesks, handleBrokerSynced,
  };
}

export function useOnboardingCompletion({
  finishingRef, resetBrokerSync, setIsFinishing, setPersistenceError, progressSaveQueueRef, stateRef,
  dispatch, onComplete,
}: {
  finishingRef: RefObject<boolean>;
  resetBrokerSync: () => boolean;
  setIsFinishing: Dispatch<SetStateAction<boolean>>;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
  progressSaveQueueRef: RefObject<Promise<void>>;
  stateRef: ReturnType<typeof useAppStateRef>;
  dispatch: ReturnType<typeof useAppDispatch>;
  onComplete: (config: AppConfig) => void | Promise<void>;
}) {
  const finish = useCallback(async (skipped = false) => {
    if (finishingRef.current) return;
    if (!resetBrokerSync()) return;
    finishingRef.current = true;
    setIsFinishing(true);
    setPersistenceError(null);
    try {
      await progressSaveQueueRef.current.catch(() => {});
      const desks = getOnboardingProgress(stateRef.current.config).desks?.filter(isDeskKey);
      const nextConfig: AppConfig = {
        ...stateRef.current.config,
        onboardingComplete: true,
        onboardingProgress: undefined,
      };
      await saveConfigImmediately(nextConfig);
      dispatch({
        type: "SET_ONBOARDING_STATE",
        complete: true,
        progress: undefined,
      });
      recordResearchActivity(skipped ? "onboarding_skipped" : "onboarding_completed", undefined, undefined, { desks });
      await Promise.resolve(onComplete(nextConfig));
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error));
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, [dispatch, onComplete, resetBrokerSync, stateRef]);
  const skipSetup = useCallback(() => { void finish(true); }, [finish]);

  return {
    finish, skipSetup,
  };
}
