import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiClient } from "../../api-client";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import {
  type AppConfig,
  findPaneInstance,
  type OnboardingProgress,
} from "../../types/config";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import { useShortcut, useViewport } from "../../react/input";
import {
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import { useAppActive } from "../../state/app/activity";
import { Box, Text, TextAttributes, useUiHost, type InputRenderable } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import type { PluginRegistry } from "../../plugins/registry";
import { chatController } from "../../plugins/builtin/chat/controller";
import { useCloudUpgradeAction } from "../../plugins/builtin/shared/cloud-upgrade";
import { usePlanAccess } from "../../plugins/builtin/shared/plan-access";
import type { ListViewItem } from "../ui";
import { AccountStep, PortfolioStep, type PortfolioSub } from "./onboarding-steps";
import {
  OnboardingActions,
  OnboardingButton,
  OnboardingCoach,
  OnboardingFeature,
  OnboardingHeader,
  OnboardingModal,
  OnboardingTitle,
  type OnboardingSectionId,
} from "./onboarding-frame";
import { ACCOUNT_CHOICE_IDS } from "./account-step/model";
import { useOnboardingAccount } from "./wizard-account";
import { useOnboardingBrokerSync } from "./wizard-broker-sync";
import {
  getConnectableBrokerOptions,
  getOnboardingProgress,
  withOnboardingProgress,
  type BrokerOption,
} from "./wizard-model";

interface OnboardingWizardProps {
  pluginRegistry: PluginRegistry;
  importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"];
  onComplete: (config: AppConfig) => void | Promise<void>;
}

export function OnboardingWizard({ pluginRegistry, importBrokerPositions, onComplete }: OnboardingWizardProps) {
  const language = useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const { height: viewportHeight } = useViewport();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const config = useAppSelector((state) => state.config);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const progress = getOnboardingProgress(config);
  const stage = progress.stage;
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);

  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("choose");
  const [portfolioOptionIdx, setPortfolioOptionIdx] = useState(0);
  const [brokerValues, setBrokerValues] = useState<Record<string, Record<string, string>>>({});
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const [brokerFieldIdx, setBrokerFieldIdx] = useState(0);
  const [brokerSelectIdx, setBrokerSelectIdx] = useState(0);
  const [editingField, setEditingField] = useState(false);
  const inputRef = useRef<InputRenderable>(null);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const finishingRef = useRef(false);

  const brokerOptions = useMemo(
    (): BrokerOption[] => getConnectableBrokerOptions(pluginRegistry.brokers),
    [pluginRegistry.brokers],
  );
  const portfolioChoices = useMemo<ListViewItem[]>(() => [
    {
      id: "manual",
      label: t("Create a manual portfolio"),
      description: t("Add one company with the command bar"),
      detail: t("Recommended"),
    },
    ...brokerOptions.map((broker) => ({
      id: broker.id,
      label: tf("Connect {broker}", { broker: broker.name }),
      description: tf("Import positions from {broker}", { broker: broker.name }),
    })),
  ], [brokerOptions, language]);
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

  const account = useOnboardingAccount({
    nextStep: () => {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    },
    setEditingField,
  });

  const handleBrokerSynced = useCallback(async (
    result: SyncBrokerInstanceResult,
    syncedConfig: AppConfig,
  ) => {
    if (finishingRef.current) return;
    const tickerSymbol = result.positions.find((position) => position.ticker)?.ticker
      ?? result.addedTickers[0]?.metadata.ticker
      ?? result.updatedTickers[0]?.metadata.ticker;
    const brokerName = brokerOptions.find((option) => option.id === selectedBrokerId)?.name;
    const nextConfig = withOnboardingProgress(syncedConfig, {
      stage: tickerSymbol ? "account" : "add-ticker",
      path: "broker",
      portfolioId: tickerSymbol ? (result.portfolioIds[0] ?? "main") : "main",
      tickerSymbol,
      brokerName,
      positionsImported: result.positions.length,
    });
    await saveConfigImmediately(nextConfig);
    dispatch({ type: "SET_CONFIG", config: nextConfig });
    dispatch({ type: "SET_TICKERS", tickers: result.tickers });
    pluginRegistry.events.emit("config:changed", { config: nextConfig });
    setEditingField(false);
    setPortfolioSub("choose");
  }, [brokerOptions, dispatch, pluginRegistry.events, selectedBrokerId]);

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

  const finish = useCallback(async () => {
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
      await Promise.resolve(onComplete(nextConfig));
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : String(error));
      finishingRef.current = false;
      setIsFinishing(false);
    }
  }, [dispatch, onComplete, resetBrokerSync, stateRef]);

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
  }, [account.accountFieldIdx, account.accountSub, brokerFieldIdx, editingField, portfolioSub]);

  useEffect(() => {
    if (stage !== "account") return;
    account.syncExistingAccountSession();
  }, [account.syncExistingAccountSession, stage]);

  useEffect(() => pluginRegistry.events.on(
    "command-bar:portfolio-membership-persisted",
    ({ symbol, portfolioId }) => {
      const current = getOnboardingProgress(stateRef.current.config);
      if (current.stage !== "add-ticker" || portfolioId !== current.portfolioId) return;
      saveProgressInBackground({
        stage: "account",
        path: current.path,
        portfolioId,
        tickerSymbol: symbol,
      });
    },
  ), [pluginRegistry.events, saveProgressInBackground, stateRef]);

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

  const choosePortfolioPath = useCallback((choiceIndex = portfolioOptionIdx) => {
    const choice = portfolioChoices[choiceIndex];
    if (!choice || choice.id === "manual") {
      resetBrokerSync();
      setSelectedBrokerId(null);
      saveProgressInBackground({
        stage: "add-ticker",
        path: "manual",
        portfolioId: config.portfolios.find((portfolio) => !portfolio.brokerInstanceId)?.id ?? "main",
      });
      return;
    }

    resetBrokerSync();
    setSelectedBrokerId(choice.id);
    setBrokerFieldIdx(0);
    setPortfolioSub("broker-fields");
    const broker = brokerOptions.find((option) => option.id === choice.id);
    const firstField = broker
      ? resolveBrokerConfigFields(broker.adapter, brokerValues[choice.id] ?? {}).filter((field) => field.required)[0]
      : null;
    setEditingField(firstField?.type !== "select");
  }, [
    brokerOptions,
    brokerValues,
    config.portfolios,
    portfolioChoices,
    portfolioOptionIdx,
    resetBrokerSync,
    saveProgressInBackground,
  ]);

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
    if (portfolioSub === "choose") {
      choosePortfolioPath();
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
    choosePortfolioPath,
    isBrokerSyncing,
    portfolioSub,
    submitBrokerField,
    syncSelectedBroker,
  ]);

  const backPortfolio = useCallback(() => {
    if (portfolioSub === "choose") return;
    if (portfolioSub === "broker-sync" && !resetBrokerSync()) return;
    setPortfolioSub("choose");
    setBrokerFieldIdx(0);
    setEditingField(false);
  }, [portfolioSub, resetBrokerSync]);

  const activateAccountChoice = useCallback((index: number) => {
    const choice = ACCOUNT_CHOICE_IDS[index];
    if (!choice || choice === "skip") {
      saveProgressInBackground({ stage: "ready", accountStatus: "skipped" });
      return;
    }
    if (choice === "qr") {
      account.beginQrSignIn();
      return;
    }
    account.beginAccountMode(choice);
  }, [account.beginAccountMode, account.beginQrSignIn, saveProgressInBackground]);

  const submitAccountField = useCallback(() => {
    setEditingField(false);
    account.submitAccountField();
  }, [account.submitAccountField]);

  const continueAccount = useCallback(() => {
    if (account.accountSub === "choose") {
      activateAccountChoice(account.accountChoiceIdx);
      return;
    }
    // The QR panel owns enter (retry after a denial); approval advances itself.
    if (account.accountSub === "qr") return;
    if (account.accountSub === "signed-in") {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
      return;
    }
    if (account.accountSubmitError?.kind === "switch-to-login") {
      account.switchToAccountLogin();
      return;
    }
    submitAccountField();
  }, [
    account.accountChoiceIdx,
    account.accountSub,
    account.accountSubmitError?.kind,
    account.switchToAccountLogin,
    activateAccountChoice,
    saveProgressInBackground,
    submitAccountField,
  ]);

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
      account.returnToAccountChooser();
      setPortfolioSub("choose");
      saveProgressInBackground({ stage: "portfolio" });
      return;
    }
    if (section === "cloud") {
      account.returnToAccountChooser();
      saveProgressInBackground({ stage: "account" });
      return;
    }
    if (planAccess.signedIn) {
      saveProgressInBackground({ stage: "upgrade", accountStatus: "signed-in" });
    }
  }, [account.returnToAccountChooser, isBrokerCommitting, planAccess.signedIn, saveProgressInBackground]);

  const sectionAvailability: Partial<Record<OnboardingSectionId, boolean>> = {
    portfolio: !isBrokerCommitting && stage !== "welcome",
    cloud: !isBrokerCommitting && (stage === "account" || stage === "upgrade" || stage === "ready" || !!progress.tickerSymbol),
    pro: !isBrokerCommitting && planAccess.signedIn && (
      stage === "upgrade"
      || stage === "ready"
      || progress.accountStatus === "signed-in"
    ),
  };

  useShortcut((event) => {
    if (helpFocused || commandBarOpen) return;
    const name = event.name ?? event.key ?? "";
    const enter = name === "enter" || name === "return";
    const escape = name === "escape" || name === "backspace";
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (name === "f10") {
      consume();
      if (stage === "portfolio" || stage === "add-ticker") return;
      if (!isBrokerCommitting) {
        if (stage === "upgrade" && !planAccess.hasProAccess) continueFree();
        else void finish();
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
        if (stage === "account") account.returnToAccountChooser();
        else if (stage === "portfolio") setPortfolioSub("choose");
      }
      return;
    }

    if (stage === "welcome") {
      if (enter) {
        consume();
        saveProgressInBackground({ stage: "portfolio" });
      } else if (name === "escape") {
        consume();
        void finish();
      }
      return;
    }
    if (stage === "add-ticker") {
      if (name === "escape" || name === "backspace") {
        consume();
        goToSection("portfolio");
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
        if (portfolioSub === "choose") setPortfolioOptionIdx((index) => Math.min(portfolioChoices.length - 1, index + 1));
        else if (activeBrokerFields[brokerFieldIdx]?.type === "select") {
          const optionCount = activeBrokerFields[brokerFieldIdx]?.options?.length ?? 0;
          setBrokerSelectIdx((index) => Math.min(Math.max(0, optionCount - 1), index + 1));
        }
      }
      return;
    }
    if (stage === "account") {
      if (enter) {
        consume();
        continueAccount();
      } else if (escape) {
        consume();
        if (account.accountSub !== "choose") account.returnToAccountChooser();
        else goToSection("portfolio");
      } else if (account.accountSub === "choose" && (name === "up" || name === "k")) {
        consume();
        account.setAccountChoiceIdx((index) => Math.max(0, index - 1));
      } else if (account.accountSub === "choose" && (name === "down" || name === "j")) {
        consume();
        account.setAccountChoiceIdx((index) => Math.min(ACCOUNT_CHOICE_IDS.length - 1, index + 1));
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

  const portfolioActionLabel = portfolioSub === "broker-sync"
      ? (isBrokerSyncing ? t("Importing...") : t("Retry"))
      : t("Continue");

  if (helpFocused || (stage === "add-ticker" && commandBarOpen)) {
    return null;
  }

  if (stage === "add-ticker") {
    return (
      <OnboardingCoach
        step={t("PORTFOLIO SETUP")}
        title={t("Add one company you follow")}
        actions={(
          <>
            <OnboardingButton label="Back" variant="ghost" onPress={() => goToSection("portfolio")} />
            <OnboardingButton
              label="Open command bar"
              variant="primary"
              shortcut="AP"
              onPress={() => pluginRegistry.openCommandBar("AP ")}
            />
          </>
        )}
      >
        <Text fg={colors.textDim} wrapText>
          {t("Use AP in the real command bar and choose any ticker. Setup continues as soon as the company is saved to your portfolio.")}
        </Text>
      </OnboardingCoach>
    );
  }

  if (stage === "welcome") {
    return (
      <OnboardingModal width={64} height={12}>
        <OnboardingHeader
          onDismiss={() => { void finish(); }}
          dismissing={isFinishing}
        />
        <OnboardingTitle
          step={t("WELCOME")}
          title={t("Make Gloomberb yours")}
          description={t("Build a real portfolio in the workspace, add one company you follow, then choose whether to connect Gloom Cloud.")}
        />
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions>
          <OnboardingButton
            label="Start with my portfolio"
            variant="primary"
            onPress={() => saveProgressInBackground({ stage: "portfolio" })}
          />
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "portfolio") {
    const selectedBrokerName = selectedBrokerId
      ? brokerOptions.find((option) => option.id === selectedBrokerId)?.name
      : null;
    const portfolioModalHeight = portfolioSub === "choose"
      ? 18
      : portfolioSub === "broker-setup"
        ? 21
        : portfolioSub === "broker-sync"
          ? 14
          : 20;
    return (
      <OnboardingModal width={70} height={portfolioModalHeight}>
        <OnboardingHeader
          active="portfolio"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={() => { void finish(); }}
          dismissing={isFinishing}
          dismissDisabled={isBrokerCommitting}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("PORTFOLIO")}
          title={portfolioSub === "choose"
            ? t("How do you want to start?")
            : selectedBrokerName
              ? tf("Connect {broker}", { broker: selectedBrokerName })
              : t("Set up a portfolio")}
          description={portfolioSub === "choose"
            ? t("Create a manual portfolio and add one ticker, or import positions from a supported broker.")
            : t("Enter the connection details for this broker. Credentials stay on this device.")}
        />
        <Box minHeight={0}>
          <PortfolioStep
            sub={portfolioSub}
            choices={portfolioChoices}
            optionIdx={portfolioOptionIdx}
            onOptionSelect={setPortfolioOptionIdx}
            onOptionActivate={choosePortfolioPath}
            selectedBrokerId={selectedBrokerId}
            brokerFields={activeBrokerFields}
            brokerFieldIdx={brokerFieldIdx}
            brokerSelectIdx={brokerSelectIdx}
            onBrokerSelect={setBrokerSelectIdx}
            brokerValues={brokerValues}
            onBrokerFieldChange={setBrokerFieldValue}
            onSubmitBrokerField={submitBrokerField}
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
        <OnboardingActions>
          {portfolioSub !== "choose" ? (
            <OnboardingButton label="Back" variant="ghost" disabled={isBrokerCommitting} onPress={backPortfolio} />
          ) : null}
          {!desktop || portfolioSub !== "choose" ? (
            <OnboardingButton
              label={portfolioActionLabel}
              variant="primary"
              disabled={isBrokerSyncing}
              onPress={continuePortfolio}
            />
          ) : null}
        </OnboardingActions>
      </OnboardingModal>
    );
  }

  if (stage === "account") {
    const accountActionLabel = account.accountSub === "signed-in"
      ? t("See Pro plans")
      : account.accountSub === "login"
        ? t("Log in")
        : account.accountSub === "signup"
          ? (account.accountFieldIdx > 0 ? t("Sign up free") : t("Continue"))
          : t("Continue");
    const accountTitle = account.accountSub === "signup"
      ? t("Create your free account")
      : account.accountSub === "login"
        ? t("Log in")
        : account.accountSub === "qr"
          ? t("Scan with the Gloom app")
          : account.accountSub === "signed-in"
            ? t("Connected")
            : t("Sync across apps");
    const accountDescription = account.accountSub === "choose"
      ? t("Adds quotes, financials, options, research, news, chat and AI commands.")
      : account.accountSub === "qr"
        ? t("Open the Gloom app on your phone and approve this workspace.")
        : account.accountSub === "signup"
        ? t("Create the free account now. Cloud features unlock after you verify your email.")
        : account.accountSub === "login"
          ? t("Use the account that should own this workspace and its synced data.")
          : t("Your account is ready. Next, choose whether you want the real-time Pro data plan.");
    const accountStatusRows = account.accountSubmitting || account.accountValidationError || account.accountSubmitError
      ? 1
      : 0;
    const accountSwitchRows = account.accountSubmitError?.kind === "switch-to-login" ? 1 : 0;
    // The QR grid is the tallest thing this wizard ever shows; DeviceSignInPanel
    // degrades to the code plus URL when the terminal cannot give it these rows.
    const accountModalHeight = account.accountSub === "choose"
      ? 17
      : account.accountSub === "qr"
        ? 32
        : account.accountSub === "signed-in"
          ? 12
          : 16 + (account.accountFieldIdx > 0 ? 2 : 0) + accountStatusRows + accountSwitchRows;
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
          onDismiss={() => { void finish(); }}
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
            choiceIdx={account.accountChoiceIdx}
            onChoiceSelect={account.setAccountChoiceIdx}
            onChoiceActivate={activateAccountChoice}
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
            onSubmitField={submitAccountField}
            onQrApproved={account.completeQrSignIn}
            height={accountPanelHeight}
          />
        </Box>
        {persistenceError ? (
          <Text fg={colors.negative} wrapText style={desktop ? { marginTop: 10 } : undefined}>
            {persistenceError}
          </Text>
        ) : null}
        <OnboardingActions>
          <OnboardingButton
            label="Back"
            variant="ghost"
            onPress={account.accountSub === "choose" ? () => goToSection("portfolio") : account.returnToAccountChooser}
          />
          {account.accountSub !== "qr" && (!desktop || account.accountSub !== "choose") ? (
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
    return (
      <OnboardingModal width={66} height={17}>
        <OnboardingHeader
          active="pro"
          available={sectionAvailability}
          onNavigate={goToSection}
          onDismiss={() => { void finish(); }}
          dismissing={isFinishing}
          showDismiss={false}
        />
        <OnboardingTitle
          step={desktop ? undefined : t("GLOOM CLOUD PRO")}
          title={planAccess.hasProAccess ? t("Pro is active") : t("$29/mo for real-time market data")}
          titlePrefix={!planAccess.hasProAccess ? (
            <Text fg={colors.textMuted} attributes={TextAttributes.STRIKETHROUGH}>
              {t("$49/mo")}
            </Text>
          ) : undefined}
          description={planAccess.hasProAccess
            ? t("This account already has real-time Cloud data.")
            : t("Limited founding offer. Start a free 7-day trial.")}
        />
        <Box flexDirection="column" style={desktop ? { marginTop: 14, gap: 8 } : undefined}>
          <OnboardingFeature
            title={t("Worldwide equities and options")}
            description={t("Free: 15m delayed. Pro: real-time.")}
          />
          <OnboardingFeature
            title={t("News wire")}
            description={t("Free: 12h delayed. Pro: real-time.")}
          />
          <OnboardingFeature
            title={t("Pro research tools")}
            description={t("More tools for company, market and portfolio research.")}
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

  const readyDescription = progress.brokerName
    ? tf("Imported {count} positions from {broker}. Your workspace is ready to explore.", {
      count: progress.positionsImported ?? 0,
      broker: progress.brokerName,
    })
    : progress.tickerSymbol
      ? tf("{ticker} is in your portfolio, and its research is ready in the workspace.", {
        ticker: progress.tickerSymbol,
      })
      : t("Your local workspace is ready. You can connect Cloud or add a portfolio later.");

  return (
    <OnboardingModal width={66} height={12}>
      <OnboardingHeader
        active={progress.accountStatus === "signed-in" ? "pro" : "cloud"}
        available={sectionAvailability}
        onNavigate={goToSection}
        onDismiss={() => { void finish(); }}
        dismissing={isFinishing}
      />
      <OnboardingTitle
        step={t("READY")}
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
