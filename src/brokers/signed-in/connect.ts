/**
 * Connecting a signed-in broker from Add Broker and onboarding. The connection
 * lives in the Gloom account, so a device needs one profile per broker:
 * connecting again syncs the profile it already has.
 */
import type { AppConfig, BrokerInstanceConfig } from "../../types/config";
import { findSignedInBroker } from "./catalog";
import type { SignedInBroker } from "./client";
import { SIGNED_IN_BROKER_TYPE, isSignedInBrokerProfile, signedInBrokerId } from "./profile";
import { requestBrokerSignIn } from "./sign-in-dialog";

export function findSignedInBrokerProfile(
  instances: readonly BrokerInstanceConfig[],
  brokerId: string,
): BrokerInstanceConfig | undefined {
  return instances.find((instance) => isSignedInBrokerProfile(instance) && signedInBrokerId(instance) === brokerId);
}

/** The broker a signed-in profile connects, known or not to the last connector list. */
export function signedInBrokerForProfile(instance: BrokerInstanceConfig, fallbackName: string): SignedInBroker {
  const id = signedInBrokerId(instance);
  return findSignedInBroker(id) ?? {
    id,
    name: fallbackName,
    capabilities: { history: false, executions: false, orders: false, singleConnection: false },
  };
}

export interface ConnectSignedInBrokerDeps<T> {
  getConfig(): AppConfig;
  createBrokerInstance(brokerType: string, label: string, values: Record<string, unknown>): Promise<BrokerInstanceConfig>;
  syncBrokerInstance(instanceId: string): Promise<T>;
  /** Opens the connect dialog; replaced in tests. */
  requestSignIn?: (broker: SignedInBroker) => Promise<boolean>;
}

/**
 * Asks the user to connect `broker`, then syncs its profile, creating it the
 * first time. Resolves null when the broker was not connected.
 */
export async function connectSignedInBrokerProfile<T>(
  broker: SignedInBroker,
  deps: ConnectSignedInBrokerDeps<T>,
): Promise<{ instance: BrokerInstanceConfig; synced: T } | null> {
  const connected = await (deps.requestSignIn ?? requestBrokerSignIn)(broker);
  if (!connected) return null;
  const instance = findSignedInBrokerProfile(deps.getConfig().brokerInstances, broker.id)
    ?? await deps.createBrokerInstance(SIGNED_IN_BROKER_TYPE, broker.name, { connectionMode: broker.id, broker: broker.id });
  return { instance, synced: await deps.syncBrokerInstance(instance.id) };
}
