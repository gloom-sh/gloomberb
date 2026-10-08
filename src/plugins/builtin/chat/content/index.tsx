import { Box, Text, useRendererHost, useUiCapabilities } from "../../../../ui";
import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import { PageStackView } from "../../../../components/ui";
import { type ScrollBoxRenderable, type TextareaRenderable } from "../../../../ui";
import { useAppDispatch, useAppSelector } from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { blendHex, colors } from "../../../../theme/colors";
import { chatController } from "../controller";
import {
  estimateComposerHeight,
} from "../layout";
import { formatChatPaneTitle } from "../channel-labels";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
} from "../channels";
import { ChatComposerArea } from "./composer";
import { ChatTranscript } from "./transcript";
import {
  ChannelSidebar,
} from "../sidebar";
import { chatSidebarStore } from "../sidebar-store";
import { useChatSnapshotState } from "./snapshot";
import { useChatContentShortcuts } from "./shortcuts";
import { useChatFooter } from "./footer";
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
import { runDiscordCommand } from "../discord-command";
import type { DiscordComposerCommand } from "../composer-commands";
import { useChatMessageSelection } from "./selection-runtime";
import type { ChatAttachment, ChatMessage } from "../../../../api-client";
import { DesktopChatDropOverlay, DesktopChatDropTarget } from "../attachments/desktop";
import { uploadFromTransferFile, type TransferFile } from "../attachments/transfer";
import { readChatImageFiles } from "../attachments/files";
import { NewDmDialog } from "./new-dm-dialog";
import { usePluginAppActions } from "../../../runtime";
import { openTeamPane } from "../../cloud/team/pane-request";
import { teamStore } from "../../cloud/team/store";
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
  const { showPane, createPaneFromTemplate, notify } = usePluginAppActions();
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const channelId = normalizeChannelId(rawChannelId);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const initialSnapshot = controller.getSnapshot(channelId);
  const { nativePaneChrome } = useUiCapabilities();
  const rendererHost = useRendererHost();
  const [inputFocused, setInputFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [followMessages, setFollowMessages] = useState(true);
  const [newDmOpen, setNewDmOpen] = useState(false);
  // Only while the pane is too small for the sidebar: the channel list stands
  // in for the open channel until one is picked.
  const [channelListOpen, setChannelListOpen] = useState(false);
  const inputRef = useRef<TextareaRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const messageElementsRef = useRef(new Map<string, unknown>());
  const applyingExternalDraftRef = useRef(false);
  const prependAnchorRef = useRef<ChatPrependAnchor | null>(null);
  const previousEditingChannelIdRef = useRef(channelId);
  const useDefaultControllerChannel = channelId === DEFAULT_CHAT_CHANNEL_ID && !onChannelChange;
  const sidebarWidth = useSyncExternalStore(
    (onChange) => chatSidebarStore.subscribe(onChange),
    () => chatSidebarStore.getSnapshot().width,
  );
  const initialWidthMetrics = resolveChatContentWidthMetrics({
    width,
    height,
    channelCount: initialSnapshot.channels.length,
    nativePaneChrome,
    sidebarWidth,
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
  const retryMessages = useCallback(() => {
    void controller.refreshChannelMessages(channelId).catch(() => {});
  }, [channelId, controller]);
  const attachmentsSupported = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribeAttachmentSupport(onChange), [controller]),
    () => controller.attachmentsSupported(),
  );
  const [dropActive, setDropActive] = useState(false);
  const attachPickerRef = useRef<(() => void) | null>(null);
  const replaceComposerDraftRef = useRef<((draft: string, cursorOffset?: number) => void) | null>(null);
  const {
    channels,
    channelsLoading,
    channelStates,
    draftAttachments,
    hasOlderMessages,
    hasSavedSession,
    loading,
    loadingOlderMessages,
    messages,
    messagesError,
    replyTo,
    setReplyTo,
    user,
  } = useChatSnapshotState({
    applyingExternalDraftRef,
    channelId,
    controller,
    // A channel hidden behind the list is not being read.
    focused: focused && !channelListOpen,
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
    sidebarWidth,
  });
  // Too small for the sidebar, the list and the open channel take turns as a
  // stack. A single channel has no list to go back to.
  const stackedNav = !showChannelSidebar && channels.length >= 2 && !!onChannelChange;
  const showingChannelList = stackedNav && channelListOpen;
  const channelListVisible = showChannelSidebar || showingChannelList;
  useEffect(() => {
    if (!stackedNav) setChannelListOpen(false);
  }, [stackedNav]);
  composerTextWidthRef.current = composerTextWidth;
  const canSend = !!user?.emailVerified;
  // Images go only to a server that said it takes them, and never into an edit.
  const imagesAvailable = canSend && attachmentsSupported;
  const canAttach = imagesAvailable && !editingMessage;
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
  const { catalog, openTicker } = useInlineTickers(messageContents, { badgeQuotes: true });
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
    stackHeader: stackedNav && !channelListOpen,
    draftAttachmentCount: draftAttachments.length,
  });
  const {
    cancelProfilePopoverClose,
    closeProfilePopover,
    dismissProfilePopover,
    hoverProfilePopover,
    ownProfileConfigured,
    profilePopoverUser,
    scheduleProfilePopoverClose,
    showProfilePopover,
    toggleProfilePopover,
  } = useChatProfilePopover(focused ? user?.id : undefined);

  const showUserProfilePopover = useCallback((targetUser: Parameters<typeof showProfilePopover>[0]) => {
    showProfilePopover(targetUser, { ownProfile: targetUser.id === user?.id });
  }, [showProfilePopover, user?.id]);

  const hoverUserProfile = useCallback((targetUser: Parameters<typeof showProfilePopover>[0]) => {
    hoverProfilePopover(targetUser, { ownProfile: targetUser.id === user?.id });
  }, [hoverProfilePopover, user?.id]);

  const toggleUserProfile = useCallback((targetUser: Parameters<typeof showProfilePopover>[0]) => {
    toggleProfilePopover(targetUser, { ownProfile: targetUser.id === user?.id });
  }, [toggleProfilePopover, user?.id]);

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
    // A card pinned in one channel does not follow into the next.
    closeProfilePopover();
  }, [channelId, closeProfilePopover]);

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

  // The list's cursor switches channels as it moves. Any other switch (a
  // notification, the unread list, a command) shows the channel it opened.
  const listChannelRef = useRef<string | null>(null);
  const onListChannelChange = useMemo(() => (
    onChannelChange
      ? (nextChannelId: string) => {
        listChannelRef.current = nextChannelId;
        onChannelChange(nextChannelId);
      }
      : undefined
  ), [onChannelChange]);
  useEffect(() => {
    if (listChannelRef.current !== channelId) setChannelListOpen(false);
  }, [channelId]);

  const {
    cycleChannel,
    expandDirectSection,
    focusChannelSidebar,
    focusChatContent,
    moveSidebarChannelSelection,
    moveSidebarToEdge,
    selectSidebarChannel,
    setSidebarFocused,
    setSidebarSectionExpanded,
    sidebarCursorChannelId,
    sidebarCursorRow,
    sidebarFocused,
    sidebarFocusedRef,
    sidebarHeaderCursor,
  } = useChatChannelNavigation({
    blurInput,
    canCreateConversation: canSend,
    channelId,
    channelIdRef,
    channels,
    channelsLoading,
    focused,
    inputFocused,
    onChannelChange: onListChannelChange,
    resetTranscriptSelection,
    channelListVisible,
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

  const openChannelList = useCallback(() => {
    blurInput();
    closeNewDmDialog();
    closeProfilePopover();
    setChannelListOpen(true);
  }, [blurInput, closeNewDmDialog, closeProfilePopover]);

  // The list owns the keys while it is shown, with its cursor on the open channel.
  useEffect(() => {
    if (!showingChannelList || !focused || newDmOpen || sidebarFocused) return;
    focusChannelSidebar();
  }, [focusChannelSidebar, focused, newDmOpen, showingChannelList, sidebarFocused]);

  const selectChannelFromList = useCallback((nextChannelId: string) => {
    selectSidebarChannel(nextChannelId);
    setChannelListOpen(false);
    setSidebarFocused(false);
  }, [selectSidebarChannel, setSidebarFocused]);

  // Enter or Right on a channel opens it, which in the stack also leaves the list.
  const openChannelFromList = useCallback(() => {
    if (!focusChatContent()) return false;
    setChannelListOpen(false);
    return true;
  }, [focusChatContent]);

  // Left and the pane menu's Channel List reach the list in either layout.
  const canReachChannelList = channelListVisible || stackedNav;
  const reachChannelList = useCallback(() => {
    if (!stackedNav || channelListOpen) return focusChannelSidebar();
    openChannelList();
    return true;
  }, [channelListOpen, focusChannelSidebar, openChannelList, stackedNav]);

  const openConversationFromDialog = useCallback(async (usernames: string[]) => {
    const channel = usernames.length === 1
      ? await controller.openDirectChannel({ username: usernames[0] })
      : await controller.openGroupChannel({ usernames });
    expandDirectSection();
    selectSidebarChannel(channel.id);
    setChannelListOpen(false);
    setSidebarFocused(false);
    closeNewDmDialog();
  }, [closeNewDmDialog, controller, expandDirectSection, selectSidebarChannel, setSidebarFocused]);

  useEffect(() => {
    if (!focused && newDmOpen) {
      closeNewDmDialog();
    }
  }, [closeNewDmDialog, focused, newDmOpen]);

  const attachFiles = useCallback((files: TransferFile[]) => {
    if (!canAttach) {
      if (imagesAvailable) notify({ body: "Images can't be added to an edit.", type: "info" });
      return;
    }
    if (controller.attachToChannel(channelIdRef.current, files.map(uploadFromTransferFile)) > 0) focusInput();
  }, [canAttach, controller, focusInput, imagesAvailable, notify]);

  const handleDiscordCommand = useCallback((command: DiscordComposerCommand) => {
    void runDiscordCommand(command, { openUrl: (url) => rendererHost.openExternal(url) }).then(notify);
  }, [notify, rendererHost]);

  // The terminal: a pasted or dropped path to an image file attaches the file
  // and leaves the composer. A path that is no file stays as typed.
  const handlePastedImagePaths = useCallback((paths: string[], pasted: string) => {
    const targetChannelId = channelIdRef.current;
    void readChatImageFiles(paths).then((uploads) => {
      if (uploads.length === 0 || channelIdRef.current !== targetChannelId) return;
      const draft = inputValueRef.current;
      const at = draft.indexOf(pasted);
      if (at >= 0) replaceComposerDraftRef.current?.(`${draft.slice(0, at)}${draft.slice(at + pasted.length)}`, at);
      controller.attachToChannel(targetChannelId, uploads);
    }).catch(() => {});
  }, [controller]);

  const removeDraftAttachment = useCallback((localId: string) => {
    controller.removeChannelAttachment(channelIdRef.current, localId);
  }, [controller]);
  const retryDraftAttachment = useCallback((localId: string) => {
    controller.retryChannelAttachment(channelIdRef.current, localId);
  }, [controller]);
  const removeLastDraftAttachment = useCallback(() => {
    const last = draftAttachments[draftAttachments.length - 1];
    if (!last) return false;
    removeDraftAttachment(last.localId);
    return true;
  }, [draftAttachments, removeDraftAttachment]);
  const retryMessage = useCallback((index: number) => {
    const message = messages[index];
    if (message?.clientStatus === "failed") controller.retryChannelMessage(channelIdRef.current, message.id);
  }, [controller, messages]);
  const refreshImageLinks = useCallback((attachment: ChatAttachment) => {
    // Only a signed link expires; a stable one that fails is gone for good.
    if (!/[?&]sig=/.test(attachment.url)) return;
    controller.refreshChannelImageLinks(channelIdRef.current);
  }, [controller]);

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
    expandDirectSection,
    setFollowMessages,
    setReplyTo,
    setSelectedIdx,
    updateComposerRows,
    useDefaultControllerChannel,
    draftAttachmentCount: draftAttachments.length,
    onPastedImagePaths: !nativePaneChrome && canAttach ? handlePastedImagePaths : undefined,
    onDiscordCommand: handleDiscordCommand,
  });
  replaceComposerDraftRef.current = replaceComposerDraft;

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
    composerLayoutKey: editingMessage ? "" : draftAttachments.map((attachment) => attachment.status).join(","),
  });

  // A jump to a message (a notification, the unread list) shows the channel.
  useEffect(() => {
    if (targetMessageId) setChannelListOpen(false);
  }, [targetMessageId]);

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
    closeProfilePopover,
    cycleChannel,
    focusChannelSidebar: reachChannelList,
    focusChatContent: openChannelFromList,
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
    moveSidebarToEdge,
    nativePaneChrome,
    editingMessage,
    profilePopoverOpen: !!profilePopoverUser,
    replyTo,
    requestOlderMessages,
    requestOlderMessagesIfNeeded,
    returnToComposer,
    retryMessage,
    removeLastDraftAttachment,
    scrollRef,
    selectedIdx,
    setFollowMessages,
    setSelectedIdx,
    setSidebarSectionExpanded,
    shouldLeaveComposerForSelection,
    channelListReachable: canReachChannelList,
    sidebarCursorRow,
    sidebarFocusedRef,
  });

  const openTeamChannel = useCallback((teamId: string) => {
    openTeamPane(createPaneFromTemplate, { teamId, section: "channels" });
  }, [createPaneFromTemplate]);
  // With the sidebar focused, keys act on the row under its cursor; otherwise
  // on the open channel.
  const cursorChannelId = sidebarFocused
    ? sidebarCursorRow?.kind === "channel" ? sidebarCursorRow.channel.id : null
    : channels.some((channel) => channel.id === channelId) ? channelId : null;
  const cursorTeamId = sidebarFocused && sidebarCursorRow
    ? sidebarCursorRow.kind === "team-header"
      ? sidebarCursorRow.team ? sidebarCursorRow.teamId : null
      : sidebarCursorRow.kind === "channel" && sidebarCursorRow.teamId && teamStore.getTeam(sidebarCursorRow.teamId)
        ? sidebarCursorRow.teamId
        : null
    : null;
  useChatFooter({
    composing: inputFocused || newDmOpen,
    canSend,
    selectedIdx,
    // While the sidebar has the keys, a message's reply and edit are not on offer.
    selectedMessage: selectionActive && !sidebarFocused ? messages[selectedIdx] ?? null : null,
    latestEditableMessageId,
    beginEditMessage,
    beginReplyTo,
    retryMessage,
    focusComposer,
    catalog,
    openTicker,
    openAttachPicker: canAttach && nativePaneChrome ? () => attachPickerRef.current?.() : null,
    currentUserId: user?.id,
    profilePopoverUser,
    showProfilePopover: showUserProfilePopover,
    closeProfilePopover,
    notificationChannelId: cursorChannelId,
    notificationsEnabled: channelStates.find((state) => state.channelId === cursorChannelId)?.notificationsEnabled === true,
    setChannelNotificationsEnabled: (nextChannelId, enabled) => controller.setChannelNotificationsEnabled(nextChannelId, enabled),
    newChannelTeamId: cursorTeamId,
    openNewDm: openNewDmDialog,
    openTeamChannel,
    canCycleChannels: channels.length > 1 && !!onChannelChange,
    cycleChannel,
    canFocusSidebar: canReachChannelList && !sidebarFocused && !!onChannelChange,
    focusChannelSidebar: reachChannelList,
    jumpToMessage,
    needsProfileSetup: !!user?.id && ownProfileConfigured === false,
    openProfileSetup,
  });

  const chatContentBg = focused && showChannelSidebar && !sidebarFocused
    ? blendHex(colors.bg, colors.borderFocused, 0.08)
    : undefined;
  const chatLayoutHeight = nativePaneChrome ? "100%" : height;
  const nativeFillStyle = nativePaneChrome ? { minHeight: 0 } : undefined;

  const channelSidebar = (
    <ChannelSidebar
      channels={channels}
      channelStates={channelStates}
      activeChannelId={sidebarFocused ? (sidebarHeaderCursor ? "" : sidebarCursorChannelId) : channelId}
      cursorHeaderKey={sidebarFocused ? sidebarHeaderCursor : null}
      width={stackedNav ? width : channelSidebarWidth}
      paneWidth={width}
      resizable={!stackedNav}
      height={height}
      focused={focused}
      keyboardFocused={sidebarFocused}
      loading={channelsLoading}
      canManageNotifications={!!user?.emailVerified}
      canCreateConversation={!!user?.emailVerified}
      needsProfileSetup={!!user?.id && ownProfileConfigured === false}
      onOpenProfile={openProfileSetup}
      onSelect={stackedNav ? selectChannelFromList : selectSidebarChannel}
      onFocusRequest={() => setSidebarFocused(true)}
      onCreateConversation={openNewDmDialog}
      onToggleNotifications={(nextChannelId, enabled) => {
        controller.setChannelNotificationsEnabled(nextChannelId, enabled);
      }}
      onCreateTeamChannel={openTeamChannel}
    />
  );

  const newDmDialog = newDmOpen ? (
    <NewDmDialog
      width={stackedNav ? width : chatWidth}
      height={height}
      userByUsername={userByUsername}
      currentUserId={user?.id}
      onCancel={closeNewDmDialog}
      onSubmit={openConversationFromDialog}
    />
  ) : null;

  const threadPane = (
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
      {/* In the stack, the Back row above takes the place of the top rule. */}
      {!nativePaneChrome && !stackedNav && (
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
        messagesError={messagesError}
        onRetryMessages={retryMessages}
        retryMessage={retryMessage}
        onImageLoadError={refreshImageLinks}
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
        showProfilePopover={hoverUserProfile}
        toggleProfilePopover={toggleUserProfile}
        dismissProfilePopover={dismissProfilePopover}
        stickyTranscript={stickyTranscript}
        user={user}
        userByUsername={userByUsername}
        onSetUpProfile={openProfileSetup}
      />

      {stackedNav ? null : newDmDialog}

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
        draftAttachments={draftAttachments}
        canAttach={canAttach}
        onAttachFiles={attachFiles}
        onRemoveAttachment={removeDraftAttachment}
        onRetryAttachment={retryDraftAttachment}
        attachPickerRef={attachPickerRef}
      />
      {nativePaneChrome && dropActive && <DesktopChatDropOverlay />}
    </Box>
  );
  // Files dropped anywhere on the thread, or pasted into its composer, attach.
  const thread = nativePaneChrome ? (
    <DesktopChatDropTarget
      enabled={imagesAvailable}
      onFiles={attachFiles}
      onDragActiveChange={setDropActive}
    >
      {threadPane}
    </DesktopChatDropTarget>
  ) : threadPane;

  if (stackedNav) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={chatLayoutHeight}
        flexGrow={nativePaneChrome ? 1 : undefined}
        position="relative"
        style={nativeFillStyle}
      >
        <PageStackView
          // Esc first drops a selection or the profile card, then leaves the channel.
          focused={focused && !newDmOpen && !inputFocused && !selectionActive && !profilePopoverUser}
          detailOpen={!channelListOpen}
          onBack={openChannelList}
          rootContent={channelSidebar}
          detailContent={thread}
        />
        {newDmDialog}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      width={width}
      height={chatLayoutHeight}
      flexGrow={nativePaneChrome ? 1 : undefined}
      style={nativeFillStyle}
    >
      {showChannelSidebar && channelSidebar}
      {thread}
    </Box>
  );
}
