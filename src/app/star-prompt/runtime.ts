/**
 * Off everywhere until the terminal app's entry point allows it, after
 * `starPromptEnvironmentAllows`: the desktop app, the web terminal, CLI
 * commands, `shot` and tests never record days or show the line.
 */
let allowed = false;

export function allowStarPrompt(value: boolean): void {
  allowed = value;
}

export function isStarPromptAllowed(): boolean {
  return allowed;
}

interface StarPromptKeyHandlers {
  open(): void;
  dismiss(): void;
}

/** What the notification keys do while the line shows; null otherwise. */
let keyHandlers: StarPromptKeyHandlers | null = null;

/** Hands the notification keys to the line while it shows; returns the release. */
export function bindStarPromptKeys(handlers: StarPromptKeyHandlers): () => void {
  keyHandlers = handlers;
  return () => {
    if (keyHandlers === handlers) keyHandlers = null;
  };
}

/**
 * Runs the line's open or dismiss for the notification keys. False when the
 * line is not showing, so the key goes on to whatever else wants it.
 */
export function pressStarPromptKey(kind: "open" | "dismiss"): boolean {
  if (!keyHandlers) return false;
  if (kind === "open") keyHandlers.open();
  else keyHandlers.dismiss();
  return true;
}
