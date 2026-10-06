import { useCallback, useEffect, useRef } from "react";
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
  runAfterLayout,
  scrollElementIntoScrollBoxView,
  scrollToBottom,
  scrollToPosition,
} from "../layout";

interface MutableRef<T> {
  current: T;
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
  latestMessageId: string | null;
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
}

export function useChatScrollRuntime({
  channelId,
  catalog,
  contentWidth,
  controller,
  focused,
  hasOlderMessages,
  height,
  latestMessageId,
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
}: ChatScrollRuntimeArgs) {
  const pendingJumpMessageIdRef = useRef<string | null>(null);

  const registerMessageElement = useCallback((messageId: string, node: unknown | null) => {
    if (node) {
      messageElementsRef.current.set(messageId, node);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, [messageElementsRef]);

  const requestOlderMessages = useCallback(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox || loadingOlderMessages || !hasOlderMessages || messages.length === 0) return;
    const exactPixels = nativePaneChrome === true && hasPixelScrollMetrics(scrollBox);

    prependAnchorRef.current = {
      oldestMessageId: messages[0]?.id ?? null,
      scrollHeight: getScrollHeight(scrollBox, exactPixels),
      scrollTop: getScrollTop(scrollBox, exactPixels),
      selectedMessageId: selectedIdx >= 0 ? messages[selectedIdx]?.id ?? null : messages[0]?.id ?? null,
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

  const requestOlderMessagesIfNeeded = useCallback(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox || scrollBox.scrollTop > 1) return;
    requestOlderMessages();
  }, [requestOlderMessages, scrollRef]);

  const handleTranscriptScrollActivity = useCallback((event?: { scroll?: { direction?: "up" | "down" | "left" | "right" } }) => {
    const direction = event?.scroll?.direction;
    runAfterLayout(() => {
      requestOlderMessagesIfNeeded();

      const scrollBox = scrollRef.current;
      if (!scrollBox) return;
      const atBottom = isScrolledToBottom(scrollBox, nativePaneChrome);
      if (direction === "up" && !atBottom) {
        setFollowMessages(false);
        return;
      }

      setFollowMessages(atBottom);
    });
  }, [nativePaneChrome, requestOlderMessagesIfNeeded, scrollRef, setFollowMessages]);

  const scrollToLoadedMessage = useCallback((messageId: string) => {
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return false;

    setSelectedIdx(targetIndex);
    setFollowMessages(false);
    prependAnchorRef.current = null;
    runAfterLayout(() => {
      if (nativePaneChrome && scrollElementIntoScrollBoxView(scrollRef.current, messageElementsRef.current.get(messageId))) return;
      const scrollBox = scrollRef.current;
      if (!scrollBox) return;
      scrollBox.scrollTo(getMessageTopOffset(messages, targetIndex, contentWidth, catalog));
    });
    return true;
  }, [
    catalog,
    contentWidth,
    messageElementsRef,
    messages,
    nativePaneChrome,
    prependAnchorRef,
    scrollRef,
    setFollowMessages,
    setSelectedIdx,
  ]);

  const jumpToMessage = useCallback((messageId: string) => {
    if (scrollToLoadedMessage(messageId)) return;
    pendingJumpMessageIdRef.current = messageId;
    if (hasOlderMessages && !loadingOlderMessages) {
      requestOlderMessages();
    } else {
      pendingJumpMessageIdRef.current = null;
    }
  }, [hasOlderMessages, loadingOlderMessages, requestOlderMessages, scrollToLoadedMessage]);

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
    } else {
      pendingJumpMessageIdRef.current = null;
    }
  }, [hasOlderMessages, loadingOlderMessages, messages, prependAnchorRef, requestOlderMessages, scrollToLoadedMessage]);

  useEffect(() => {
    if (!stickyTranscript) return;
    queueMicrotask(() => scrollToBottom(scrollRef.current, nativePaneChrome));
  }, [channelId, composerLayoutKey, contentWidth, height, latestMessageId, messageAreaHeight, nativePaneChrome, scrollRef, stickyTranscript]);

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

    const previousOldestIndex = currentAnchor.oldestMessageId
      ? messages.findIndex((message) => message.id === currentAnchor.oldestMessageId)
      : -1;
    const exactPixels = nativePaneChrome === true && hasPixelScrollMetrics(scrollBox);
    const addedRows = !exactPixels && previousOldestIndex > 0
      ? getMessageTopOffset(messages, previousOldestIndex, contentWidth, catalog)
      : Math.max(0, getScrollHeight(scrollBox, exactPixels) - currentAnchor.scrollHeight);
    scrollToPosition(scrollBox, currentAnchor.scrollTop + addedRows, exactPixels);
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
    if (!focused || !stickyTranscript) return;
    queueMicrotask(() => scrollToBottom(scrollRef.current, nativePaneChrome));
  }, [focused, nativePaneChrome, scrollRef, stickyTranscript]);

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    if (!selectionActive) return;
    if (prependAnchorRef.current) return;
    if (nativePaneChrome) {
      const selectedMessageId = messages[selectedIdx]?.id ?? "";
      runAfterLayout(() => scrollElementIntoScrollBoxView(scrollRef.current, messageElementsRef.current.get(selectedMessageId)));
      return;
    }
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

  return {
    handleTranscriptScrollActivity,
    jumpToMessage,
    registerMessageElement,
    requestOlderMessages,
    requestOlderMessagesIfNeeded,
  };
}
