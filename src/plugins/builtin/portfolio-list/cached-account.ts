import { peekPersistedBrokerAccounts } from "../../../brokers/account-cache";
import type { AppResourceStorePort } from "../../../core/app-service-ports";
import type { AppConfig } from "../../../types/config";
import type { Portfolio } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { resolvePortfolioAccountState } from "./summary";

/**
 * Every profile's broker accounts as last synced on this device, by profile,
 * for reports and screenshots that run without a broker connection. The pane
 * reads the same accounts from app state.
 */
export function peekCachedBrokerAccounts(
  config: Pick<AppConfig, "brokerInstances">,
  resources: Pick<AppResourceStorePort, "list"> | null | undefined,
): Record<string, BrokerAccount[]> {
  const brokerAccounts: Record<string, BrokerAccount[]> = {};
  if (!resources) return brokerAccounts;
  for (const instance of config.brokerInstances) {
    try {
      const accounts = peekPersistedBrokerAccounts(resources, instance);
      if (accounts?.length) brokerAccounts[instance.id] = accounts;
    } catch {
      // An unreadable snapshot leaves the portfolio without account figures.
    }
  }
  return brokerAccounts;
}

/** The broker account a portfolio was last synced with, as saved on this device. */
export function findCachedPortfolioAccount(
  config: AppConfig,
  portfolio: Portfolio,
  resources: Pick<AppResourceStorePort, "list"> | null | undefined,
): BrokerAccount | null {
  if (!resources || !portfolio.brokerInstanceId) return null;
  return resolvePortfolioAccountState(
    portfolio,
    { config, brokerAccounts: peekCachedBrokerAccounts(config, resources) },
    { status: null, accounts: [] },
  )?.account ?? null;
}
