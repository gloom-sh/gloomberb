import { useSyncExternalStore } from "react";
import type { CombinedPaneFooter, PaneFooterSegment } from "./footer/model";

/**
 * While a pane's picture is taken its footer reads as a status line: what
 * the pane says about its data (live, delayed, as of) and when the picture
 * was taken, without the action keys, which mean nothing in a picture.
 */
let stamp: { paneId: string; text: string } | null = null;
const listeners = new Set<() => void>();

export function setPaneCaptureStamp(paneId: string, text: string | null): void {
  stamp = text ? { paneId, text } : stamp?.paneId === paneId ? null : stamp;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The status line of the picture being taken of this pane, or null. */
export function usePaneCaptureStamp(paneId: string): string | null {
  return useSyncExternalStore(subscribe, () => (stamp?.paneId === paneId ? stamp.text : null), () => null);
}

export function captureStampFooter(footer: CombinedPaneFooter, text: string | null): CombinedPaneFooter {
  if (!text) return footer;
  // The footer sets it apart from what the pane says about its data, which may itself be a time.
  const segment: PaneFooterSegment = {
    id: "capture-stamp",
    parts: [{ text, tone: "label" }],
  };
  return {
    ...footer,
    info: [...footer.info, segment],
    hints: [],
  };
}
