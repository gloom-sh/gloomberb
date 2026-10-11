/**
 * The `?` on a pane, and the pane menu's Docs item, ask for that pane's docs
 * here. The window's global shortcuts answer: the main window opens the
 * pane's entry in DOCS; a popped-out window, which cannot open a pane, shows
 * the pane's help card with its docs link.
 */
type PaneDocsHandler = (paneId: string) => void;

const handlers = new Set<PaneDocsHandler>();

/**
 * One press reaches the terminal header twice, through its button and the
 * shell's hit test, the same as the menu button; the second ask is dropped so
 * one press never opens two readers.
 */
const REPEAT_MS = 300;
let last: { paneId: string; at: number } | null = null;

/**
 * Asks this window for the pane's docs. Without an answer from the app (a
 * shell mounted on its own) `fallback` opens them, through the plugin registry.
 */
export function requestPaneDocs(paneId: string, fallback?: PaneDocsHandler): void {
  const now = Date.now();
  if (last?.paneId === paneId && now - last.at < REPEAT_MS) return;
  last = { paneId, at: now };
  if (handlers.size === 0) {
    fallback?.(paneId);
    return;
  }
  for (const handler of handlers) handler(paneId);
}

export function registerPaneDocsHandler(handler: PaneDocsHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
