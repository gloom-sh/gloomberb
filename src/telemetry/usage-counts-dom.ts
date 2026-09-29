import { flushUsageCounts } from "./usage-counts";

/**
 * The desktop view and the web terminal send what they have counted when the
 * page goes away or into the background. The request uses `keepalive`, so a
 * browser finishes it after unload; a phone that never fires `pagehide`
 * still sends when the tab is hidden.
 */
export function installWindowUsageFlush(target: Window = window): () => void {
  const flush = () => {
    void flushUsageCounts({ timeoutMs: 1_000 });
  };
  const onVisibilityChange = () => {
    if (target.document.visibilityState === "hidden") flush();
  };
  target.addEventListener("pagehide", flush);
  target.document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    target.removeEventListener("pagehide", flush);
    target.document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
