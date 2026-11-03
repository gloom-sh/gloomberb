import { BrowserView, Socket } from "electrobun/bun";
import { createHeldMessages } from "./held-messages";

/** How long a window's messages wait for its socket before going by running script. */
const HOLD_LIMIT_MS = 8_000;
/** How many may wait; the next sends them all by running script. */
const MAX_HELD_MESSAGES = 1_000;

let installed = false;

/**
 * On Windows, running script in a page waits on the thread that runs the
 * windows, which is busy loading that very page when its first messages
 * go out: they wait for its socket instead. Once per process.
 */
export function holdWebviewMessagesUntilSocketOpens(platform: string = process.platform): void {
  if (platform !== "win32" || installed) return;
  installed = true;
  Socket.setWebviewMessageHolder(createHeldMessages({
    limitMs: HOLD_LIMIT_MS,
    maxMessages: MAX_HELD_MESSAGES,
    sendByScript(webviewId, messages) {
      const view = BrowserView.getById(webviewId);
      if (!view) return;
      for (const message of messages) view.sendMessageToWebviewViaExecute(message);
    },
  }));
}
