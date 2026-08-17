import { Box, Text, useUiCapabilities } from "../../../../ui";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { type ScrollBoxRenderable, type TextareaRenderable } from "../../../../ui";
import { useAppDispatch, useAppSelector } from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { blendHex, colors } from "../../../../theme/colors";
import { chatController } from "../controller";
import {
  estimateComposerHeight,
} from "../layout";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  formatChatPaneTitle,
  normalizeChannelId,
} from "../channels";
import { ChatComposerArea } from "./composer";
import { ChatTranscript } from "./transcript";
import {
  ChannelSidebar,
} from "../sidebar";
import { useChatSnapshotState } from "./snapshot";
import { useChatContentShortcuts } from "./shortcuts";
import type { ChatContentController } from "./types";
import { useChatProfilePopover } from "../profile-popover";
import { useChatChannelNavigation } from "./channel-navigation";
import { useChatScrollRuntime, type ChatPrependAnchor } from "./scroll";
import {
  resolveChatContentHeightMetrics,
  resolveChatContentWidthMetrics,
} from "./layout-metrics";
import { buildChatUserByUsername } from "./user-map";
import { useChatComposerRuntime } from "./composer-runtime";
import { useChatMessageSelection } from "./selection-runtime";
import type { ChatMessage } from "../../../../api-client";
import { NewDmDialog } from "./new-dm-dialog";
import { usePluginAppActions } from "../../../runtime";
import { requestAccountManagementTab } from "../../account-management/navigation";
import {
  CHAT_MESSAGE_EDIT_WINDOW_MS,
  findLatestEditableChatMessage,
} from "../edit-window";
import {
  applyMentionSuggestion,
  buildRecentMentionSuggestions,
  detectChatMentionTrigger,
  filterMentionSuggestions,
} from "./mentions";
import { getComposerCursorOffset } from "./composer-cursor";

interface ChatContentProps {
  width: number;
  height: number;
  focused: boolean;
  channelId?: string;
  onChannelChange?: (channelId: string) => void;
  onChannelTitleChange?: (title: string) => void;
  controller?: ChatContentController;
  targetMessageId?: string;
  onTargetMessageHandled?: () => void;
}

