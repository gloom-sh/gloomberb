import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { recordResearchActivity, type ResearchActivity } from "../../api-client/research-activity";
import { apiClient, type CloudPricing } from "../../api-client";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import {
  type AppConfig,
  findPaneInstance,
  type OnboardingProgress,
  type OnboardingStage,
} from "../../types/config";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import { useShortcut, useViewport } from "../../react/input";
import {
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import { useAppActive } from "../../state/app/activity";
import { Box, Text, TextAttributes, useCommandBarShortcut, useUiHost, type InputRenderable } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import type { PluginRegistry } from "../../plugins/registry";
import { chatController } from "../../plugins/builtin/chat/controller";
import { formatCloudMonthlyPrice } from "../../plugins/builtin/account-management/model";
import { useCloudUpgradeAction } from "../../plugins/builtin/shared/cloud-upgrade";
import { usePlanAccess } from "../../plugins/builtin/shared/plan-access";
import { Button, type ListViewItem } from "../ui";
import { AccountStep, PortfolioStep, type PortfolioSub } from "./onboarding-steps";
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

export function OnboardingWizard({ pluginRegistry, importBrokerPositions, onComplete }: OnboardingWizardProps) {
  const language = useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const commandBarShortcut = useCommandBarShortcut();
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

  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("positions");
  const [portfolioOptionIdx, setPortfolioOptionIdx] = useState(0);
  const [brokerValues, setBrokerValues] = useState<Record<string, Record<string, string>>>({});
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const [brokerFieldIdx, setBrokerFieldIdx] = useState(0);
  const [brokerSelectIdx, setBrokerSelectIdx] = useState(0);
  const [editingField, setEditingField] = useState(false);
  const inputRef = useRef<InputRenderable>(null);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finishingRef = useRef(false);

  // Enter inside every form is handled once, by the shortcut below: the
  // fields deliberately get no onSubmit, because the host input fires it in
  // the same keystroke and the two paths used to submit twice.
  const brokerOptions = useMemo(
    (): BrokerOption[] => getConnectableBrokerOptions(pluginRegistry.brokers),
    [pluginRegistry.brokers],
  );
  const brokerChoices = useMemo<ListViewItem[]>(() => brokerOptions.map((broker) => ({
    id: broker.id,
    label: tf("Connect {broker}", { broker: broker.name }),
    description: tf("Import positions from {broker}", { broker: broker.name }),
  })), [brokerOptions, language]);
  const activeBrokerFields = useMemo((): BrokerConfigField[] => {
    if (!selectedBrokerId) return [];
    const broker = brokerOptions.find((option) => option.id === selectedBrokerId);
    return broker
      ? resolveBrokerConfigFields(broker.adapter, brokerValues[selectedBrokerId] ?? {}).filter((field) => field.required)
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
    for (const metadata of planFirstRunWatchlist(stateRef.current.tickers, watchlistId)) {
      try {
        const ticker = await pluginRegistry.tickerRepository.createTicker(metadata);
        dispatch({ type: "UPDATE_TICKER", ticker });
        pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
      } catch (error) {
        onboardingLog.error("First-run watchlist seed failed", { symbol: metadata.ticker, error: String(error) });
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
  } = useOnboardingBrokerSync({
    config,
    brokerOptions,
    brokerValues,
    selectedBrokerId,
    importBrokerPositions,
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
    setPortfolioSub("broker-fields");
    const broker = brokerOptions.find((option) => option.id === brokerId);
    const firstField = broker
      ? resolveBrokerConfigFields(broker.adapter, brokerValues[brokerId] ?? {}).filter((field) => field.required)[0]
      : null;
    setEditingField(firstField?.type !== "select");
  }, [brokerOptions, brokerValues, resetBrokerSync]);

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
      const broker = brokerOptions.find((entry) => entry.id === selectedBrokerId);
      const nextFields = broker
        ? resolveBrokerConfigFields(broker.adapter, nextValues).filter((entry) => entry.required)
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
    }).then(() => openUpgrade()).catch(() => {});
  }, [openUpgrade, persistProgress, progress.accountStatus]);

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

  useShortcut((event) => {
    if (helpFocused) return;
    const name = event.name ?? event.key ?? "";
    const enter = name === "enter" || name === "return";
    const escape = name === "escape" || name === "backspace";
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (name === "f10") {
      consume();
      if (stage === "portfolio") return;
      if (!isBrokerCommitting) {
        if (stage === "upgrade" && !planAccess.hasProAccess) continueFree();
        else void finish(true);
      }
      return;
    }

    if (stage === "portfolio" && portfolioSub === "positions") {
      if (editingField) {
        if (enter) {
          consume();
          positions.submitField();
        } else if (name === "tab") {
          consume();
          positions.setFieldIdx((index) => (
            event.shift ? Math.max(0, index - 1) : Math.min(POSITION_FIELDS.length - 1, index + 1)
          ));
        } else if (name === "escape") {
          consume();
          setEditingField(false);
        }
        return;
      }
      if (enter) {
        consume();
        if (positionCount > 0) continueFromPositions();
        else positions.focusField(0);
      } else if (name === "a") {
        consume();
        positions.focusField(0);
      } else if (name === "b" && positionCount > 0) {
        consume();
        openBrokerConnect();
      }
      return;
    }

    if (editingField) {
      if (enter) {
        consume();
        if (stage === "portfolio") submitBrokerField();
        else if (stage === "account") submitAccountField();
      } else if (name === "escape") {
        consume();
        setEditingField(false);
        if (stage === "portfolio") backPortfolio();
      }
      return;
    }

    if (stage === "portfolio") {
      if (enter) {
        consume();
        continuePortfolio();
      } else if (escape) {
        consume();
        backPortfolio();
      } else if (name === "up" || name === "k") {
        consume();
        if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.max(0, index - 1));
        else if (activeBrokerFields[brokerFieldIdx]?.type === "select") setBrokerSelectIdx((index) => Math.max(0, index - 1));
      } else if (name === "down" || name === "j") {
        consume();
        if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.min(brokerChoices.length - 1, index + 1));
        else if (activeBrokerFields[brokerFieldIdx]?.type === "select") {
          const optionCount = activeBrokerFields[brokerFieldIdx]?.options?.length ?? 0;
          setBrokerSelectIdx((index) => Math.min(Math.max(0, optionCount - 1), index + 1));
        }
      }
      return;
    }
    if (stage === "research" && enter) {
      consume();
      saveProgressInBackground({ stage: "account" });
      return;
    }
    if (stage === "account") {
      if (enter) {
        consume();
        continueAccount();
      } else if (escape) {
        consume();
        if (account.accountSub === "qr" || account.accountSub === "login") account.returnToAccountForm();
        else goToSection("portfolio");
      } else if (name === "b" && account.accountSub !== "qr" && account.accountSub !== "signed-in") {
        consume();
        account.beginQrSignIn();
      }
      return;
    }
    if (stage === "upgrade") {
      if (enter) {
        consume();
        primaryUpgradeAction();
      } else if (escape) {
        consume();
        goToSection("cloud");
      }
      return;
    }
    if (stage === "ready") {
      if (enter) {
        consume();
        void finish();
      } else if (escape) {
        consume();
        goToSection(progress.accountStatus === "signed-in" ? "pro" : "cloud");
      }
    }
  }, { phase: "before", allowEditable: true });

  if (helpFocused) {
    return null;
  }

  if (stage === "research") {
    const ticker = progress.tickerSymbol ?? t("your company");
    return <OnboardingCoach step={t("YOUR WORKSPACE")}
      title={tf("Built around {ticker}", { ticker })}
      actions={<><OnboardingButton label="Keep exploring" variant="ghost" onPress={() => { void finish(); }} />
        <OnboardingButton label="Connect free Cloud" variant="primary" onPress={() => saveProgressInBackground({ stage: "account" })} /></>}>
      <Text fg={colors.textDim} wrapText>{tf("Your holdings as a heatmap, a watchlist, and {ticker} charted. Every pane moves; {shortcut} adds more.", {
        ticker,
        shortcut: commandBarShortcut,
      })}</Text>
    </OnboardingCoach>;
  }

  if (stage === "portfolio") {
    const selectedBrokerName = selectedBrokerId
      ? brokerOptions.find((option) => option.id === selectedBrokerId)?.name
      : null;
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
    const description = portfolioSub === "positions"
      ? undefined
      : portfolioSub === "choose"
        ? t("Credentials stay on this device.")
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
                <OnboardingButton label="Connect a broker" variant="ghost" onPress={openBrokerConnect} />
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
            <Button label="Sign in with the browser instead" variant="plain" compact onPress={account.beginQrSignIn} />
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
    const monthlyPrice = formatCloudMonthlyPrice(pricing);
    const ticker = progress.tickerSymbol;
    return (
      <OnboardingModal width={70} height={26}>
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
          title={planAccess.hasProAccess ? t("Pro is active") : monthlyPrice.price}
          titlePrefix={!planAccess.hasProAccess && monthlyPrice.anchor ? (
            <Text fg={colors.textMuted} attributes={TextAttributes.STRIKETHROUGH}>
              {monthlyPrice.anchor}
            </Text>
          ) : undefined}
          titleSuffix={!planAccess.hasProAccess && monthlyPrice.note ? monthlyPrice.note : undefined}
          description={planAccess.hasProAccess
            ? t("This account already has real-time Cloud data.")
            : t("7 days free. Card required. Cancel anytime.")}
        />
        {/* Ranked by what a new account asks for first. */}
        <Box flexDirection="column" style={desktop ? { marginTop: ONBOARDING_DESKTOP.afterHeader, gap: 10 } : undefined}>
          <OnboardingFeature
            title={t("MCP server")}
            description={t("Claude Code, Codex or Cursor call Gloom's research tools.")}
          />
          <OnboardingFeature
            title={t("Ask Gloom")}
            description={t("Answers cite filings, calls and news.")}
          />
          <OnboardingFeature
            title={ticker ? tf("Real-time {ticker}, options, news wire, X", { ticker }) : t("Real-time quotes, options, news wire, X")}
            description={t("Free is 15 minutes behind on quotes and 12 hours on news.")}
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
              shortcut={desktop ? undefined : "F10"}
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
