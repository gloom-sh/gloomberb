import { ApiRequestError } from "../../../api-client/errors";
import { isHistoryRetentionError, parseHistoryRetentionError } from "../../../sources/history-retention";

const DATE_MARKER = "__gloomDate";
const MAP_MARKER = "__gloomMap";
const RESPONSE_MARKER = "__gloomRpcResponse";

/** Electrobun serializes thrown errors as message strings, losing API status. */
export async function encodeRpcResponse(load: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return { [RESPONSE_MARKER]: 1, ok: true, value: encodeRpcValue(await load()) };
  } catch (error) {
    if (isHistoryRetentionError(error)) return {
      [RESPONSE_MARKER]: 1,
      ok: false,
      error: { kind: "history-retention", retention: error.retention, candidates: error.candidates, outcomes: error.outcomes },
    };
    if (!(error instanceof ApiRequestError)) throw error;
    return {
      [RESPONSE_MARKER]: 1,
      ok: false,
      error: { message: error.message, status: error.status, retryAfterMs: error.retryAfterMs },
    };
  }
}

/** The backend wraps every response in encodeRpcResponse; anything else is malformed. */
export function decodeRpcResponse<T = unknown>(value: unknown): T {
  if (!value || typeof value !== "object" || !(RESPONSE_MARKER in value)) throw new Error("Invalid desktop response");
  const response = value as Record<string, unknown>;
  if (response[RESPONSE_MARKER] !== 1) throw new Error("Unsupported desktop response");
  if (response.ok === true) return decodeRpcValue<T>(response.value);
  const error = response.error as Record<string, unknown> | null;
  if (response.ok === false && error && typeof error === "object" && error.kind === "history-retention") {
    const retention = parseHistoryRetentionError(error);
    if (!retention) throw new Error("Invalid desktop response");
    throw retention;
  }
  if (response.ok !== false || !error || typeof error !== "object"
    || (error.kind !== undefined && error.kind !== "api")
    || typeof error.message !== "string"
    || (error.status !== undefined && (!Number.isInteger(error.status) || Number(error.status) < 100 || Number(error.status) > 599))
    || (error.retryAfterMs !== undefined && (typeof error.retryAfterMs !== "number" || !Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0))) {
    throw new Error("Invalid desktop response");
  }
  throw new ApiRequestError(error.message, error.status as number | undefined, error.retryAfterMs as number | undefined);
}

export function encodeRpcValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_MARKER]: value.toISOString() };
  }
  if (value instanceof Map) {
    return { [MAP_MARKER]: [...value.entries()].map(([key, entry]) => [key, encodeRpcValue(entry)]) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRpcValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, encodeRpcValue(entry)]),
    );
  }
  return value;
}

export function decodeRpcValue<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeRpcValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record[DATE_MARKER] === "string") {
      return new Date(record[DATE_MARKER]) as T;
    }
    if (Array.isArray(record[MAP_MARKER])) {
      return new Map(record[MAP_MARKER].map((entry) => {
        const pair = entry as [unknown, unknown];
        return [pair[0], decodeRpcValue(pair[1])];
      })) as T;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, decodeRpcValue(entry)]),
    ) as T;
  }
  return value as T;
}
