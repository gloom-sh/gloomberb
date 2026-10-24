import { createContext } from "react";
import type { apiClient, ScannerFeedEvent, ScannerKind } from "../../../api-client";

// The panes that read a scanner feed, and the shot capture that reads it for
// them. Core (the CLI's `shot` and its page) imports this, not the scanner
// plugin, which imports it too.

export const HILO_PANE_ID = "scanner-hilo";
export const FLOW_PANE_ID = "scanner-flow";
/** SCAN, the user's own live scan; it polls Gloom Cloud rather than reading a shared feed. */
export const LIVE_SCAN_PANE_ID = "scanner-live";
export const LIVE_SCAN_TEMPLATE_ID = "scanner-live-pane";
/** The panes that read a scanner feed, by the scanner each one reads. */
export const SCANNER_PANE_KINDS: Readonly<Record<string, ScannerKind>> = { [HILO_PANE_ID]: "hilo", [FLOW_PANE_ID]: "flow" };

export type ScannerClient = Pick<typeof apiClient, "subscribeScanner">;
/** Where a scanner pane gets its feed; absent, the shared cloud socket. */
export const ScannerClientContext = createContext<ScannerClient | null>(null);

/** What one scanner answered a capture: its first usable payload, or the server's refusal. */
export type ScannerCapture = readonly [scanner: ScannerKind, event: ScannerFeedEvent];

/**
 * A captured pane has the one answer the capture process read with its own
 * session. The page's socket cannot ask again: the server refuses a browser
 * origin like the preview's, and the page holds no credential to send. A live
 * stream would also keep the page from ever holding still for the screenshot.
 */
export function createSnapshotScannerClient(captures: readonly ScannerCapture[]): ScannerClient {
  const answers = new Map(captures);
  return {
    subscribeScanner(scanner, listener) {
      const answer = answers.get(scanner);
      if (answer) listener(answer);
      return () => {};
    },
  };
}

// An idle scanner has to win the lock and seed its universe before it reports,
// which takes several seconds; a short wait turned every cold call into a
// timeout or a stale "degraded" row.
export const SCANNER_SNAPSHOT_TIMEOUT_MS = 30_000;

const SCANNER_LABELS: Record<ScannerKind, string> = {
  hilo: "Highs and lows",
  flow: "Options flow",
};

/**
 * Resolves on the first live or closed payload, or on the server's refusal. A
 * degraded payload is kept and returned only if nothing better arrives before
 * the deadline, since a scanner warming up can pass through a stale row on its
 * way to live.
 */
export function captureScannerEvent(
  client: ScannerClient,
  scanner: ScannerKind,
  signal: AbortSignal,
  timeoutMs = SCANNER_SNAPSHOT_TIMEOUT_MS,
): Promise<ScannerFeedEvent> {
  const label = SCANNER_LABELS[scanner];
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let degraded: ScannerFeedEvent | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(`${label} snapshot aborted`)));
    const timer = setTimeout(() => finish(() => {
      if (degraded) resolve(degraded);
      else reject(new Error(`${label} snapshot timed out`));
    }), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = client.subscribeScanner(scanner, (event: ScannerFeedEvent) => {
      if (event.type === "denied") {
        finish(() => resolve(event));
        return;
      }
      if (event.payload.status === "starting") return;
      if (event.payload.status === "degraded") {
        degraded = event;
        return;
      }
      finish(() => resolve(event));
    });
    if (settled) unsubscribe();
  });
}

