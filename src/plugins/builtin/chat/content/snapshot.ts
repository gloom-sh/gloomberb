import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TextareaRenderable } from "../../../../ui";
import type { ChatMessage } from "../../../../api-client";
import type { ChatContentController } from "./types";
import type { ChatPrependAnchor } from "./scroll";

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
  prependAnchorRef: MutableRef<ChatPrependAnchor | null>;
  setFollowMessages: Dispatch<SetStateAction<boolean>>;
  setSelectedIdx: Dispatch<SetStateAction<number>>;
  updateComposerRows: (draft: string) => void;
  useDefaultControllerChannel: boolean;
}

function syncDraftFromSnapshot({
  applyingExternalDraftRef,
  inputRef,
  inputValueRef,
  onComposerStateChange,
  snapshot,
  updateComposerRows,
}: {
  applyingExternalDraftRef: MutableRef<boolean>;
  inputRef: MutableRef<TextareaRenderable | null>;
  inputValueRef: MutableRef<string>;
  onComposerStateChange?: (draft: string, cursorOffset: number) => void;
  snapshot: ChatSnapshot;
  updateComposerRows: (draft: string) => void;
}) {
  if (inputValueRef.current !== snapshot.draft) {
    inputValueRef.current = snapshot.draft;
    updateComposerRows(snapshot.draft);
    onComposerStateChange?.(snapshot.draft, snapshot.draft.length);
  }
  const textarea = inputRef.current;
  if (textarea && textarea.editBuffer.getText() !== snapshot.draft) {
    applyingExternalDraftRef.current = true;
    textarea.setText(snapshot.draft);
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
  prependAnchorRef,
  setFollowMessages,
  setSelectedIdx,
  updateComposerRows,
  useDefaultControllerChannel,
}: ChatSnapshotStateArgs) {
  const [channels, setChannels] = useState(initialSnapshot.channels);
  const [channelsLoading, setChannelsLoading] = useState(initialSnapshot.channelsLoading);
  const [messages, setMessages] = useState<ChatMessage[]>(initialSnapshot.messages);
  const [channelStates, setChannelStates] = useState(initialSnapshot.channelStates);
  const [onlineCount, setOnlineCount] = useState(initialSnapshot.onlineCount);
  const [hasSavedSession, setHasSavedSession] = useState(initialSnapshot.hasSavedSession);
  const [user, setUser] = useState<{ id: string; username: string; emailVerified: boolean } | null>(initialSnapshot.user);
  const [loading, setLoading] = useState(initialSnapshot.loading);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(initialSnapshot.loadingOlderMessages);
  const [hasOlderMessages, setHasOlderMessages] = useState(initialSnapshot.hasOlderMessages);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(() => resolveReplyTo(initialSnapshot));

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
      setChannels(snapshot.channels);
      setChannelStates(snapshot.channelStates);
      setOnlineCount(snapshot.onlineCount);
      setChannelsLoading(snapshot.channelsLoading);
      setHasSavedSession(snapshot.hasSavedSession);
      setUser(snapshot.user);
      setLoading(snapshot.loading);
      setLoadingOlderMessages(snapshot.loadingOlderMessages);
      setHasOlderMessages(snapshot.hasOlderMessages);
      syncDraftFromSnapshot({
        applyingExternalDraftRef,
        inputRef,
        inputValueRef,
        onComposerStateChange,
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
    inputRef,
    inputValueRef,
    onComposerStateChange,
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
    hasOlderMessages,
    hasSavedSession,
    loading,
    loadingOlderMessages,
    messages,
    onlineCount,
    replyTo,
    setReplyTo,
    user,
  };
}