export function ChatContent({
  width,
  height,
  focused,
  channelId: rawChannelId,
  onChannelChange,
  onChannelTitleChange,
  controller = chatController,
  targetMessageId,
  onTargetMessageHandled,
}: ChatContentProps) {
  const dispatch = useAppDispatch();
  const { showPane } = usePluginAppActions();
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const channelId = normalizeChannelId(rawChannelId);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const initialSnapshot = controller.getSnapshot(channelId);
  const { nativePaneChrome } = useUiCapabilities();
  const [inputFocused, setInputFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [followMessages, setFollowMessages] = useState(true);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const inputRef = useRef<TextareaRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const messageElementsRef = useRef(new Map<string, unknown>());
  const applyingExternalDraftRef = useRef(false);
  const prependAnchorRef = useRef<ChatPrependAnchor | null>(null);
  const previousEditingChannelIdRef = useRef(channelId);
  const useDefaultControllerChannel = channelId === DEFAULT_CHAT_CHANNEL_ID && !onChannelChange;
  const initialWidthMetrics = resolveChatContentWidthMetrics({
    width,
    height,
    channelCount: initialSnapshot.channels.length,
    nativePaneChrome,
  });
  const composerTextWidthRef = useRef(initialWidthMetrics.composerTextWidth);
  const inputValueRef = useRef(initialSnapshot.draft);
  const [composerDraft, setComposerDraft] = useState(initialSnapshot.draft);
  const [composerCursorOffset, setComposerCursorOffset] = useState(initialSnapshot.draft.length);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const syncComposerState = useCallback((draft: string, cursorOffset = getComposerCursorOffset(inputRef.current, draft)) => {
    setComposerDraft((current) => (current === draft ? current : draft));
    setComposerCursorOffset((current) => (current === cursorOffset ? current : cursorOffset));
  }, []);
  const syncComposerCursor = useCallback(() => {
    const draft = inputRef.current?.editBuffer.getText() ?? inputValueRef.current;
    syncComposerState(draft, getComposerCursorOffset(inputRef.current, draft));
  }, [syncComposerState]);
  const [composerRows, setComposerRows] = useState(() => estimateComposerHeight(initialSnapshot.draft, initialWidthMetrics.composerTextWidth));
  const updateComposerRows = useCallback((draft: string) => {
    const nextRows = estimateComposerHeight(draft, composerTextWidthRef.current);
    setComposerRows((current) => (current === nextRows ? current : nextRows));
  }, []);
  const {
    channels,
    channelsLoading,
    channelStates,
    hasOlderMessages,
    hasSavedSession,
    loading,
    loadingOlderMessages,
    messages,
    onlineCount,
    replyTo,
    setReplyTo,
    user,
  } = useChatSnapshotState({
    applyingExternalDraftRef,
    channelId,
    controller,
    focused,
    initialSnapshot,
    inputRef,
    inputValueRef,
    onComposerStateChange: syncComposerState,
    prependAnchorRef,
    setFollowMessages,
    setSelectedIdx,
    updateComposerRows,
    useDefaultControllerChannel,
  });
  const {
    channelSidebarWidth,
    chatWidth,
    composerTextWidth,
    composerWidth,
    contentWidth,
    messageBodyWidth,
    showChannelSidebar,
  } = resolveChatContentWidthMetrics({
    width,
    height,
    channelCount: channels.length,
    nativePaneChrome,
  });
  composerTextWidthRef.current = composerTextWidth;
  const canSend = !!user?.emailVerified;
  const selectionActive = selectedIdx >= 0 && selectedIdx < messages.length;
  const stickyTranscript = followMessages && !selectionActive;
  const latestMessageId = messages[messages.length - 1]?.id ?? null;
  const [editWindowNowMs, setEditWindowNowMs] = useState(() => Date.now());
  const latestOwnMessage = useMemo(() => {
    if (!user?.id) return null;
    return [...messages]
      .reverse()
      .find((message) => message.user.id === user.id && !message.clientStatus) ?? null;
  }, [messages, user?.id]);

  useEffect(() => {
    if (!latestOwnMessage) return;
    const createdMs = Date.parse(latestOwnMessage.createdAt);
    if (!Number.isFinite(createdMs)) return;
    const expiresInMs = createdMs + CHAT_MESSAGE_EDIT_WINDOW_MS - Date.now();
    if (expiresInMs <= 0) return;
    const timer = setTimeout(() => {
      setEditWindowNowMs(Date.now());
    }, Math.min(expiresInMs + 250, 60_000));
    return () => clearTimeout(timer);
  }, [editWindowNowMs, latestOwnMessage]);

  const latestEditableMessageId = useMemo(() => {
    return findLatestEditableChatMessage(messages, user?.id, editWindowNowMs)?.id ?? null;
  }, [editWindowNowMs, messages, user?.id]);
  useEffect(() => {
    updateComposerRows(inputValueRef.current);
  }, [updateComposerRows]);

  const messageContents = useMemo(() => messages.map((message) => message.content), [messages]);
  const { catalog, openTicker } = useInlineTickers(messageContents);
  const userByUsername = useMemo(() => buildChatUserByUsername(channels, messages), [channels, messages]);
  const activeChannel = useMemo(() => channels.find((channel) => channel.id === channelId), [channelId, channels]);
  const activeChannelTitle = useMemo(() => formatChatPaneTitle(activeChannel, channelId), [activeChannel, channelId]);
  const recentMentionSuggestions = useMemo(() => buildRecentMentionSuggestions({
    activeChannel,
    currentUserId: user?.id,
    messages,
  }), [activeChannel, messages, user?.id]);
  const mentionDisabled = activeChannel?.kind === "direct" || (!activeChannel && channelId.startsWith("dm:"));
  const mentionTrigger = useMemo(() => (
    mentionDisabled ? null : detectChatMentionTrigger(composerDraft, composerCursorOffset)
  ), [
    mentionDisabled,
    composerCursorOffset,
    composerDraft,
  ]);
  const mentionTriggerKey = mentionTrigger
    ? `${channelId}:${mentionTrigger.start}:${mentionTrigger.end}:${mentionTrigger.query}`
    : null;
  const mentionSuggestions = useMemo(() => {
    if (!mentionTrigger || mentionTriggerKey === dismissedMentionKey) return [];
    return filterMentionSuggestions(recentMentionSuggestions, mentionTrigger.query);
  }, [dismissedMentionKey, mentionTrigger, mentionTriggerKey, recentMentionSuggestions]);
  const mentionSelectedIndexSafe = mentionSuggestions.length > 0
    ? Math.min(mentionSelectedIndex, mentionSuggestions.length - 1)
    : 0;
  useEffect(() => {
    setMentionSelectedIndex(0);
  }, [mentionTriggerKey]);
  const {
    composerHeight,
    messageAreaHeight,
  } = resolveChatContentHeightMetrics({
    canSend,
    composerRows,
    editingMessage,
    height,
    mentionSuggestionCount: mentionSuggestions.length,
    nativePaneChrome,
    replyTo,
  });
  const {
    cancelProfilePopoverClose,
    closeProfilePopover,
    profilePopoverUser,
    scheduleProfilePopoverClose,
    showProfilePopover,
  } = useChatProfilePopover();

  const showUserProfilePopover = useCallback((targetUser: Parameters<typeof showProfilePopover>[0]) => {
    showProfilePopover(targetUser, { ownProfile: targetUser.id === user?.id });
  }, [showProfilePopover, user?.id]);

  const openProfileSetup = useCallback(() => {
    closeProfilePopover();
    requestAccountManagementTab("profile");
    showPane("account-management");
  }, [closeProfilePopover, showPane]);

  const blurInput = useCallback(() => {
    setInputFocused(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  useEffect(() => {
    onChannelTitleChange?.(activeChannelTitle);
  }, [activeChannelTitle, onChannelTitleChange]);

  useEffect(() => {
    if (previousEditingChannelIdRef.current === channelId) return;
    previousEditingChannelIdRef.current = channelId;
    setEditingMessage(null);
  }, [channelId]);

  const {
    moveMessageSelection,
    resetTranscriptSelection,
    shouldLeaveComposerForSelection,
  } = useChatMessageSelection({
    inputRef,
    messageCount: messages.length,
    selectedIdx,
    setFollowMessages,
    setSelectedIdx,
  });

  const {
    cycleChannel,
    directExpanded,
    focusChannelSidebar,
    focusChatContent,
    moveSidebarChannelSelection,
    selectSidebarChannel,
    setDirectExpanded,
    setSidebarFocused,
    sidebarCursorChannelId,
    sidebarFocused,
    sidebarFocusedRef,
  } = useChatChannelNavigation({
    blurInput,
    channelId,
    channelIdRef,
    channels,
    channelsLoading,
    focused,
    inputFocused,
    onChannelChange,
    resetTranscriptSelection,
    showChannelSidebar,
  });

  const focusInput = useCallback(() => {
    setNewDmOpen(false);
    setSidebarFocused(false);
    setInputFocused(true);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    inputRef.current?.focus?.();
  }, [dispatch, setSidebarFocused]);

  const closeNewDmDialog = useCallback(() => {
    setNewDmOpen(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  const openNewDmDialog = useCallback(() => {
    blurInput();
    closeProfilePopover();
    setSidebarFocused(false);
    setNewDmOpen(true);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
  }, [blurInput, closeProfilePopover, dispatch, setSidebarFocused]);

  const openConversationFromDialog = useCallback(async (usernames: string[]) => {
    const channel = usernames.length === 1
      ? await controller.openDirectChannel({ username: usernames[0] })
      : await controller.openGroupChannel({ usernames });
    setDirectExpanded(true);
    selectSidebarChannel(channel.id);
    setSidebarFocused(false);
    closeNewDmDialog();
  }, [closeNewDmDialog, controller, selectSidebarChannel, setDirectExpanded, setSidebarFocused]);

  useEffect(() => {
    if (!focused && newDmOpen) {
      closeNewDmDialog();
    }
  }, [closeNewDmDialog, focused, newDmOpen]);

  const {
    beginEditLatestMessage,
    beginEditMessage,
    beginReplyTo,
    cancelEditMessage,
    clearReplyTarget,
    commitLocalDraft,
    editingPreview,
    focusComposer,
    inputPlaceholder,
    replyPreview,
    replaceComposerDraft,
    returnToComposer,
    sendMessage,
  } = useChatComposerRuntime({
    applyingExternalDraftRef,
    blurInput,
    canSend,
    channelId,
    channelIdRef,
    contentWidth,
    controller,
    focusInput,
    focused,
    inputFocused,
    inputRef,
    inputValueRef,
    messages,
    onComposerStateChange: syncComposerState,
    onChannelChange,
    editingMessage,
    latestEditableMessageId,
    replyTo,
    setEditingMessage,
    setDirectExpanded,
    setFollowMessages,
    setReplyTo,
    setSelectedIdx,
    updateComposerRows,
    useDefaultControllerChannel,
  });

  const moveMentionSelection = useCallback((direction: "up" | "down") => {
    if (mentionSuggestions.length === 0) return false;
    setMentionSelectedIndex((current) => {
      const safeCurrent = Math.max(0, Math.min(current, mentionSuggestions.length - 1));
      if (direction === "up") {
        return safeCurrent <= 0 ? mentionSuggestions.length - 1 : safeCurrent - 1;
      }
      return safeCurrent >= mentionSuggestions.length - 1 ? 0 : safeCurrent + 1;
    });
    return true;
  }, [mentionSuggestions.length]);

  const dismissMentionSuggestions = useCallback(() => {
    if (!mentionTriggerKey || mentionSuggestions.length === 0) return false;
    setDismissedMentionKey(mentionTriggerKey);
    return true;
  }, [mentionSuggestions.length, mentionTriggerKey]);

  const commitMentionSelection = useCallback((index = mentionSelectedIndexSafe) => {
    if (!mentionTrigger || mentionSuggestions.length === 0) return false;
    const suggestion = mentionSuggestions[index] ?? mentionSuggestions[0];
    if (!suggestion) return false;
    const replacement = applyMentionSuggestion(composerDraft, mentionTrigger, suggestion);
    replaceComposerDraft(replacement.draft, replacement.cursorOffset);
    setMentionSelectedIndex(0);
    setDismissedMentionKey(mentionTriggerKey);
    queueMicrotask(() => focusInput());
    return true;
  }, [
    composerDraft,
    focusInput,
    mentionSelectedIndexSafe,
    mentionSuggestions,
    mentionTrigger,
    mentionTriggerKey,
    replaceComposerDraft,
  ]);

  const {
    handleTranscriptScrollActivity,
    jumpToMessage,
    registerMessageElement,
    requestOlderMessages,
    requestOlderMessagesIfNeeded,
  } = useChatScrollRuntime({
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
  });

  const handledTargetMessageRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetMessageId || loading || messages.length === 0) return;
    const targetKey = `${channelId}:${targetMessageId}`;
    if (handledTargetMessageRef.current === targetKey) return;
    handledTargetMessageRef.current = targetKey;
    jumpToMessage(targetMessageId);
    onTargetMessageHandled?.();
  }, [
    channelId,
    jumpToMessage,
    loading,
    messages.length,
    onTargetMessageHandled,
    targetMessageId,
  ]);

  useChatContentShortcuts({
    beginEditLatestMessage,
    beginReplyTo,
    blurInput,
    canSend,
    cancelEditMessage,
    commandBarOpen,
    clearReplyTarget,
    cycleChannel,
    focusChannelSidebar,
    focusChatContent,
    focusComposer,
    focused: focused && !newDmOpen,
    hasOlderMessages,
    inputFocused,
    inputValueRef,
    loadingOlderMessages,
    messages,
    mentionMenuOpen: mentionSuggestions.length > 0,
    moveMentionSelection,
    dismissMentionSuggestions,
    commitMentionSelection,
    moveMessageSelection,
    moveSidebarChannelSelection,
    nativePaneChrome,
    editingMessage,
    replyTo,
    requestOlderMessages,
    requestOlderMessagesIfNeeded,
    returnToComposer,
    scrollRef,
    selectedIdx,
    setFollowMessages,
    setSelectedIdx,
    shouldLeaveComposerForSelection,
    showChannelSidebar,
    sidebarFocusedRef,
  });

  const chatContentBg = focused && showChannelSidebar && !sidebarFocused
    ? blendHex(colors.bg, colors.borderFocused, 0.08)
    : undefined;
  const chatLayoutHeight = nativePaneChrome ? "100%" : height;
  const nativeFillStyle = nativePaneChrome ? { minHeight: 0 } : undefined;

  return (
    <Box
      flexDirection="row"
      width={width}
      height={chatLayoutHeight}
      flexGrow={nativePaneChrome ? 1 : undefined}
      style={nativeFillStyle}
    >
      {showChannelSidebar && (
        <ChannelSidebar
          channels={channels}
          channelStates={channelStates}
          activeChannelId={sidebarFocused ? sidebarCursorChannelId : channelId}
          onlineCount={onlineCount}
          width={channelSidebarWidth}
          height={height}
          focused={focused}
          keyboardFocused={sidebarFocused}
          loading={channelsLoading}
          canManageNotifications={!!user?.emailVerified}
          canCreateConversation={!!user?.emailVerified}
          directExpanded={directExpanded}
          onSelect={selectSidebarChannel}
          onFocusRequest={() => setSidebarFocused(true)}
          onCreateConversation={openNewDmDialog}
          onToggleNotifications={(nextChannelId, enabled) => {
            controller.setChannelNotificationsEnabled(nextChannelId, enabled);
          }}
          onToggleDirectExpanded={() => setDirectExpanded((expanded) => !expanded)}
        />
      )}

      <Box
        flexDirection="column"
        width={chatWidth}
        height={chatLayoutHeight}
        flexGrow={nativePaneChrome ? 1 : undefined}
        backgroundColor={chatContentBg}
        position="relative"
        onMouseDown={() => focusChatContent()}
        style={nativeFillStyle}
      >
      {!nativePaneChrome && (
        <Box height={1} width={contentWidth}>
          <Text fg={colors.border}>{"-".repeat(contentWidth)}</Text>
        </Box>
      )}

      <ChatTranscript
        beginReplyTo={beginReplyTo}
        beginEditMessage={beginEditMessage}
        canSend={canSend}
        catalog={catalog}
        cancelProfilePopoverClose={cancelProfilePopoverClose}
        chatWidth={chatWidth}
        contentWidth={contentWidth}
        handleTranscriptScrollActivity={handleTranscriptScrollActivity}
        hoveredIdx={hoveredIdx}
        jumpToMessage={jumpToMessage}
        loading={loading}
        loadingOlderMessages={loadingOlderMessages}
        messageAreaHeight={messageAreaHeight}
        messageBodyWidth={messageBodyWidth}
        messages={messages}
        nativePaneChrome={nativePaneChrome}
        latestEditableMessageId={latestEditableMessageId}
        openTicker={openTicker}
        profilePopoverUser={profilePopoverUser}
        registerMessageElement={registerMessageElement}
        scheduleProfilePopoverClose={scheduleProfilePopoverClose}
        scrollRef={scrollRef}
        selectedIdx={selectedIdx}
        setHoveredIdx={setHoveredIdx}
        showProfilePopover={showUserProfilePopover}
        stickyTranscript={stickyTranscript}
        user={user}
        userByUsername={userByUsername}
        onSetUpProfile={openProfileSetup}
      />

      {newDmOpen ? (
        <NewDmDialog
          width={chatWidth}
          height={height}
          userByUsername={userByUsername}
          currentUserId={user?.id}
          onCancel={closeNewDmDialog}
          onSubmit={openConversationFromDialog}
        />
      ) : null}

      {!nativePaneChrome && !canSend && (
        <Box height={1} width={contentWidth}>
          <Text fg={colors.border}>{"-".repeat(contentWidth)}</Text>
        </Box>
      )}

      <ChatComposerArea
        canSend={canSend}
        cancelEditMessage={cancelEditMessage}
        clearReplyTarget={clearReplyTarget}
        commitLocalDraft={commitLocalDraft}
        composerHeight={composerHeight}
        composerWidth={composerWidth}
        contentWidth={contentWidth}
        focused={focused}
        focusComposer={focusComposer}
        hasSavedSession={hasSavedSession}
        inputFocused={inputFocused}
        inputPlaceholder={inputPlaceholder}
        inputRef={inputRef}
        inputValueRef={inputValueRef}
        nativePaneChrome={nativePaneChrome}
        editingMessage={editingMessage}
        editingPreview={editingPreview}
        replyPreview={replyPreview}
        replyTo={replyTo}
        sendMessage={sendMessage}
        mentionSuggestions={mentionSuggestions}
        mentionSelectedIndex={mentionSelectedIndexSafe}
        onMentionCursorChange={syncComposerCursor}
        onMentionSelect={commitMentionSelection}
        user={user}
      />
      </Box>
    </Box>
  );
}
