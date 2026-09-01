import { useCallback, useSyncExternalStore } from "react";
import type { BrokerInstanceConfig } from "../../../types/config";
import { getGatewayConfig } from "../config";
import { ibkrGatewayManager } from "./service";

export function useGatewaySnapshot(instanceId?: string) {
  const subscribe = useCallback(
    (listener: () => void) => ibkrGatewayManager.subscribe(instanceId, listener),
    [instanceId],
  );
  const getSnapshot = useCallback(
    () => ibkrGatewayManager.getSnapshot(instanceId),
    [instanceId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getGatewayRequiredMessage(instanceCount: number) {
  return instanceCount > 0
    ? "Choose a Gateway / TWS IBKR profile first."
    : "Connect a Gateway / TWS IBKR profile first.";
}

export async function refreshGatewayData(instance: BrokerInstanceConfig): Promise<void> {
  const gateway = getGatewayConfig(instance.config);
  const service = ibkrGatewayManager.getService(instance.id);
  await service.connect(gateway);
  await Promise.allSettled([
    service.getAccounts(gateway),
    service.listOpenOrders(gateway),
    service.listExecutions(gateway),
  ]);
}
