import { t, tf } from "../../../i18n";
import type {
  CommandBarResultDef,
  CommandBarSearchProvider,
  GloomPluginContext,
} from "../../../types/plugin";
import { chatController } from "./controller";
import {
  buildChatConversations,
  parseChatConversationQuery,
  selectChatConversations,
  type ChatConversation,
  type ChatConversationKind,
  type ChatConversationList,
} from "./conversations";
import { requestChatPaneAction } from "./pane-requests";

const CHAT_PANE_TEMPLATE_ID = "new-chat-pane";
/**
 * Pane template value: show the conversation in a Chat pane that is already
 * open (switching it over) rather than in a pane of its own.
 */
export const CHAT_REUSE_PANE_VALUE = "reusePane";
const CHAT_SEARCH_PROVIDER_ID = "chat:conversations";

type OpenChatPane = Pick<GloomPluginContext, "createPaneFromTemplate">;

/**
 * Shows a conversation with its composer ready: in the open Chat pane, which
 * switches to it, or in a new one when none is open.
 */
export function openChatConversation(ctx: OpenChatPane, channelId: string): void {
  requestChatPaneAction({ action: "compose", channelId });
  ctx.createPaneFromTemplate(CHAT_PANE_TEMPLATE_ID, {
    arg: channelId,
    values: { [CHAT_REUSE_PANE_VALUE]: "1" },
  });
}

/** The Chat pane's own New DM dialog, in the open Chat pane or a new one. */
export function openChatNewDm(ctx: OpenChatPane): void {
  requestChatPaneAction({ action: "new-dm" });
  ctx.createPaneFromTemplate(CHAT_PANE_TEMPLATE_ID, { values: { [CHAT_REUSE_PANE_VALUE]: "1" } });
}

const BADGES: Record<ChatConversationKind, string> = {
  channel: "CHAT",
  team: "TEAM",
  direct: "DM",
  group: "GROUP",
};

const DETAILS: Record<ChatConversationKind, string> = {
  channel: "Channel",
  team: "Team channel",
  direct: "Direct message",
  group: "Group chat",
};

function unreadLabel(count: number): string {
  return tf("{count} unread", { count: count > 99 ? "99+" : String(count) });
}

/**
 * One conversation as a command-bar row: a tag that tells channels from DMs,
 * the name the Chat pane shows, and the unread count on the right. `right` is
 * empty rather than unset so a command's shortcut never stands in for it.
 */
export function chatConversationRow(
  conversation: ChatConversation,
  open: (channelId: string) => void,
): CommandBarResultDef {
  return {
    id: `conversation:${conversation.channelId}`,
    label: conversation.title,
    ...(conversation.name ? { name: conversation.name } : {}),
    badge: BADGES[conversation.kind],
    detail: t(DETAILS[conversation.kind]),
    right: conversation.unreadCount > 0 ? unreadLabel(conversation.unreadCount) : "",
    keywords: [...conversation.words, "chat", "messages"],
    execute: () => open(conversation.channelId),
  };
}

export function chatNewDmRow(open: () => void): CommandBarResultDef {
  return {
    id: "new-dm",
    label: t("New DM"),
    detail: t("Start a direct or group chat"),
    right: "",
    keywords: ["new", "dm", "direct", "message", "group", "chat"],
    execute: open,
  };
}

interface ChatSearchSource {
  listConversations(): ChatConversationList | null;
}

/**
 * The conversations that answer the command bar's text, from the chat state
 * the Chat pane already keeps: nothing is asked of the server. Signed out or
 * unverified there is nothing, and the Chat pane command is all there is.
 */
export function buildChatSearchRows(
  ctx: OpenChatPane,
  query: string,
  source: ChatSearchSource = chatController,
): CommandBarResultDef[] {
  const list = source.listConversations();
  if (!list) return [];
  const parsed = parseChatConversationQuery(query);
  const conversations = selectChatConversations(buildChatConversations(list.states, list.userId), parsed);
  const rows = conversations.map((conversation) => chatConversationRow(conversation, (channelId) => {
    openChatConversation(ctx, channelId);
  }));
  return parsed.kind === "listing" ? [...rows, chatNewDmRow(() => openChatNewDm(ctx))] : rows;
}

/**
 * Channels and DMs in the command bar: typing part of a channel or a person
 * finds the conversation, "chat" and "messages" list them, and the empty bar
 * shows the unread and latest ones. Answered from memory on every keystroke.
 */
export function createChatSearchProvider(
  ctx: OpenChatPane,
  source: ChatSearchSource = chatController,
): CommandBarSearchProvider {
  const match = (query: string) => buildChatSearchRows(ctx, query, source);
  return {
    id: CHAT_SEARCH_PROVIDER_ID,
    category: "Chat",
    minQueryLength: 0,
    shortcuts: ["CHAT"],
    match,
    provide: async (query) => match(query),
  };
}
