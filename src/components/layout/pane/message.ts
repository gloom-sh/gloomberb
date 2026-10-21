import { useEffect, useSyncExternalStore } from "react";
import type { AppNotificationRequest, AppNotificationType } from "../../../types/plugin";
import type { CombinedPaneFooter, PaneFooterPart, PaneFooterSegment } from "./footer/model";

/**
 * What one pane says about itself for a moment: an action of its own that
 * finished or failed, its broker profile, its data. It shows in that pane's
 * footer, never in the app's toasts, which are for app-wide events (a layout
 * saved, sign-in, an update). A pane raises one with `usePaneNotify`, or any
 * code with `notify({ ..., paneId })`.
 */
export interface PaneMessage {
  id: number;
  type: AppNotificationType;
  body: string;
  title?: string;
  action?: { label: string; onClick: () => void };
}

/** How long a message stays, unless it asks otherwise: a failure longer, so it is read. */
export const PANE_MESSAGE_MS = 5_000;
export const PANE_ERROR_MESSAGE_MS = 10_000;

let nextMessageId = 1;
const messages = new Map<string, PaneMessage>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Frames on screen per pane: a message for a pane nobody shows goes to a toast instead. */
const shownFrames = new Map<string, number>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

function clearTimer(paneId: string): void {
  const timer = timers.get(paneId);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(paneId);
}

/** Whether a frame shows this pane now, so a message for it would be seen. */
function isPaneShown(paneId: string): boolean {
  return (shownFrames.get(paneId) ?? 0) > 0;
}

/**
 * Puts `notification` in the footer of the pane it names. False, and nothing
 * shown, when no frame shows that pane (it was closed, or sits in another
 * layout), so the caller can say it another way.
 */
export function showPaneMessage(paneId: string, notification: AppNotificationRequest): boolean {
  const body = notification.body.trim();
  if (!body || !isPaneShown(paneId)) return false;
  clearTimer(paneId);
  const type = notification.type ?? "info";
  const message: PaneMessage = {
    id: nextMessageId++,
    type,
    body,
    ...(notification.title?.trim() ? { title: notification.title.trim() } : {}),
    ...(notification.action ? { action: notification.action } : {}),
  };
  messages.set(paneId, message);
  const duration = notification.persistent
    ? 0
    : notification.duration ?? (type === "error" ? PANE_ERROR_MESSAGE_MS : PANE_MESSAGE_MS);
  // 0 and Infinity both mean "until the next message replaces it".
  if (Number.isFinite(duration) && duration > 0) {
    timers.set(paneId, setTimeout(() => clearPaneMessage(paneId, message.id), duration));
  }
  publish();
  return true;
}

/** Takes the pane's message down: any, or only `id` when it is still the one shown. */
function clearPaneMessage(paneId: string, id?: number): void {
  const current = messages.get(paneId);
  if (!current || (id !== undefined && current.id !== id)) return;
  clearTimer(paneId);
  messages.delete(paneId);
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The message the pane's footer shows now, or null. */
export function getPaneMessage(paneId: string): PaneMessage | null {
  return messages.get(paneId) ?? null;
}

/**
 * A frame shows the pane until the returned function runs. When the last
 * frame goes (the pane closed), its message goes with it.
 */
export function registerPaneFrame(paneId: string): () => void {
  shownFrames.set(paneId, (shownFrames.get(paneId) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const left = (shownFrames.get(paneId) ?? 1) - 1;
    if (left > 0) {
      shownFrames.set(paneId, left);
      return;
    }
    shownFrames.delete(paneId);
    clearPaneMessage(paneId);
  };
}

/**
 * The message a pane frame draws in its footer. The frame counts as showing
 * the pane while it is mounted and `shown` (not covered by another pane).
 */
export function usePaneMessage(paneId: string, shown = true): PaneMessage | null {
  useEffect(() => (shown ? registerPaneFrame(paneId) : undefined), [paneId, shown]);
  return useSyncExternalStore(subscribe, () => getPaneMessage(paneId), () => null);
}

const MESSAGE_TONE: Record<AppNotificationType, PaneFooterPart["tone"]> = {
  error: "negative",
  success: "positive",
  info: "muted",
};

function segmentText(segment: PaneFooterSegment): string {
  return segment.parts.map((part) => part.text).join("").trim();
}

/**
 * The footer with the pane's message first, where a result is read before the
 * pane's standing status. A message with an action makes it a press on the
 * footer and an entry in the pane menu. One the footer already says (a failed
 * sync whose error is now the broker's status) is not said twice.
 */
export function withPaneMessage(footer: CombinedPaneFooter, message: PaneMessage | null, paneId: string): CombinedPaneFooter {
  if (!message) return footer;
  if (!message.action && footer.info.some((segment) => segmentText(segment) === message.body)) return footer;
  const tone = MESSAGE_TONE[message.type];
  const segments: PaneFooterSegment[] = [{
    id: "pane-message",
    clip: true,
    parts: [
      ...(message.title ? [{ text: message.title, tone, bold: true }] : []),
      { text: message.body, tone },
    ],
  }];
  const action = message.action;
  if (!action) return { ...footer, info: [...segments, ...footer.info] };
  const run = () => {
    try {
      action.onClick();
    } finally {
      clearPaneMessage(paneId, message.id);
    }
  };
  segments.push({ id: "pane-message-action", label: action.label, parts: [{ text: action.label, tone: "value" }], onPress: run });
  return {
    ...footer,
    info: [...segments, ...footer.info],
    menu: [
      { id: "pane-message-action", label: action.label, onSelect: run },
      ...(footer.menu.length > 0 ? [{ type: "divider" as const, id: "pane-message:divider" }] : []),
      ...footer.menu,
    ],
  };
}

/** Test seam: forgets every message, timer and frame. */
export function resetPaneMessagesForTest(): void {
  for (const paneId of timers.keys()) clearTimer(paneId);
  messages.clear();
  shownFrames.clear();
  publish();
}
