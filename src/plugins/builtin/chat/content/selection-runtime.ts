import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { TextareaRenderable } from "../../../../ui";

interface MutableRef<T> {
  current: T;
}

/**
 * Desktop: a control in the message list that has the page's focus gives it
 * up. Shift-Tab from the composer puts the focus on a message's icon, where
 * Enter presses that icon. Once a row key moves the list's cursor, Enter is
 * the Reply of the row the cursor is on, as that row's icons say, and must not
 * press a control left focused on another row. The terminal has no page, and
 * nothing to let go of.
 */
export function releaseTranscriptFocus(): void {
  const active = (globalThis as {
    document?: { activeElement?: { closest?: (selector: string) => unknown; blur?: () => void } | null };
  }).document?.activeElement;
  if (active?.closest?.('[data-gloom-role="chat-transcript"]')) active.blur?.();
}

export function useChatMessageSelection({
  inputRef,
  messageCount,
  selectedIdx,
  setFollowMessages,
  setSelectedIdx,
}: {
  inputRef: MutableRef<TextareaRenderable | null>;
  messageCount: number;
  selectedIdx: number;
  setFollowMessages: Dispatch<SetStateAction<boolean>>;
  setSelectedIdx: Dispatch<SetStateAction<number>>;
}) {
  const resetTranscriptSelection = useCallback(() => {
    setSelectedIdx(-1);
    setFollowMessages(true);
  }, [setFollowMessages, setSelectedIdx]);

  const moveMessageSelection = useCallback((direction: "up" | "down") => {
    if (messageCount === 0) return false;

    let next: number;
    if (selectedIdx < 0) {
      if (direction === "down") return false;
      next = messageCount - 1;
    } else if (direction === "down") {
      next = Math.min(selectedIdx + 1, messageCount - 1);
    } else {
      next = Math.max(selectedIdx - 1, 0);
    }

    setSelectedIdx(next);
    setFollowMessages(next === messageCount - 1);
    releaseTranscriptFocus();
    return true;
  }, [messageCount, selectedIdx, setFollowMessages, setSelectedIdx]);

  const shouldLeaveComposerForSelection = useCallback((direction: "up" | "down") => {
    const textarea = inputRef.current;
    if (!textarea || textarea.hasSelection()) return false;

    const visualLineCount = Math.max(textarea.virtualLineCount, 1);
    if (direction === "up") {
      return textarea.visualCursor.visualRow <= 0;
    }

    return textarea.visualCursor.visualRow >= visualLineCount - 1;
  }, [inputRef]);

  useEffect(() => {
    if (selectedIdx < messageCount) return;
    setSelectedIdx(messageCount - 1);
  }, [messageCount, selectedIdx, setSelectedIdx]);

  return {
    moveMessageSelection,
    resetTranscriptSelection,
    shouldLeaveComposerForSelection,
  };
}
