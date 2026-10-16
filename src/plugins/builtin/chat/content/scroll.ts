import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatContentController } from "./types";
import {
  estimateMessageHeight,
  getMessageTopOffset,
  getScrollHeight,
  getScrollTop,
  getSelectedMessageScrollTop,
  hasPixelScrollMetrics,
  isGroupedWithPrevious,
  isScrolledToBottom,
  readScrollPlace,
  restoreScrollPlace,
  runAfterLayout,
  scrollElementIntoScrollBoxView,
  scrollToBottom,
  scrollToPosition,
  type ScrollPlace,
} from "../layout";

interface MutableRef<T> {
  current: T;
}

interface RequestOlderOptions {
  /** The first message was selected a moment ago, by a key whose state has not been drawn yet. */
  firstIsSelected?: boolean;
}

export interface ChatPrependAnchor {
  oldestMessageId: string | null;
  scrollHeight: number;
  scrollTop: number;
  selectedMessageId: string | null;
}

interface ChatScrollRuntimeArgs {
  channelId: string;
  catalog: Record<string, InlineTickerCatalogEntry>;
  contentWidth: number;
  controller: ChatContentController;
  focused: boolean;
  hasOlderMessages: boolean;
  height: number;
  latestMessage: ChatMessage | null;
  loadingOlderMessages: boolean;
  messageAreaHeight: number;
  messageElementsRef: MutableRef<Map<string, unknown>>;
  messages: ChatMessage[];
  nativePaneChrome?: boolean;
  prependAnchorRef: MutableRef<ChatPrependAnchor | null>;
  scrollRef: MutableRef<ScrollBoxRenderable | null>;
  selectedIdx: number;
  selectionActive: boolean;
  setFollowMessages: (followMessages: boolean) => void;
  setSelectedIdx: (selectedIdx: number) => void;
  stickyTranscript: boolean;
  useDefaultControllerChannel: boolean;
  /**
   * Changes when something below the transcript grows or shrinks without
   * changing its row count, such as the desktop's waiting images.
   */
  composerLayoutKey?: string;
  /** Shows a message the reader was sent to (a notification, a quoted reply) for a moment. */
  highlightMessage: (messageId: string) => void;
  /** Drops the hover on a row: the list moved under the pointer. */
  clearHover: () => void;
  /** Drops the highlight on a message: the reader acted. */
  clearHighlight: () => void;
}

