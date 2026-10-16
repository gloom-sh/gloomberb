import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TextareaRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import type { ChatContentController } from "./types";
import type { ChatPrependAnchor } from "./scroll";
import { splitComposerDraft, type ComposerShareLink } from "../pane-links/composer";

type ChatSnapshot = ReturnType<ChatContentController["getSnapshot"]>;

interface MutableRef<T> {
  current: T;
}

interface ChatSnapshotStateArgs {
  applyingExternalDraftRef: MutableRef<boolean>;
  channelId: string;
  controller: ChatContentController;
  focused: boolean;
  initialSnapshot: ChatSnapshot;
  inputRef: MutableRef<TextareaRenderable | null>;
  inputValueRef: MutableRef<string>;
  onComposerStateChange?: (draft: string, cursorOffset: number) => void;
  /** The share links at the end of the saved draft, drawn as chips above the field. */
  draftLinksRef: MutableRef<ComposerShareLink[]>;
  /** Sets the chips; also updates `draftLinksRef`. */
  onDraftLinksChange: (links: ComposerShareLink[]) => void;
  prependAnchorRef: MutableRef<ChatPrependAnchor | null>;
  setFollowMessages: Dispatch<SetStateAction<boolean>>;
  setSelectedIdx: Dispatch<SetStateAction<number>>;
  updateComposerRows: (draft: string) => void;
  useDefaultControllerChannel: boolean;
}

function sameLinks(a: readonly ComposerShareLink[], b: readonly ComposerShareLink[]): boolean {
  return a.length === b.length && a.every((link, index) => link.url === b[index]!.url);
}

function syncDraftFromSnapshot({
  applyingExternalDraftRef,
  draftLinksRef,
  inputRef,
  inputValueRef,
  onComposerStateChange,
  onDraftLinksChange,
  snapshot,
  updateComposerRows,
}: {
  applyingExternalDraftRef: MutableRef<boolean>;
  draftLinksRef: MutableRef<ComposerShareLink[]>;
  inputRef: MutableRef<TextareaRenderable | null>;
  inputValueRef: MutableRef<string>;
  onComposerStateChange?: (draft: string, cursorOffset: number) => void;
  onDraftLinksChange: (links: ComposerShareLink[]) => void;
  snapshot: ChatSnapshot;
  updateComposerRows: (draft: string) => void;
}) {
  const { text, links } = splitComposerDraft(snapshot.draft);
  if (!sameLinks(draftLinksRef.current, links)) onDraftLinksChange(links);
  if (inputValueRef.current !== text) {
    inputValueRef.current = text;
    updateComposerRows(text);
    onComposerStateChange?.(text, text.length);
  }
  const textarea = inputRef.current;
  if (textarea && textarea.editBuffer.getText() !== text) {
    applyingExternalDraftRef.current = true;
    textarea.setText(text);
    applyingExternalDraftRef.current = false;
  }
}

function resolveReplyTo(snapshot: ChatSnapshot): ChatMessage | null {
  return snapshot.replyToId
    ? snapshot.messages.find((message) => message.id === snapshot.replyToId) ?? null
    : null;
}

export function useChatSnapshotState({
  applyingExternalDraftRef,
  channelId,
  controller,
  focused,
  initialSnapshot,
  inputRef,
  inputValueRef,
  onComposerStateChange,
  draftLinksRef,
  onDraftLinksChange,
  prependAnchorRef,
  setFollowMessages,
  setSelectedIdx,
  updateComposerRows,
  useDefaultControllerChannel,
}: ChatSnapshotStateArgs) {
  const [mentionState, setMentionState] = useState({
    channelId: initialSnapshot.channelId,
    candidates: initialSnapshot.mentionCandidates,
  });
  const [channels, setChannels] = useState(initialSnapshot.channels);
  const [channelsLoading, setChannelsLoading] = useState(initialSnapshot.channelsLoading);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSnapshot.messages);
  const [channelStates, setChannelStates] = useState(initialSnapshot.channelStates);
  const [conversationActivity, setConversationActivity] = useState(initialSnapshot.conversationActivity);
  const [hasSavedSession, setHasSavedSession] = useState(initialSnapshot.hasSavedSession);
  const [user, setUser] = useState<{ id: string; username: string; emailVerified: boolean } | null>(initialSnapshot.user);
  const [loading, setLoading] = useState(initialSnapshot.loading);
  const [messagesError, setMessagesError] = useState(initialSnapshot.messagesError);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(initialSnapshot.loadingOlderMessages);
  const [hasOlderMessages, setHasOlderMessages] = useState(initialSnapshot.hasOlderMessages);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(() => resolveReplyTo(initialSnapshot));
  const [draftAttachments, setDraftAttachments] = useState(initialSnapshot.draftAttachments);

  useEffect(() => {
    return useDefaultControllerChannel
      ? controller.attachView(focused)
      : controller.attachChannelView(channelId, focused);
  }, [channelId, controller, focused, useDefaultControllerChannel]);

  useEffect(() => {
    void controller.refreshChannels().catch(() => {});
    void controller.refreshPresence().catch(() => {});
    void controller.refreshSession().catch(() => {});
  }, [controller]);

  useEffect(() => {
    setSelectedIdx(-1);
    setFollowMessages(true);
    prependAnchorRef.current = null;

    const applySnapshot = (snapshot: ChatSnapshot) => {
      setMessages(snapshot.messages);
      setMentionState((current) => current.channelId === snapshot.channelId && current.candidates === snapshot.mentionCandidates
        ? current
        : { channelId: snapshot.channelId, candidates: snapshot.mentionCandidates });
      setChannels(snapshot.channels);
      setChannelStates(snapshot.channelStates);
      setConversationActivity(snapshot.conversationActivity);
      setChannelsLoading(snapshot.channelsLoading);
      setHasSavedSession(snapshot.hasSavedSession);
      setUser(snapshot.user);
      setLoading(snapshot.loading);
      setMessagesError(snapshot.messagesError);
      setLoadingOlderMessages(snapshot.loadingOlderMessages);
      setHasOlderMessages(snapshot.hasOlderMessages);
      setDraftAttachments(snapshot.draftAttachments);
      syncDraftFromSnapshot({
        applyingExternalDraftRef,
        draftLinksRef,
        inputRef,
        inputValueRef,
        onComposerStateChange,
        onDraftLinksChange,
        snapshot,
        updateComposerRows,
      });
      setReplyTo(resolveReplyTo(snapshot));
    };

    applySnapshot(controller.getSnapshot(channelId));

    const unsubscribe = useDefaultControllerChannel
      ? controller.subscribe(applySnapshot)
      : controller.subscribe(channelId, applySnapshot);

    void (useDefaultControllerChannel ? controller.refreshMessages() : controller.refreshChannelMessages(channelId)).catch(() => {});
    return unsubscribe;
  }, [
    applyingExternalDraftRef,
    channelId,
    controller,
    draftLinksRef,
    inputRef,
    inputValueRef,
    onComposerStateChange,
    onDraftLinksChange,
    prependAnchorRef,
    setFollowMessages,
    setSelectedIdx,
    updateComposerRows,
    useDefaultControllerChannel,
  ]);

  return {
    channels,
    channelsLoading,
    channelStates,
    conversationActivity,
    draftAttachments,
    hasOlderMessages,
    hasSavedSession,
    loading,
    loadingOlderMessages,
    messages,
    messagesError,
    mentionCandidates: mentionState.channelId === channelId ? mentionState.candidates : undefined,
    replyTo,
    setReplyTo,
    user,
  };
}
