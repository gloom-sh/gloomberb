import type { AppNotificationRequest } from "../../../../types/plugin";
import type { ChatMessage } from "../../../../api-client";
import { describeChatSendError } from "../attachments/model";
import { readyDraftAttachments } from "./attachments";
import {
  createPendingMessage,
  hasPendingSend,
} from "./messages";
import type { ChatSessionUser } from "./persistence";
import type { ChannelRuntimeState } from "./state";
import { createClientMessageId } from "./utils";

type ChatChannelConnection = NonNullable<ChannelRuntimeState["wsConnection"]>;

interface DeliverPendingMessageOptions {
  channel: ChannelRuntimeState;
  connection: ChatChannelConnection;
  pendingMessage: ChatMessage;
  emit: () => void;
  mergeMessages: (messages: ChatMessage[]) => void;
  notify: (notification: AppNotificationRequest) => void;
}

/**
 * Sends a message already drawn as pending. The images went up before, so a
 * send only names them; a retry repeats the same ids and idempotency key and
 * the server answers with the message it may already have stored.
 */
function deliverPendingMessage({
  channel,
  connection,
  pendingMessage,
  emit,
  mergeMessages,
  notify,
}: DeliverPendingMessageOptions): void {
  const attachmentIds = (pendingMessage.attachments ?? []).map((attachment) => attachment.id);
  void connection.send(
    pendingMessage.content,
    pendingMessage.replyToId ?? undefined,
    pendingMessage.clientMessageId,
    attachmentIds.length > 0 ? attachmentIds : undefined,
  ).then((message) => {
    channel.pendingMessages = channel.pendingMessages.filter(
      (entry) => entry.id !== pendingMessage.id,
    );
    mergeMessages([message]);
  }).catch((error) => {
    const errorMessage = describeChatSendError(error);
    channel.pendingMessages = channel.pendingMessages.map((entry) => (
      entry.id === pendingMessage.id
        ? { ...entry, clientStatus: "failed", clientError: errorMessage }
        : entry
    ));
    emit();
    notify({ body: errorMessage, type: "error" });
  });
}

function openConnection(
  channel: ChannelRuntimeState,
  ensureConnection: () => void,
  notify: (notification: AppNotificationRequest) => void,
): ChatChannelConnection | null {
  if (!channel.wsConnection) {
    ensureConnection();
  }
  const connection = channel.wsConnection;
  if (!connection) {
    notify({ body: "Unable to send message right now.", type: "error" });
    return null;
  }
  return connection;
}

interface SendChannelMessageOptions {
  channelId: string;
  channel: ChannelRuntimeState;
  content: string;
  replyToId?: string;
  user: ChatSessionUser | null;
  ensureConnection: () => void;
  getVisibleMessages: () => ChatMessage[];
  nextPendingMessageId: () => string;
  persistChannelState: () => void;
  emit: () => void;
  mergeMessages: (messages: ChatMessage[]) => void;
  notify: (notification: AppNotificationRequest) => void;
}

/**
 * Sends the composer's text and images. The message shows at once as sent;
 * it waits only while an image is still uploading, and an image that failed
 * has to be retried or removed first.
 */
export function sendChatMessageToChannel({
  channelId,
  channel,
  content,
  replyToId,
  user,
  ensureConnection,
  getVisibleMessages,
  nextPendingMessageId,
  persistChannelState,
  emit,
  mergeMessages,
  notify,
}: SendChannelMessageOptions): boolean {
  const messageContent = content.trim();
  const images = readyDraftAttachments(channel.draftAttachments);
  if (!messageContent && channel.draftAttachments.length === 0) return false;
  if (!user?.emailVerified) return false;
  if (images.blocked === "uploading") return false;
  if (images.blocked === "failed") {
    notify({ body: "Retry or remove the image that did not upload.", type: "error" });
    return false;
  }
  const attachmentIds = images.attachments.map((image) => image.uploaded.id);
  if (hasPendingSend(channel, messageContent, replyToId, attachmentIds)) return true;
  const connection = openConnection(channel, ensureConnection, notify);
  if (!connection) return false;

  const clientMessageId = channel.draftClientMessageId ?? createClientMessageId();
  const pendingMessage = createPendingMessage({
    channelId,
    content: messageContent,
    replyToId,
    pendingId: nextPendingMessageId(),
    user,
    visibleMessages: getVisibleMessages(),
    attachments: images.attachments.map(({ uploaded, previewUrl }) => ({
      ...uploaded,
      url: previewUrl ?? uploaded.url,
    })),
    clientMessageId,
  });
  channel.pendingMessages = [...channel.pendingMessages, pendingMessage];
  channel.draft = "";
  channel.draftClientMessageId = null;
  channel.draftAttachments = [];
  channel.replyToId = null;
  persistChannelState();
  emit();

  deliverPendingMessage({ channel, connection, pendingMessage, emit, mergeMessages, notify });
  return true;
}

/**
 * Sends a failed message again: same text, same images (not uploaded again)
 * and the same idempotency key, so a send that did reach the server is not
 * stored twice. It looks sent again at once, like a new message.
 */
export function retryChatMessageInChannel({
  channel,
  messageId,
  ensureConnection,
  emit,
  mergeMessages,
  notify,
}: {
  channel: ChannelRuntimeState;
  messageId: string;
  ensureConnection: () => void;
  emit: () => void;
  mergeMessages: (messages: ChatMessage[]) => void;
  notify: (notification: AppNotificationRequest) => void;
}): boolean {
  const failed = channel.pendingMessages.find((message) => (
    message.id === messageId && message.clientStatus === "failed"
  ));
  if (!failed) return false;
  const connection = openConnection(channel, ensureConnection, notify);
  if (!connection) return false;

  const pendingMessage: ChatMessage = {
    ...failed,
    clientStatus: "sending",
    clientError: null,
    clientMessageId: failed.clientMessageId ?? createClientMessageId(),
    createdAt: new Date().toISOString(),
  };
  channel.pendingMessages = channel.pendingMessages.map((message) => (
    message.id === messageId ? pendingMessage : message
  ));
  emit();
  deliverPendingMessage({ channel, connection, pendingMessage, emit, mergeMessages, notify });
  return true;
}
