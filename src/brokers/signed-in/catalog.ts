/**
 * The signed-in brokers Gloom Cloud offers, as last seen. Add Broker, the
 * Brokers pane, onboarding and the adapter read it synchronously. It refreshes
 * at startup and when Add Broker or onboarding opens, and the last list is kept
 * in plugin state (which, unlike the desktop view's resource cache, survives a
 * restart everywhere) so the directory still lists them offline.
 */
import type { PluginPersistence } from "../../types/plugin";
import { listSignedInBrokers, type SignedInBroker } from "./client";

const FRESH_MS = 5 * 60_000;
const STATE_KEY = "signed-in-brokers";
const SCHEMA_VERSION = 1;
/** One empty list, so a React snapshot of "nothing yet" is stable. */
const NONE: SignedInBroker[] = [];

function isSignedInBroker(value: unknown): value is SignedInBroker {
  const entry = value as Partial<SignedInBroker> | null;
  return !!entry
    && typeof entry.id === "string"
    && typeof entry.name === "string"
    && !!entry.capabilities
    && typeof entry.capabilities === "object";
}

function readBrokers(value: unknown): SignedInBroker[] | null {
  return Array.isArray(value) ? value.filter(isSignedInBroker) : null;
}

export interface SignedInBrokerCatalog {
  attach(persistence: PluginPersistence): void;
  reset(): void;
  get(): SignedInBroker[];
  find(brokerId: string): SignedInBroker | null;
  refresh(options?: { force?: boolean }): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createSignedInBrokerCatalog(
  load: () => Promise<{ connectors: SignedInBroker[] }>,
  now: () => number = Date.now,
): SignedInBrokerCatalog {
  let persistence: PluginPersistence | null = null;
  // Null until a list is known, so a store attached after the first read still counts.
  let brokers: SignedInBroker[] | null = null;
  let fetchedAt = 0;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const ensureLoaded = (): SignedInBroker[] => {
    if (brokers) return brokers;
    const saved = persistence?.getState<{ brokers?: unknown; fetchedAt?: unknown }>(STATE_KEY, {
      schemaVersion: SCHEMA_VERSION,
    });
    const restored = readBrokers(saved?.brokers);
    if (!restored) return NONE;
    brokers = restored;
    fetchedAt = typeof saved?.fetchedAt === "number" ? saved.fetchedAt : 0;
    return brokers;
  };

  return {
    attach(next) {
      persistence = next;
      if (!brokers) ensureLoaded();
    },
    reset() {
      persistence = null;
      brokers = null;
      fetchedAt = 0;
      inFlight = null;
    },
    get: ensureLoaded,
    find(brokerId) {
      return ensureLoaded().find((broker) => broker.id === brokerId) ?? null;
    },
    refresh(options = {}) {
      ensureLoaded();
      if (inFlight) return inFlight;
      if (!options.force && brokers && now() - fetchedAt < FRESH_MS) return Promise.resolve();
      inFlight = load()
        .then((response) => {
          const next = readBrokers(response?.connectors);
          if (!next) return;
          brokers = next;
          fetchedAt = now();
          notify();
          persistence?.setState(STATE_KEY, { brokers: next, fetchedAt }, { schemaVersion: SCHEMA_VERSION });
        })
        // Offline or Cloud down: the last list stays, and the next open retries.
        .catch(() => {})
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const catalog = createSignedInBrokerCatalog(listSignedInBrokers);

export const attachSignedInBrokerPersistence = catalog.attach;
export const resetSignedInBrokerCatalog = catalog.reset;
/** The last known list; empty until the first fetch or a restored copy. */
export const getSignedInBrokers = catalog.get;
export const findSignedInBroker = catalog.find;
/** Fetches the list unless it is under five minutes old. Never rejects. */
export const refreshSignedInBrokers = catalog.refresh;
export const subscribeSignedInBrokers = catalog.subscribe;
