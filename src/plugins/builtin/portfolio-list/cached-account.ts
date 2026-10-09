import { peekPersistedBrokerAccounts } from "../../../brokers/account-cache";
import type { AppResourceStorePort } from "../../../core/app-service-ports";
import type { AppConfig } from "../../../types/config";
import type { Portfolio } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { resolvePortfolioAccountState } from "./summary";

/**
 * The broker account a portfolio was last synced with, as saved on this
 * device, for reports that run without a broker connection. The pane reads
 * the same account from app state.
 */
export function findCachedPortfolioAccount(
  config: AppConfig,
  portfolio: Portfolio,
  resources: Pick<AppResourceStorePort, "list"> | null | undefined,
): BrokerAccount | null {
  if (!resources || !portfolio.brokerInstanceId) return null;
  const brokerAccounts: Record<string, BrokerAccount[]> = {};
  for (const instance of config.brokerInstances) {
    try {
      const accounts = peekPersistedBrokerAccounts(resources, instance);
      if (accounts?.length) brokerAccounts[instance.id] = accounts;
    } catch {
      // An unreadable snapshot leaves the portfolio without account figures.
    }
  }
  return resolvePortfolioAccountState(
    portfolio,
    { config, brokerAccounts },
    { status: null, accounts: [] },
  )?.account ?? null;
}
