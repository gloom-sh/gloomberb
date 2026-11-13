import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import { recordResearchActivity } from "../../api-client/research-activity";
import { apiClient } from "../../api-client";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import { saveConfigImmediately, scheduleConfigSave } from "../../state/config-save-scheduler";
import type { AppConfig, OnboardingProgress } from "../../types/config";
import type { useAppDispatch, useAppStateRef } from "../../state/app/context";
import { t } from "../../i18n";
import type { PluginRegistry } from "../../plugins/registry";
import { resolvePlanAccess } from "../../api-client/plan-access";
import type { PortfolioSub } from "./onboarding-steps";
import type { useOnboardingPositions } from "./wizard-positions";
import {
  applyFirstRunLayout,
  buildFirstRunLayout,
  FIRST_RUN_WATCHLIST,
  isCompactHomeViewport,
  onboardingDeskLayoutId,
  planFirstRunWatchlist,
  setupDeskPicks,
  type FirstRunPick,
} from "./first-run-workspace";
import { assignFirstRunTickers, confirmFirstRunTickers, recordFirstRunTickersFinished } from "../../api-client/install-experiments";
import { upsertTickerFromSearchResult } from "../../tickers/search";
import { asksFirstRunTickers, type TickerPick } from "./tickers-step-model";
import { buildDesk, getDesk, isDeskKey, isDeskStock, pickDeskCompany, type DeskKey } from "../../layout/desks";
import { debugLog } from "../../utils/debug-log";
import {
  getOnboardingProgress,
  pickLargestBrokerPosition,
  pickLargestPosition,
  withOnboardingProgress,
  type BrokerOption,
} from "./wizard-model";
import { logFailure } from "../../utils/log-failure";
import { useViewport } from "../../react/input";

const onboardingLog = debugLog.createLogger("onboarding");

function saveFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || t("Unable to save onboarding progress.");
}

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
      .catch(() => {
        // Intentional ignore: the queue only holds settled saves, and each save reports its own failure.
      })
      .then(async () => {
        if (finishingRef.current) return stateRef.current.config;
        const nextConfig = withOnboardingProgress(baseConfig ?? stateRef.current.config, patch);
        const show = () => dispatch({
          type: "SET_ONBOARDING_STATE",
          complete: false,
          progress: nextConfig.onboardingProgress,
        });
        try {
          await saveConfigImmediately(nextConfig);
          show();
          return nextConfig;
        } catch (error) {
          // The step moves on all the same, with the reason on the card: a
          // profile that cannot be written must not hold anyone on a step.
          // The next save that works records where they are.
          setPersistenceError(saveFailureMessage(error));
          show();
          throw error;
        }
      });
    progressSaveQueueRef.current = operation.then(() => {}, () => {
      // Intentional ignore: this save's caller receives its rejection; the queue only orders the next save.
    });
    return operation;
  }, [dispatch, stateRef]);

  const saveProgressInBackground = useCallback((
    patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
    baseConfig?: AppConfig,
  ) => {
    void persistProgress(patch, baseConfig).catch(logFailure("onboarding.progress", "Save onboarding progress failed"));
  }, [persistProgress]);

  return {
    persistenceError, setPersistenceError, isFinishing, setIsFinishing, progressSaveQueueRef, finishingRef,
    persistProgress, saveProgressInBackground,
  };
}