export function useChatScrollRuntime({
  channelId,
  catalog,
  contentWidth,
  controller,
  focused,
  hasOlderMessages,
  height,
  latestMessage,
  loadingOlderMessages,
  messageAreaHeight,
  messageElementsRef,
  messages,
  nativePaneChrome,
  prependAnchorRef,
  scrollRef,
  selectedIdx,
  selectionActive,
  setFollowMessages,
  setSelectedIdx,
  stickyTranscript,
  useDefaultControllerChannel,
  composerLayoutKey,
  highlightMessage,
  clearHover,
  clearHighlight,
}: ChatScrollRuntimeArgs) {
  const pendingJumpMessageIdRef = useRef<string | null>(null);
  const latestMessageId = latestMessage?.id ?? null;
  // Whether the reader is at the bottom of the list, which is where new messages
  // show up. The desktop list reports it as it follows the bottom or is left;
  // the terminal's list follows while `stickyTranscript` holds.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const atBottom = nativePaneChrome ? pinnedToBottom : stickyTranscript;

  const registerMessageElement = useCallback((messageId: string, node: unknown | null) => {
    if (node) {
      messageElementsRef.current.set(messageId, node);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, [messageElementsRef]);

  const requestOlderMessages = useCallback((options?: RequestOlderOptions) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox || loadingOlderMessages || !hasOlderMessages || messages.length === 0) return;
    const exactPixels = nativePaneChrome === true && hasPixelScrollMetrics(scrollBox);

    prependAnchorRef.current = {
      oldestMessageId: messages[0]?.id ?? null,
      scrollHeight: getScrollHeight(scrollBox, exactPixels),
      scrollTop: getScrollTop(scrollBox, exactPixels),
      // Only a selection there is follows the rows down. Nothing selected stays so: the
      // oldest message used to be selected here, and kept the selected band and its Reply
      // button until the reader pressed Esc, which a mouse reader never does.
      selectedMessageId: selectedIdx >= 0
        ? messages[selectedIdx]?.id ?? null
        : options?.firstIsSelected ? messages[0]?.id ?? null : null,
    };
    setFollowMessages(false);
    const request = useDefaultControllerChannel
      ? controller.loadOlderMessages()
      : controller.loadOlderChannelMessages(channelId);
    void request.catch(() => {
      prependAnchorRef.current = null;
    });
  }, [
    channelId,
    controller,
    hasOlderMessages,
    loadingOlderMessages,
    messages,
    nativePaneChrome,
    prependAnchorRef,
    scrollRef,
    selectedIdx,
    setFollowMessages,
    useDefaultControllerChannel,
  ]);

  const requestOlderMessagesIfNeeded = useCallback((options?: RequestOlderOptions) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox || scrollBox.scrollTop > 1) return;
    requestOlderMessages(options);
  }, [requestOlderMessages, scrollRef]);

  // The thread is built again when the pane crosses the width the channel list
  // stops fitting beside it, which would put a reader who scrolled back at the
  // top or the bottom of a list that is otherwise the same. Where the reader was
  // when they last scrolled is kept, and the new transcript takes it back as it
  // comes. It is not read as the old one goes: by then the pane has been resized
  // and the rows re-wrapped, before the list has put the reader's row back.
  const placeRef = useRef<{ channelId: string; place: ScrollPlace } | null>(null);
  const placeSourcesRef = useRef({ channelId, messages, nativePaneChrome });
  placeSourcesRef.current = { channelId, messages, nativePaneChrome };
  const rememberScrollPlace = useCallback(() => {
    const sources = placeSourcesRef.current;
    const place = sources.nativePaneChrome ? readScrollPlace(scrollRef.current, sources.messages, messageElementsRef.current) : null;
    placeRef.current = place ? { channelId: sources.channelId, place } : null;
  }, [messageElementsRef, scrollRef]);
  const takeBackScrollPlace = useCallback(() => {
    const remembered = placeRef.current;
    if (!remembered || remembered.channelId !== placeSourcesRef.current.channelId) return;
    restoreScrollPlace(scrollRef.current, remembered.place, messageElementsRef.current);
  }, [messageElementsRef, scrollRef]);

  const handleTranscriptScrollActivity = useCallback((event?: { scroll?: { direction?: "up" | "down" | "left" | "right" } }) => {
    const direction = event?.scroll?.direction;
    // Rows moved under a pointer that did not: whatever it was over is no longer
    // under it. A wheel or touch move is the reader's own, so a message they
    // were sent to has done its job; the scroll events a list raises when it
    // repositions itself carry no direction.
    clearHover();
    if (event?.scroll) clearHighlight();
    runAfterLayout(() => {
      requestOlderMessagesIfNeeded();

      const scrollBox = scrollRef.current;
      if (!scrollBox) return;
      rememberScrollPlace();
      const atBottom = isScrolledToBottom(scrollBox, nativePaneChrome);
      if (direction === "up" && !atBottom) {
        setFollowMessages(false);
        return;
      }

      setFollowMessages(atBottom);
    });
  }, [clearHighlight, clearHover, nativePaneChrome, rememberScrollPlace, requestOlderMessagesIfNeeded, scrollRef, setFollowMessages]);

  const scrollToLoadedMessage = useCallback((messageId: string) => {
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return false;

    // Shown for a moment, not selected: a selection stays until someone clears
    // it, and holds the list off the bottom for as long.
    highlightMessage(messageId);
    setFollowMessages(false);
    prependAnchorRef.current = null;
    runAfterLayout(() => {
      if (nativePaneChrome && scrollRef.current?.scrollToItem?.(messageId, { align: "center" })) return;
      if (nativePaneChrome && scrollElementIntoScrollBoxView(scrollRef.current, messageElementsRef.current.get(messageId), { center: true })) return;
      const scrollBox = scrollRef.current;
      if (!scrollBox) return;
      scrollBox.scrollTo(getMessageTopOffset(messages, targetIndex, contentWidth, catalog));
      // A message near the bottom leaves the reader at it, and following.
      setFollowMessages(isScrolledToBottom(scrollBox, nativePaneChrome));
    });
    return true;
  }, [
    catalog,
    contentWidth,
    highlightMessage,
    messageElementsRef,
    messages,
    nativePaneChrome,
    prependAnchorRef,
    scrollRef,
    setFollowMessages,
  ]);

  const jumpToLoadedOrOlderMessage = useCallback((messageId: string) => {
    if (scrollToLoadedMessage(messageId)) return;
    pendingJumpMessageIdRef.current = messageId;
    if (hasOlderMessages && !loadingOlderMessages) {
      requestOlderMessages();
    } else if (!hasOlderMessages || !nativePaneChrome) {
      pendingJumpMessageIdRef.current = null;
    }
  }, [hasOlderMessages, loadingOlderMessages, nativePaneChrome, requestOlderMessages, scrollToLoadedMessage]);
  // Every message row takes this: one that changed with the width or the list
  // would draw every row again at each step of a resize and each new message.
  const jumpSourceRef = useRef(jumpToLoadedOrOlderMessage);
  jumpSourceRef.current = jumpToLoadedOrOlderMessage;
  const jumpToMessage = useCallback((messageId: string) => jumpSourceRef.current(messageId), []);

  useEffect(() => {
    const pendingId = pendingJumpMessageIdRef.current;
    if (!pendingId) return;
    if (scrollToLoadedMessage(pendingId)) {
      pendingJumpMessageIdRef.current = null;
      prependAnchorRef.current = null;
      return;
    }
    if (hasOlderMessages && !loadingOlderMessages) {
      requestOlderMessages();
    } else if (!hasOlderMessages || !nativePaneChrome) {
      // The windowed list waits for a page in flight, then continues paging or
      // mounts its target. Leave the terminal's paging path unchanged.
      pendingJumpMessageIdRef.current = null;
    }
  }, [hasOlderMessages, loadingOlderMessages, messages, nativePaneChrome, prependAnchorRef, requestOlderMessages, scrollToLoadedMessage]);

  // The terminal's list follows the bottom itself while it is sticky; this
  // covers what its own layout changes do not (a taller composer, a resize).
  useEffect(() => {
    if (nativePaneChrome || !stickyTranscript) return;
    queueMicrotask(() => scrollToBottom(scrollRef.current, nativePaneChrome));
  }, [channelId, composerLayoutKey, contentWidth, height, latestMessageId, messageAreaHeight, nativePaneChrome, scrollRef, stickyTranscript]);

  // The desktop list follows the bottom while the reader is at it, and keeps a
  // reader who scrolled back where they are (see attachStickyScroll). Only three
  // things take it to the bottom: opening a channel, a message of your own that
  // is going out, and the jump control. Focusing the composer, a resize or an
  // update to a message does not.
  useLayoutEffect(() => {
    if (!nativePaneChrome) return;
    pendingJumpMessageIdRef.current = null;
    scrollToBottom(scrollRef.current, true);
    setPinnedToBottom(true);
  }, [channelId, nativePaneChrome, scrollRef]);
  const lastLatestMessageIdRef = useRef(latestMessageId);
  useLayoutEffect(() => {
    if (lastLatestMessageIdRef.current === latestMessageId) return;
    lastLatestMessageIdRef.current = latestMessageId;
    if (!nativePaneChrome || !latestMessage?.clientStatus) return;
    scrollToBottom(scrollRef.current, true);
    setPinnedToBottom(true);
  }, [latestMessage, latestMessageId, nativePaneChrome, scrollRef]);

  useEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || loadingOlderMessages) return;

    const currentAnchor = anchor;
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    if (pendingJumpMessageIdRef.current) {
      prependAnchorRef.current = null;
      return;
    }

    // The desktop list keeps the row the reader is looking at in place by
    // itself, from where that row is when the page arrives rather than from where
    // the list was when it was asked for: scrolling during the wait is kept.
    if (!nativePaneChrome) {
      const previousOldestIndex = currentAnchor.oldestMessageId
        ? messages.findIndex((message) => message.id === currentAnchor.oldestMessageId)
        : -1;
      const addedRows = previousOldestIndex > 0
        ? getMessageTopOffset(messages, previousOldestIndex, contentWidth, catalog)
        : Math.max(0, getScrollHeight(scrollBox, false) - currentAnchor.scrollHeight);
      scrollToPosition(scrollBox, currentAnchor.scrollTop + addedRows, false);
    }
    if (currentAnchor.selectedMessageId) {
      const selectedMessageIndex = messages.findIndex((message) => message.id === currentAnchor.selectedMessageId);
      if (selectedMessageIndex >= 0) {
        setSelectedIdx(selectedMessageIndex);
      }
    }
    queueMicrotask(() => {
      if (prependAnchorRef.current === currentAnchor) {
        prependAnchorRef.current = null;
      }
    });
  }, [catalog, contentWidth, loadingOlderMessages, messages, nativePaneChrome, prependAnchorRef, scrollRef, setSelectedIdx]);

  useEffect(() => {
    if (nativePaneChrome || !focused || !stickyTranscript) return;
    queueMicrotask(() => scrollToBottom(scrollRef.current, nativePaneChrome));
  }, [focused, nativePaneChrome, scrollRef, stickyTranscript]);

  // The desktop list brings a message into view when the selection moves to it,
  // and only then: a new message or an update to one must not pull a reader who
  // scrolled away back to the selection.
  const selectedMessageId = selectionActive ? messages[selectedIdx]?.id ?? "" : "";
  useEffect(() => {
    if (!nativePaneChrome || !selectedMessageId) return;
    if (prependAnchorRef.current) return;
    runAfterLayout(() => {
      if (scrollRef.current?.scrollToItem?.(selectedMessageId)) return;
      scrollElementIntoScrollBoxView(scrollRef.current, messageElementsRef.current.get(selectedMessageId));
    });
  }, [messageElementsRef, nativePaneChrome, prependAnchorRef, scrollRef, selectedMessageId]);

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || nativePaneChrome) return;
    if (!selectionActive) return;
    if (prependAnchorRef.current) return;
    const top = getMessageTopOffset(messages, selectedIdx, contentWidth, catalog);
    const rowHeight = estimateMessageHeight(messages[selectedIdx]!, contentWidth, isGroupedWithPrevious(messages, selectedIdx), catalog);
    const nextScrollTop = getSelectedMessageScrollTop({
      scrollTop: sb.scrollTop,
      viewportHeight: sb.viewport?.height ?? 0,
      top,
      rowHeight,
    });
    if (nextScrollTop !== sb.scrollTop) {
      sb.scrollTo(nextScrollTop);
    }
  }, [
    catalog,
    contentWidth,
    messageElementsRef,
    messages,
    nativePaneChrome,
    prependAnchorRef,
    scrollRef,
    selectedIdx,
    selectionActive,
  ]);

  /** Takes the reader to the newest message and back to following it. */
  const scrollToLatest = useCallback(() => {
    scrollToBottom(scrollRef.current, nativePaneChrome);
    setPinnedToBottom(true);
    setFollowMessages(true);
  }, [nativePaneChrome, scrollRef, setFollowMessages]);

  return {
    atBottom,
    handleTranscriptScrollActivity,
    jumpToMessage,
    registerMessageElement,
    requestOlderMessages,
    requestOlderMessagesIfNeeded,
    scrollToLatest,
    setPinnedToBottom,
    takeBackScrollPlace,
  };
}
