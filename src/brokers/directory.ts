/**
 * Every broker a user can connect, whichever way: signed in through the Gloom
 * account (described by the backend) or on this device through an installed
 * adapter. One broker offered both ways is one entry with two methods, so Add
 * Broker and onboarding list "Interactive Brokers" once.
 */
import type { BrokerAdapter } from "../types/broker";
import type { SignedInBroker } from "./signed-in/client";
import { SIGNED_IN_BROKER_TYPE } from "./signed-in/profile";

export type BrokerMethod =
  | { kind: "signed-in"; broker: SignedInBroker }
  | { kind: "device"; adapter: BrokerAdapter };

export interface BrokerDirectoryEntry {
  key: string;
  name: string;
  /** Signed-in first, since it needs nothing installed or configured. */
  methods: BrokerMethod[];
}

export function buildBrokerDirectory({
  signedIn,
  adapters,
}: {
  signedIn: readonly SignedInBroker[];
  adapters: Iterable<BrokerAdapter>;
}): BrokerDirectoryEntry[] {
  const installed = [...adapters];
  const entries = new Map<string, BrokerDirectoryEntry>();
  // Signing in needs the built-in adapter, which the web app and a disabled Broker plugin lack.
  const canSignIn = installed.some((adapter) => adapter.id === SIGNED_IN_BROKER_TYPE);
  for (const broker of canSignIn ? signedIn : []) {
    if (entries.has(broker.id)) continue;
    entries.set(broker.id, { key: broker.id, name: broker.name, methods: [{ kind: "signed-in", broker }] });
  }
  for (const adapter of installed) {
    // An adapter with nothing to configure (the signed-in adapter itself) is not a way to connect.
    if (adapter.configSchema.length === 0) continue;
    const method: BrokerMethod = { kind: "device", adapter };
    const entry = entries.get(adapter.id);
    if (entry) {
      if (!entry.methods.some((candidate) => candidate.kind === "device")) entry.methods.push(method);
    } else {
      entries.set(adapter.id, { key: adapter.id, name: adapter.name, methods: [method] });
    }
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function brokerMethodLabel(entry: BrokerDirectoryEntry, method: BrokerMethod): string {
  if (method.kind === "signed-in") {
    return entry.methods.some((candidate) => candidate.kind === "device") ? "Sign in (recommended)" : "Sign in";
  }
  return entry.methods.length > 1 ? `On this device (${method.adapter.name})` : method.adapter.name;
}
