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
type BrokerSignInPhase = "starting" | "waiting" | "connected" | "signed-out" | "error";

export interface BrokerSignInSnapshot {
  phase: BrokerSignInPhase;
  connectUrl: string | null;
  code: string | null;
  /** A transient poll failure while waiting, or why starting failed. */
  error: string | null;
}

/** What a read of the account's connection tells the flow. */
export type BrokerConnectionRead = Pick<SignedInBrokerConnection, "status"> & { connectedAt?: string | null };

export interface BrokerSignInOptions {
  /**
   * Sign in again although the broker is connected, to start a new sign-in
   * before the broker ends the old one. Without it a connected broker is done
   * at once, as when a device adds a connection the account already holds.
   */
  renew?: boolean;
}

export interface BrokerSignInIo {
  start(brokerId: string, write: boolean): Promise<{ connectUrl: string; code: string; expiresAt: string }>;
  fetchConnection(brokerId: string): Promise<BrokerConnectionRead>;
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

function stamp(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether `now` shows a sign-in made after `before` was read. Renewing a
 * connection takes more than connected: a broker that was connected when the
 * flow began stays connected while the user signs in again, until Gloom stamps
 * the new sign-in. Both reads are Gloom's, so a device clock that runs fast or
 * slow cannot matter.
 */
function signedInSince(before: BrokerConnectionRead, now: BrokerConnectionRead): boolean {
  if (now.status !== "connected") return false;
  if (before.status !== "connected") return true;
  const at = stamp(now.connectedAt);
  const was = stamp(before.connectedAt);
  return at !== null && (was === null || at > was);
}

export class BrokerSignInController {
  private readonly io: BrokerSignInIo;
  private readonly listeners = new Set<(snapshot: BrokerSignInSnapshot) => void>();
  private generation = 0;
  /**
   * Renewing only: the account's connection as first seen. It outlives a
   * restarted code, so a sign-in finished while "r" asked for a new one still
   * counts.
   */
  private before: BrokerConnectionRead | null = null;
  private readonly renew: boolean;
  private snapshot: BrokerSignInSnapshot = { phase: "starting", connectUrl: null, code: null, error: null };

  constructor(
    private readonly broker: SignedInBroker,
    /** Ask for trading as well as reading when the broker offers it. */
    private readonly write: boolean,
    io: Partial<BrokerSignInIo> = {},
    options: BrokerSignInOptions = {},
  ) {
    this.io = { ...defaultIo, ...io };
    this.renew = options.renew === true;
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
    // Renewing: read before a code exists, so nothing the user does can come
    // first. A failed read leaves the first poll to stand in for it: no
    // sign-in finishes within a poll interval.
    if (this.renew && !this.before) {
      const read = await this.io.fetchConnection(this.broker.id).catch(() => null);
      if (stale()) return;
      this.before ??= read;
    }
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
          const connection = await this.io.fetchConnection(this.broker.id);
          // Connected is enough: a user who declined trading still gets a read-only connection.
          let done = connection.status === "connected";
          if (this.renew) {
            this.before ??= connection;
            done = signedInSince(this.before, connection);
          }
          if (done) {
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
  connectBroker(broker: SignedInBroker, write: boolean, renew: boolean): Promise<BrokerSignInOutcome>;
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
  options: BrokerSignInOptions = {},
): Promise<boolean> {
  if (!steps.isSignedIn() && !await steps.signInToGloom()) return false;
  // Trading is asked for only where the broker takes orders from Gloom.
  const scope = write ?? Boolean(broker.capabilities.orders);
  const renew = options.renew === true;
  let outcome = await steps.connectBroker(broker, scope, renew);
  if (outcome === "signed-out" && await steps.signInToGloom()) {
    outcome = await steps.connectBroker(broker, scope, renew);
  }
  return outcome === "connected";
}
