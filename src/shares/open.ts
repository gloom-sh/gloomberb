/**
 * How a share link opens in this window. The app binds the path the web
 * app's `?share=` hand-off and a gloomberb://share link already take, so a
 * share opened from chat lands the same way. `fallback` is where the share
 * goes when this app cannot open it (the service is unreachable, or the link
 * holds a snapshot rather than a live pane): the share's own web page.
 */
type ShareOpener = (id: string, options: { fallback?: () => void }) => Promise<void>;

let opener: ShareOpener | null = null;

export function registerShareOpener(next: ShareOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
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
