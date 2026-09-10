import type { PluginRegistry } from "../../plugins/registry";
import type { BrokerAdapter } from "../../types/broker";
import type { AppConfig } from "../../types/config";
import type { CachedFinancialsTarget, MarketDataRequestContext } from "../../types/data-provider";

const BROKER_ATTEMPT_TIMEOUT = 10_000;

export interface BrokerCandidate {
  brokerId: string;
  brokerInstanceId: string;
  brokerLabel: string;
  broker: BrokerAdapter;
  instance: AppConfig["brokerInstances"][number];
}

export function withBrokerTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), BROKER_ATTEMPT_TIMEOUT);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function getBrokerCandidates(
  registry: PluginRegistry | null,
  config: AppConfig,
  preferredBrokerInstanceId?: string,
  preferredBrokerId?: string,
  includeFallbackInstances = true,
): BrokerCandidate[] {
  if (!registry) return [];
  const candidates: BrokerCandidate[] = [];

  const pushCandidate = (instance: AppConfig["brokerInstances"][number]) => {
    if (instance.enabled === false) return;
    if (preferredBrokerId && instance.brokerType !== preferredBrokerId && instance.id !== preferredBrokerInstanceId) return;
    const broker = registry.brokers.get(instance.brokerType);
    if (!broker) return;
    candidates.push({
      brokerId: instance.brokerType,
      brokerInstanceId: instance.id,
      brokerLabel: instance.label,
      broker,
      instance,
    });
  };

  const preferredInstance = preferredBrokerInstanceId
    ? config.brokerInstances.find((instance) => instance.id === preferredBrokerInstanceId)
    : undefined;
  if (preferredInstance) {
    pushCandidate(preferredInstance);
  }

  if (!includeFallbackInstances && preferredInstance) {
    return candidates;
  }

  for (const instance of config.brokerInstances) {
    if (instance.id === preferredBrokerInstanceId) continue;
    pushCandidate(instance);
  }

  return candidates;
}

export function getBrokerCandidatesForContext(
  registry: PluginRegistry | null,
  config: AppConfig,
  context?: MarketDataRequestContext,
  includeFallbackInstances = true,
): BrokerCandidate[] {
  return getBrokerCandidates(
    registry,
    config,
    context?.instrument?.brokerInstanceId ?? context?.brokerInstanceId,
    context?.instrument?.brokerId ?? context?.brokerId,
    includeFallbackInstances,
  );
}

export function hasBrokerContext(context?: MarketDataRequestContext): boolean {
  return !!(
    context?.brokerId ||
    context?.brokerInstanceId ||
    context?.instrument?.brokerId ||
    context?.instrument?.brokerInstanceId
  );
}

export function hasCachedTargetBrokerContext(target: CachedFinancialsTarget): boolean {
  return !!(
    target.brokerId ||
    target.brokerInstanceId ||
    target.instrument?.brokerId ||
    target.instrument?.brokerInstanceId
  );
}

export function contextFromCachedTarget(target: CachedFinancialsTarget): MarketDataRequestContext {
  return {
    statementHistory: target.statementHistory,
    brokerId: target.brokerId,
    brokerInstanceId: target.brokerInstanceId,
    instrument: target.instrument ?? null,
  };
}
