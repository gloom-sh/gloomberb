import type { LayoutConfig } from "../../../types/config";
import { isRecord } from "../../../utils/guards";

/**
 * Plugin pane-state keys that older builds kept in the layout and a pane now
 * keeps in the data directory (`paneSnapshots`): the news panes' articles.
 * Taken out of the config that is written, so one left behind by an older
 * install does not stay in the file for the next one to read.
 */
const LEGACY_SNAPSHOT_KEYS: Readonly<Record<string, readonly RegExp[]>> = {
  news: [
    /^(?:[^:]+:)+articles(?::v\d+)?$/,
    /^articles:[^:]*:[^:]*(?::v\d+)?$/,
    /^story(?::articles)?(?::v\d+)?$/,
  ],
};

/** Whether any saved pane still carries news data that must leave config.json. */
export function hasLegacyPaneSnapshots(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).some((pane) => {
    if (!isRecord(pane) || !isRecord(pane.pluginState)) return false;
    const pluginState = pane.pluginState;
    return Object.entries(LEGACY_SNAPSHOT_KEYS).some(([pluginId, patterns]) => {
      const saved = pluginState[pluginId];
      return isRecord(saved) && Object.keys(saved).some((key) => patterns.some((pattern) => pattern.test(key)));
    });
  });
}

function withoutLegacySnapshots(paneState: Record<string, unknown>): Record<string, unknown> {
  const pluginState = paneState.pluginState;
  if (!isRecord(pluginState)) return paneState;
  let nextPluginState = pluginState;
  for (const [pluginId, patterns] of Object.entries(LEGACY_SNAPSHOT_KEYS)) {
    const saved = pluginState[pluginId];
    if (!isRecord(saved)) continue;
    const kept = Object.keys(saved).filter((key) => !patterns.some((pattern) => pattern.test(key)));
    if (kept.length === Object.keys(saved).length) continue;
    nextPluginState = { ...nextPluginState };
    if (kept.length === 0) delete nextPluginState[pluginId];
    else nextPluginState[pluginId] = Object.fromEntries(kept.map((key) => [key, saved[key]]));
  }
  if (nextPluginState === pluginState) return paneState;
  const { pluginState: _saved, ...rest } = paneState;
  return Object.keys(nextPluginState).length > 0 ? { ...rest, pluginState: nextPluginState } : rest;
}

// Pane state is sanitized on every config write, and most of it is the same
// objects as last time: the store replaces what changed and keeps the rest.
// The result depends on nothing but the input, so it is kept per identity.
const sanitizedValues = new WeakMap<object, unknown>();

function sanitizeSerializableValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") return undefined;
  if (sanitizedValues.has(value)) return sanitizedValues.get(value);
  let sanitized: unknown;
  if (Array.isArray(value)) {
    sanitized = value
      .map((entry) => sanitizeSerializableValue(entry))
      .filter((entry) => entry !== undefined);
  } else if (isRecord(value)) {
    sanitized = Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sanitizeSerializableValue(entry)])
        .filter(([, entry]) => entry !== undefined),
    );
  } else {
    sanitized = undefined;
  }
  sanitizedValues.set(value, sanitized);
  return sanitized;
}

/** The JSON-safe state of the panes the layout still has, dropping everything else. */
export function sanitizeSavedPaneState(
  value: unknown,
  layout: LayoutConfig,
): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const validPaneIds = new Set(layout.instances.map((instance) => instance.instanceId));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([paneId, entry]) => validPaneIds.has(paneId) && isRecord(entry))
      .map(([paneId, entry]) => [paneId, withoutLegacySnapshots(sanitizeSerializableValue(entry) as Record<string, unknown>)])
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  );
}
