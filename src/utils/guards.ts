// Narrowing helpers for unknown payloads: decoded JSON, persisted state, RPC
// messages and anything else that crosses a trust boundary.

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value as a plain object, or null when it is not one. */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** The value as a plain object, or an empty one, so nested reads can chain. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A number that is not NaN or infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The value when it is a finite number, otherwise null. */
export function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}
