/**
 * Connecting a signed-in broker: Gloom Cloud hands out a link and a short code,
 * the user opens the link, types the code, and signs in to the broker there.
 * The code is what ties the browser to this app, so a link someone else started
 * cannot attach their brokerage to this account. The connection itself lives in
 * the Cloud account, shared by every device and by the user's agents.
 */
import { ApiRequestError } from "../../api-client/errors";
import {
  fetchSignedInBrokerConnection,
  startSignedInBrokerConnect,
  type SignedInBroker,
  type SignedInBrokerConnection,
} from "./client";

/** "signed-out": Gloom refused the session, so the dialog host signs in again. */
export type BrokerSignInPhase = "starting" | "waiting" | "connected" | "signed-out" | "error";

export interface BrokerSignInSnapshot {
  phase: BrokerSignInPhase;
  connectUrl: string | null;
  code: string | null;
  /** A transient poll failure while waiting, or why starting failed. */
  error: string | null;
}

export interface BrokerSignInIo {
  start(brokerId: string, write: boolean): Promise<{ connectUrl: string; code: string; expiresAt: string }>;
  fetchConnection(brokerId: string): Promise<Pick<SignedInBrokerConnection, "status">>;
  now(): number;
  delay(ms: number): Promise<void>;
}

const POLL_INTERVAL_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Used when the expiry is missing or unreadable, so polling can never run forever. */
const DEFAULT_CODE_TTL_MS = 15 * 60_000;

const defaultIo: BrokerSignInIo = {
  start: (brokerId, write) => startSignedInBrokerConnect(brokerId, write),
  fetchConnection: (brokerId) => fetchSignedInBrokerConnection(brokerId),
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function describeStartError(error: unknown, broker: SignedInBroker): string {
  if (error instanceof ApiRequestError && error.status === 404) return `${broker.name} is not available right now.`;
  return "Can't reach Gloom. Retrying...";
}

/**
 * When a code stops working. An expiry this device's clock already sees as
 * past (the clock runs fast) counts as missing, or every code would expire
 * the moment it arrived.
 */
function codeDeadline(expiresAt: string, now: number): number {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > now ? parsed : now + DEFAULT_CODE_TTL_MS;
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
        // A session Gloom no longer accepts (expired, or signed out elsewhere) needs a new sign-in.
        if (error instanceof ApiRequestError && error.status === 401) {
          this.update({ phase: "signed-out", error: "Sign in to Gloom first." });
          return;
        }
        this.update({ phase: "error", error: describeStartError(error, this.broker) });
        // An unknown broker will not fix itself by retrying.
        if (error instanceof ApiRequestError && error.status === 404) return;
        await this.io.delay(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      if (stale()) return;
      retryMs = POLL_INTERVAL_MS;
      this.update({ phase: "waiting", connectUrl: started.connectUrl, code: started.code, error: null });
      const deadline = codeDeadline(started.expiresAt, this.io.now());
      // At least one poll per code, so the next code is never asked for at once.
      do {
        await this.io.delay(POLL_INTERVAL_MS);
        if (stale()) return;
        try {
          // Connected is enough: a user who declined trading still gets a read-only connection.
          if ((await this.io.fetchConnection(this.broker.id)).status === "connected") {
            if (!stale()) this.update({ phase: "connected", error: null });
            this.generation += 1;
            return;
          }
          if (this.snapshot.error) this.update({ error: null });
        } catch {
          if (!stale()) this.update({ error: "Connection problem, retrying..." });
        }
      } while (!stale() && this.io.now() < deadline);
    }
  }
}

/** How one showing of the connect dialog ended. */
export type BrokerSignInOutcome = "connected" | "cancelled" | "signed-out";

export interface BrokerSignInSteps {
  isSignedIn(): boolean;
  /** The Gloom device sign-in; true once signed in. */
  signInToGloom(): Promise<boolean>;
  connectBroker(broker: SignedInBroker, write: boolean): Promise<BrokerSignInOutcome>;
}

/**
 * Connects `broker`, signing in to Gloom first when there is no session. A
 * session kept on this device that Gloom no longer accepts only shows once the
 * connect starts, so that signs in and tries the broker once more.
 */
export async function runBrokerSignIn(
  broker: SignedInBroker,
  write: boolean | undefined,
  steps: BrokerSignInSteps,
): Promise<boolean> {
  if (!steps.isSignedIn() && !await steps.signInToGloom()) return false;
  // Trading is asked for only where the broker takes orders from Gloom.
  const scope = write ?? Boolean(broker.capabilities.orders);
  let outcome = await steps.connectBroker(broker, scope);
  if (outcome === "signed-out" && await steps.signInToGloom()) {
    outcome = await steps.connectBroker(broker, scope);
  }
  return outcome === "connected";
}
