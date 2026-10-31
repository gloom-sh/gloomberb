import { logFailure } from "../utils/log-failure";
import { apiClient } from "../api-client";
import type { AttentionAction, AttentionCountsPayload } from "../api-client/telemetry";
import { CHART_COMPOSER_PANE_ID, TICKER_RESEARCH_PANE_ID, type TelemetryConfig } from "../types/config";
import { attentionNoticeShown } from "./attention-setting";
import { telemetryOptedOut } from "./crash-reports";
import { currentTelemetryConfig, subscribeTelemetryConfig } from "./live-config";
import { automationActive } from "./usage-counts";
import { cloudSyncController } from "../sync/controller";

const FLUSH_MS = 60_000;
const MAX_AGE_MS = 120_000;
const HOUR_MS = 3_600_000;
const MAX_EVENTS = 100;
const SYMBOL = /^[A-Z0-9^][A-Z0-9.^_:/=-]{0,63}$/;
const ACTIONS = new Set<AttentionAction>(["des", "chart", "quote", "option_chain", "watchlist_add"]);

/**
 * Whether `account`'s ticker opens count. On by default: an explicit `true`
 * counts, `false` never does, and while the setting is untouched the account
 * counts only once this installation has drawn the notice for it.
 */
export function attentionCountsEnabled(
  config: { telemetry?: TelemetryConfig } | null | undefined,
  account: string | null,
  env: Record<string, string | undefined> = {},
): boolean {
  const telemetry = config?.telemetry;
  if (telemetryOptedOut(env) || telemetry?.attention === false) return false;
  return telemetry?.attention === true || attentionNoticeShown(telemetry, account);
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
      // Intentional ignore: Unreadable consent or session state disables attention collection.
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
      } catch (error) {
        logFailure("telemetry-attention-counts", "Could not record attention event")(error);
      }
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
    } catch (error) {
      logFailure("telemetry-attention-counts", "Could not send attention counts")(error);
    }
    finally {
      if (this.inFlight === controller) this.inFlight = null;
      this.schedule();
    }
  }
}

let counter: AttentionCounter | null = null;
let collectionAllowed: (() => boolean) | null = null;

interface AttentionCounterOptions {
  /** False under a privacy signal (`DO_NOT_TRACK`, browser Do Not Track or GPC): nothing counts and no notice shows. */
  allowed(): boolean;
  /** The config the surface launched with; the app's live switches replace it once reported. */
  launchConfig(): { telemetry?: TelemetryConfig } | null | undefined;
  /**
   * Whether this surface has the signed-in account's synced settings, so an
   * Attention Counts off made on another device has arrived before anything
   * counts. Defaults to this session's cloud sync having pulled them; without
   * cloud sync nothing counts. A popped-out desktop window gets them from the
   * main window instead.
   */
  accountSettingsPulled?(): boolean;
}

function cloudSettingsPulled(): boolean {
  return cloudSyncController.getStatus().lastPullAt !== null;
}

/** Installed only by interactive terminal, desktop and web entry points. */
export function installAttentionCounter({
  allowed,
  launchConfig,
  accountSettingsPulled = cloudSettingsPulled,
}: AttentionCounterOptions): () => void {
  counter?.dispose();
  const next = new AttentionCounter({
    isEnabled: () => allowed()
      && accountSettingsPulled()
      && attentionCountsEnabled(currentTelemetryConfig(launchConfig()), apiClient.getCurrentUser()?.id ?? null),
    verifiedSession: () => apiClient.getVerifiedSessionIdentity(),
    send: (payload, signal) => apiClient.reportAttentionCounts(payload, signal),
  });
  counter = next;
  collectionAllowed = allowed;
  const config = subscribeTelemetryConfig(() => next.refresh());
  const auth = apiClient.subscribeCurrentUser(() => next.refresh());
  return () => {
    next.dispose();
    config();
    auth();
    if (counter === next) {
      counter = null;
      collectionAllowed = null;
    }
  };
}

/**
 * Whether this surface counts at all: an interactive entry point installed
 * the collector and no privacy signal is set. The notice shows only here, so
 * CLI commands, `shot`, tests and opted-out environments never draw it.
 */
export function attentionCollectionAvailable(): boolean {
  try {
    return counter !== null && collectionAllowed?.() === true;
  } catch {
    // Intentional ignore: an unreadable privacy signal counts as set.
    return false;
  }
}

/** Sends what the installed counter holds now instead of after its delay. */
export async function __flushAttentionCountsForTests(): Promise<void> {
  await counter?.flush();
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
