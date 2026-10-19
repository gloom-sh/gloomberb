import { createContext } from "react";
import type { apiClient, ScannerFeedEvent, ScannerKind } from "../../../api-client";

export const HILO_PANE_ID = "scanner-hilo";
export const FLOW_PANE_ID = "scanner-flow";
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
