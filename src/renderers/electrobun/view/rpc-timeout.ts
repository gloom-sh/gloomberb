import { getCloudApiBaseUrl } from "../../../api-client/request";
import { REQUEST_TIMED_OUT_MESSAGE, RPC_CLOCK_FRESHNESS_MS, rpcAwakeTimeBound, RpcTimeoutError, type RpcClockSample } from "../../../utils/rpc-timeout-error";
import type { DesktopBackendRequestMethod } from "../shared/protocol";

/** How long the view waits for the Bun process to answer one request. */
export const RPC_MAX_REQUEST_TIME_MS = 120_000;

/** What Electrobun's request timer rejects with: no method, request id or caller. */
const ELECTROBUN_REQUEST_TIMEOUT_MESSAGE = "RPC request timed out.";
const EVIDENCE_WAIT_MS = 400;

type ClockProbe = (fresh?: boolean) => Promise<RpcClockSample | null>;

/** Share burst samples and leave at most one clock request outstanding if the host stops answering. */
export function createRpcTimeoutClockProbe(read: () => Promise<RpcClockSample | null>): ClockProbe {
  let recent: { at: number; result: Promise<RpcClockSample | null> } | undefined;
  let pending: Promise<RpcClockSample | null> | undefined;
  return (fresh = false) => {
    const now = Date.now();
    if (pending) return pending;
    if (!fresh && recent && now >= recent.at && now - recent.at < RPC_CLOCK_FRESHNESS_MS) return recent.result;
    const result = Promise.resolve().then(read).catch(() => {
      // Intentional ignore: a failed optional clock RPC provides no sleep evidence and must not fail the primary request.
      return null;
    }).finally(() => { pending = undefined; });
    pending = result;
    recent = { at: now, result };
    return result;
  };
}

async function awakeTimeBound(startedAt: number, timedOutAt: number, before: ReturnType<ClockProbe>, clock: ClockProbe): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([before, clock(true)]).then(([start, end]) => rpcAwakeTimeBound(startedAt, timedOutAt, start, end)),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EVIDENCE_WAIT_MS); }),
    ]);
  } catch {
    // Intentional ignore: rejected clock evidence must not replace the visible timeout or suppress its crash report.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs one `backend.request` and, when Electrobun's request timer gives up on
 * it, rethrows the timeout with the request named in its `report`. Every other
 * failure passes through untouched. A pane shows only the plain message.
 *
 * The library's error is the same for every method, so crash reports could not
 * tell a stalled update check from a stalled fetch. The name is the method,
 * plus the capability operation for `capability.invoke`. An HTTP request to
 * the Gloom API adds its host and first path segment; any other URL can come
 * from the user's config (a broker gateway, a feed, a plugin endpoint) and is
 * only called external. Never the payload, rest of the path, query or headers.
 * Elapsed time is rounded to 10 s because crash reports are deduplicated per
 * session on the reported message. The error keeps its `Error` type, and
 * carries awake-time evidence, when the host can supply it, so sleep can be
 * told from a request that really stalled.
 */
export async function nameRpcTimeout<T>(
  method: DesktopBackendRequestMethod,
  payload: unknown,
  request: () => Promise<T>,
  clock?: ClockProbe,
): Promise<T> {
  const startedAt = performance.now();
  const wallStartedAt = clock ? Date.now() : 0;
  const before = clock?.();
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ELECTROBUN_REQUEST_TIMEOUT_MESSAGE) throw error;
    const elapsedMs = performance.now() - startedAt;
    const wallTimedOutAt = clock ? Date.now() : 0;
    const seconds = Math.round(elapsedMs / 10_000) * 10;
    throw new RpcTimeoutError(REQUEST_TIMED_OUT_MESSAGE, {
      elapsedMs,
      limitMs: RPC_MAX_REQUEST_TIME_MS,
      awakeUpperBoundMs: before && clock ? await awakeTimeBound(wallStartedAt, wallTimedOutAt, before, clock) : null,
      report: `RPC request timed out: ${describeRequest(method, payload)} after ~${seconds}s`,
      cause: error,
    });
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
    // Intentional ignore: a URL that does not parse names no Gloom API area.
    return null;
  }
}
