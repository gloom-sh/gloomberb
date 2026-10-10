import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { buildBrokerDirectory } from "../../brokers/directory";
import { getSignedInBrokers, refreshSignedInBrokers, subscribeSignedInBrokers } from "../../brokers/signed-in/catalog";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import type { useRendererHost } from "../../ui";
import { tf } from "../../i18n";
import type { useAppLanguage } from "../../i18n/react";
import type { PluginRegistry } from "../../plugins/registry";
import type { ListViewItem } from "../ui";
import type { PortfolioSub } from "./onboarding-steps";
import { brokerSetupGuideUrl } from "./portfolio-step/broker-setup-panel";
import type { useOnboardingBrokerSync } from "./wizard-broker-sync";
import { getConnectableBrokerOptions, type BrokerOption } from "./wizard-model";

export function useOnboardingBrokerFields({
  pluginRegistry, language,
}: {
  pluginRegistry: PluginRegistry;
  language: ReturnType<typeof useAppLanguage>;
}) {
  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>("positions");
  const [portfolioOptionIdx, setPortfolioOptionIdx] = useState(0);
  const [brokerValues, setBrokerValues] = useState<Record<string, Record<string, string>>>({});
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const [brokerFieldIdx, setBrokerFieldIdx] = useState(0);
  const [brokerSelectIdx, setBrokerSelectIdx] = useState(0);

  useEffect(() => {
    if (pluginRegistry.brokers.has(SIGNED_IN_BROKER_TYPE)) void refreshSignedInBrokers();
  }, [pluginRegistry.brokers]);
  const signedInBrokers = useSyncExternalStore(subscribeSignedInBrokers, getSignedInBrokers, getSignedInBrokers);
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

  return {
    portfolioSub, setPortfolioSub, portfolioOptionIdx, setPortfolioOptionIdx, brokerValues, setBrokerValues,
    selectedBrokerId, setSelectedBrokerId, brokerFieldIdx, setBrokerFieldIdx, brokerSelectIdx,
    setBrokerSelectIdx, brokerOptions, brokerChoices, activeBrokerFields,
  };
}

export function useOnboardingBrokerForm({
  selectedBrokerId, activeBrokerFields, brokerFieldIdx, brokerValues, setBrokerSelectIdx, resetBrokerSync,
  setBrokerValues, setSelectedBrokerId, setBrokerFieldIdx, brokerOptions, setEditingField,
  connectSignedInBroker, setPortfolioSub, portfolioOptionIdx, brokerChoices, setPortfolioOptionIdx,
  isBrokerSyncing, syncSelectedBroker, brokerSelectIdx, portfolioSub, continueFromPositions, brokerSyncError,
  rendererHost,
}: {
  selectedBrokerId: string | null;
  activeBrokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  brokerValues: Record<string, Record<string, string>>;
  setBrokerSelectIdx: Dispatch<SetStateAction<number>>;
  resetBrokerSync: () => boolean;
  setBrokerValues: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
  setSelectedBrokerId: Dispatch<SetStateAction<string | null>>;
  setBrokerFieldIdx: Dispatch<SetStateAction<number>>;
  brokerOptions: BrokerOption[];
  setEditingField: Dispatch<SetStateAction<boolean>>;
  connectSignedInBroker: ReturnType<typeof useOnboardingBrokerSync>["connectSignedInBroker"];
  setPortfolioSub: Dispatch<SetStateAction<PortfolioSub>>;
  portfolioOptionIdx: number;
  brokerChoices: ListViewItem[];
  setPortfolioOptionIdx: Dispatch<SetStateAction<number>>;
  isBrokerSyncing: boolean;
  syncSelectedBroker: (brokerValueOverrides?: Record<string, string> | undefined) => Promise<void>;
  brokerSelectIdx: number;
  portfolioSub: PortfolioSub;
  continueFromPositions: () => void;
  brokerSyncError: string | null;
  rendererHost: ReturnType<typeof useRendererHost>;
}) {
  useEffect(() => {
    if (!selectedBrokerId) return;
    const field = activeBrokerFields[brokerFieldIdx];
    if (!field || field.type !== "select") return;
    const currentValue = brokerValues[selectedBrokerId]?.[field.key] ?? field.options?.[0]?.value ?? "";
    const index = Math.max(0, field.options?.findIndex((option) => option.value === currentValue) ?? 0);
    setBrokerSelectIdx(index);
  }, [activeBrokerFields, brokerFieldIdx, brokerValues, selectedBrokerId]);

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

  const openBrokerGuide = useCallback(() => {
    const url = selectedBrokerId ? brokerSetupGuideUrl(selectedBrokerId, brokerValues) : null;
    if (url) void rendererHost.openExternal(url).catch(() => {});
  }, [brokerValues, rendererHost, selectedBrokerId]);

  return {
    setBrokerFieldValue, chooseBroker, openBrokerConnect, submitBrokerField, continuePortfolio,
    backPortfolio, openBrokerGuide,
  };
}
