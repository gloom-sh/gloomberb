import type { MutableRefObject } from "react";
import { useShortcut } from "../../../../react/input";
import type { ScrollBoxRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import { isPlainKey } from "../../../../utils/keyboard";
import { scrollToBottom } from "../layout";
import type { ChatSidebarRow } from "../sidebar-rows";

export function useChatContentShortcuts({
  beginEditLatestMessage,
  beginReplyTo,
  blurInput,
  canSend,
  cancelEditMessage,
  commandBarOpen,
  clearReplyTarget,
  closeProfilePopover,
  cycleChannel,
  focusChannelSidebar,
  focusChatContent,
  focusComposer,
  focused,
  hasOlderMessages,
  inputFocused,
  inputValueRef,
  loadingOlderMessages,
  messages,
  mentionMenuOpen,
  moveMentionSelection,
  dismissMentionSuggestions,
  commitMentionSelection,
  moveMessageSelection,
  moveSidebarChannelSelection,
  moveSidebarToEdge,
  nativePaneChrome,
  editingMessage,
  profilePopoverOpen,
  replyTo,
  requestOlderMessages,
  requestOlderMessagesIfNeeded,
  returnToComposer,
  scrollRef,
  selectedIdx,
  setFollowMessages,
  setSelectedIdx,
  setSidebarSectionExpanded,
  shouldLeaveComposerForSelection,
  showChannelSidebar,
  sidebarCursorRow,
  sidebarFocusedRef,
}: {
  beginEditLatestMessage: (options?: { deferFocus?: boolean }) => boolean;
  beginReplyTo: (index: number, options?: { deferFocus?: boolean }) => void;
  blurInput: () => void;
  canSend: boolean;
  cancelEditMessage: () => void;
  commandBarOpen: boolean;
  clearReplyTarget: () => void;
  closeProfilePopover: () => void;
  cycleChannel: (direction: 1 | -1) => boolean;
  focusChannelSidebar: () => boolean;
  focusChatContent: () => boolean;
  focusComposer: () => void;
  focused: boolean;
  hasOlderMessages: boolean;
  inputFocused: boolean;
  inputValueRef: MutableRefObject<string>;
  loadingOlderMessages: boolean;
  messages: ChatMessage[];
  mentionMenuOpen: boolean;
  moveMentionSelection: (direction: "up" | "down") => boolean;
  dismissMentionSuggestions: () => boolean;
  commitMentionSelection: () => boolean;
  moveMessageSelection: (direction: "up" | "down") => boolean;
  moveSidebarChannelSelection: (direction: "up" | "down") => boolean;
  moveSidebarToEdge: (edge: "first" | "last") => boolean;
  nativePaneChrome?: boolean;
  editingMessage: ChatMessage | null;
  profilePopoverOpen: boolean;
  replyTo: ChatMessage | null;
  requestOlderMessages: () => void;
  requestOlderMessagesIfNeeded: () => void;
  returnToComposer: () => void;
  scrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  selectedIdx: number;
  setFollowMessages: (followMessages: boolean) => void;
  setSelectedIdx: (selectedIdx: number) => void;
  setSidebarSectionExpanded: (expanded: boolean | "toggle") => boolean;
  shouldLeaveComposerForSelection: (direction: "up" | "down") => boolean;
  showChannelSidebar: boolean;
  sidebarCursorRow: ChatSidebarRow | null;
  sidebarFocusedRef: MutableRefObject<boolean>;
}) {
  useShortcut((event) => {
    if (!focused || commandBarOpen || !inputFocused || !mentionMenuOpen) return;
    if (
      event.name !== "tab"
      || event.ctrl
      || event.meta
      || event.super
      || event.alt
    ) {
      return;
    }

    event.preventDefault?.();
    event.stopPropagation?.();
    commitMentionSelection();
  }, { allowEditable: true, phase: "before" });

  useShortcut((event) => {
    if (!focused || commandBarOpen) return;
    const isEnterKey = event.name === "return" || event.name === "enter";

    if (sidebarFocusedRef.current && showChannelSidebar) {
      // A section header folds and unfolds in place; a channel opens.
      const headerRow = sidebarCursorRow && sidebarCursorRow.kind !== "channel" ? sidebarCursorRow : null;
      if (isEnterKey) {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (!setSidebarSectionExpanded("toggle")) focusChatContent();
        return;
      }

      if (isPlainKey(event, "left")) {
        event.preventDefault?.();
        event.stopPropagation?.();
        setSidebarSectionExpanded(false);
        return;
      }

      if (isPlainKey(event, "right")) {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (headerRow && !headerRow.expanded) setSidebarSectionExpanded(true);
        else focusChatContent();
        return;
      }

      if (isPlainKey(event, "up", "down", "j", "k")) {
        event.preventDefault?.();
        event.stopPropagation?.();
        moveSidebarChannelSelection(event.name === "up" || event.name === "k" ? "up" : "down");
        return;
      }

      if (isPlainKey(event, "home", "end")) {
        event.preventDefault?.();
        event.stopPropagation?.();
        moveSidebarToEdge(event.name === "home" ? "first" : "last");
        return;
      }
    }

    if (
      isPlainKey(event, "left") &&
      showChannelSidebar &&
      (!inputFocused || inputValueRef.current.length === 0) &&
      focusChannelSidebar()
    ) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }

    if (inputFocused) {
      if (mentionMenuOpen) {
        if (event.name === "escape") {
          event.preventDefault?.();
          event.stopPropagation?.();
          dismissMentionSuggestions();
          return;
        }

        if (isPlainKey(event, "up", "down")) {
          event.preventDefault?.();
          event.stopPropagation?.();
          if (event.name === "up" || event.name === "down") {
            moveMentionSelection(event.name);
          }
          return;
        }
      }

      if (event.name === "escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (editingMessage) {
          cancelEditMessage();
        } else if (replyTo) {
          clearReplyTarget();
        } else {
          blurInput();
        }
        return;
      }

      const verticalDirection = event.name === "up" || event.name === "down" ? event.name : null;
      if (
        verticalDirection === "up"
        && canSend
        && isPlainKey(event, "up")
        && inputValueRef.current.trim().length === 0
        && beginEditLatestMessage({ deferFocus: true })
      ) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return;
      }
      if (verticalDirection && isPlainKey(event, "up", "down") && shouldLeaveComposerForSelection(verticalDirection)) {
        const moved = moveMessageSelection(verticalDirection);
        if (moved) {
          event.preventDefault?.();
          event.stopPropagation?.();
          blurInput();
          return;
        }
      }

      return;
    }

    if (isPlainKey(event, "]") && cycleChannel(1)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    if (isPlainKey(event, "[") && cycleChannel(-1)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }

    if (canSend && isEnterKey && selectedIdx >= 0 && selectedIdx < messages.length) {
      event.preventDefault?.();
      event.stopPropagation?.();
      beginReplyTo(selectedIdx, { deferFocus: true });
      return;
    }

    if ((isEnterKey || isPlainKey(event, "i")) && canSend) {
      event.preventDefault?.();
      event.stopPropagation?.();
      queueMicrotask(() => focusComposer());
      return;
    }

    if (event.name === "escape") {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (profilePopoverOpen) {
        closeProfilePopover();
        return;
      }
      if (selectedIdx >= 0) {
        setSelectedIdx(-1);
        setFollowMessages(true);
      }
      return;
    }

    if (isPlainKey(event, "j", "down")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selectedIdx === messages.length - 1) {
        returnToComposer();
        return;
      }
      moveMessageSelection("down");
      return;
    }
    if (isPlainKey(event, "k", "up")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selectedIdx === 0 && hasOlderMessages && !loadingOlderMessages) {
        requestOlderMessages();
        return;
      }
      moveMessageSelection("up");
      return;
    }

    if (isPlainKey(event, "g")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIdx(0);
      setFollowMessages(false);
      scrollRef.current?.scrollTo(0);
      queueMicrotask(requestOlderMessagesIfNeeded);
      return;
    }
    if (event.name === "g" && event.shift) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIdx(messages.length - 1);
      setFollowMessages(true);
      queueMicrotask(() => scrollToBottom(scrollRef.current, nativePaneChrome));
    }
  }, { allowEditable: true });
}
