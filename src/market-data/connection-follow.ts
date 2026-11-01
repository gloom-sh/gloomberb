import {
  GLOOM_CLOUD_HTTP_CONNECTION_ID,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthRegistry,
} from "../core/connection-health";
import type { MarketDataCoordinator } from "./coordinator";

/**
 * A stream that closes and comes straight back (a server restart) is not
 * called stale for it. One that failed (no answer, a network error) is at once:
 * the socket has already waited out its silence by then.
 */
export const QUOTE_STREAM_DOWN_GRACE_MS = 3_000;

/**
 * Keeps the market data in step with the data service's connection: what
 * failed while the service was unreachable is asked again once it answers,
 * and streamed prices read as stale while the quote stream is down.
 */
export function followDataServiceHealth(
  health: ConnectionHealthRegistry,
  coordinator: Pick<MarketDataCoordinator, "reloadAfterOutage" | "setQuoteStreamDown">,
): () => void {
  const stopRecovery = health.subscribeRecovery((sourceId) => {
    if (sourceId === GLOOM_CLOUD_HTTP_CONNECTION_ID) coordinator.reloadAfterOutage();
  });

  /** The stream has been open since it was last torn down on purpose: only then can it go down. */
  let streamed = false;
  let downSince: number | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = () => {
    if (grace) clearTimeout(grace);
    grace = null;
  };
  const followStream = () => {
    const state = health.socketState(GLOOM_CLOUD_SOCKET_CONNECTION_ID);
    if (state === "open" || state === "idle" || state === null) {
      // Open again, or closed on purpose (signed out, nothing left to stream): nothing is down.
      streamed = state === "open";
      clearGrace();
      downSince = null;
      coordinator.setQuoteStreamDown(null);
      return;
    }
    if (!streamed) return;
    if (downSince == null) downSince = Date.now();
    if (state === "error") {
      clearGrace();
      coordinator.setQuoteStreamDown(downSince);
      return;
    }
    if (grace) return;
    const since = downSince;
    grace = setTimeout(() => {
      grace = null;
      if (downSince === since) coordinator.setQuoteStreamDown(since);
    }, QUOTE_STREAM_DOWN_GRACE_MS);
  };
  const stopHealth = health.subscribe(followStream);
  followStream();

  return () => {
    stopRecovery();
    stopHealth();
    clearGrace();
  };
}
