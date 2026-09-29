import {
  apiClient,
  type FunctionUsageCount,
  type UsageCountsPayload,
  type UsageCountsSurface,
} from "../api-client";
import { isOfficialPluginRepo } from "../plugins/auto-update";
import { listExternalPlugins } from "../plugins/external-runtime";
import type { PluginRegistry } from "../plugins/registry";
import { TICKER_RESEARCH_PANE_ID, type TelemetryConfig } from "../types/config";
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
 * The same setting covers command-bar searches, which are not anonymous:
 * when signed in, a search the user finishes in the bar (the text, the AI's
 * suggestions and the row they ran) is stored with their account to improve
 * search. See `usageTelemetryAllowed` and the command bar's search report.
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
/** Panes the app's own commands open, which no pane template names. */
const PANE_FUNCTIONS: Record<string, string> = {
  [TICKER_RESEARCH_PANE_ID]: "DES",
  help: "HELP",
  "layout-marketplace": "LAY",
  "twitter-feed": "TWIT",
  team: "TEAM",
};

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
   * Without it, or until it has answered, every external plugin's function
   * is `plugin`.
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
let officialIds: ReadonlySet<string> | null = null;
let officialLookup: Promise<void> | null = null;
let automationDepth = 0;
const builtinPlugins = new WeakSet<object>();

/** Reads the config switch and the environment. Absent means on. */
export function usageCountsEnabled(
  config: { telemetry?: TelemetryConfig } | null | undefined,
  env: Record<string, string | undefined> = {},
): boolean {
  if (config?.telemetry?.usage === false) return false;
  return !telemetryOptedOut(env);
}

/**
 * Whether the Usage setting allows sending something right now, for what it
 * covers besides the counts (command-bar searches): the config switch and the
 * environment, plus the installed surface's own opt-outs, such as Do Not
 * Track in the browser and the launch environment on the desktop. Never throws.
 */
export function usageTelemetryAllowed(config: { telemetry?: TelemetryConfig } | null | undefined): boolean {
  try {
    if (!usageCountsEnabled(config, typeof process !== "undefined" ? process.env : undefined)) return false;
    return !host || host.isEnabled();
  } catch {
    return false;
  }
}

/**
 * Tells a function of the app, built-in plugins included, from one an
 * external plugin contributes. `pluginId` is the owner the registry reports.
 * An external plugin keeps its mnemonic only when it was installed from
 * gloom-sh or built into the app; a fork or a private plugin that reuses an
 * official id does not. Never throws; when in doubt the function counts as
 * an external plugin's.
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
    const entry = plugin ? listExternalPlugins().find((candidate) => candidate.plugin === plugin) : undefined;
    // A plugin still being set up after an install is not in the external
    // list yet; only a registered plugin the app started with is built in.
    if (plugin && !entry && builtinPlugins.has(plugin)) return { shortcut, externalPluginId: null };
    const trusted = !!entry && (entry.directory === undefined || isOfficialPluginRepo(entry.repo));
    return { shortcut: trusted ? shortcut : null, externalPluginId: pluginId };
  } catch {
    return { shortcut: null, externalPluginId: pluginId };
  }
}

/** The app's own plugins, as the runtime registers them at startup. */
export function rememberBuiltinPlugins(plugins: Iterable<object>): void {
  for (const plugin of plugins) builtinPlugins.add(plugin);
}

/**
 * The function a pane stands for: the mnemonic of the first template with a
 * shortcut that opens it (charts: G, GP, GIP count as G), owned by whoever
 * registered that template. Never throws; an unknown pane counts as nothing.
 */
export function usageFunctionForPane(
  registry: Pick<PluginRegistry, "allPlugins" | "paneTemplates" | "getPanePluginId" | "getPaneTemplatePluginId">,
  paneId: string,
): UsageFunction {
  try {
    const own = PANE_FUNCTIONS[paneId];
    if (own) return describeUsageFunction(registry, registry.getPanePluginId(paneId), own);
    for (const template of registry.paneTemplates.values()) {
      if (template.paneId !== paneId || !template.shortcut?.prefix) continue;
      return describeUsageFunction(registry, registry.getPaneTemplatePluginId(template.id), template.shortcut.prefix);
    }
    return describeUsageFunction(registry, registry.getPanePluginId(paneId), null);
  } catch {
    return { shortcut: null, externalPluginId: null };
  }
}

/**
 * Runs work that automation drives, such as remote control: what it opens
 * is not the user opening a function.
 */
