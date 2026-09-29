import type { JsonValue } from "./protocol";

/** One-line error text for a tool note, capped at `maxLength` characters. */
export function shortReason(error: unknown, maxLength: number): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength) || "Unknown error.";
}

/** Converts any value to wire JSON with sorted keys, so equal values compare and hash equally. */
export function normalizeJson(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => normalizeJson(entry, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = normalizeJson((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}
