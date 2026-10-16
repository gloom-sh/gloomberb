import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { TextareaRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import {
  COMPOSER_ACTION_WIDTH,
  formatInlinePreview,
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
  messages,
  onComposerStateChange,
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
  messages: ChatMessage[];
  onComposerStateChange?: (draft: string, cursorOffset: number) => void;
  onChannelChange?: (channelId: string) => void;
  editingMessage: ChatMessage | null;
  latestEditableMessageId: string | null;
  replyTo: ChatMessage | null;
  setEditingMessage: Dispatch<SetStateAction<ChatMessage | null>>;
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
  const replyToRef = useRef(replyTo);
  const draftAttachmentCountRef = useRef(draftAttachmentCount);
  draftAttachmentCountRef.current = draftAttachmentCount;
  replyToRef.current = replyTo;
  const editingMessageRef = useRef(editingMessage);
  editingMessageRef.current = editingMessage;
  const editSubmittingRef = useRef(false);

  const focusComposer = useCallback(() => {
    setSelectedIdx(-1);
    setFollowMessages(true);
    focusInput();
  }, [focusInput, setFollowMessages, setSelectedIdx]);

  const clearReplyTarget = useCallback(() => {
    setReplyTo(null);
    if (useDefaultControllerChannel) {
      controller.setReplyToId(null);
    } else {
      controller.setChannelReplyToId(channelId, null);
    }
  }, [channelId, controller, setReplyTo, useDefaultControllerChannel]);

  // The field's text is saved with the links of its chips, the way it will be sent.
  const persistDraft = useCallback((text: string, links: readonly ComposerShareLink[] = draftLinksRef.current) => {
    const draft = joinComposerDraft(text, links);
    if (useDefaultControllerChannel) {
      controller.setDraft(draft);
    } else {
      controller.setChannelDraft(channelId, draft);
    }
  }, [channelId, controller, draftLinksRef, useDefaultControllerChannel]);

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
    replaceLocalComposer(draft, cursorOffset);
    persistDraft(draft);
  }, [persistDraft, replaceLocalComposer]);

  /** New chips above the field, saved with the text as it is. */
  const replaceDraftLinks = useCallback((links: ComposerShareLink[]) => {
    setDraftLinks(links);
    persistDraft(inputValueRef.current, links);
  }, [inputValueRef, persistDraft, setDraftLinks]);

  const beginReplyTo = useCallback((index: number, options?: { deferFocus?: boolean }) => {
    if (!canSend || index < 0 || index >= messages.length) return;
    const nextReplyTo = messages[index] ?? null;
    if (!nextReplyTo) return;
    if (editingMessageRef.current) {
      setDraftLinks([]);
      replaceLocalComposer("");
      persistDraft("", []);
    }
    setEditingMessage(null);
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
    focusInput,
    messages,
    persistDraft,
    replaceLocalComposer,
    setEditingMessage,
    setFollowMessages,
    setDraftLinks,
    setReplyTo,
    setSelectedIdx,
    useDefaultControllerChannel,
  ]);

  const beginEditMessage = useCallback((index: number, options?: { deferFocus?: boolean }) => {
    if (!canSend || index < 0 || index >= messages.length) return false;
    const message = messages[index] ?? null;
    if (!message || message.id !== latestEditableMessageId) return false;
    clearReplyTarget();
    setEditingMessage(message);
    setSelectedIdx(index);
    setFollowMessages(index === messages.length - 1);
    // Links at the end of the message are chips again while it is edited.
    const view = splitComposerDraft(message.content);
    setDraftLinks(view.links);
    replaceLocalComposer(view.text);
    persistDraft(view.text, view.links);
    if (options?.deferFocus) {
      queueMicrotask(() => focusInput());
    } else {
      focusInput();
    }
    return true;
  }, [
    canSend,
    clearReplyTarget,
    focusInput,
    latestEditableMessageId,
    messages,
    persistDraft,
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
    if (!editingMessageRef.current) return;
    setEditingMessage(null);
    setDraftLinks([]);
    replaceLocalComposer("");
    persistDraft("", []);
    focusInput();
  }, [focusInput, persistDraft, replaceLocalComposer, setDraftLinks, setEditingMessage]);

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
    const content = composerMessage(inputValueRef.current, draftLinksRef.current);
    const editing = editingMessageRef.current;
    // Images let a message, or an edit of one that has them, go without text.
    const imagesAllowEmpty = editing
      ? (editing.attachments?.length ?? 0) > 0
      : draftAttachmentCountRef.current > 0;
    if (!content && !imagesAllowEmpty) return;
    if (editing) {
      if (editSubmittingRef.current) return;
      const sendChannelId = useDefaultControllerChannel ? channelId : channelIdRef.current;
      if (editing.channelId !== sendChannelId) return;
      editSubmittingRef.current = true;
      void controller.editChannelMessage(sendChannelId, editing.id, content).then((accepted) => {
        if (!accepted) return;
        setEditingMessage(null);
        clearLocalComposer();
        persistDraft("", []);
        setSelectedIdx(-1);
        setFollowMessages(true);
      }).finally(() => {
        editSubmittingRef.current = false;
      });
      return;
    }
    const composerCommand = content ? parseChatComposerCommand(content) : null;
    if (composerCommand?.kind === "direct") {
      void controller.openDirectChannel({ username: composerCommand.username }).then((channel) => {
        expandDirectSection();
        channelIdRef.current = channel.id;
        onChannelChange?.(channel.id);
        clearLocalComposer();
        if (composerCommand.draft) {
          controller.setChannelDraft(channel.id, composerCommand.draft);
        }
      }).catch((error: unknown) => onConversationStartError?.(error, [composerCommand.username]));
      return;
    }
    if (composerCommand?.kind === "discord" && onDiscordCommand) {
      setDraftLinks([]);
      replaceComposerDraft("");
      onDiscordCommand(composerCommand);
      return;
    }
    if (composerCommand?.kind === "group") {
      void controller.openGroupChannel({
        usernames: composerCommand.usernames,
        name: composerCommand.name,
      }).then((channel) => {
        expandDirectSection();
        channelIdRef.current = channel.id;
        onChannelChange?.(channel.id);
        clearLocalComposer();
      }).catch((error: unknown) => onConversationStartError?.(error, composerCommand.usernames));
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
    channelId,
    channelIdRef,
    clearLocalComposer,
    controller,
    draftLinksRef,
    inputValueRef,
    onChannelChange,
    onConversationStartError,
    onDiscordCommand,
    expandDirectSection,
    persistDraft,
    replaceComposerDraft,
    setDraftLinks,
    setEditingMessage,
    setFollowMessages,
    setSelectedIdx,
    useDefaultControllerChannel,
  ]);

  const commitLocalDraft = useCallback((draft: string) => {
    if (applyingExternalDraftRef.current) return;
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
    inputRef,
    inputValueRef,
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

  useEffect(() => {
    if (canSend || !replyTo) return;
    clearReplyTarget();
  }, [canSend, clearReplyTarget, replyTo]);

  useEffect(() => {
    if (canSend || !editingMessage) return;
    cancelEditMessage();
  }, [canSend, cancelEditMessage, editingMessage]);

  const replyPreview = replyTo
    ? formatInlinePreview(
      chatTextWithImages(replyTo.content, replyTo.attachments?.length ?? 0),
      Math.max(
        contentWidth - ` replying to @${replyTo.user.username}`.length - (isManagedBot(replyTo.user) ? CHAT_PERSON_ICON_WIDTH + 1 : 2) - COMPOSER_ACTION_WIDTH - 1,
        0,
      ),
    )
    : "";
  const editingPreview = editingMessage
    ? formatInlinePreview(
      chatTextWithImages(editingMessage.content, editingMessage.attachments?.length ?? 0),
      Math.max(contentWidth - " editing: ".length - COMPOSER_ACTION_WIDTH - 1, 0),
    )
    : "";
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
