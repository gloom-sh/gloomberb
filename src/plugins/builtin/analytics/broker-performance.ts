import { useCallback, useMemo } from "react";
import { useAsyncResource } from "../../../react/async-resource";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
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

export type PerformanceMetric = "value" | "cumulativeReturn";

/** A later observation at the same date replaces the whole earlier row. */
function performanceObservations(performance: BrokerPortfolioPerformance | null) {
  const byDate = new Map<number, BrokerPortfolioPerformance["points"][number]>();
  for (const point of performance?.points ?? []) {
    const timestamp = new Date(point.date).getTime();
    if (Number.isFinite(timestamp)) byDate.set(timestamp, point);
  }
  return [...byDate.entries()].sort(([left], [right]) => left - right);
}

function finitePointValue(point: BrokerPortfolioPerformance["points"][number], metric: PerformanceMetric): number | null {
  const value = point[metric];
  return value != null && Number.isFinite(value) ? value : null;
}

/** Choose one unit for the entire series; a missing NAV is never a percentage. */
export function resolvePerformanceMetric(performance: BrokerPortfolioPerformance | null): PerformanceMetric {
  const points = performanceObservations(performance);
  const count = (metric: PerformanceMetric) => points.filter(([, point]) => finitePointValue(point, metric) != null).length;
  const valueCount = count("value");
  const returnCount = count("cumulativeReturn");
  return valueCount >= 2 || (valueCount > 0 && returnCount < 2) ? "value" : "cumulativeReturn";
}

export function buildPerformanceChartPoints(performance: BrokerPortfolioPerformance | null): ProjectedChartPoint[] {
  if (!performance) return [];
  const metric = resolvePerformanceMetric(performance);
  return performanceObservations(performance).map(([timestamp, point]) => {
    // The chart's nonfinite sentinel preserves a known gap and its date.
    const value = finitePointValue(point, metric) ?? Number.NaN;
    return { date: new Date(timestamp), open: value, high: value, low: value, close: value, volume: 0 };
  });
}

export function performanceHistoryNote(performance: BrokerPortfolioPerformance | null): string | null {
  if (!performance) return null;
  const metric = resolvePerformanceMetric(performance);
  const missing = performanceObservations(performance).filter(([, point]) => finitePointValue(point, metric) == null).length;
  return missing
    ? `${missing} missing ${metric === "value" ? "value" : "return"} observation${missing === 1 ? "" : "s"}.`
    : null;
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
