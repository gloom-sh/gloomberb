import {
  apiClient,
  type FunctionUsageCount,
  type UsageCountsPayload,
  type UsageCountsSurface,
} from "../api-client";
import { listExternalPlugins } from "../plugins/external-runtime";
import type { PluginRegistry } from "../plugins/registry";
import type { TelemetryConfig } from "../types/config";
import { VERSION } from "../version";
import { telemetryOptedOut } from "./crash-reports";

/**
 * Anonymous function usage counts.
 *
 * Counts how often each function is opened (from the command bar, a menu or
 * a link in another pane) and which functions are on screen when the
 * workspace is restored at launch, and posts the counts to Gloom's API,
 * which forwards them to analytics; the app never talks to an analytics
 * service itself. What leaves the machine is each function's mnemonic with
 * its two counts, the surface, the app version, the OS and the random
 * install id. A function from a plugin that is neither built in nor an
 * official gloom-sh plugin goes out as `plugin`, so no private plugin's name
 * leaves the machine. Nothing from the workspace goes along: no tickers,
 * arguments, layouts, portfolios or queries.
 *
 * Counting never throws and never blocks. Counts add up in memory and are
 * sent a minute after the first one, then at most every 15 minutes, and
 * when the app quits.
 */

const FIRST_FLUSH_DELAY_MS = 60_000;
const FLUSH_INTERVAL_MS = 15 * 60_000;
/** Distinct functions held, so one request never carries more than the server takes. */
const MAX_FUNCTIONS = 200;
/** The server clamps each count to this as well. */
const MAX_COUNT = 1_000;
const FUNCTION_NAME = /^[A-Z0-9][A-Z0-9-]{0,23}$/;
const OTHER_PLUGIN = "plugin";

/** A function as the app knows it. Only its public name is ever sent. */
export interface UsageFunction {
  /** The mnemonic the command bar knows it by, such as `DES` or `GP`. */
  shortcut: string | null | undefined;
  /** The external plugin that contributes it; null for the app's own functions. */
  externalPluginId: string | null;
}

export interface UsageCounterHost {
  surface: UsageCountsSurface;
  /** Platform, release and architecture. */
  os?: string;
  /** The off switch, read when a function is counted and again before sending. */
  isEnabled(): boolean;
  /** The crash reports' install id. Null means nothing can be sent yet. */
  getInstallId(): Promise<string | null> | string | null;
  /**
   * The official gloom-sh plugins, whose functions keep their mnemonic.
   * Without it, or when it fails, every external plugin's function is `plugin`.
   */
  officialPluginIds?(): Promise<ReadonlySet<string>>;
  /** Defaults to the Cloud API client. */
  send?(payload: UsageCountsPayload): Promise<void>;
}

interface PendingCount {
  /** The normalized mnemonic; empty when the function has none that could be sent. */
  name: string;
  externalPluginId: string | null;
  opened: number;
  restored: number;
}

let host: UsageCounterHost | null = null;
const pending = new Map<string, PendingCount>();
let restoredRecorded = false;
let flushedOnce = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/** Reads the config switch and the environment. Absent means on. */
export function usageCountsEnabled(
  config: { telemetry?: TelemetryConfig } | null | undefined,
  env: Record<string, string | undefined> = {},
): boolean {
  if (config?.telemetry?.usage === false) return false;
  return !telemetryOptedOut(env);
}

/**
 * Tells a function of the app, built-in plugins included, from one an
 * external plugin contributes. `pluginId` is the owner the registry reports.
 * Never throws; when in doubt the function counts as an external plugin's.
 */
export function describeUsageFunction(
  registry: Pick<PluginRegistry, "allPlugins">,
  pluginId: string | null | undefined,
  shortcut: string | null | undefined,
): UsageFunction {
  if (!pluginId) return { shortcut, externalPluginId: null };
  try {
    const plugin = registry.allPlugins.get(pluginId);
    // By identity rather than id: a failed external plugin can carry a built-in's id.
    const external = !plugin || listExternalPlugins().some((entry) => entry.plugin === plugin);
    return { shortcut, externalPluginId: external ? pluginId : null };
  } catch {
    return { shortcut, externalPluginId: pluginId };
  }
}

/** Counts one open of a function by the user. Never throws. */
export function recordFunctionOpen(fn: UsageFunction): void {
  try {
    if (host && !host.isEnabled()) return;
    count(fn, "opened");
    scheduleFlush();
  } catch {
    /* Counting must never get in the way of opening a function. */
  }
}

/**
 * Counts the functions open in the workspace restored at launch, one per
 * pane. Only the first call in a session counts.
 */
