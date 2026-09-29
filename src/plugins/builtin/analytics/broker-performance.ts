import { useCallback, useMemo } from "react";
import { useAsyncResource } from "../../../react/async-resource";
import type { AppConfig, BrokerInstanceConfig } from "../../../types/config";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import type { Portfolio } from "../../../types/ticker";
import { usePluginBrokerActions } from "../../runtime";

export interface BrokerPerformanceState {
  loading: boolean;
  performance: BrokerPortfolioPerformance | null;
  error: string | null;
}

function findBrokerInstance(config: AppConfig, portfolio: Portfolio | null): BrokerInstanceConfig | null {
  if (!portfolio?.brokerInstanceId) return null;
  return config.brokerInstances.find((instance) => instance.id === portfolio.brokerInstanceId) ?? null;
}

/** An IBKR profile that can supply account history: Flex statements or the Cloud connection. */
function isIbkrHistoryProfile(instance: BrokerInstanceConfig): boolean {
  if (instance.brokerType !== "ibkr" || instance.enabled === false) return false;
  const config = instance.config ?? {};
  const flex = typeof config.flex === "object" && config.flex
    ? config.flex as Record<string, unknown>
    : {};
  const mode = instance.connectionMode ?? config.connectionMode;
  if (mode === "cloud") return true;
  return mode === "flex"
    && typeof flex.token === "string"
    && flex.token.length > 0
    && typeof flex.queryId === "string"
    && flex.queryId.length > 0;
}

function findBrokerPerformanceCandidates(
  config: AppConfig,
  portfolio: Portfolio | null,
): BrokerInstanceConfig[] {
  const primary = findBrokerInstance(config, portfolio);
  if (!primary) return [];
  if (primary.brokerType !== "ibkr") return [primary];

  const candidates = [primary];
  for (const instance of config.brokerInstances) {
    if (instance.id === primary.id) continue;
    if (!isIbkrHistoryProfile(instance)) continue;
    candidates.push(instance);
  }
  return candidates;
}

function resolveBrokerAccountId(portfolio: Portfolio | null): string | null {
  if (portfolio?.brokerAccountId) return portfolio.brokerAccountId;
  const parts = portfolio?.id.split(":") ?? [];
  return parts[0] === "broker" && parts.length >= 3 ? parts.slice(2).join(":") : null;
}

export function useBrokerPortfolioPerformance(
  portfolio: Portfolio | null,
  config: AppConfig,
): BrokerPerformanceState {
  const { getBrokerAdapter } = usePluginBrokerActions();
  const brokerInstances = useMemo(() => findBrokerPerformanceCandidates(config, portfolio), [config, portfolio]);
  const accountId = useMemo(() => resolveBrokerAccountId(portfolio), [portfolio]);
  const load = useCallback(async () => {
    let lastError: string | null = null;
    for (const brokerInstance of brokerInstances) {
      const broker = getBrokerAdapter(brokerInstance.brokerType);
      if (!broker?.getPortfolioPerformance || !accountId) continue;
      try {
        const performance = await broker.getPortfolioPerformance(brokerInstance, accountId);
        if (performance && performance.accountId !== accountId) {
          lastError = "Returned history belongs to a different account";
          continue;
        }
        if (performance && performance.points.length > 0) return performance;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(lastError ?? "No account history returned");
  }, [accountId, brokerInstances, getBrokerAdapter]);
  const resource = useAsyncResource(brokerInstances.length > 0 && accountId ? load : null);
  return { loading: resource.loading, performance: resource.data, error: resource.error };
}
