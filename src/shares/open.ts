import type { PaneShareData } from "./payload";

/**
 * How a share link opens in this window. The app binds the path the web
 * app's `?share=` hand-off and a gloomberb://share link already take, so a
 * share opened from chat lands the same way. `fallback` is where the share
 * goes when this app cannot open it (the service is unreachable, or the link
 * holds a snapshot rather than a live pane): the share's own web page.
 */
type ShareOpener = (id: string, options: { fallback?: () => void }) => Promise<void>;

/**
 * How a pane share held here opens, the one a link carries once it is read:
 * an Ask Gloom answer keeps each source as one, and makes it a link only when
 * the answer is shared.
 */
type SharedPaneOpener = (share: PaneShareData) => Promise<void>;

let opener: ShareOpener | null = null;
let paneOpener: SharedPaneOpener | null = null;

export function registerShareOpener(next: ShareOpener, nextPane?: SharedPaneOpener): () => void {
  opener = next;
  if (nextPane) paneOpener = nextPane;
  return () => {
    if (opener === next) opener = null;
    if (nextPane && paneOpener === nextPane) paneOpener = null;
  };
}

/** Opens a shared pane here, or runs `fallback` when nothing in this window opens shares. */
export function openShareLink(id: string, fallback?: () => void): void {
  if (!opener) {
    fallback?.();
    return;
  }
  void opener(id, { fallback });
}

/** Opens a pane share's pane as its link would, or runs `unavailable` when nothing in this window opens shares. */
export function openSharedPane(share: PaneShareData, unavailable?: () => void): void {
  if (!paneOpener) {
    unavailable?.();
    return;
  }
  void paneOpener(share);
}