export function recordRestoredFunctions(fns: readonly UsageFunction[]): void {
  try {
    if (restoredRecorded) return;
    restoredRecorded = true;
    if (host && !host.isEnabled()) return;
    for (const fn of fns) count(fn, "restored");
    scheduleFlush();
  } catch {
    /* Best effort. */
  }
}

/** Installs the surface's host and schedules what was counted before it. */
export function installUsageCounter(next: UsageCounterHost): () => void {
  host = next;
  if (!next.isEnabled()) pending.clear();
  else scheduleFlush();
  return () => {
    if (host === next) host = null;
  };
}

/**
 * Sends what has been counted, waiting at most `timeoutMs`. For an exit
 * path: resolves as soon as there is nothing left, and never rejects.
 */
export async function flushUsageCounts(options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0 && !inFlight) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([flushNow(), deadline]);
  } catch {
    /* The caller is on its way out. */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function count(fn: UsageFunction, field: "opened" | "restored"): void {
  const name = normalizeShortcut(fn.shortcut);
  const externalPluginId = fn.externalPluginId;
  // An app function without a mnemonic has no name to send. An external
  // plugin's function is kept either way: it may still go out as `plugin`.
  if (externalPluginId === null && !name) return;
  const key = externalPluginId === null ? name : `${externalPluginId}\u0000${name}`;
  let entry = pending.get(key);
  if (!entry) {
    if (pending.size >= MAX_FUNCTIONS) return;
    entry = { name, externalPluginId, opened: 0, restored: 0 };
    pending.set(key, entry);
  }
  entry[field] = Math.min(entry[field] + 1, MAX_COUNT);
}

function normalizeShortcut(shortcut: string | null | undefined): string {
  const name = shortcut?.trim().toUpperCase() ?? "";
  return FUNCTION_NAME.test(name) ? name : "";
}

function scheduleFlush(): void {
  if (!host || flushTimer || pending.size === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, flushedOnce ? FLUSH_INTERVAL_MS : FIRST_FLUSH_DELAY_MS);
  // Pending counts must not keep a process alive that is otherwise done;
  // exit paths flush explicitly.
  (flushTimer as { unref?: () => void }).unref?.();
}

async function flushNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const current = host;
      if (!current || pending.size === 0) return;
      if (!current.isEnabled()) {
        pending.clear();
        return;
      }
      const installId = await current.getInstallId();
      if (!installId) return;
      const entries = [...pending.values()];
      pending.clear();
      flushedOnce = true;
      const counts = await publicCounts(entries, current);
      if (counts.length === 0) return;
      await send(current, {
        installId,
        surface: current.surface,
        appVersion: VERSION,
        ...(current.os ? { os: current.os } : {}),
        counts,
      });
    } catch {
      // A batch that could not be sent is dropped, not retried: an offline
      // app, a rate limit, or a server without this endpoint yet (404).
    } finally {
      inFlight = null;
      // Counts that came in while this batch was out.
      scheduleFlush();
    }
  })();
  return inFlight;
}

/** Public names only: private plugin functions merge into one `plugin` count. */
async function publicCounts(entries: PendingCount[], current: UsageCounterHost): Promise<FunctionUsageCount[]> {
  const official = entries.some((entry) => entry.externalPluginId !== null)
    ? await officialPluginIds(current)
    : new Set<string>();
  const byName = new Map<string, FunctionUsageCount>();
  for (const entry of entries) {
    const fn = entry.externalPluginId === null
      ? entry.name
      : official.has(entry.externalPluginId) ? entry.name : OTHER_PLUGIN;
    if (!fn) continue;
    const total = byName.get(fn) ?? { fn, opened: 0, restored: 0 };
    total.opened = Math.min(total.opened + entry.opened, MAX_COUNT);
    total.restored = Math.min(total.restored + entry.restored, MAX_COUNT);
    byName.set(fn, total);
  }
  return [...byName.values()];
}

async function officialPluginIds(current: UsageCounterHost): Promise<ReadonlySet<string>> {
  try {
    return (await current.officialPluginIds?.()) ?? new Set();
  } catch {
    return new Set();
  }
}

function send(current: UsageCounterHost, payload: UsageCountsPayload): Promise<void> {
  return current.send ? current.send(payload) : apiClient.reportUsageCounts(payload);
}

/** Test seam: forgets the host, the counts and the session's restore. */
export function resetUsageCountsForTests(): void {
  host = null;
  pending.clear();
  restoredRecorded = false;
  flushedOnce = false;
  inFlight = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
