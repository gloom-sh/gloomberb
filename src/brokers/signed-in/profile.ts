/**
 * How a signed-in broker profile is stored: the built-in adapter's type, with
 * the backend broker in `connectionMode` (cloud sync keeps it, unlike `config`)
 * and again in `config.broker`.
 */
import type { BrokerInstanceConfig } from "../../types/config";

export const SIGNED_IN_BROKER_TYPE = "signed-in";

export function isSignedInBrokerProfile(instance: BrokerInstanceConfig): boolean {
  return instance.brokerType === SIGNED_IN_BROKER_TYPE;
}

/** The backend broker a profile connects, e.g. "ibkr". */
export function signedInBrokerId(instance: BrokerInstanceConfig): string {
  if (instance.connectionMode) return instance.connectionMode;
  return typeof instance.config.broker === "string" ? instance.config.broker : "";
}
