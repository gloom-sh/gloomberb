import type { Socket } from "electrobun/bun";
import { debugLog } from "../../../../utils/debug-log";

const heldLog = debugLog.createLogger("held-webview-messages");

interface HeldMessagesOptions {
  limitMs: number;
  maxMessages: number;
  /** Sends a window's messages by running script in its page, in order. */
  sendByScript(webviewId: number, messages: string[]): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

type HeldMessages = Socket.WebviewMessageHolder;

/**
 * Holds the messages for a window whose socket has not opened yet, and sends
 * them over it, in order, once it opens. A page connects once, so the wait
 * is bounded: `limitMs` after the first one, or once `maxMessages` wait, the
 * window's messages go by running script in its page, as they did before,
 * and so do later ones until its socket opens.
 */
export function createHeldMessages(options: HeldMessagesOptions): HeldMessages {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const held = new Map<number, { messages: string[]; timer: unknown }>();
  /** Windows whose socket did not open in time: by script until it does. */
  const givenUp = new Set<number>();

  const giveUp = (webviewId: number, why: string) => {
    const entry = held.get(webviewId);
    if (!entry) return;
    clearTimer(entry.timer);
    held.delete(webviewId);
    givenUp.add(webviewId);
    heldLog.warn("A window's socket has not opened; its messages go by running script", { webviewId, why, messages: entry.messages.length });
    options.sendByScript(webviewId, entry.messages);
  };

  return {
    hold(webviewId, message) {
      if (givenUp.has(webviewId)) return false;
      let entry = held.get(webviewId);
      if (!entry) {
        entry = { messages: [], timer: setTimer(() => giveUp(webviewId, "time"), options.limitMs) };
        held.set(webviewId, entry);
      }
      entry.messages.push(message);
      if (entry.messages.length >= options.maxMessages) giveUp(webviewId, "count");
      return true;
    },
    release(webviewId) {
      givenUp.delete(webviewId);
      const entry = held.get(webviewId);
      if (!entry) return [];
      clearTimer(entry.timer);
      held.delete(webviewId);
      return entry.messages;
    },
    forget(webviewId) {
      givenUp.delete(webviewId);
      const entry = held.get(webviewId);
      if (!entry) return;
      clearTimer(entry.timer);
      held.delete(webviewId);
    },
  };
}
