/**
 * Connecting a signed-in broker: Gloom Cloud hands out a link and a short code,
 * the user opens the link, types the code, and signs in to the broker there.
 * The code is what ties the browser to this app, so a link someone else started
 * cannot attach their brokerage to this account. The connection itself lives in
 * the Cloud account, shared by every device and by the user's agents.
 */
import { ApiRequestError } from "../../api-client/errors";
import { fetchSignedInBrokerConnection, startSignedInBrokerConnect, type SignedInBroker } from "./client";

export type BrokerSignInPhase = "starting" | "waiting" | "connected" | "error";

export interface BrokerSignInSnapshot {
  phase: BrokerSignInPhase;
  connectUrl: string | null;
  code: string | null;
  /** A transient poll failure while waiting, or why starting failed. */
  error: string | null;
}

export interface BrokerSignInIo {
  start(brokerId: string, write: boolean): Promise<{ connectUrl: string; code: string; expiresAt: string }>;
  isConnected(brokerId: string, write: boolean): Promise<boolean>;
  now(): number;
  delay(ms: number): Promise<void>;
}

const POLL_INTERVAL_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Used when the expiry is missing or unreadable, so polling can never run forever. */
const DEFAULT_CODE_TTL_MS = 15 * 60_000;

const defaultIo: BrokerSignInIo = {
  start: (brokerId, write) => startSignedInBrokerConnect(brokerId, write),
  async isConnected(brokerId, write) {
    const connection = await fetchSignedInBrokerConnection(brokerId);
    return connection.status === "connected" && (!write || connection.canTrade);
  },
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function describeStartError(error: unknown, broker: SignedInBroker): string {
  if (error instanceof ApiRequestError && error.status === 401) return "Sign in to Gloom first.";
  if (error instanceof ApiRequestError && error.status === 404) return `${broker.name} is not available right now.`;
  return "Can't reach Gloom. Retrying...";
}

export class BrokerSignInController {
  private readonly io: BrokerSignInIo;
  private readonly listeners = new Set<(snapshot: BrokerSignInSnapshot) => void>();
  private generation = 0;
  private snapshot: BrokerSignInSnapshot = { phase: "starting", connectUrl: null, code: null, error: null };

  constructor(
    private readonly broker: SignedInBroker,
    /** Ask for trading as well as reading when the broker offers it. */
    private readonly write: boolean,
    io: Partial<BrokerSignInIo> = {},
  ) {
    this.io = { ...defaultIo, ...io };
  }

  getSnapshot(): BrokerSignInSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: BrokerSignInSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts, or restarts with a fresh code. Safe to call repeatedly. */
  start(): void {
    const generation = ++this.generation;
    void this.run(generation);
  }

  cancel(): void {
    this.generation += 1;
  }

  private update(next: Partial<BrokerSignInSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private async run(generation: number): Promise<void> {
    const stale = () => this.generation !== generation;
    let retryMs = POLL_INTERVAL_MS;
    // Each iteration is one code: start, poll until connected, and loop again
    // when the code expired so the link refreshes instead of dead-ending.
    while (!stale()) {
      this.update({ phase: "starting", connectUrl: null, code: null, error: null });
      let started: Awaited<ReturnType<BrokerSignInIo["start"]>>;
      try {
        started = await this.io.start(this.broker.id, this.write);
      } catch (error) {
        if (stale()) return;
        const message = describeStartError(error, this.broker);
        this.update({ phase: "error", error: message });
        // Signed out or unknown broker will not fix itself by retrying.
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) return;
        await this.io.delay(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      if (stale()) return;
      retryMs = POLL_INTERVAL_MS;
      this.update({ phase: "waiting", connectUrl: started.connectUrl, code: started.code, error: null });
      const expiresAt = Date.parse(started.expiresAt);
      const deadline = Number.isFinite(expiresAt) ? expiresAt : this.io.now() + DEFAULT_CODE_TTL_MS;
      while (!stale() && this.io.now() < deadline) {
        await this.io.delay(POLL_INTERVAL_MS);
        if (stale()) return;
        try {
          if (await this.io.isConnected(this.broker.id, this.write)) {
            if (!stale()) this.update({ phase: "connected", error: null });
            this.generation += 1;
            return;
          }
          if (this.snapshot.error) this.update({ error: null });
        } catch {
          if (!stale()) this.update({ error: "Connection problem, retrying..." });
        }
      }
    }
  }
}