export function useOnboardingWorkspace({
  stateRef, pluginRegistry, dispatch, positions, setEditingField, saveProgressInBackground, persistProgress,
  setPersistenceError, finishingRef, brokerOptions, selectedBrokerId, setPortfolioSub,
}: {
  stateRef: ReturnType<typeof useAppStateRef>;
  pluginRegistry: PluginRegistry;
  dispatch: ReturnType<typeof useAppDispatch>;
  positions: ReturnType<typeof useOnboardingPositions>;
  setEditingField: Dispatch<SetStateAction<boolean>>;
  saveProgressInBackground: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig | undefined) => void;
  persistProgress: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig) => Promise<AppConfig>;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
  finishingRef: RefObject<boolean>;
  brokerOptions: BrokerOption[];
  selectedBrokerId: string | null;
  setPortfolioSub: Dispatch<SetStateAction<PortfolioSub>>;
}) {
  // Run again, it starts with the desks it made ticked.
  const [chosenDesks, setChosenDesks] = useState<DeskKey[]>(() => setupDeskPicks(stateRef.current.config));
  const [deskCursor, setDeskCursor] = useState(0);
  const [buildingDesks, setBuildingDesks] = useState(false);
  const buildingDesksRef = useRef(false);
  // The window the workspace is built for: a small terminal gets the compact Home.
  const viewport = useViewport();
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  /**
   * Seeds the watchlist and swaps Home for the first-run workspace built
   * around `symbol`, with the picked desks as tabs right after it. The
   * names picked at "Which tickers do you follow?" lead the watchlist. Run
   * again, it replaces the layouts it made before instead of adding copies,
   * and from Settings it leaves an existing watchlist alone. The config
   * comes back for the caller to persist with its own progress patch.
   */
  const buildFirstRunWorkspace = useCallback(async (
    baseConfig: AppConfig,
    symbol: string,
    portfolioId: string,
    desks: readonly DeskKey[],
    picks: readonly FirstRunPick[] = [],
  ): Promise<AppConfig> => {
    let config = baseConfig;
    const rerun = getOnboardingProgress(baseConfig).rerun === true;
    let watchlistId = config.watchlists[0]?.id;
    // A run from Settings leaves a watchlist the user has as it is.
    const seedWatchlist = !rerun || !watchlistId;
    if (!watchlistId) {
      watchlistId = "watchlist";
      config = { ...config, watchlists: [{ id: watchlistId, name: "Watchlist" }] };
    }
    const plan = seedWatchlist
      ? planFirstRunWatchlist(stateRef.current.tickers, watchlistId, portfolioId, picks)
      : { create: [], update: [] };
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
    const { tickers, financials } = stateRef.current;
    const held = [...tickers.values()]
      .filter((ticker) => ticker.metadata.portfolios.includes(portfolioId))
      .map((ticker) => ticker.metadata.ticker);
    const home = buildFirstRunLayout({
      symbol,
      portfolioId,
      watchlistId,
      hasPane: (paneId) => pluginRegistry.panes?.has(paneId) ?? false,
      compact: isCompactHomeViewport(viewportRef.current),
      holdings: held.length > 0,
    });
    const workspace = applyFirstRunLayout(config, home, [], { rerun });
    if (desks.length === 0) return workspace;
    const company = pickDeskCompany([symbol, ...picks.map((pick) => pick.symbol), ...held], (candidate) => (
      isDeskStock(tickers.get(candidate), financials.get(candidate))
    ));
    const pro = resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess;
    // A desk that fails to build is left out; it never holds up the first run.
    const deskTabs = await Promise.all(desks.map((key) => (
      buildDesk(getDesk(key), { catalog: pluginRegistry, config: workspace, company, pro }).then(
        (tab) => (tab ? { ...tab, id: onboardingDeskLayoutId(key) } : null),
        (error) => {
          onboardingLog.error("Desk build failed", { desk: key, error: String(error) });
          return null;
        },
      )
    )));
    return applyFirstRunLayout(config, home, deskTabs.filter((tab) => tab !== null), { rerun });
  }, [dispatch, pluginRegistry, stateRef]);

  const commitWorkspaceProgress = useCallback(async (
    nextConfig: AppConfig,
    patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
  ) => {
    const withProgress = withOnboardingProgress(nextConfig, patch);
    try {
      await saveConfigImmediately(withProgress);
    } catch (error) {
      // Built all the same: finishing setup saves the whole config again.
      onboardingLog.error("Saving the first-run workspace failed", { error: String(error) });
      setPersistenceError(saveFailureMessage(error));
    }
    dispatch({ type: "SET_CONFIG", config: withProgress });
    pluginRegistry.events.emit("config:changed", { config: withProgress });
  }, [dispatch, pluginRegistry.events, setPersistenceError]);

  // Continue with a ticker typed but not added adds it first, then goes on once its row is listed.
  const [continueAfterAdd, setContinueAfterAdd] = useState(false);
  const continueFromPositions = useCallback(() => {
    if (positions.hasDraft) {
      void positions.addPosition().then((added) => { if (added) setContinueAfterAdd(true); })
        .catch(logFailure("onboarding.positions", "Add position on Continue failed"));
      return;
    }
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
  useEffect(() => {
    if (!continueAfterAdd) return;
    setContinueAfterAdd(false);
    continueFromPositions();
  }, [continueAfterAdd, continueFromPositions]);

  /**
   * Leaves "What do you hold?" holding nothing, as the Desks step can be left
   * picking nothing: the workspace is built around the first name on the
   * first-run watchlist, and holdings can be added once it is open.
   */
  const skipPositions = useCallback(() => {
    if (positions.positions.length > 0) return;
    setEditingField(false);
    saveProgressInBackground({
      stage: "desks",
      path: "manual",
      portfolioId: positions.portfolioId,
      tickerSymbol: FIRST_RUN_WATCHLIST[0]!.ticker,
      positionsImported: 0,
      brokerName: undefined,
      asksTickers: true,
    });
  }, [positions, saveProgressInBackground]);

  /**
   * Leaves "What do you trade most?": builds the workspace with the picked desks as
   * tabs (none when skipped, which is today's workspace) and moves on. A first
   * run that holds nothing asks first_run_tickers for its arm first, at the
   * moment "Which tickers do you follow?" would show: the `tickers` arm goes
   * there with the desks, and the workspace is built once it closes.
   */
  const finishDesks = useCallback((desks: readonly DeskKey[]) => {
    if (buildingDesksRef.current) return;
    const progress = getOnboardingProgress(stateRef.current.config);
    const { tickerSymbol, portfolioId } = progress;
    if (!tickerSymbol) {
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    buildingDesksRef.current = true;
    setBuildingDesks(true);
    setPersistenceError(null);
    void (async () => {
      try {
        const arm = asksFirstRunTickers(progress) ? await assignFirstRunTickers() : null;
        // The arm the first run goes on with is the exposure; no answer in time is never counted.
        if (arm && !finishingRef.current) confirmFirstRunTickers(arm);
        if (arm === "tickers") {
          if (finishingRef.current) return;
          await persistProgress({ stage: "tickers", desks: [...desks] }).catch(
            logFailure("onboarding.progress", "Save onboarding progress failed"),
          );
          return;
        }
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
  }, [buildFirstRunWorkspace, commitWorkspaceProgress, persistProgress, positions.portfolioId, saveProgressInBackground, stateRef]);

  /**
   * The picks as the watchlist takes them: a saved ticker as it is, a search
   * result saved through the usual search upsert, a suggestion by its seed
   * when the app has no ticker for it yet. One that cannot be saved is left
   * out.
   */
  const savePickedTickers = useCallback(async (picks: readonly TickerPick[]): Promise<FirstRunPick[]> => {
    const saved: FirstRunPick[] = [];
    for (const pick of picks) {
      if (pick.ticker) {
        saved.push({ symbol: pick.ticker.metadata.ticker });
      } else if (pick.result) {
        try {
          const { ticker, created } = await upsertTickerFromSearchResult(pluginRegistry.tickerRepository, pick.result);
          dispatch({ type: "UPDATE_TICKER", ticker });
          if (created) pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
          saved.push({ symbol: ticker.metadata.ticker });
        } catch (error) {
          onboardingLog.error("Saving a picked ticker failed", { symbol: pick.symbol, error: String(error) });
        }
      } else {
        saved.push(stateRef.current.tickers.has(pick.symbol) ? { symbol: pick.symbol } : { symbol: pick.symbol, seed: pick.seed });
      }
    }
    return saved.filter((pick, index) => saved.findIndex((other) => other.symbol === pick.symbol) === index);
  }, [dispatch, pluginRegistry, stateRef]);

  /**
   * Leaves "Which tickers do you follow?": the picks lead the watchlist and the
   * workspace is built around the first, with the desks picked before it.
   * Skip keeps the first run as the control has it. Either way the step's end
   * is reported with how many names it kept, never which.
   */
  const finishTickers = useCallback((picks: readonly TickerPick[], skipped: boolean) => {
    if (buildingDesksRef.current) return;
    const progress = getOnboardingProgress(stateRef.current.config);
    if (!progress.tickerSymbol) {
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    const desks = (progress.desks ?? []).filter(isDeskKey);
    buildingDesksRef.current = true;
    setBuildingDesks(true);
    setPersistenceError(null);
    void (async () => {
      try {
        const chosen = skipped ? [] : await savePickedTickers(picks);
        recordFirstRunTickersFinished({ picked: chosen.length, skipped });
        const tickerSymbol = chosen[0]?.symbol ?? progress.tickerSymbol!;
        const nextConfig = await buildFirstRunWorkspace(
          stateRef.current.config,
          tickerSymbol,
          progress.portfolioId ?? positions.portfolioId,
          desks,
          chosen,
        );
        if (finishingRef.current) return;
        await commitWorkspaceProgress(nextConfig, { stage: "research", desks, tickerSymbol });
      } catch (error) {
        setPersistenceError(error instanceof Error ? error.message : String(error));
      } finally {
        buildingDesksRef.current = false;
        setBuildingDesks(false);
      }
    })().catch(logFailure("onboarding.tickers", "Finishing the tickers step failed"));
  }, [buildFirstRunWorkspace, commitWorkspaceProgress, positions.portfolioId, saveProgressInBackground, savePickedTickers, stateRef]);

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
    skipPositions, finishDesks, finishTickers, handleBrokerSynced,
  };
}

export function useOnboardingCompletion({
  finishingRef, resetBrokerSync, setIsFinishing, setPersistenceError, progressSaveQueueRef, stateRef,
  dispatch, onComplete, onSaveFailure,
}: {
  finishingRef: RefObject<boolean>;
  resetBrokerSync: () => boolean;
  setIsFinishing: Dispatch<SetStateAction<boolean>>;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
  progressSaveQueueRef: RefObject<Promise<void>>;
  stateRef: ReturnType<typeof useAppStateRef>;
  dispatch: ReturnType<typeof useAppDispatch>;
  onComplete: (config: AppConfig) => void | Promise<void>;
  /** Finishing could not be saved; setup closes all the same, so this says so where the user still looks. */
  onSaveFailure: () => void;
}) {
  const finish = useCallback(async (skipped = false) => {
    if (finishingRef.current) return;
    if (!resetBrokerSync()) return;
    finishingRef.current = true;
    setIsFinishing(true);
    setPersistenceError(null);
    try {
      await progressSaveQueueRef.current.catch(() => {
        // Intentional ignore: the queue only holds settled saves, and each save reports its own failure.
      });
      const { desks: picked, rerun } = getOnboardingProgress(stateRef.current.config);
      const desks = picked?.filter(isDeskKey);
      const nextConfig: AppConfig = {
        ...stateRef.current.config,
        onboardingComplete: true,
        onboardingProgress: undefined,
      };
      let saved = true;
      try {
        await saveConfigImmediately(nextConfig);
      } catch (error) {
        // Setup closes all the same: a profile that cannot be written must
        // not keep anyone in it. The save below tries again.
        saved = false;
        onboardingLog.error("Saving finished setup failed", { error: String(error) });
      }
      dispatch({
        type: "SET_ONBOARDING_STATE",
        complete: true,
        progress: undefined,
      });
      // Saved once more from the state. A pane that queued a save while the
      // one above ran queued the config with setup still open, which would
      // open it again at the next launch; this replaces it, and retries a
      // save that failed.
      scheduleConfigSave(() => ({ ...stateRef.current.config, recentTickers: stateRef.current.recentTickers }));
      if (!saved) onSaveFailure();
      // The funnel counts first runs; a run from Settings is not one.
      if (!rerun) recordResearchActivity(skipped ? "onboarding_skipped" : "onboarding_completed", undefined, undefined, { desks });
      await Promise.resolve(onComplete(nextConfig));
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error));
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, [dispatch, onComplete, onSaveFailure, resetBrokerSync, stateRef]);
  const skipSetup = useCallback(() => { void finish(true); }, [finish]);

  return {
    finish, skipSetup,
  };
}
