import type { AppConfig, BrokerInstanceConfig } from "../../types/config";
import { getBrokerInstance, getBrokerInstancesByType } from "../../utils/broker-instances";
import { isGatewayConfigured, normalizeIbkrConfig } from "./config";

function isIbkrGatewayInstance(instance?: BrokerInstanceConfig): instance is BrokerInstanceConfig {
  if (!instance || instance.brokerType !== "ibkr" || instance.enabled === false) return false;
  const normalized = normalizeIbkrConfig(instance.config);
  return normalized.connectionMode === "gateway" && isGatewayConfigured(instance.config);
}

export function getConfiguredIbkrGatewayInstances(config: AppConfig): BrokerInstanceConfig[] {
  return getBrokerInstancesByType(config.brokerInstances, "ibkr").filter(isIbkrGatewayInstance);
}

export function getLockedIbkrTradingInstanceId(config: AppConfig, collectionId: string | null): string | undefined {
  const activePortfolio = config.portfolios.find((portfolio) => portfolio.id === collectionId);
  if (activePortfolio?.brokerId !== "ibkr" || !activePortfolio.brokerInstanceId) return undefined;
  const instance = getBrokerInstance(config.brokerInstances, activePortfolio.brokerInstanceId);
  return isIbkrGatewayInstance(instance) ? instance.id : undefined;
}

export function resolveIbkrTradingInstanceId(
  config: AppConfig,
  collectionId: string | null,
  preferredInstanceId?: string,
): string | undefined {
  const lockedInstanceId = getLockedIbkrTradingInstanceId(config, collectionId);
  if (lockedInstanceId) return lockedInstanceId;

  const preferredInstance = getBrokerInstance(config.brokerInstances, preferredInstanceId);
  if (isIbkrGatewayInstance(preferredInstance)) return preferredInstance.id;

  const gatewayInstance = getConfiguredIbkrGatewayInstances(config)[0];
  if (gatewayInstance) return gatewayInstance.id;
  return undefined;
}
