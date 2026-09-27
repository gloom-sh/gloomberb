import type { LayoutConfig } from "../../../types/config";
import { isRecord } from "../../../utils/guards";

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
      .map(([paneId, entry]) => [paneId, sanitizeSerializableValue(entry)])
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  );
}
