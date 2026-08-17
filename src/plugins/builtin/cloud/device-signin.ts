/**
 * QR / device sign-in flow: start a device authorization, show the code, and
 * poll until the Gloomberb mobile app approves it. On approval the session is
 * adopted through the same persistence and API-client path boot restoration
 * uses, so the rest of the app sees a normal signed-in session.
 */
import { hostname } from "os";
import {
  apiClient,
  type AuthUser,
  type DeviceAuthStartResponse,
  type DeviceAuthTokenResponse,
} from "../../../api-client";
import { chatController } from "../chat/controller";

export type DeviceSignInPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "approved"
  | "denied"
  | "error";

export interface DeviceSignInSnapshot {
  phase: DeviceSignInPhase;
  userCode: string | null;
  verificationUri: string | null;
  /** Signed-in user once phase is "approved". */
  user: AuthUser | null;
  /**
   * Last transport problem. While phase stays "waiting" this is a transient
   * poll failure that is being retried with backoff; with phase "error" the
   * start call itself is being retried.
   */
  error: string | null;
}

export interface DeviceSignInIo {
  start(body: { clientName?: string; clientPlatform?: string }): Promise<DeviceAuthStartResponse>;
  poll(deviceCode: string): Promise<DeviceAuthTokenResponse>;
  adoptSession(sessionToken: string, user: AuthUser): Promise<void>;
  now(): number;
  delay(ms: number): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 30_000;
/** Used when expiresAt is missing or unparseable, so polling can never run forever. */
const DEFAULT_CODE_TTL_MS = 10 * 60_000;
const START_RETRY_BASE_MS = 2_000;
const START_RETRY_MAX_MS = 30_000;
const POLL_BACKOFF_FACTOR = 2;

function defaultClientName(): string {
  try {
    const name = hostname().trim();
    if (name && name !== "localhost") return name;
  } catch {
    // Browser-bundled builds have no hostname; fall through to the generic name.
  }
  return "Gloomberb TUI";
}

function defaultClientPlatform(): string | undefined {
  return typeof process !== "undefined" ? process.platform : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Could not reach Gloomberb Cloud.";
}

export function parseDeviceCodeExpiryMs(expiresAt: unknown, now: number): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now) {
    return expiresAt;
  }
  if (typeof expiresAt === "string") {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return now + DEFAULT_CODE_TTL_MS;
}

const defaultIo: DeviceSignInIo = {
  start: (body) => apiClient.startDeviceSignIn(body),
  poll: (deviceCode) => apiClient.pollDeviceSignIn(deviceCode),
  adoptSession: async (sessionToken, user) => {
    chatController.adoptSession(sessionToken, user);
    // Validate and pick up realtime wiring; the session is already persisted,
    // so a transient failure here must not surface as a sign-in failure.
    await chatController.refreshSession().catch(() => {});
  },
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface DeviceSignInControllerOptions {
  io?: Partial<DeviceSignInIo>;
  clientName?: string;
  clientPlatform?: string;
}

export class DeviceSignInController {
  private readonly io: DeviceSignInIo;
  private readonly clientName: string;
  private readonly clientPlatform: string | undefined;
  private readonly listeners = new Set<(snapshot: DeviceSignInSnapshot) => void>();
  private generation = 0;
  private snapshot: DeviceSignInSnapshot = {
    phase: "idle",
    userCode: null,
    verificationUri: null,
    user: null,
    error: null,
  };

  constructor(options: DeviceSignInControllerOptions = {}) {
    this.io = { ...defaultIo, ...options.io };
    this.clientName = options.clientName ?? defaultClientName();
    this.clientPlatform = options.clientPlatform ?? defaultClientPlatform();
  }

  getSnapshot(): DeviceSignInSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: DeviceSignInSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts (or restarts, after a denial) the flow. Safe to call repeatedly. */
  start(): void {
    const generation = ++this.generation;
    void this.run(generation);
  }

  /** Stops polling. The pending device code simply expires server-side. */
  cancel(): void {
    this.generation += 1;
    if (this.snapshot.phase !== "approved") {
      this.update({ phase: "idle", userCode: null, verificationUri: null, user: null, error: null });
    }
  }

  private update(next: Partial<DeviceSignInSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private isStale(generation: number): boolean {
    return this.generation !== generation;
  }

  private async run(generation: number): Promise<void> {
    let startRetryMs = START_RETRY_BASE_MS;
    // Each iteration is one device code: start, poll to a terminal state, and
    // loop again when the code expired so the QR refreshes instead of dead-ending.
    while (!this.isStale(generation)) {
      this.update({ phase: "starting", userCode: null, verificationUri: null, user: null, error: null });

      let started: DeviceAuthStartResponse;
      try {
        started = await this.io.start({
          clientName: this.clientName,
          clientPlatform: this.clientPlatform,
        });
      } catch (error) {
        if (this.isStale(generation)) return;
        this.update({ phase: "error", error: errorMessage(error) });
        await this.io.delay(startRetryMs);
        startRetryMs = Math.min(startRetryMs * POLL_BACKOFF_FACTOR, START_RETRY_MAX_MS);
        continue;
      }
      if (this.isStale(generation)) return;
      startRetryMs = START_RETRY_BASE_MS;

      this.update({
        phase: "waiting",
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        error: null,
      });

      const outcome = await this.pollUntilSettled(generation, started);
      if (outcome !== "restart") return;
    }
  }

  private async pollUntilSettled(
    generation: number,
    started: DeviceAuthStartResponse,
  ): Promise<"settled" | "restart"> {
    const baseIntervalMs = Math.min(
      Math.max(started.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
      MAX_POLL_INTERVAL_MS,
    );
    const expiresAtMs = parseDeviceCodeExpiryMs(started.expiresAt, this.io.now());
    let intervalMs = baseIntervalMs;

    while (!this.isStale(generation)) {
      if (this.io.now() >= expiresAtMs) return "restart";
      await this.io.delay(intervalMs);
      if (this.isStale(generation)) return "settled";

      let result: DeviceAuthTokenResponse;
      try {
        result = await this.io.poll(started.deviceCode);
      } catch (error) {
        if (this.isStale(generation)) return "settled";
        // Offline or 5xx: back off and keep waiting until the code's TTL.
        intervalMs = Math.min(intervalMs * POLL_BACKOFF_FACTOR, MAX_POLL_INTERVAL_MS);
        this.update({ error: errorMessage(error) });
        continue;
      }
      if (this.isStale(generation)) return "settled";

      switch (result.status) {
        case "pending":
          intervalMs = baseIntervalMs;
          if (this.snapshot.error) this.update({ error: null });
          break;
        case "approved":
          await this.io.adoptSession(result.sessionToken, result.user);
          if (this.isStale(generation)) return "settled";
          this.update({ phase: "approved", user: result.user, error: null });
          return "settled";
        case "denied":
          this.update({ phase: "denied", error: null });
          return "settled";
        case "expired":
          return "restart";
      }
    }
    return "settled";
  }
}
