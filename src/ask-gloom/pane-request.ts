/**
 * Asking Ask Gloom about a pane. Every pane offers it the same way, with no
 * code of its own: the button beside the `?` in a desktop pane header, Ask
 * Gloom in the pane menu, and the pane-ask key. The shell describes the pane
 * here, and Ask Gloom, while its plugin is on, opens a new conversation with
 * the pane attached.
 */

/** A pane as Ask Gloom receives it: what it is and what it showed when asked. */
export interface AskGloomPaneAttachment {
  /** The pane instance. */
  paneId: string;
  /** Its pane type. */
  paneType: string;
  /** What its header calls it, such as `DES AAPL`. */
  title: string;
  /** The function code that opens it, such as `DES`, when one does. */
  code: string | null;
  /** The ticker it shows, when it shows one. */
  symbol: string | null;
  /** How it is set up as the user sees it: its tab, range or view. Short values only. */
  args: Readonly<Record<string, string>>;
  /** Its text as drawn when asked, bounded; null when none could be read. */
  visibleText: string | null;
  /**
   * The pane declares personal data (`PaneDef.personalData`), so Ask Gloom
   * asks before anything it shows leaves the device.
   */
  personal: boolean;
}

type AskGloomPaneHandler = (attachment: AskGloomPaneAttachment) => void;

const handlers = new Set<AskGloomPaneHandler>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Ask Gloom takes pane questions while it is registered. The shell offers the
 * button, the menu entry and the key only then, so a profile with the cloud
 * plugin off shows none of them.
 */
export function registerAskGloomPaneHandler(handler: AskGloomPaneHandler): () => void {
  handlers.add(handler);
  changed();
  return () => {
    if (handlers.delete(handler)) changed();
  };
}

export function canAskGloomAboutPanes(): boolean {
  return handlers.size > 0;
}

export function subscribeAskGloomAboutPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hands the pane to Ask Gloom. False when nothing takes it. */
export function askGloomAboutPane(attachment: AskGloomPaneAttachment): boolean {
  if (handlers.size === 0) return false;
  for (const handler of [...handlers]) handler(attachment);
  return true;
}
