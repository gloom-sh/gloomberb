import { getCloudApiBaseUrl } from "../../../api-client/request";
import type { DesktopBackendRequestMethod } from "../shared/protocol";

/** What Electrobun's request timer rejects with: no method, request id or caller. */
const ELECTROBUN_REQUEST_TIMEOUT_MESSAGE = "RPC request timed out.";

/**
 * Runs one `backend.request` and, when Electrobun's request timer gives up on
 * it, rethrows the timeout with the request named. Every other failure passes
 * through untouched.
 *
 * The library's error is the same for every method, so crash reports could not
 * tell a stalled update check from a stalled fetch. The name is the method,
 * plus the capability operation for `capability.invoke`. An HTTP request to
 * the Gloom API adds its host and first path segment; any other URL can come
 * from the user's config (a broker gateway, a feed, a plugin endpoint) and is
 * only called external. Never the payload, rest of the path, query or headers.
 * Elapsed time is rounded to 10 s because crash reports are deduplicated per
 * session on the message.
 */
export async function nameRpcTimeout<T>(
  method: DesktopBackendRequestMethod,
  payload: unknown,
  request: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ELECTROBUN_REQUEST_TIMEOUT_MESSAGE) throw error;
    const seconds = Math.round((performance.now() - startedAt) / 10_000) * 10;
    throw new Error(`RPC request timed out: ${describeRequest(method, payload)} after ~${seconds}s`, { cause: error });
  }
}

function describeRequest(method: DesktopBackendRequestMethod, payload: unknown): string {
  if (!payload || typeof payload !== "object") return method;
  const { capabilityId, operationId, url } = payload as Record<string, unknown>;
  if (method === "capability.invoke" && typeof capabilityId === "string" && typeof operationId === "string") {
    return `${method} ${capabilityId}.${operationId}`;
  }
  if (method === "http.fetch" || method === "http.stream.open") {
    return `${method} ${gloomApiArea(url) ?? "external"}`;
  }
  return method;
}

/** `api.gloom.sh/market` for a Gloom API URL, null for anything else. */
function gloomApiArea(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(getCloudApiBaseUrl()).origin) return null;
    const segment = parsed.pathname.split("/")[1];
    return segment ? `${parsed.host}/${segment}` : parsed.host;
  } catch {
    return null;
  }
}
