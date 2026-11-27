import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useUiCapabilities, type TextareaRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import {
  COMPOSER_ACTION_WIDTH,
  formatInlinePreview,
  normalizeInlinePreview,
} from "../layout";
import { parseChatComposerCommand, type DiscordComposerCommand } from "../composer-commands";
import { t, tf } from "../../../../i18n";
import type { ChatContentController } from "./types";
import { getComposerCursorOffset, moveComposerCursorToOffset } from "./composer-cursor";
import { insertedText, pastedImagePaths } from "../attachments/transfer";
import { composerMessage, joinComposerDraft, pastedShareChips, splitComposerDraft, type ComposerShareLink } from "../pane-links/composer";
import { chatTextWithImages } from "../attachments/model";
import { isManagedBot } from "../ghost-user";
import { CHAT_PERSON_ICON_WIDTH } from "../people";

interface MutableRef<T> {
  current: T;
}

export function useChatComposerRuntime({
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
  isComposerCurrent,
  messages,
  onComposerStateChange,
  onChannelChange,
  editingMessage,
  editingMessageRef,
  latestEditableMessageId,
  replyTo,
  setEditingMessage,
  expandDirectSection,
  setFollowMessages,
  setReplyTo,
  setSelectedIdx,
  updateComposerRows,
  useDefaultControllerChannel,
  draftAttachmentCount = 0,
  draftLinksRef,
  setDraftLinks,
  onPastedImagePaths,
  onConversationStartError,
  onDiscordCommand,
}: {
  applyingExternalDraftRef: MutableRef<boolean>;
  blurInput: () => void;
  canSend: boolean;
  channelId: string;
  channelIdRef: MutableRef<string>;
  contentWidth: number;
  controller: ChatContentController;
  focusInput: () => void;
  focused: boolean;
  inputFocused: boolean;
  inputRef: MutableRef<TextareaRenderable | null>;
  inputValueRef: MutableRef<string>;
  isComposerCurrent: () => boolean;
  messages: ChatMessage[];
  onComposerStateChange?: (draft: string, cursorOffset: number) => void;
  onChannelChange?: (channelId: string) => void;
  editingMessage: ChatMessage | null;
  editingMessageRef: MutableRef<ChatMessage | null>;
  latestEditableMessageId: string | null;
  replyTo: ChatMessage | null;
  setEditingMessage: (message: ChatMessage | null) => void;
  expandDirectSection: () => void;
  setFollowMessages: Dispatch<SetStateAction<boolean>>;
  setReplyTo: Dispatch<SetStateAction<ChatMessage | null>>;
  setSelectedIdx: Dispatch<SetStateAction<number>>;
  updateComposerRows: (draft: string) => void;
  useDefaultControllerChannel: boolean;
  /** Images waiting in the composer: with any, a message may go without text. */
  draftAttachmentCount?: number;
  /** The share links drawn as chips above the field; they go at the end of the message. */
  draftLinksRef: MutableRef<ComposerShareLink[]>;
  setDraftLinks: (links: ComposerShareLink[]) => void;
  /** Set where pasted file paths can attach (the terminal): the paths, and the text that named them. */
  onPastedImagePaths?: (paths: string[], pasted: string) => void;
  /** A `/dm` or `/group` command the server refused, with the names it asked for. */
  onConversationStartError?: (error: unknown, usernames: string[]) => void;
  /** Runs a /discord command. Without it the command is sent as text. */
  onDiscordCommand?: (command: DiscordComposerCommand) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const replyToRef = useRef(replyTo);
  const draftAttachmentCountRef = useRef(draftAttachmentCount);
  draftAttachmentCountRef.current = draftAttachmentCount;
  replyToRef.current = replyTo;
  const editSubmittingRef = useRef<ChatMessage | null>(null);

  const focusComposer = useCallback(() => {
    setSelectedIdx(-1);
    setFollowMessages(true);
    focusInput();
  }, [focusInput, setFollowMessages, setSelectedIdx]);

  const clearReplyTarget = useCallback(() => {
    if (!isComposerCurrent()) return;
    setReplyTo(null);
    if (useDefaultControllerChannel) {
      controller.setReplyToId(null);
    } else {
      controller.setChannelReplyToId(channelId, null);
    }
  }, [channelId, controller, isComposerCurrent, setReplyTo, useDefaultControllerChannel]);

  // The field's text is saved with the links of its chips, the way it will be sent.
  const persistDraft = useCallback((text: string, links: readonly ComposerShareLink[] = draftLinksRef.current) => {
    if (editingMessageRef.current) return;
    const draft = joinComposerDraft(text, links);
    if (useDefaultControllerChannel) {
      controller.setDraft(draft);
    } else {
      controller.setChannelDraft(channelId, draft);
    }
  }, [channelId, controller, draftLinksRef, editingMessageRef, useDefaultControllerChannel]);

  const replaceLocalComposer = useCallback((draft: string, cursorOffset = draft.length) => {
    inputValueRef.current = draft;
    updateComposerRows(draft);
    const textarea = inputRef.current;
    if (textarea && textarea.editBuffer.getText() !== draft) {
      applyingExternalDraftRef.current = true;
      try {
        textarea.setText(draft);
        moveComposerCursorToOffset(textarea, draft, cursorOffset);
      } finally {
        applyingExternalDraftRef.current = false;
      }
    } else if (textarea) {
      moveComposerCursorToOffset(textarea, draft, cursorOffset);
    }
    onComposerStateChange?.(draft, cursorOffset);
  }, [applyingExternalDraftRef, inputRef, inputValueRef, onComposerStateChange, updateComposerRows]);

  const replaceComposerDraft = useCallback((draft: string, cursorOffset = draft.length) => {
    if (!isComposerCurrent()) return;
    replaceLocalComposer(draft, cursorOffset);
    persistDraft(draft);
  }, [isComposerCurrent, persistDraft, replaceLocalComposer]);

  /** New chips above the field, saved with the text as it is. */
  const replaceDraftLinks = useCallback((links: ComposerShareLink[]) => {
    if (!isComposerCurrent()) return;
    setDraftLinks(links);
    persistDraft(inputValueRef.current, links);
  }, [inputValueRef, isComposerCurrent, persistDraft, setDraftLinks]);

  const restoreNewMessageDraft = useCallback(() => {
    setEditingMessage(null);
    const view = splitComposerDraft(controller.getSnapshot(channelId).draft);
    setDraftLinks(view.links);
    replaceLocalComposer(view.text);
  }, [channelId, controller, replaceLocalComposer, setDraftLinks, setEditingMessage]);

  const beginReplyTo = useCallback((index: number, options?: { deferFocus?: boolean }) => {
    if (!canSend || !isComposerCurrent() || index < 0 || index >= messages.length) return;
    const nextReplyTo = messages[index] ?? null;
    if (!nextReplyTo) return;
    if (editingMessageRef.current) restoreNewMessageDraft();
    setSelectedIdx(index);
    setFollowMessages(index === messages.length - 1);
    setReplyTo(nextReplyTo);
    if (useDefaultControllerChannel) {
      controller.setReplyToId(nextReplyTo.id);
    } else {
      controller.setChannelReplyToId(channelId, nextReplyTo.id);
    }
    if (options?.deferFocus) {
      queueMicrotask(() => focusInput());
    } else {
      focusInput();
    }
  }, [
    canSend,
    channelId,
    controller,
    editingMessageRef,
    focusInput,
    isComposerCurrent,
    messages,
    restoreNewMessageDraft,
    setFollowMessages,
    setReplyTo,
    setSelectedIdx,
    useDefaultControllerChannel,
  ]);

  const beginEditMessage = useCallback((index: number, options?: { deferFocus?: boolean }) => {
    if (!canSend || !isComposerCurrent() || index < 0 || index >= messages.length) return false;
    const message = messages[index] ?? null;
    if (!message || message.id !== latestEditableMessageId) return false;
    const edit = { ...message };
    setEditingMessage(edit);
    clearReplyTarget();
    if (editingMessageRef.current !== edit || !isComposerCurrent()) return false;
    setSelectedIdx(index);
    setFollowMessages(index === messages.length - 1);
    // Links at the end of the message are chips again while it is edited.
    const view = splitComposerDraft(message.content);
    setDraftLinks(view.links);
    replaceLocalComposer(view.text);
    if (options?.deferFocus) {
      queueMicrotask(() => focusInput());
    } else {
      focusInput();
    }
    return true;
  }, [
    canSend,
    clearReplyTarget,
    editingMessageRef,
    focusInput,
    isComposerCurrent,
    latestEditableMessageId,
    messages,
    replaceLocalComposer,
    setDraftLinks,
    setEditingMessage,
    setFollowMessages,
    setSelectedIdx,
  ]);

  const beginEditLatestMessage = useCallback((options?: { deferFocus?: boolean }) => {
    if (!latestEditableMessageId) return false;
    const index = messages.findIndex((message) => message.id === latestEditableMessageId);
    return beginEditMessage(index, options);
  }, [beginEditMessage, latestEditableMessageId, messages]);

  const cancelEditMessage = useCallback(() => {
    if (!isComposerCurrent() || !editingMessageRef.current) return;
    restoreNewMessageDraft();
    focusInput();
  }, [editingMessageRef, focusInput, isComposerCurrent, restoreNewMessageDraft]);

  const returnToComposer = useCallback(() => {
    setSelectedIdx(-1);
    setFollowMessages(true);
    if (canSend) {
      queueMicrotask(() => focusInput());
    }
  }, [canSend, focusInput, setFollowMessages, setSelectedIdx]);

  const clearLocalComposer = useCallback(() => {
    setDraftLinks([]);
    replaceLocalComposer("");
  }, [replaceLocalComposer, setDraftLinks]);

  const sendMessage = useCallback(() => {
    if (!canSend || !isComposerCurrent()) return;
    const content = composerMessage(inputValueRef.current, draftLinksRef.current);
    const editing = editingMessageRef.current;
    // Images let a message, or an edit of one that has them, go without text.
    const imagesAllowEmpty = editing
      ? (editing.attachments?.length ?? 0) > 0
      : draftAttachmentCountRef.current > 0;
    if (!content && !imagesAllowEmpty) return;
    if (editing) {
      if (editSubmittingRef.current === editing) return;
      const sendChannelId = useDefaultControllerChannel ? channelId : channelIdRef.current;
      if (editing.channelId !== sendChannelId) return;
      const isCurrent = controller.captureSessionScope();
      if (!isCurrent()) return;
      editSubmittingRef.current = editing;
      void controller.editChannelMessage(sendChannelId, editing.id, content).then((accepted) => {
        if (!accepted || !isCurrent() || editingMessageRef.current !== editing) return;
        restoreNewMessageDraft();
        setSelectedIdx(-1);
        setFollowMessages(true);
      }).finally(() => {
        if (editSubmittingRef.current === editing) editSubmittingRef.current = null;
      });
      return;
    }
    const composerCommand = content ? parseChatComposerCommand(content) : null;
    if (composerCommand?.kind === "direct" || composerCommand?.kind === "group") {
      const isCurrent = controller.captureSessionScope();
      if (!isCurrent()) return;
      const usernames = composerCommand.kind === "direct" ? [composerCommand.username] : composerCommand.usernames;
      const request = composerCommand.kind === "direct"
        ? controller.openDirectChannel({ username: composerCommand.username })
        : controller.openGroupChannel({ usernames, name: composerCommand.name });
      void request.then((channel) => {
        if (!channel || !isCurrent()) return;
        expandDirectSection();
        channelIdRef.current = channel.id;
        onChannelChange?.(channel.id);
        if (!isCurrent()) return;
        clearLocalComposer();
        if (composerCommand.kind === "direct" && composerCommand.draft) {
          controller.setChannelDraft(channel.id, composerCommand.draft);
        }
      }).catch((error: unknown) => {
        if (isCurrent()) onConversationStartError?.(error, usernames);
      });
      return;
    }
    if (composerCommand?.kind === "discord" && onDiscordCommand) {
      setDraftLinks([]);
      replaceComposerDraft("");
      onDiscordCommand(composerCommand);
      return;
    }
    const sendChannelId = useDefaultControllerChannel ? channelId : channelIdRef.current;
    const replyToId = replyToRef.current?.channelId === sendChannelId
      ? replyToRef.current.id
      : undefined;
    const accepted = useDefaultControllerChannel
      ? controller.send(content, replyToId)
      : controller.sendToChannel(sendChannelId, content, replyToId);
    if (!accepted) return;
    clearLocalComposer();
    setSelectedIdx(-1);
    setFollowMessages(true);
  }, [
    canSend,
    channelId,
    channelIdRef,
    clearLocalComposer,
    controller,
    draftLinksRef,
    editingMessageRef,
    inputValueRef,
    isComposerCurrent,
    onChannelChange,
    onConversationStartError,
    onDiscordCommand,
    expandDirectSection,
    replaceComposerDraft,
    restoreNewMessageDraft,
    setDraftLinks,
    setFollowMessages,
    setSelectedIdx,
    useDefaultControllerChannel,
  ]);

  const commitLocalDraft = useCallback((draft: string) => {
    if (applyingExternalDraftRef.current || !isComposerCurrent()) return;
    const previousDraft = inputValueRef.current;
    // A share link pasted at the end of the draft leaves the field for a chip
    // above it, the one the sent message shows; the cursor stays where it was.
    const inserted = insertedText(previousDraft, draft);
    const textAfter = inserted ? draft.slice(inserted.start + inserted.text.length) : "";
    const chips = inserted && inserted.text.length > 4 ? pastedShareChips(inserted.text, textAfter, draftLinksRef.current) : null;
    if (inserted && chips) {
      setDraftLinks([...draftLinksRef.current, ...chips]);
      replaceComposerDraft(`${draft.slice(0, inserted.start)}${textAfter}`, inserted.start);
      return;
    }
    inputValueRef.current = draft;
    updateComposerRows(draft);
    persistDraft(draft);
    const rawCursorOffset = getComposerCursorOffset(inputRef.current, draft);
    const cursorOffset = rawCursorOffset === 0 && draft.length > previousDraft.length && draft.startsWith(previousDraft)
      ? draft.length
      : rawCursorOffset;
    onComposerStateChange?.(draft, cursorOffset);
    if (onPastedImagePaths && !editingMessageRef.current) {
      // A file dropped on a terminal arrives as its path, typed in one go.
      const paths = inserted && inserted.text.length > 4 ? pastedImagePaths(inserted.text) : null;
      if (paths) onPastedImagePaths(paths, inserted!.text);
    }
  }, [
    applyingExternalDraftRef,
    draftLinksRef,
    editingMessageRef,
    inputRef,
    inputValueRef,
    isComposerCurrent,
    onComposerStateChange,
    onPastedImagePaths,
    persistDraft,
    replaceComposerDraft,
    setDraftLinks,
    updateComposerRows,
  ]);

  useEffect(() => {
    if (!canSend && inputFocused) {
      blurInput();
    }
  }, [blurInput, canSend, inputFocused]);

  useEffect(() => {
    if (!focused && inputFocused) {
      blurInput();
    }
  }, [blurInput, focused, inputFocused]);

  useEffect(() => {
    if (focused && inputFocused) {
      inputRef.current?.focus?.();
    }
  }, [focused, inputFocused, inputRef]);

  // The terminal textarea reports edits only through `onContentChange`. It
  // mounts with the composer, which can come after this hook first runs (the
  // saved session landing after the first render on a cold launch, sign-in or
  // email verification finishing, a narrow pane going back to the thread), and
  // a ref change rerenders nothing. So after every render, bind whichever
  // textarea is there now, and let go of the one it replaced.
  const commitLocalDraftRef = useRef(commitLocalDraft);
  commitLocalDraftRef.current = commitLocalDraft;
  const boundTextareaRef = useRef<TextareaRenderable | null>(null);
  useLayoutEffect(() => {
    const textarea = inputRef.current;
    const bound = boundTextareaRef.current;
    if (textarea === bound) return;
    if (bound) bound.onContentChange = undefined;
    boundTextareaRef.current = textarea;
    if (!textarea) return;
    textarea.onContentChange = () => {
      commitLocalDraftRef.current(textarea.editBuffer.getText());
    };
  });
  useLayoutEffect(() => () => {
    const bound = boundTextareaRef.current;
    boundTextareaRef.current = null;
    if (bound) bound.onContentChange = undefined;
  }, []);

  // The desktop and the web take the whole text and cut it in CSS where its row ends.
  const replyPreview = !replyTo ? ""
    : nativePaneChrome ? normalizeInlinePreview(chatTextWithImages(replyTo.content, replyTo.attachments?.length ?? 0))
    : formatInlinePreview(
      chatTextWithImages(replyTo.content, replyTo.attachments?.length ?? 0),
      Math.max(
        contentWidth - ` replying to @${replyTo.user.username}`.length - (isManagedBot(replyTo.user) ? CHAT_PERSON_ICON_WIDTH + 1 : 2) - COMPOSER_ACTION_WIDTH - 1,
        0,
      ),
    );
  const editingPreview = !editingMessage ? ""
    : nativePaneChrome ? normalizeInlinePreview(chatTextWithImages(editingMessage.content, editingMessage.attachments?.length ?? 0))
    : formatInlinePreview(
      chatTextWithImages(editingMessage.content, editingMessage.attachments?.length ?? 0),
      Math.max(contentWidth - " editing: ".length - COMPOSER_ACTION_WIDTH - 1, 0),
    );
  const inputPlaceholder = editingMessage
    ? t("Edit message...")
    : replyTo
      ? tf("Reply to @{username}...", { username: replyTo.user.username ?? "unknown" })
      : t("Type a message...");

  return {
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
    replaceDraftLinks,
    returnToComposer,
    sendMessage,
  };
}
