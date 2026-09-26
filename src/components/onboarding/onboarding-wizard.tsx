import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { recordResearchActivity, type ResearchActivity } from "../../api-client/research-activity";
import { apiClient, type CloudPricing } from "../../api-client";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { buildBrokerDirectory } from "../../brokers/directory";
import {
  getSignedInBrokers,
  refreshSignedInBrokers,
  subscribeSignedInBrokers,
} from "../../brokers/signed-in/catalog";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import {
  type AppConfig,
  findPaneInstance,
  type OnboardingProgress,
  type OnboardingStage,
} from "../../types/config";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import { useShortcut, useViewport, type KeyEventLike } from "../../react/input";
import {
  matchKeybinding,
  matchesKeybindingAction,
  useKeybindings,
  type ResolvedKeybindings,
} from "../../app/keybindings";
import {
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import { useAppActive } from "../../state/app/activity";
import {
  Box,
  Text,
  TextAttributes,
  useActionShortcut,
  useCommandBarShortcut,
  useRendererHost,
  useUiHost,
  type InputRenderable,
} from "../../ui";
import { useDialogState } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { isCopyShortcut, isPasteShortcut } from "../../utils/selection-clipboard";
import { useThemeColors } from "../../theme/theme-context";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import type { PluginRegistry } from "../../plugins/registry";
import { chatController } from "../../plugins/builtin/chat/controller";
import {
  type CloudBillingInterval,
  formatCloudPrice,
  monthsFreeYearly,
} from "../../plugins/builtin/account-management/model";
import { useCloudUpgradeAction } from "../../plugins/builtin/shared/cloud-upgrade";
import { usePlanAccess } from "../../plugins/builtin/shared/plan-access";
import { Button, SegmentedControl, type ListViewItem } from "../ui";
import { AccountStep, PortfolioStep, type PortfolioSub } from "./onboarding-steps";
import { BROKER_GUIDE_KEY, brokerSetupGuideUrl } from "./portfolio-step/broker-setup-panel";
import { REMOVE_POSITION_KEY } from "./portfolio-step/positions-panel";
import {
  ONBOARDING_DESKTOP,
  OnboardingActions,
  OnboardingButton,
  OnboardingCoach,
  OnboardingFeature,
  OnboardingHeader,
  OnboardingModal,
  OnboardingTitle,
  type OnboardingSectionId,
} from "./onboarding-frame";
import { useOnboardingAccount } from "./wizard-account";
import { useOnboardingBrokerSync } from "./wizard-broker-sync";
import { POSITION_FIELDS, useOnboardingPositions } from "./wizard-positions";
import { applyFirstRunLayout, buildFirstRunLayout, planFirstRunWatchlist } from "./first-run-workspace";
import { debugLog } from "../../utils/debug-log";
import {
  getConnectableBrokerOptions,
  getOnboardingProgress,
  pickLargestBrokerPosition,
  pickLargestPosition,
  withOnboardingProgress,
  type BrokerOption,
} from "./wizard-model";

const onboardingLog = debugLog.createLogger("onboarding");

interface OnboardingWizardProps {
  pluginRegistry: PluginRegistry;
  importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"];
  onComplete: (config: AppConfig) => void | Promise<void>;
}

/** One funnel milestone per stage the user reaches; the account step reports sign-in itself. */
const STAGE_ACTIVITY: Partial<Record<OnboardingStage, ResearchActivity>> = {
  portfolio: "onboarding_started",
  research: "onboarding_research_opened",
  account: "onboarding_account_viewed",
  upgrade: "onboarding_pro_viewed",
};

/**
 * Card keys, shown on the buttons they press. Letters only act while no field
 * is being typed in (Esc leaves the field first); F10, the old skip key, still
 * works everywhere.
 */
const SKIP_SETUP_KEY = "s";
const KEEP_FREE_KEY = "f";
const CONNECT_BROKER_KEY = "b";
const BROWSER_SIGN_IN_KEY = "b";

/** Digits jump straight to a section the header would let you click. */
const SECTION_DIGITS: Record<string, OnboardingSectionId> = { "1": "portfolio", "2": "cloud", "3": "pro" };

/**
 * Whether a key the onboarding card did not use may still reach the app
 * behind it. Toasts float above the card, copy and paste work anywhere, and
 * Help is the way out (the card steps aside while Help has focus). A field
 * keeps its typing and editing keys; of the chords that reach app shortcuts
 * while typing, only the ones the app binds are held back. Everything else
 * would act on a pane hidden behind the scrim.
 */
function keyReachesPastOnboardingModal(event: KeyEventLike, keybindings: ResolvedKeybindings): boolean {
  if (isCopyShortcut(event) || isPasteShortcut(event)) return true;
  const match = matchKeybinding(keybindings, event);
  const action = match?.kind === "action" ? match.id : null;
  if (action === "notification-action" || action === "notification-dismiss") return true;
  if (event.targetEditable) {
    const chord = event.ctrl || event.meta || event.super === true;
    return !chord || !match;
  }
  return action === "help";
}

export function OnboardingWizard({ pluginRegistry, importBrokerPositions, onComplete }: OnboardingWizardProps) {
  const language = useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const rendererHost = useRendererHost();
  const commandBarShortcut = useCommandBarShortcut();
  const notificationActionShortcut = useActionShortcut("notification-action");
  const notificationDismissShortcut = useActionShortcut("notification-dismiss");
  const keybindings = useKeybindings();
  const dialogOpen = useDialogState((dialog) => dialog.isOpen);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const { height: viewportHeight } = useViewport();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const config = useAppSelector((state) => state.config);
  const progress = getOnboardingProgress(config);
  const stage = progress.stage;
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const researchOpenedRef = useRef<string | null>(null);
  const [pricing, setPricing] = useState<CloudPricing | null>(null);
  const [billingInterval, setBillingInterval] = useState<CloudBillingInterval>("month");

  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("positions");
  const [portfolioOptionIdx, setPortfolioOptionIdx] = useState(0);
  const [brokerValues, setBrokerValues] = useState<Record<string, Record<string, string>>>({});
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const [brokerFieldIdx, setBrokerFieldIdx] = useState(0);
  const [brokerSelectIdx, setBrokerSelectIdx] = useState(0);
  const [editingField, setEditingField] = useState(false);
  /** The added position the keyboard acts on once no field is being typed in. */
  const [positionCursorSymbol, setPositionCursorSymbol] = useState<string | null>(null);
  const inputRef = useRef<InputRenderable>(null);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finishingRef = useRef(false);

  useEffect(() => {
    if (pluginRegistry.brokers.has(SIGNED_IN_BROKER_TYPE)) void refreshSignedInBrokers();
  }, [pluginRegistry.brokers]);
  const signedInBrokers = useSyncExternalStore(subscribeSignedInBrokers, getSignedInBrokers, getSignedInBrokers);
  // Enter inside every form is handled once, by the shortcut below: the
  // fields deliberately get no onSubmit, because the host input fires it in
  // the same keystroke and the two paths used to submit twice.
  const brokerOptions = useMemo(
    (): BrokerOption[] => getConnectableBrokerOptions(buildBrokerDirectory({
      signedIn: signedInBrokers,
      adapters: pluginRegistry.brokers.values(),
    })),
    [pluginRegistry.brokers, signedInBrokers],
  );
  const brokerChoices = useMemo<ListViewItem[]>(() => brokerOptions.map((broker) => ({
    id: broker.id,
    label: tf("Connect {broker}", { broker: broker.name }),
    // A broker offered two ways shows which way each choice connects.
    description: broker.methodLabel ?? tf("Import positions from {broker}", { broker: broker.name }),
  })), [brokerOptions, language]);
  const activeBrokerFields = useMemo((): BrokerConfigField[] => {
    if (!selectedBrokerId) return [];
    const adapter = brokerOptions.find((option) => option.id === selectedBrokerId)?.adapter;
    return adapter
      ? resolveBrokerConfigFields(adapter, brokerValues[selectedBrokerId] ?? {}).filter((field) => field.required)
      : [];
  }, [brokerOptions, brokerValues, selectedBrokerId]);

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

  // Pro follows sign-in directly. Email verification continues in the status
  // bar, so an unread inbox never stalls the first session.
  const account = useOnboardingAccount({
    nextStep: () => {
      recordResearchActivity("onboarding_signed_in");
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    },
    setEditingField,
  });

  const positions = useOnboardingPositions({ pluginRegistry, onFieldEditing: setEditingField });
  const positionCount = positions.positions.length;
  // The cursor rests on the newest row until the keyboard moves it; it only
  // shows once the fields let go of the keyboard.
  const cursorMatch = positions.positions.findIndex((row) => row.symbol === positionCursorSymbol);
  const positionCursorIndex = cursorMatch >= 0 ? cursorMatch : positionCount - 1;
  const selectedPositionSymbol = !editingField && positionCursorIndex >= 0
    ? positions.positions[positionCursorIndex]!.symbol
    : null;

  useEffect(() => {
    const activity = STAGE_ACTIVITY[stage];
    if (activity) recordResearchActivity(activity);
  }, [stage]);

  useEffect(() => {
    if (stage === "portfolio" && positionCount > 0) recordResearchActivity("onboarding_position_added");
  }, [positionCount, stage]);

  // The portfolio step opens straight into the ticker field.
  useEffect(() => {
    if (stage === "portfolio" && portfolioSub === "positions") setEditingField(true);
  }, [portfolioSub, stage]);

  /**
   * Seeds the watchlist and swaps Home for the first-run workspace built
   * around `symbol`. The config comes back for the caller to persist with its
   * own progress patch.
   */
  const buildFirstRunWorkspace = useCallback(async (
    baseConfig: AppConfig,
    symbol: string,
    portfolioId: string,
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
    return applyFirstRunLayout(config, home);
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
    setPersistenceError(null);
    void (async () => {
      try {
        const nextConfig = await buildFirstRunWorkspace(stateRef.current.config, largest.symbol, positions.portfolioId);
        if (finishingRef.current) return;
        await commitWorkspaceProgress(nextConfig, {
          stage: "research",
          path: "manual",
          portfolioId: positions.portfolioId,
          tickerSymbol: largest.symbol,
          positionsImported: positions.positions.length,
          brokerName: undefined,
        });
      } catch (error) {
        setPersistenceError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [buildFirstRunWorkspace, commitWorkspaceProgress, positions, stateRef]);

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
    const workspaceConfig = tickerSymbol
      ? await buildFirstRunWorkspace(syncedConfig, tickerSymbol, portfolioId)
      : syncedConfig;
    await commitWorkspaceProgress(workspaceConfig, {
      stage: tickerSymbol ? "research" : "portfolio",
      path: "broker",
      portfolioId,
      tickerSymbol,
      brokerName,
      positionsImported: result.positions.length,
    });
    setEditingField(false);
    setPortfolioSub("positions");
  }, [brokerOptions, buildFirstRunWorkspace, commitWorkspaceProgress, dispatch, selectedBrokerId]);

  const {
    isBrokerSyncing,
    isBrokerCommitting,
    brokerSyncError,
    resetBrokerSync,
    syncSelectedBroker,
    connectSignedInBroker,
  } = useOnboardingBrokerSync({
    config,
    brokerOptions,
    brokerValues,
    selectedBrokerId,
    importBrokerPositions,
    getConfig: () => stateRef.current.config,
    createBrokerInstance: (brokerType, label, values) => pluginRegistry.createBrokerInstanceFn(brokerType, label, values),
    onSynced: handleBrokerSynced,
    setEditingField,
    setPortfolioSub,
  });

  const finish = useCallback(async (skipped = false) => {
    if (finishingRef.current) return;
    if (!resetBrokerSync()) return;
    finishingRef.current = true;
    setIsFinishing(true);
    setPersistenceError(null);
    try {
      await progressSaveQueueRef.current.catch(() => {});
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
      recordResearchActivity(skipped ? "onboarding_skipped" : "onboarding_completed");
      await Promise.resolve(onComplete(nextConfig));
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error));
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, [dispatch, onComplete, resetBrokerSync, stateRef]);
  const skipSetup = useCallback(() => { void finish(true); }, [finish]);

  useEffect(() => {
    if (!selectedBrokerId) return;
    const field = activeBrokerFields[brokerFieldIdx];
    if (!field || field.type !== "select") return;
    const currentValue = brokerValues[selectedBrokerId]?.[field.key] ?? field.options?.[0]?.value ?? "";
    const index = Math.max(0, field.options?.findIndex((option) => option.value === currentValue) ?? 0);
    setBrokerSelectIdx(index);
  }, [activeBrokerFields, brokerFieldIdx, brokerValues, selectedBrokerId]);

  useEffect(() => {
    if (!editingField) return;
    const timer = setTimeout(() => inputRef.current?.focus?.(), 10);
    return () => clearTimeout(timer);
  }, [account.accountFieldIdx, account.accountSub, brokerFieldIdx, editingField, portfolioSub, positions.fieldIdx]);

  useEffect(() => {
    if (stage !== "account") return;
    account.syncExistingAccountSession();
  }, [account.syncExistingAccountSession, stage]);

  useEffect(() => {
    if (stage !== "research" || !progress.tickerSymbol || researchOpenedRef.current === progress.tickerSymbol) return;
    researchOpenedRef.current = progress.tickerSymbol;
    recordResearchActivity("ticker_saved");
  }, [stage, progress.tickerSymbol]);

  useEffect(() => {
    if (stage !== "upgrade" || pricing) return;
    void apiClient.getCloudPricing().then(setPricing).catch(() => {});
  }, [pricing, stage]);

  const appActive = useAppActive();
  const planAccess = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  useEffect(() => {
    if (stage !== "upgrade" || !progress.checkoutOpenedAt || !appActive) return;
    void apiClient.getSession()
      .then(() => chatController.refreshSession())
      .catch(() => {});
  }, [appActive, progress.checkoutOpenedAt, stage]);

  useEffect(() => {
    if (stage === "upgrade" && planAccess.hasProAccess) {
      saveProgressInBackground({ stage: "ready", accountStatus: "signed-in" });
    }
  }, [planAccess.hasProAccess, saveProgressInBackground, stage]);

  const setBrokerFieldValue = useCallback((brokerId: string, key: string, value: string) => {
    resetBrokerSync();
    setBrokerValues((previous) => ({
      ...previous,
      [brokerId]: { ...previous[brokerId], [key]: value },
    }));
  }, [resetBrokerSync]);

  const selectBroker = useCallback((brokerId: string) => {
    resetBrokerSync();
    setSelectedBrokerId(brokerId);
    setBrokerFieldIdx(0);
    const broker = brokerOptions.find((option) => option.id === brokerId);
    if (broker?.signedIn) {
      // Nothing to fill in: the connect dialog opens over this step.
      setEditingField(false);
      void connectSignedInBroker(broker.signedIn);
      return;
    }
    setPortfolioSub("broker-fields");
    const firstField = broker?.adapter
      ? resolveBrokerConfigFields(broker.adapter, brokerValues[brokerId] ?? {}).filter((field) => field.required)[0]
      : null;
    setEditingField(firstField?.type !== "select");
  }, [brokerOptions, brokerValues, connectSignedInBroker, resetBrokerSync]);

  const chooseBroker = useCallback((choiceIndex = portfolioOptionIdx) => {
    const choice = brokerChoices[choiceIndex];
    if (choice) selectBroker(choice.id);
  }, [brokerChoices, portfolioOptionIdx, selectBroker]);

  /** Broker import is the secondary path: one broker goes straight to its fields. */
  const openBrokerConnect = useCallback(() => {
    if (brokerOptions.length === 0) return;
    setEditingField(false);
    if (brokerOptions.length === 1) {
      selectBroker(brokerOptions[0]!.id);
      return;
    }
    setPortfolioOptionIdx(0);
    setPortfolioSub("choose");
  }, [brokerOptions, selectBroker]);

  const submitBrokerField = useCallback(() => {
    if (!selectedBrokerId || isBrokerSyncing) return;
    const field = activeBrokerFields[brokerFieldIdx];
    if (!field) {
      void syncSelectedBroker();
      return;
    }

    const currentValues = brokerValues[selectedBrokerId] ?? {};
    if (field.type === "select") {
      const option = field.options?.[brokerSelectIdx];
      if (!option) return;
      const nextValues = { ...currentValues, [field.key]: option.value };
      setBrokerFieldValue(selectedBrokerId, field.key, option.value);
      const adapter = brokerOptions.find((entry) => entry.id === selectedBrokerId)?.adapter;
      const nextFields = adapter
        ? resolveBrokerConfigFields(adapter, nextValues).filter((entry) => entry.required)
        : activeBrokerFields;
      if (brokerFieldIdx < nextFields.length - 1) {
        const nextIndex = brokerFieldIdx + 1;
        setBrokerFieldIdx(nextIndex);
        if (field.key === "connectionMode") {
          setPortfolioSub("broker-setup");
        } else {
          setEditingField(nextFields[nextIndex]?.type !== "select");
        }
        return;
      }
      void syncSelectedBroker(nextValues);
      return;
    }

    const rawValue = currentValues[field.key]?.trim() ?? "";
    const value = rawValue || field.defaultValue || "";
    if (!value) {
      setEditingField(true);
      return;
    }
    const nextValues = { ...currentValues, [field.key]: value };
    if (!rawValue && field.defaultValue) {
      setBrokerFieldValue(selectedBrokerId, field.key, field.defaultValue);
    }
    setEditingField(false);
    if (brokerFieldIdx < activeBrokerFields.length - 1) {
      const nextIndex = brokerFieldIdx + 1;
      setBrokerFieldIdx(nextIndex);
      setEditingField(activeBrokerFields[nextIndex]?.type !== "select");
      return;
    }
    void syncSelectedBroker(nextValues);
  }, [
    activeBrokerFields,
    brokerFieldIdx,
    brokerOptions,
    brokerSelectIdx,
    brokerValues,
    isBrokerSyncing,
    selectedBrokerId,
    setBrokerFieldValue,
    syncSelectedBroker,
  ]);

  const continuePortfolio = useCallback(() => {
    if (portfolioSub === "positions") {
      continueFromPositions();
      return;
    }
    if (portfolioSub === "choose") {
      chooseBroker();
      return;
    }
    if (portfolioSub === "broker-setup") {
      setPortfolioSub("broker-fields");
      setEditingField(activeBrokerFields[brokerFieldIdx]?.type !== "select");
      return;
    }
    if (portfolioSub === "broker-sync") {
      if (!isBrokerSyncing && brokerSyncError) void syncSelectedBroker();
      return;
    }
    submitBrokerField();
  }, [
    activeBrokerFields,
    brokerFieldIdx,
    brokerSyncError,
    chooseBroker,
    continueFromPositions,
    isBrokerSyncing,
    portfolioSub,
    submitBrokerField,
    syncSelectedBroker,
  ]);

  const backPortfolio = useCallback(() => {
    if (portfolioSub === "positions") return;
    if (portfolioSub === "broker-sync" && !resetBrokerSync()) return;
    setPortfolioSub("positions");
    setSelectedBrokerId(null);
    setBrokerFieldIdx(0);
    setEditingField(false);
  }, [portfolioSub, resetBrokerSync]);

  const movePositionCursor = useCallback((delta: number) => {
    if (positionCursorIndex < 0) return;
    const next = Math.max(0, Math.min(positionCount - 1, positionCursorIndex + delta));
    setPositionCursorSymbol(positions.positions[next]?.symbol ?? null);
  }, [positionCount, positionCursorIndex, positions.positions]);

  /** Removes the row under the cursor; the cursor moves to the row that takes its place. */
  const removePositionAtCursor = useCallback(() => {
    if (!selectedPositionSymbol) return;
    const neighbour = positions.positions[positionCursorIndex + 1] ?? positions.positions[positionCursorIndex - 1];
    setPositionCursorSymbol(neighbour?.symbol ?? null);
    void positions.removePosition(selectedPositionSymbol);
  }, [positionCursorIndex, positions, selectedPositionSymbol]);

  const openBrokerGuide = useCallback(() => {
    const url = selectedBrokerId ? brokerSetupGuideUrl(selectedBrokerId, brokerValues) : null;
    if (url) void rendererHost.openExternal(url).catch(() => {});
  }, [brokerValues, rendererHost, selectedBrokerId]);

  const submitAccountField = useCallback(() => {
    setEditingField(false);
    account.submitAccountField();
  }, [account.submitAccountField]);

  const continueAccount = useCallback(() => {
    // The QR panel owns enter (retry after a denial); approval advances itself.
    if (account.accountSub === "qr") return;
    if (account.accountSub === "signed-in") {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
      return;
    }
    submitAccountField();
  }, [account.accountSub, saveProgressInBackground, submitAccountField]);

  // The account step opens on the email form with the cursor in it.
  useEffect(() => {
    if (stage === "account" && (account.accountSub === "signup" || account.accountSub === "login")) setEditingField(true);
  }, [account.accountSub, stage]);

  const startUpgrade = useCallback(() => {
    void persistProgress({
      stage: "upgrade",
      accountStatus: progress.accountStatus,
      checkoutOpenedAt: new Date().toISOString(),
    }).then(() => openUpgrade({ interval: billingInterval })).catch(() => {});
  }, [billingInterval, openUpgrade, persistProgress, progress.accountStatus]);

  const primaryUpgradeAction = useCallback(() => {
    if (planAccess.hasProAccess) {
      saveProgressInBackground({ stage: "ready", accountStatus: "signed-in" });
      return;
    }
    startUpgrade();
  }, [planAccess.hasProAccess, saveProgressInBackground, startUpgrade]);

  const continueFree = useCallback(() => {
    saveProgressInBackground({ stage: "ready", accountStatus: progress.accountStatus });
  }, [progress.accountStatus, saveProgressInBackground]);

  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const focusedInstance = focusedPaneId
    ? findPaneInstance(config.layout, focusedPaneId)
    : null;
  const helpFocused = focusedInstance?.paneId === "help";

  const goToSection = useCallback((section: OnboardingSectionId) => {
    if (finishingRef.current || isBrokerCommitting) return;
    setEditingField(false);
    if (section === "portfolio") {
      setPortfolioSub("positions");
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    if (section === "cloud") {
      saveProgressInBackground({ stage: "account" });
      return;
    }
    if (planAccess.signedIn) {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    }
  }, [isBrokerCommitting, planAccess.signedIn, saveProgressInBackground]);

  const sectionAvailability: Partial<Record<OnboardingSectionId, boolean>> = {
    portfolio: !isBrokerCommitting,
    cloud: !isBrokerCommitting && (stage === "account" || stage === "upgrade" || stage === "ready" || !!progress.tickerSymbol),
    pro: !isBrokerCommitting && planAccess.signedIn && (
      stage === "upgrade"
      || stage === "ready"
      || progress.accountStatus === "signed-in"
    ),
  };

  const activeSection: OnboardingSectionId = stage === "portfolio"
    ? "portfolio"
    : stage === "upgrade" || (stage === "ready" && progress.accountStatus === "signed-in")
      ? "pro"
      : "cloud";
  const accountForm = account.accountSub === "signup" || account.accountSub === "login";
  const modalShown = !helpFocused && stage !== "research";

  /**
   * The card's keys. The card is modal: whatever it does not use stops here,
   * so nothing reaches the workspace behind the scrim. The scope carries the
   * stage so each step registers afresh and runs ahead of any pane that
   * mounted since (the first-run workspace mounts after the wizard).
   */
  useShortcut((event) => {
    const name = event.name ?? event.key ?? "";
    const chord = event.ctrl || event.meta || event.super === true || event.alt;
    const enter = !chord && (name === "enter" || name === "return");
    const escape = !chord && (name === "escape" || name === "backspace");
    const letter = (key: string) => !chord && !event.shift && name === key;
    const tab = !chord && name === "tab";
    const sectionDigit = !chord && !editingField && !event.targetEditable ? SECTION_DIGITS[name] : undefined;

    const handled = ((): boolean => {
      if (isPlainKey(event, "f10")) {
        if (stage === "portfolio" || isBrokerCommitting) return true;
        if (stage === "upgrade" && !planAccess.hasProAccess) continueFree();
        else void finish(true);
        return true;
      }

      if (sectionDigit) {
        if (sectionDigit !== activeSection && sectionAvailability[sectionDigit]) goToSection(sectionDigit);
        return true;
      }

      if (stage === "portfolio" && portfolioSub === "positions") {
        if (editingField) {
          if (enter) {
            positions.submitField();
          } else if (tab) {
            positions.setFieldIdx((index) => (
              event.shift ? Math.max(0, index - 1) : Math.min(POSITION_FIELDS.length - 1, index + 1)
            ));
          } else if (!chord && name === "escape") {
            setEditingField(false);
          } else {
            return false;
          }
          return true;
        }
        if (enter) {
          if (positionCount > 0) continueFromPositions();
          else positions.focusField(0);
        } else if (letter("a") || tab) {
          // Tab from the list goes back into the form, at its far end for Shift+Tab.
          positions.focusField(tab && event.shift ? POSITION_FIELDS.length - 1 : 0);
        } else if (letter(CONNECT_BROKER_KEY) && positionCount > 0) {
          openBrokerConnect();
        } else if (!chord && (name === "up" || name === "k")) {
          movePositionCursor(-1);
        } else if (!chord && (name === "down" || name === "j")) {
          movePositionCursor(1);
        } else if (letter(REMOVE_POSITION_KEY) || (!chord && name === "delete")) {
          removePositionAtCursor();
        } else {
          return false;
        }
        return true;
      }

      if (editingField && (stage === "portfolio" || (stage === "account" && accountForm))) {
        if (enter) {
          if (stage === "portfolio") submitBrokerField();
          else submitAccountField();
        } else if (!chord && name === "escape") {
          setEditingField(false);
          if (stage === "portfolio") backPortfolio();
        } else if (stage === "account" && tab) {
          account.focusAccountField(event.shift ? 0 : 1);
        } else {
          return false;
        }
        return true;
      }

      if (stage === "portfolio") {
        if (enter) {
          continuePortfolio();
        } else if (escape) {
          backPortfolio();
        } else if (!chord && (name === "up" || name === "k")) {
          if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.max(0, index - 1));
          else if (activeBrokerFields[brokerFieldIdx]?.type === "select") setBrokerSelectIdx((index) => Math.max(0, index - 1));
        } else if (!chord && (name === "down" || name === "j")) {
          if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.min(brokerChoices.length - 1, index + 1));
          else if (activeBrokerFields[brokerFieldIdx]?.type === "select") {
            const optionCount = activeBrokerFields[brokerFieldIdx]?.options?.length ?? 0;
            setBrokerSelectIdx((index) => Math.min(Math.max(0, optionCount - 1), index + 1));
          }
        } else if (portfolioSub === "broker-setup" && letter(BROKER_GUIDE_KEY)) {
          openBrokerGuide();
        } else {
          return false;
        }
        return true;
      }

      if (stage === "account") {
        if (enter) {
          continueAccount();
        } else if (escape) {
          if (account.accountSub === "qr" || account.accountSub === "login") account.returnToAccountForm();
          else goToSection("portfolio");
        } else if (letter(BROWSER_SIGN_IN_KEY) && accountForm) {
          account.beginQrSignIn();
        } else if (letter(SKIP_SETUP_KEY)) {
          skipSetup();
        } else if (tab && accountForm) {
          account.focusAccountField(account.accountFieldIdx > 0 ? 1 : 0);
        } else {
          return false;
        }
        return true;
      }

      if (stage === "upgrade") {
        if (enter) {
          primaryUpgradeAction();
        } else if (escape) {
          goToSection("cloud");
        } else if (!planAccess.hasProAccess && letter(KEEP_FREE_KEY)) {
          continueFree();
        } else if (!planAccess.hasProAccess && (isPlainKey(event, "left") || letter("h"))) {
          setBillingInterval("month");
        } else if (!planAccess.hasProAccess && (isPlainKey(event, "right") || letter("l"))) {
          setBillingInterval("year");
        } else {
          return false;
        }
        return true;
      }

      if (stage === "ready") {
        if (enter) void finish();
        else if (escape) goToSection(progress.accountStatus === "signed-in" ? "pro" : "cloud");
        else return false;
        return true;
      }
      return false;
    })();

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (keyReachesPastOnboardingModal(event, keybindings)) return;
    // An app chord held here still must not fall through to the browser's own
    // meaning for it (Cmd+digit switches tabs in a web host).
    if (matchKeybinding(keybindings, event)) event.preventDefault();
    event.stopPropagation();
  }, {
    phase: "before",
    allowEditable: true,
    scope: `onboarding:${stage}`,
    enabled: modalShown && !dialogOpen && !commandBarOpen,
  });

  /**
   * The research coach floats over a live workspace, so it takes no key a pane
   * could want. It answers the notification keys, like a toast that stays up,
   * and only when nothing else used them.
   */
  useShortcut((event) => {
    if (event.targetEditable) return;
    const connect = matchesKeybindingAction(keybindings, "notification-action", event);
    const dismiss = matchesKeybindingAction(keybindings, "notification-dismiss", event) || isPlainKey(event, "f10");
    if (!connect && !dismiss) return;
    event.preventDefault();
    event.stopPropagation();
    if (connect) saveProgressInBackground({ stage: "account" });
    else void finish();
  }, {
    phase: "after",
    enabled: stage === "research" && !helpFocused && !dialogOpen && !commandBarOpen,
  });

  if (helpFocused) {
    return null;
  }

  if (stage === "research") {
    const ticker = progress.tickerSymbol ?? t("your company");
    return <OnboardingCoach step={t("YOUR WORKSPACE")}
      title={tf("Built around {ticker}", { ticker })}
      actions={<>
        {/* The card has no room for both keys: like a toast, the dismiss key
            is in the desktop tooltip. F10 also dismisses it. */}
        <OnboardingButton
          label="Keep exploring"
          variant="ghost"
          title={notificationDismissShortcut ? `${t("Keep exploring")} (${notificationDismissShortcut})` : undefined}
          onPress={() => { void finish(); }}
        />
        <OnboardingButton
          label="Connect free Cloud"
          variant="primary"
          shortcut={notificationActionShortcut || undefined}
          onPress={() => saveProgressInBackground({ stage: "account" })}
        />
      </>}>
      <Text fg={colors.textDim} wrapText>{tf("Your holdings as a heatmap, a watchlist, and {ticker} charted. Every pane moves; {shortcut} adds more.", {
        ticker,
        shortcut: commandBarShortcut,
      })}</Text>
    </OnboardingCoach>;
  }

  if (stage === "portfolio") {
    const selectedBroker = selectedBrokerId
      ? brokerOptions.find((option) => option.id === selectedBrokerId)
      : null;
    const selectedBrokerName = selectedBroker?.name;
    const portfolioModalHeight = portfolioSub === "positions"
      ? 22
      : portfolioSub === "choose"
        ? 16
        : portfolioSub === "broker-setup"
          ? 21
          : portfolioSub === "broker-sync"
            ? 14
            : 20;
    const title = portfolioSub === "positions"
      ? t("What do you hold?")
      : portfolioSub === "choose"
        ? t("Connect a broker")
        : selectedBrokerName
          ? tf("Connect {broker}", { broker: selectedBrokerName })
          : t("Set up a portfolio");
    // A signed-in broker keeps its credentials with the broker, so the line is left out.
    const description = portfolioSub === "positions"
      ? undefined
      : portfolioSub === "choose"
        ? brokerOptions.some((option) => option.signedIn) ? undefined : t("Credentials stay on this device.")
        : selectedBroker?.signedIn
          ? undefined
          : t("Enter the connection details for this broker. Credentials stay on this device.");
    return (
      <OnboardingModal width={76} height={portfolioModalHeight} desktopWidth="min(620px, 100%)">
        <OnboardingHeader
          active="portfolio"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissing={isFinishing}
          dismissDisabled={isBrokerCommitting}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("PORTFOLIO")}
          title={title}
          description={description}
        />
        <Box minHeight={0}>
          <PortfolioStep
            sub={portfolioSub}
            positions={positions}
            positionsInputRef={inputRef}
            positionsEditing={editingField}
            selectedPositionSymbol={selectedPositionSymbol}
            commandBarShortcut={commandBarShortcut}
            choices={brokerChoices}
            optionIdx={portfolioOptionIdx}
            onOptionSelect={setPortfolioOptionIdx}
            onOptionActivate={chooseBroker}
            selectedBrokerId={selectedBrokerId}
            brokerFields={activeBrokerFields}
            brokerFieldIdx={brokerFieldIdx}
            brokerSelectIdx={brokerSelectIdx}
            onBrokerSelect={setBrokerSelectIdx}
            brokerValues={brokerValues}
            onBrokerFieldChange={setBrokerFieldValue}
            editing={editingField}
            inputRef={inputRef}
            brokerSyncing={isBrokerSyncing}
            brokerSyncError={brokerSyncError}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions hint={portfolioSub === "positions" && desktop ? tf("Later: {shortcut}, then AP.", { shortcut: commandBarShortcut }) : undefined}>
          {portfolioSub === "positions" ? (
            <>
              {brokerOptions.length > 0 && positionCount > 0 ? (
                <OnboardingButton label="Connect a broker" variant="ghost" shortcut={CONNECT_BROKER_KEY} onPress={openBrokerConnect} />
              ) : null}
              <OnboardingButton
                label="Continue"
                variant="primary"
                disabled={positionCount === 0 || positions.submitting}
                onPress={continueFromPositions}
              />
            </>
          ) : (
            <>
              <OnboardingButton label="Back" variant="ghost" disabled={isBrokerCommitting} onPress={backPortfolio} />
              {!desktop || portfolioSub !== "choose" ? (
                <OnboardingButton
                  label={portfolioSub === "broker-sync" ? (isBrokerSyncing ? t("Importing...") : t("Retry")) : t("Continue")}
                  variant="primary"
                  disabled={isBrokerSyncing}
                  onPress={continuePortfolio}
                />
              ) : null}
            </>
          )}
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "account") {
    const accountActionLabel = account.accountSub === "signed-in"
      ? t("See Pro plans")
      : account.accountSub === "login"
        ? t("Log in")
        : t("Continue");
    const accountTitle = account.accountSub === "signup"
      ? t("Connect Gloom Cloud")
      : account.accountSub === "login"
        ? t("Log in")
        : account.accountSub === "qr"
          ? t("Continue in browser")
          : t("Connected");
    const accountDescription = account.accountSub === "qr"
      ? t("Open the sign-in link, or scan the code with your phone.")
      : account.accountSub === "signup"
        ? t("Gloom Cloud adds the data layer: quotes, news, filings and Ask Gloom, synced to every device. Free account.")
        : account.accountSub === "login"
          ? t("Enter the password for this account.")
          : t("Next: real-time Pro data.");
    const accountStatusRows = account.accountSubmitting || account.accountValidationError || account.accountSubmitError
      ? 1
      : 0;
    // The QR grid is the tallest thing this wizard ever shows; DeviceSignInPanel
    // degrades to the code plus URL when the terminal cannot give it these rows.
    const accountModalHeight = account.accountSub === "qr"
      ? 32
      : account.accountSub === "signed-in"
        ? 12
        : 17 + (account.accountFieldIdx > 0 ? 2 : 0) + accountStatusRows;
    const browserSignIn = account.accountSub === "signup" || account.accountSub === "login";
    // OnboardingModal clamps the card to the viewport, so the panel has to size
    // off the clamped height or the QR overflows a short terminal.
    const accountPanelHeight = Math.max(4, Math.min(accountModalHeight, viewportHeight - 2) - 9);
    return (
      <OnboardingModal
        width={68}
        height={accountModalHeight}
      >
        <OnboardingHeader
          active="cloud"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissShortcut={SKIP_SETUP_KEY}
          dismissing={isFinishing}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("GLOOM CLOUD")}
          title={accountTitle}
          description={accountDescription}
        />
        <Box minHeight={0}>
          <AccountStep
            sub={account.accountSub}
            email={account.accountEmail}
            password={account.accountPassword}
            fieldIdx={account.accountFieldIdx}
            editing={editingField}
            inputRef={inputRef}
            submitting={account.accountSubmitting}
            submitError={account.accountSubmitError}
            validationError={account.accountValidationError}
            outcome={account.accountOutcome}
            onEmailChange={account.setAccountEmail}
            onPasswordChange={account.setAccountPassword}
            onFieldFocus={account.focusAccountField}
            onQrApproved={account.completeQrSignIn}
            height={accountPanelHeight}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        {!desktop && browserSignIn ? (
          <Box height={1}>
            <Text fg={colors.textMuted}>{t("b: sign in with the browser instead")}</Text>
          </Box>
        ) : null}
        <OnboardingActions
          hint={desktop && browserSignIn ? (
            <Button label="Sign in with the browser instead" variant="plain" compact shortcut={BROWSER_SIGN_IN_KEY} onPress={account.beginQrSignIn} />
          ) : undefined}
        >
          <OnboardingButton
            label="Back"
            variant="ghost"
            onPress={account.accountSub === "qr" || account.accountSub === "login" ? account.returnToAccountForm : () => goToSection("portfolio")}
          />
          {account.accountSub !== "qr" ? (
            <OnboardingButton
              label={accountActionLabel}
              variant="primary"
              disabled={account.accountSubmitting}
              onPress={continueAccount}
            />
          ) : null}
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "upgrade") {
    const primaryLabel = planAccess.hasProAccess ? t("Continue with Pro") : t("Start 7-day free trial");
    const price = formatCloudPrice(pricing, billingInterval);
    const monthsFree = monthsFreeYearly(pricing);
    const yearlyLabel = monthsFree > 0 ? tf("Yearly, {months} months free", { months: monthsFree }) : t("Yearly");
    const priceNote = [price.note, billingInterval === "year" && monthsFree > 0 ? tf("{months} months free", { months: monthsFree }) : null]
      .filter((part): part is string => !!part)
      .join(" \u00b7 ");
    return (
      <OnboardingModal width={70} height={28}>
        <OnboardingHeader
          active="pro"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={skipSetup}
          dismissing={isFinishing}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("GLOOM CLOUD PRO")}
          title={planAccess.hasProAccess ? t("Pro is active") : price.price}
          titlePrefix={!planAccess.hasProAccess && price.anchor ? (
            <Text fg={colors.textMuted} attributes={TextAttributes.STRIKETHROUGH}>
              {price.anchor}
            </Text>
          ) : undefined}
          titleSuffix={!planAccess.hasProAccess && priceNote ? priceNote : undefined}
          description={planAccess.hasProAccess
            ? t("This account already has real-time Cloud data.")
            : t("7 days free. Card required. Cancel anytime.")}
        />
        {!planAccess.hasProAccess ? (
          <Box flexDirection="row" style={desktop ? { marginTop: 12 } : undefined} paddingTop={desktop ? undefined : 1}>
            <SegmentedControl
              options={[
                { label: t("Monthly"), value: "month" },
                { label: yearlyLabel, value: "year" },
              ]}
              value={billingInterval}
              onChange={(value) => setBillingInterval(value === "year" ? "year" : "month")}
              // The card's Left and Right move it on both hosts.
              focused
            />
          </Box>
        ) : null}
        {/* Ranked: the data itself first, then what reads it. */}
        <Box flexDirection="column" style={desktop ? { marginTop: ONBOARDING_DESKTOP.afterHeader, gap: 10 } : undefined}>
          <OnboardingFeature
            title={t("Real-time market data")}
            description={t("Free is 15 minutes behind on quotes and 12 hours on news.")}
          />
          <OnboardingFeature
            title={t("MCP server")}
            description={t("Claude Code, Codex or Cursor call Gloom's research tools.")}
          />
          <OnboardingFeature
            title={t("Ask Gloom")}
            description={t("Answers cite filings, calls and news.")}
          />
          <OnboardingFeature
            title={t("Earnings calls")}
            description={t("Transcripts, summaries, guidance and scores.")}
          />
          <OnboardingFeature
            title={t("Equity Diagnostic")}
            description={t("Full report: red and green flags with evidence.")}
          />
          <OnboardingFeature
            title={t("Search, theses and flow")}
            description={t("Instant search with alerts, thesis monitoring, options flow, hiring and compensation data.")}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions>
          {!planAccess.hasProAccess ? (
            <OnboardingButton
              label="Keep Free for now"
              variant="secondary"
              shortcut={KEEP_FREE_KEY}
              onPress={continueFree}
            />
          ) : null}
          <OnboardingButton
            label={primaryLabel}
            variant="primary"
            onPress={primaryUpgradeAction}
          />
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  const readyDescription = progress.tickerSymbol
    ? tf("{ticker} is open. {shortcut}, then AP, adds more.", {
      ticker: progress.tickerSymbol,
      shortcut: commandBarShortcut,
    })
    : t("Your local workspace is ready. You can connect Cloud or add a portfolio later.");

  return (
    <OnboardingModal width={66} height={12}>
      <OnboardingHeader
        active={progress.accountStatus === "signed-in" ? "pro" : "cloud"}
        available={sectionAvailability}
        onNavigate={goToSection}
        onDismiss={skipSetup}
        dismissing={isFinishing}
        showDismiss={false}
      />
      <OnboardingTitle
        step={desktop ? undefined : t("READY")}
        title={t("Your workspace is ready")}
        description={readyDescription}
      />
      {persistenceError ? (
        <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
          {persistenceError}
        </Text>
      ) : null}
      <OnboardingActions>
        <OnboardingButton
          label="Back"
          variant="ghost"
          onPress={() => goToSection(progress.accountStatus === "signed-in" ? "pro" : "cloud")}
        />
        <OnboardingButton
          label={isFinishing ? "Opening workspace..." : "Start exploring"}
          variant="primary"
          disabled={isFinishing}
          onPress={() => { void finish(); }}
        />
      </OnboardingActions>
    </OnboardingModal>
  );
}
