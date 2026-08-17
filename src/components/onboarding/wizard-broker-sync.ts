import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { buildBrokerProfileConfig, validateBrokerProfileValues } from "../../brokers/profile-form";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import type { AppConfig } from "../../types/config";
import { createBrokerInstanceId } from "../../utils/broker-instances";
import { debugLog } from "../../utils/debug-log";
import type { PortfolioSub } from "./onboarding-steps";
import type { BrokerOption } from "./wizard-model";

const onboardingLog = debugLog.createLogger("onboarding");

export function summarizeOnboardingError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Unable to connect the broker.";
}

function focusPortfolioListCollection(config: AppConfig, collectionId: string): AppConfig {
  const nextInstances = config.layout.instances.map((instance) => {
    if (instance.paneId !== "portfolio-list") {
      return instance;
    }

    const visibleCollectionIds = Array.isArray(instance.settings?.visibleCollectionIds)
      ? instance.settings.visibleCollectionIds.filter((value): value is string => typeof value === "string")
      : [];

    return {
      ...instance,
      params: {
        ...instance.params,
        collectionId,
      },
      settings: {
        ...instance.settings,
        visibleCollectionIds: [collectionId, ...visibleCollectionIds.filter((value) => value !== collectionId)],
      },
    };
  });

  return {
    ...config,
    layout: {
      ...config.layout,
      instances: nextInstances,
    },
  };
}

export function useOnboardingBrokerSync({
  config,
  brokerOptions,
  brokerValues,
  selectedBrokerId,
  importBrokerPositions,
  onSynced,
  setEditingField,
  setPortfolioSub,
}: {
  config: AppConfig;
  brokerOptions: BrokerOption[];
  brokerValues: Record<string, Record<string, string>>;
  selectedBrokerId: string | null;
  importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"];
  onSynced: (result: SyncBrokerInstanceResult, config: AppConfig) => void | Promise<void>;
  setEditingField: (editing: boolean) => void;
  setPortfolioSub: Dispatch<SetStateAction<PortfolioSub>>;
}) {
  const brokerSyncAttemptRef = useRef(0);
  const brokerSyncAbortRef = useRef<AbortController | null>(null);
  const brokerSyncCommitRef = useRef(false);
  const [isBrokerSyncing, setIsBrokerSyncing] = useState(false);
  const [isBrokerCommitting, setIsBrokerCommitting] = useState(false);
  const [brokerSyncError, setBrokerSyncError] = useState<string | null>(null);

  const resetBrokerSync = useCallback(() => {
    if (brokerSyncCommitRef.current) return false;
    brokerSyncAttemptRef.current += 1;
    brokerSyncAbortRef.current?.abort();
    brokerSyncAbortRef.current = null;
    setIsBrokerSyncing(false);
    setIsBrokerCommitting(false);
    setBrokerSyncError(null);
    return true;
  }, []);

  const buildDraftBrokerConfig = useCallback((brokerValueOverrides?: Record<string, string>) => {
    const selectedValues = selectedBrokerId ? (brokerValueOverrides ?? brokerValues[selectedBrokerId]) : null;
    if (!selectedBrokerId || selectedBrokerId === "manual" || !selectedValues) {
      throw new Error("Broker setup is incomplete.");
    }

    const brokerOption = brokerOptions.find((option) => option.id === selectedBrokerId);
    const adapter = brokerOption?.adapter;
    if (!adapter) throw new Error(`Unknown broker "${selectedBrokerId}".`);
    const validationError = validateBrokerProfileValues(adapter, selectedValues);
    if (validationError) throw new Error(validationError);

    const label = brokerOption?.name || selectedBrokerId;
    const brokerConfig = buildBrokerProfileConfig(adapter, selectedValues);
    const instanceId = createBrokerInstanceId(
      selectedBrokerId,
      label,
      config.brokerInstances.map((instance) => instance.id),
    );

    return {
      instanceId,
      config: {
        ...config,
        brokerInstances: [
          ...config.brokerInstances,
          {
            id: instanceId,
            brokerType: selectedBrokerId,
            label,
            connectionMode: typeof brokerConfig.connectionMode === "string" ? brokerConfig.connectionMode : undefined,
            config: brokerConfig,
            enabled: true,
          },
        ],
      } satisfies AppConfig,
    };
  }, [brokerOptions, brokerValues, config, selectedBrokerId]);

  const syncSelectedBroker = useCallback(async (brokerValueOverrides?: Record<string, string>) => {
    const attemptId = brokerSyncAttemptRef.current + 1;
    brokerSyncAttemptRef.current = attemptId;
    brokerSyncAbortRef.current?.abort();
    const abortController = new AbortController();
    brokerSyncAbortRef.current = abortController;
    brokerSyncCommitRef.current = false;
    setEditingField(false);
    setPortfolioSub("broker-sync");
    setIsBrokerSyncing(true);
    setIsBrokerCommitting(false);
    setBrokerSyncError(null);

    try {
      const { config: draftConfig, instanceId } = buildDraftBrokerConfig(brokerValueOverrides);
      onboardingLog.info("Syncing broker during onboarding", { instanceId, brokerId: selectedBrokerId });
      const result = await importBrokerPositions(instanceId, undefined, {
        config: draftConfig,
        persistResolvedBrokerConfig: true,
        signal: abortController.signal,
        onCommitStart: () => {
          if (brokerSyncAttemptRef.current !== attemptId) return;
          brokerSyncCommitRef.current = true;
          setIsBrokerCommitting(true);
        },
        onCommitEnd: () => {
          if (brokerSyncAttemptRef.current !== attemptId) return;
          // Keep navigation locked until the onboarding-specific config and
          // progress have also been persisted by onSynced below.
        },
      });
      if (brokerSyncAttemptRef.current !== attemptId) {
        return;
      }
      brokerSyncCommitRef.current = true;
      setIsBrokerCommitting(true);

      const portfolioId = result.portfolioIds[0] ?? null;
      const nextConfig = portfolioId
        ? focusPortfolioListCollection(result.config, portfolioId)
        : result.config;
      setBrokerSyncError(null);
      onboardingLog.info("Broker onboarding sync completed", {
        instanceId,
        portfolioId,
        positionsImported: result.positions.length,
      });
      await onSynced(result, nextConfig);
      brokerSyncCommitRef.current = false;
      setIsBrokerSyncing(false);
      setIsBrokerCommitting(false);
      setPortfolioSub("broker-fields");
    } catch (error) {
      if (brokerSyncAttemptRef.current !== attemptId) {
        return;
      }

      onboardingLog.error("Broker onboarding sync failed", { error: summarizeOnboardingError(error), brokerId: selectedBrokerId });
      brokerSyncCommitRef.current = false;
      setBrokerSyncError(summarizeOnboardingError(error));
      setIsBrokerSyncing(false);
      setIsBrokerCommitting(false);
      setPortfolioSub("broker-sync");
    }
  }, [
    buildDraftBrokerConfig,
    importBrokerPositions,
    onSynced,
    selectedBrokerId,
    setEditingField,
    setPortfolioSub,
  ]);

  return {
    isBrokerSyncing,
    isBrokerCommitting,
    brokerSyncError,
    resetBrokerSync,
    syncSelectedBroker,
  };
}