export async function runAutomated<T>(work: () => Promise<T> | T): Promise<T> {
  automationDepth += 1;
  try {
    return await work();
  } finally {
    automationDepth -= 1;
  }
}

export function automationActive(): boolean {
  return automationDepth > 0;
}

/** Counts one open of a function by the user. Never throws. */
export function recordFunctionOpen(fn: UsageFunction): void {
  try {
    if (automationDepth > 0) return;
    if (host && !host.isEnabled()) return;
    count(fn, "opened");
    scheduleFlush();
  } catch {
    /* Counting must never get in the way of opening a function. */
  }
}

/**
 * Counts the functions open in the workspace restored at launch, one per
 * pane. Only the first call in a session counts; an empty list marks a
 * launch with nothing restored.
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
  if (!next.isEnabled()) {
    pending.clear();
  } else {
    if ([...pending.values()].some((entry) => entry.externalPluginId !== null)) void lookUpOfficialPlugins();
    scheduleFlush();
  }
  return () => {
    if (host === next) host = null;
  };
}

/**
 * Sends what has been counted, waiting at most `timeoutMs`. For an exit
 * path: resolves as soon as there is nothing left, and never rejects. It
 * does not wait on the network before sending, so a page going away still
 * gets its request out.
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
    await Promise.race([flushNow({ exiting: true }), deadline]);
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
  if (externalPluginId !== null) void lookUpOfficialPlugins();
}

function normalizeShortcut(shortcut: string | null | undefined): string {
  const name = shortcut?.trim().toUpperCase() ?? "";
  return FUNCTION_NAME.test(name) ? name : "";
}

/** Asks for the official plugins once an external plugin's function is counted, well before a flush needs them. */
function lookUpOfficialPlugins(): Promise<void> {
  if (officialIds) return Promise.resolve();
  if (officialLookup) return officialLookup;
  const lookup = host?.officialPluginIds;
  if (!lookup) return Promise.resolve();
  officialLookup = Promise.resolve()
    .then(() => lookup())
    .then((ids) => {
      // An empty answer means the registry could not be read; ask again later.
      if (ids.size > 0) officialIds = ids;
    })
    .catch(() => {})
    .finally(() => {
      officialLookup = null;
    });
  return officialLookup;
}

function scheduleFlush(): void {
  if (!host || flushTimer || pending.size === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow({ exiting: false });
  }, flushedOnce ? FLUSH_INTERVAL_MS : FIRST_FLUSH_DELAY_MS);
  // Pending counts must not keep a process alive that is otherwise done;
  // exit paths flush explicitly.
  (flushTimer as { unref?: () => void }).unref?.();
}

function flushNow(options: { exiting: boolean }): Promise<void> {
  // `finally` runs on a later tick, so a batch that ends before its first
  // await still clears `inFlight` after it has been set, not before.
  inFlight ??= sendPending(options).finally(() => {
    inFlight = null;
    // Counts that came in while this batch was out.
    scheduleFlush();
  });
  return inFlight;
}

async function sendPending({ exiting }: { exiting: boolean }): Promise<void> {
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
    if (!exiting && entries.some((entry) => entry.externalPluginId !== null)) await lookUpOfficialPlugins();
    const counts = publicCounts(entries, officialIds ?? new Set());
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
  }
}

/** Public names only: every other plugin's functions merge into one `plugin` count. */
function publicCounts(entries: PendingCount[], official: ReadonlySet<string>): FunctionUsageCount[] {
  const byName = new Map<string, FunctionUsageCount>();
  for (const entry of entries) {
    const fn = entry.externalPluginId === null
      ? entry.name
      : official.has(entry.externalPluginId) && entry.name ? entry.name : OTHER_PLUGIN;
    if (!fn) continue;
    const total = byName.get(fn) ?? { fn, opened: 0, restored: 0 };
    total.opened = Math.min(total.opened + entry.opened, MAX_COUNT);
    total.restored = Math.min(total.restored + entry.restored, MAX_COUNT);
    byName.set(fn, total);
  }
  return [...byName.values()];
}

function send(current: UsageCounterHost, payload: UsageCountsPayload): Promise<void> {
  return current.send ? current.send(payload) : apiClient.reportUsageCounts(payload);
}

/** Test seam: forgets the host, the counts, the official plugins and the session's restore. */
export function resetUsageCountsForTests(): void {
  host = null;
  pending.clear();
  restoredRecorded = false;
  flushedOnce = false;
  inFlight = null;
  officialIds = null;
  officialLookup = null;
  automationDepth = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
