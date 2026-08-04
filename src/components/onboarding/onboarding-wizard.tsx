import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type InputRenderable } from "../../ui";
import { useViewport } from "../../react/input";
import { colors, applyTheme } from "../../theme/colors";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { getThemeIds } from "../../theme/themes";
import type { AppConfig } from "../../types/config";
import type { PluginRegistry } from "../../plugins/registry";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import type { ListViewItem } from "../ui";
import {
  PortfolioStep,
  ReadyStep,
  ShortcutsStep,
  ThemeStep,
  WelcomeStep,
  type PortfolioSub,
} from "./onboarding-steps";
import { finishOnboarding, summarizeOnboardingError, useOnboardingBrokerSync } from "./wizard-broker-sync";
import { useOnboardingKeyboard } from "./wizard-keyboard";
import {
  getConnectableBrokerOptions,
  ONBOARDING_STEPS,
  type BrokerOption,
  type OnboardingStep,
} from "./wizard-model";

// Blank spacer + progress dots + hint line.
const FOOTER_ROWS = 3;

interface OnboardingWizardProps {
  config: AppConfig;
  pluginRegistry: PluginRegistry;
  onComplete: (config: AppConfig) => void | Promise<void>;
}

export function OnboardingWizard({ config, pluginRegistry, onComplete }: OnboardingWizardProps) {
  const language = useAppLanguage();
  const { width: termWidth, height: termHeight } = useViewport();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [themeIdx, setThemeIdx] = useState(0);
  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("choose");
  const [portfolioOptionIdx, setPortfolioOptionIdx] = useState(0);
  const portfolioName = "Main Portfolio";
  const [brokerValues, setBrokerValues] = useState<Record<string, Record<string, string>>>({});
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const [brokerFieldIdx, setBrokerFieldIdx] = useState(0);
  const [brokerSelectIdx, setBrokerSelectIdx] = useState(0);
  const [editingField, setEditingField] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const inputRef = useRef<InputRenderable>(null);
  const themeIds = getThemeIds();
  const stepIdx = ONBOARDING_STEPS.indexOf(step);

  const brokerOptions = useMemo(
    (): BrokerOption[] => getConnectableBrokerOptions(pluginRegistry.brokers),
    [pluginRegistry.brokers],
  );

  const portfolioChoices = useMemo<ListViewItem[]>(() => {
    const choices: ListViewItem[] = [
      { id: "manual", label: t("Create Manual Portfolio"), description: t("Add tickers and positions by hand") },
    ];
    for (const broker of brokerOptions) {
      choices.push({
        id: broker.id,
        label: `Connect ${broker.name}`,
        description: `Auto-import positions via ${broker.name}`,
      });
    }
    return choices;
  }, [brokerOptions, language]);

  const activeBrokerFields = useMemo((): BrokerConfigField[] => {
    if (!selectedBrokerId) return [];
    const broker = brokerOptions.find((option) => option.id === selectedBrokerId);
    return broker
      ? resolveBrokerConfigFields(broker.adapter, brokerValues[selectedBrokerId] ?? {}).filter((field) => field.required)
      : [];
  }, [selectedBrokerId, brokerOptions, brokerValues]);

  if (step === "theme") {
    applyTheme(themeIds[themeIdx]!);
  }

  useEffect(() => {
    if (!editingField) return;
    const focusTimer = setTimeout(() => inputRef.current?.focus?.(), 10);
    return () => clearTimeout(focusTimer);
  }, [editingField, portfolioSub, brokerFieldIdx]);

  useEffect(() => {
    if (!selectedBrokerId) return;
    const field = activeBrokerFields[brokerFieldIdx];
    if (!field || field.type !== "select") return;
    const currentValue = brokerValues[selectedBrokerId]?.[field.key] ?? field.options?.[0]?.value ?? "";
    const index = Math.max(0, field.options?.findIndex((option) => option.value === currentValue) ?? 0);
    setBrokerSelectIdx(index);
  }, [selectedBrokerId, brokerFieldIdx, activeBrokerFields, brokerValues]);

  useEffect(() => {
    if (step !== "ready" && finishError) {
      setFinishError(null);
    }
  }, [finishError, step]);

  const nextStep = useCallback(() => {
    const idx = ONBOARDING_STEPS.indexOf(step);
    if (idx < ONBOARDING_STEPS.length - 1) {
      setEditingField(false);
      setStep(ONBOARDING_STEPS[idx + 1]!);
    }
  }, [step]);

  const prevStep = useCallback(() => {
    const idx = ONBOARDING_STEPS.indexOf(step);
    if (idx > 0) {
      setStep(ONBOARDING_STEPS[idx - 1]!);
    }
  }, [step]);

  const {
    isBrokerSyncing,
    brokerSyncError,
    brokerSyncedConfig,
    brokerSyncSummary,
    resetBrokerSync,
    syncSelectedBroker,
  } = useOnboardingBrokerSync({
    config,
    brokerOptions,
    brokerValues,
    selectedBrokerId,
    pluginRegistry,
    nextStep,
    setEditingField,
    setPortfolioSub,
  });

  const finish = useCallback(() => {
    if (isFinishing) {
      return;
    }

    setFinishError(null);
    const selectedTheme = themeIds[themeIdx]!;
    applyTheme(selectedTheme);

    const isBroker = Boolean(selectedBrokerId && selectedBrokerId !== "manual");
    const baseConfig = isBroker ? brokerSyncedConfig : config;

    setIsFinishing(true);
    void finishOnboarding({
      config,
      baseConfig,
      isBroker,
      selectedTheme,
      portfolioName,
      onComplete,
    }).catch((error) => {
      setFinishError(summarizeOnboardingError(error));
      setIsFinishing(false);
    });
  }, [
    brokerSyncedConfig,
    config,
    isFinishing,
    onComplete,
    portfolioName,
    selectedBrokerId,
    themeIds,
    themeIdx,
  ]);

  const setBrokerFieldValue = useCallback((brokerId: string, key: string, value: string) => {
    resetBrokerSync();
    setBrokerValues((prev) => ({
      ...prev,
      [brokerId]: { ...prev[brokerId], [key]: value },
    }));
  }, [resetBrokerSync]);

  useOnboardingKeyboard({
    step,
    portfolioSub,
    setPortfolioSub,
    themeIds,
    setThemeIdx,
    portfolioChoices,
    portfolioOptionIdx,
    setPortfolioOptionIdx,
    brokerOptions,
    brokerValues,
    selectedBrokerId,
    setSelectedBrokerId,
    activeBrokerFields,
    brokerFieldIdx,
    setBrokerFieldIdx,
    brokerSelectIdx,
    setBrokerSelectIdx,
    editingField,
    setEditingField,
    isBrokerSyncing,
    brokerSyncError,
    isFinishing,
    nextStep,
    prevStep,
    finish,
    resetBrokerSync,
    setBrokerFieldValue,
    syncSelectedBroker,
  });

  const contentWidth = Math.min(60, termWidth - 4);
  const contentLeft = Math.floor((termWidth - contentWidth) / 2);
  // The footer is pinned to the last FOOTER_ROWS rows, so steps get whatever is left.
  const contentTop = Math.max(0, Math.min(Math.floor((termHeight - 24) / 2), termHeight - FOOTER_ROWS - 1));
  const contentHeight = Math.max(1, termHeight - contentTop - FOOTER_ROWS);
  const progressDots = ONBOARDING_STEPS.map((_, index) => {
    if (index < stepIdx) return "\u2501";
    if (index === stepIdx) return "\u25cf";
    return "\u00b7";
  }).join(" ");
  const connectedBrokerName = selectedBrokerId
    ? brokerOptions.find((broker) => broker.id === selectedBrokerId)?.name
    : null;

  let hintText = t("enter ->");
  if (step === "ready") {
    hintText = t("enter to launch");
  }
  if (step === "portfolio" && portfolioSub === "broker-sync") {
    hintText = isBrokerSyncing ? "syncing broker..." : "enter to retry";
  } else if (isFinishing) {
    hintText = t("launching...");
  }

  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      width={termWidth}
      height={termHeight}
      backgroundColor={colors.bg}
      zIndex={200}
    >
      <Box
        position="absolute"
        top={contentTop}
        left={contentLeft}
        width={contentWidth}
        height={contentHeight}
        flexDirection="column"
      >
        {step === "welcome" && <WelcomeStep />}
        {step === "theme" && (
          <ThemeStep
            themeIds={themeIds}
            selectedIdx={themeIdx}
            onSelect={setThemeIdx}
            height={contentHeight}
          />
        )}
        {step === "portfolio" && (
          <PortfolioStep
            sub={portfolioSub}
            choices={portfolioChoices}
            optionIdx={portfolioOptionIdx}
            onOptionSelect={setPortfolioOptionIdx}
            selectedBrokerId={selectedBrokerId}
            brokerFields={activeBrokerFields}
            brokerFieldIdx={brokerFieldIdx}
            brokerSelectIdx={brokerSelectIdx}
            brokerValues={brokerValues}
            onBrokerFieldChange={setBrokerFieldValue}
            editing={editingField}
            inputRef={inputRef}
            brokerSyncing={isBrokerSyncing}
            brokerSyncError={brokerSyncError}
          />
        )}
        {step === "shortcuts" && (
          <ShortcutsStep height={contentHeight} />
        )}
        {step === "ready" && (
          <ReadyStep
            brokerName={connectedBrokerName ?? null}
            portfolioName={portfolioName}
            brokerSyncSummary={brokerSyncSummary}
            isFinishing={isFinishing}
            error={finishError}
          />
        )}
      </Box>

      <Box
        position="absolute"
        top={termHeight - FOOTER_ROWS}
        left={contentLeft}
        width={contentWidth}
        flexDirection="column"
      >
        <Box height={1} />
        <Box height={1} flexDirection="row" width={contentWidth}>
          <Box flexGrow={1}>
            <Text fg={colors.textMuted}>{progressDots}</Text>
          </Box>
        </Box>
        <Box height={1} flexDirection="row" width={contentWidth}>
          <Box flexGrow={1} />
          <Box>
            <Text fg={colors.textMuted}>{hintText}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
