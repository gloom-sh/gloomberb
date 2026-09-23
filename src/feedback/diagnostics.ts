/**
 * The debug context attached to every feedback report: what is running, where,
 * and what went wrong recently. It never includes config, portfolios, broker
 * settings or pane params; the logs are scrubbed by `redactText`.
 */
import { apiClient } from "../api-client";
import { connectionHealth } from "../core/connection-health";
import { getLanguage } from "../i18n";
import { getCurrentPluginTarget } from "../plugins/current-target";
import type { PluginRegistry } from "../plugins/registry";
import type { AppState } from "../state/app/context";
import { debugLog, type LogEntry } from "../utils/debug-log";
import { VERSION } from "../version";
import { redactText, redactValue } from "./redact";
import { FEEDBACK_LOGS_MAX, type FeedbackSource } from "./types";

const RECENT_PROBLEM_WINDOW_MS = 60 * 60_000;
const MAX_PROBLEM_ENTRIES = 150;
const MAX_RECENT_ENTRIES = 150;
const MAX_LINE_CHARS = 400;
const MAX_DATA_CHARS = 300;
/** The server drops diagnostics over 16,000 characters; stay under it. */
const MAX_DIAGNOSTICS_CHARS = 15_000;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * A request error as it can go in a report: scrubbed, then cut. A schema
 * failure echoes the whole request body back (an Ask G prompt, a note), so
 * only its kind is kept.
 */
function connectionError(message: string): string {
  if (message.startsWith("{\"type\":\"validation\"")) {
    try {
      const parsed = JSON.parse(message) as { on?: unknown };
      return `validation failed (${typeof parsed.on === "string" ? parsed.on : "request"})`;
    } catch {
      return "validation failed";
    }
  }
  return clip(redactText(message), MAX_DATA_CHARS);
}

export function feedbackSource(): FeedbackSource {
  return getCurrentPluginTarget();
}

function runtimeInfo(): Record<string, unknown> {
  const proc = typeof process !== "undefined" ? process : undefined;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const env = proc?.env ?? {};
  return {
    platform: proc?.platform ?? (nav as { platform?: string } | undefined)?.platform ?? null,
    arch: proc?.arch ?? null,
    bun: bunVersion ?? null,
    userAgent: getCurrentPluginTarget() === "web" ? nav?.userAgent ?? null : null,
    term: env.TERM ?? null,
    termProgram: env.TERM_PROGRAM ?? null,
    colorTerm: env.COLORTERM ?? null,
    tmux: env.TMUX ? true : undefined,
    ssh: env.SSH_CONNECTION ? true : undefined,
  };
}

function failingConnections(): Array<Record<string, unknown>> {
  return connectionHealth.getSnapshot().sources
    .filter((source) => source.status === "error" || source.status === "disconnected" || source.lastError)
    .slice(0, 20)
    .map((source) => ({
      id: source.id,
      status: source.status,
      socket: source.socketState,
      lastError: source.lastError
        ? {
          at: new Date(source.lastError.at).toISOString(),
          operation: clip(source.lastError.operation, 120),
          error: source.lastError.error ? connectionError(source.lastError.error) : null,
        }
        : null,
    }));
}

export function collectFeedbackDiagnostics(state: AppState, registry: PluginRegistry | null, viewport: { width: number; height: number }): Record<string, unknown> {
  const user = apiClient.getCurrentUser();
  const instances = state.config.layout.instances ?? [];
  const plugins = registry
    ? [...registry.allPlugins.values()]
      .filter((plugin) => !state.config.disabledPlugins.includes(plugin.id))
      .map((plugin) => `${plugin.id}@${plugin.version}`)
    : [];
  const diagnostics = {
    app: { version: VERSION, target: getCurrentPluginTarget(), language: getLanguage(), theme: state.config.theme },
    runtime: runtimeInfo(),
    viewport,
    // The plan tells us which data path they are on. Not `account`: that key
    // is scrubbed as a possible account number.
    cloud: user
      ? { id: user.id, verified: user.emailVerified, plan: user.plan ?? null, effectivePlan: user.effectivePlan ?? null }
      : { signedIn: false },
    layout: {
      panes: instances.map((instance) => instance.paneId).slice(0, 60),
      focusedPane: instances.find((instance) => instance.instanceId === state.focusedPaneId)?.paneId ?? null,
    },
    plugins,
    connections: failingConnections(),
  };
  const result = redactValue(diagnostics) as Record<string, unknown> & { connections: unknown[] };
  while (result.connections.length > 0 && JSON.stringify(result).length > MAX_DIAGNOSTICS_CHARS) {
    result.connections.pop();
  }
  return result;
}

function safeData(data: unknown): string {
  if (data === undefined) return "";
  try {
    const serialized = data instanceof Error
      ? `${data.name}: ${data.message}`
      : JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    if (!serialized) return "";
    return serialized.length > MAX_DATA_CHARS ? `${serialized.slice(0, MAX_DATA_CHARS)}...` : serialized;
  } catch {
    return "[unserializable]";
  }
}

function formatEntry(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  const data = safeData(entry.data);
  const line = `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${entry.message}${data ? ` ${data}` : ""}`;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}

/**
 * Warnings and errors from the last hour plus the most recent lines of any
 * level, oldest first, scrubbed and capped. The newest lines win the cap.
 */
export function collectFeedbackLogs(now = Date.now()): string {
  const entries = debugLog.getEntries();
  const picked = new Map<number, LogEntry>();
  const problems = entries.filter((entry) => (entry.level === "warn" || entry.level === "error") && now - entry.timestamp <= RECENT_PROBLEM_WINDOW_MS);
  for (const entry of problems.slice(-MAX_PROBLEM_ENTRIES)) picked.set(entry.id, entry);
  for (const entry of entries.slice(-MAX_RECENT_ENTRIES)) picked.set(entry.id, entry);
  const lines = [...picked.values()].sort((a, b) => a.id - b.id).map((entry) => redactText(formatEntry(entry)));

  let total = 0;
  let start = lines.length;
  while (start > 0 && total + lines[start - 1]!.length + 1 <= FEEDBACK_LOGS_MAX) {
    start -= 1;
    total += lines[start]!.length + 1;
  }
  return lines.slice(start).join("\n");
}
