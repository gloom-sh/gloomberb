import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { buildBrokerProfileConfig, validateBrokerProfileValues } from "../../brokers/profile-form";
import type { SignedInBroker } from "../../brokers/signed-in/client";
import { connectSignedInBrokerProfile } from "../../brokers/signed-in/connect";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import type { AppConfig, BrokerInstanceConfig } from "../../types/config";
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
  getConfig,
  createBrokerInstance,
  onSynced,
  setEditingField,
  setPortfolioSub,
}: {
  config: AppConfig;
  brokerOptions: BrokerOption[];
  brokerValues: Record<string, Record<string, string>>;
  selectedBrokerId: string | null;
  importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"];
  /** The live config and profile creation, for the signed-in path that Add Broker shares. */
  getConfig: () => AppConfig;
  createBrokerInstance: (brokerType: string, label: string, values: Record<string, unknown>) => Promise<BrokerInstanceConfig>;
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

  /** Starts an attempt; a newer attempt or Back makes every older one stale. */
  const beginAttempt = useCallback(() => {
    const attemptId = brokerSyncAttemptRef.current + 1;
    brokerSyncAttemptRef.current = attemptId;
    brokerSyncAbortRef.current?.abort();
    const abortController = new AbortController();
    brokerSyncAbortRef.current = abortController;
    brokerSyncCommitRef.current = false;
    return { attemptId, abortController };
  }, []);

  const showSyncing = useCallback(() => {
    setEditingField(false);
    setPortfolioSub("broker-sync");
    setIsBrokerSyncing(true);
    setIsBrokerCommitting(false);
    setBrokerSyncError(null);
  }, [setEditingField, setPortfolioSub]);

  const importInto = useCallback((
    instanceId: string,
    attemptId: number,
    signal: AbortSignal,
    draftConfig?: AppConfig,
  ) => importBrokerPositions(instanceId, undefined, {
    config: draftConfig,
    persistResolvedBrokerConfig: true,
    signal,
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
  }), [importBrokerPositions]);

  const finishSync = useCallback(async (
    attemptId: number,
    instanceId: string,
    result: SyncBrokerInstanceResult,
    nextSub: PortfolioSub | null,
  ) => {
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
    if (nextSub) setPortfolioSub(nextSub);
  }, [onSynced, setPortfolioSub]);

  const failSync = useCallback((attemptId: number, error: unknown) => {
    if (brokerSyncAttemptRef.current !== attemptId) {
      return;
    }

    onboardingLog.error("Broker onboarding sync failed", { error: summarizeOnboardingError(error), brokerId: selectedBrokerId });
    brokerSyncCommitRef.current = false;
    setBrokerSyncError(summarizeOnboardingError(error));
    setIsBrokerSyncing(false);
    setIsBrokerCommitting(false);
    setPortfolioSub("broker-sync");
  }, [selectedBrokerId, setPortfolioSub]);

  /**
   * Signing in goes the way Add Broker does: the dialog, then the profile this
   * device has for the broker (or a new one), then the import. Not connecting
   * leaves the step where it was.
   */
  const connectSignedInBroker = useCallback(async (broker: SignedInBroker) => {
    const { attemptId, abortController } = beginAttempt();
    setEditingField(false);
    setBrokerSyncError(null);
    try {
      const connected = await connectSignedInBrokerProfile(broker, {
        getConfig,
        createBrokerInstance,
        syncBrokerInstance: (instanceId) => {
          if (brokerSyncAttemptRef.current === attemptId) showSyncing();
          return importInto(instanceId, attemptId, abortController.signal);
        },
      });
      if (!connected) return;
      await finishSync(attemptId, connected.instance.id, connected.synced, null);
    } catch (error) {
      failSync(attemptId, error);
    }
  }, [beginAttempt, createBrokerInstance, failSync, finishSync, getConfig, importInto, setEditingField, showSyncing]);

  const syncSelectedBroker = useCallback(async (brokerValueOverrides?: Record<string, string>) => {
    const signedIn = brokerOptions.find((option) => option.id === selectedBrokerId)?.signedIn;
    if (signedIn) {
      await connectSignedInBroker(signedIn);
      return;
    }
    const { attemptId, abortController } = beginAttempt();
    showSyncing();

    try {
      const { config: draftConfig, instanceId } = buildDraftBrokerConfig(brokerValueOverrides);
      onboardingLog.info("Syncing broker during onboarding", { instanceId, brokerId: selectedBrokerId });
      const result = await importInto(instanceId, attemptId, abortController.signal, draftConfig);
      await finishSync(attemptId, instanceId, result, "broker-fields");
    } catch (error) {
      failSync(attemptId, error);
    }
  }, [
    beginAttempt,
    brokerOptions,
    buildDraftBrokerConfig,
    connectSignedInBroker,
    failSync,
    finishSync,
    importInto,
    selectedBrokerId,
    showSyncing,
  ]);

  return {
    isBrokerSyncing,
    isBrokerCommitting,
    brokerSyncError,
    resetBrokerSync,
    syncSelectedBroker,
    connectSignedInBroker,
  };
}
