import type { AppConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { getBrokerInstance } from "../../../utils/broker-instances";
import { normalizeIbkrConfig } from "../config";
import { ibkrGatewayManager } from "./service";
import {
  getConfiguredIbkrGatewayInstances,
  getLockedIbkrTradingInstanceId,
  resolveIbkrTradingInstanceId,
} from "../instance-selection";
import {
  getGatewayRequiredMessage,
  useGatewaySnapshot,
} from "./helpers";
import { getKnownIbkrAccounts } from "../trade/utils";

export function useIbkrGatewaySelection(
  config: AppConfig,
  brokerAccounts: Record<string, BrokerAccount[]>,
  collectionId: string | null | undefined,
  preferredInstanceId?: string,
) {
  const activePortfolio = config.portfolios.find((portfolio) => portfolio.id === collectionId);
  const gatewayInstances = getConfiguredIbkrGatewayInstances(config);
  const lockedBrokerInstanceId = getLockedIbkrTradingInstanceId(config, collectionId ?? null);
  const selectedBrokerInstanceId = resolveIbkrTradingInstanceId(config, collectionId ?? null, preferredInstanceId);
  const selectedInstance = getBrokerInstance(config.brokerInstances, selectedBrokerInstanceId);
  const gatewaySnapshot = useGatewaySnapshot(selectedBrokerInstanceId);
  const gatewayService = selectedBrokerInstanceId ? ibkrGatewayManager.getService(selectedBrokerInstanceId) : null;
  const normalizedConfig = selectedInstance ? normalizeIbkrConfig(selectedInstance.config) : null;
  const isGatewayMode = selectedInstance != null && normalizedConfig?.connectionMode === "gateway";
  const availableAccounts = getKnownIbkrAccounts(
    brokerAccounts,
    selectedBrokerInstanceId,
    gatewaySnapshot.accounts,
  );

  return {
    activePortfolio,
    gatewayInstances,
    lockedBrokerInstanceId,
    selectedBrokerInstanceId,
    selectedInstance,
    gatewaySnapshot,
    gatewayService,
    normalizedConfig,
    isGatewayMode,
    availableAccounts,
    gatewayRequiredMessage: getGatewayRequiredMessage(gatewayInstances.length),
  };
}
