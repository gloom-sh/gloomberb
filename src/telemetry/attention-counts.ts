import { apiClient } from "../api-client";
import type { AttentionAction, AttentionCountsPayload } from "../api-client/telemetry";
import { CHART_COMPOSER_PANE_ID, TICKER_RESEARCH_PANE_ID, type TelemetryConfig } from "../types/config";
import { telemetryOptedOut } from "./crash-reports";
import { subscribeTelemetryConfig } from "./live-config";
import { automationActive } from "./usage-counts";

const FLUSH_MS = 60_000;
const MAX_AGE_MS = 120_000;
const HOUR_MS = 3_600_000;
const MAX_EVENTS = 100;
const SYMBOL = /^[A-Z0-9^][A-Z0-9.^_:/=-]{0,63}$/;
const ACTIONS = new Set<AttentionAction>(["des", "chart", "quote", "option_chain", "watchlist_add"]);

/** Ticker-level counting always requires its own explicit consent. */
export function attentionCountsEnabled(
  config: { telemetry?: TelemetryConfig } | null | undefined,
  env: Record<string, string | undefined> = {},
): boolean {
  return config?.telemetry?.attention === true && !telemetryOptedOut(env);
}

interface AttentionHost {
  isEnabled(): boolean;
  /** An opaque object used only to notice account changes, never serialized. */
  verifiedSession(): object | null;
  send(payload: AttentionCountsPayload, signal: AbortSignal): Promise<void>;
  now?(): number;
}

/** No disk queue, identifiers, timestamps in the payload, or retries. */
export class AttentionCounter {
  private readonly pending = new Map<string, AttentionCountsPayload["events"][number]>();
  private session: object | null = null;
  private generation = 0;
  private collectedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private disposed = false;

  constructor(private readonly host: AttentionHost) {}

  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** Synchronous: opt-out, sign-out and account changes erase unsent counts. */
  refresh(): boolean {
    try {
      const session = !this.disposed && this.host.isEnabled() ? this.host.verifiedSession() : null;
      if (!session || session !== this.session) {
        this.clear();
        this.session = session;
      }
      return session !== null;
    } catch {
      this.clear();
      this.session = null;
      return false;
    }
  }

  private clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.collectedAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  dispose(): void {
    this.disposed = true;
    this.refresh();
  }

  /** Capture before awaiting ticker resolution: consent cannot be retroactive. */
  capture(): (symbol: string, action: AttentionAction) => void {
    if (!this.refresh() || automationActive()) return () => {};
    const generation = this.generation;
    return (rawSymbol, action) => {
      try {
        if (!this.refresh() || generation !== this.generation || automationActive()) return;
        const symbol = rawSymbol.trim().toUpperCase();
        if (!SYMBOL.test(symbol) || !ACTIONS.has(action)) return;
        const now = this.now();
        // A suspended window cannot replay an old hour after it wakes up.
        if (this.collectedAt !== null && (now < this.collectedAt || now - this.collectedAt > MAX_AGE_MS
          || Math.floor(now / HOUR_MS) !== Math.floor(this.collectedAt / HOUR_MS))) {
          this.pending.clear();
          this.collectedAt = null;
        }
        if (this.pending.size >= MAX_EVENTS) return;
        this.collectedAt ??= now;
        this.pending.set(`${symbol}\0${action}`, { symbol, action });
        this.schedule();
      } catch { /* A count must never interrupt a user action. */ }
    };
  }

  private schedule(): void {
    if (this.timer || this.pending.size === 0 || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.refresh() || this.inFlight || this.pending.size === 0) return;
    const now = this.now();
    const collectedAt = this.collectedAt!;
    const events = [...this.pending.values()];
    this.pending.clear();
    this.collectedAt = null;
    if (now < collectedAt || now - collectedAt > MAX_AGE_MS
      || Math.floor(now / HOUR_MS) !== Math.floor(collectedAt / HOUR_MS)) return;
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      // There is deliberately no await between the final consent check and send.
      if (this.refresh() && !controller.signal.aborted) {
        await this.host.send({ consent: true, events }, controller.signal);
      }
    } catch { /* Failed batches are dropped, never retried. */ }
    finally {
      if (this.inFlight === controller) this.inFlight = null;
      this.schedule();
    }
  }
}

let counter: AttentionCounter | null = null;

/** Installed only by interactive terminal, desktop and web entry points. */
export function installAttentionCounter(isEnabled: () => boolean): () => void {
  counter?.dispose();
  const next = new AttentionCounter({
    isEnabled,
    verifiedSession: () => apiClient.getVerifiedSessionIdentity(),
    send: (payload, signal) => apiClient.reportAttentionCounts(payload, signal),
  });
  counter = next;
  const config = subscribeTelemetryConfig(() => next.refresh());
  const auth = apiClient.subscribeCurrentUser(() => next.refresh());
  return () => {
    next.dispose();
    config();
    auth();
    if (counter === next) counter = null;
  };
}

export function captureAttentionAction(): (symbol: string, action: AttentionAction) => void {
  return counter?.capture() ?? (() => {});
}

/** Only explicit opens of these built-in surfaces count, never mount or polling. */
export function attentionActionForPane(paneId: string): AttentionAction | null {
  if (paneId === TICKER_RESEARCH_PANE_ID) return "des";
  if (paneId === CHART_COMPOSER_PANE_ID || paneId === "historical-prices") return "chart";
  if (paneId === "quote-monitor") return "quote";
  if (paneId === "options") return "option_chain";
  return null;
}
