/**
 * Connecting a signed-in broker from Add Broker and onboarding. The connection
 * lives in the Gloom account, so a device needs one profile per broker:
 * connecting again syncs the profile it already has.
 */
import { ApiRequestError } from "../../api-client/errors";
import type { AppConfig, BrokerInstanceConfig } from "../../types/config";
import { findSignedInBroker } from "./catalog";
import { disconnectSignedInBroker, type SignedInBroker } from "./client";
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

/**
 * Disconnects the Gloom account's connection behind a signed-in profile before
 * the profile goes. Already gone is fine; signed out of Gloom, the account
 * keeps the broker, which the caller reports as `stillConnected`.
 */
export async function disconnectSignedInProfile(instance: BrokerInstanceConfig): Promise<{ stillConnected: boolean }> {
  if (!isSignedInBrokerProfile(instance)) return { stillConnected: false };
  try {
    await disconnectSignedInBroker(signedInBrokerId(instance));
    return { stillConnected: false };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { stillConnected: false };
    if (error instanceof ApiRequestError && error.status === 401) return { stillConnected: true };
    throw error;
  }
}

