import type { CommandResultDef, GloomPluginContext } from "../../../types/plugin";
import type { ChatChannel, ChatChannelState } from "../../../api-client";
import type { AppConfig } from "../../../types/config";
import { t } from "../../../i18n";
import { chatController } from "./controller";
import { describeConversationStartError, knownConversationRefusal } from "./direct-messages";
import { buildChatUserByUsername } from "./content/user-map";
import { chatConversationRow, chatNewDmRow, openChatConversation, openChatNewDm } from "./command-bar";
import { buildChatConversations, selectChatConversations } from "./conversations";

export const DEFAULT_CHAT_CHANNEL_ID = "everyone";
export const LAST_VISITED_CHAT_CHANNEL_KEY = "lastChatChannelId";

const CHAT_USERNAME_ARG = /^@?([A-Za-z][A-Za-z0-9_]{2,29})$/;

export function normalizeChannelId(channelId: string | null | undefined) {
  const trimmed = channelId?.trim();
  return trimmed || DEFAULT_CHAT_CHANNEL_ID;
}

export function normalizeShortcutChannelId(channelId: string | null | undefined) {
  const trimmed = channelId?.trim().replace(/^#+/, "");
  return normalizeChannelId(trimmed?.toLowerCase());
}

function getLastVisitedChatChannelId(config: { pluginConfig: Record<string, Record<string, unknown>> }) {
  return normalizeChannelId(config.pluginConfig["gloomberb-cloud"]?.[LAST_VISITED_CHAT_CHANNEL_KEY] as string | undefined);
}

export function getPreferredChatOpenChannelId(
  config: AppConfig,
  snapshot?: { channels: ChatChannel[]; channelStates: ChatChannelState[] },
) {
  if (!snapshot) return getLastVisitedChatChannelId(config);
  const channelById = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const unreadStates = snapshot.channelStates
    .filter((state) => state.unreadCount > 0 && channelById.has(state.channelId))
    .sort((a, b) => b.unreadCount - a.unreadCount);
  const unreadConversation = unreadStates.find((state) => {
    const kind = channelById.get(state.channelId)?.kind ?? "public";
    return kind === "direct" || kind === "group";
  });
  return normalizeChannelId(unreadConversation?.channelId ?? unreadStates[0]?.channelId ?? getLastVisitedChatChannelId(config));
}

export function parseDmUsernames(value: string): string[] {
  const usernames = new Set<string>();
  for (const rawPart of value.split(/[\s,]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(CHAT_USERNAME_ARG);
    if (!match?.[1]) continue;
    usernames.add(match[1].toLowerCase());
  }
  return [...usernames];
}

export function hasOnlyDmUsernameArgs(value: string): boolean {
  const parts = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => CHAT_USERNAME_ARG.test(part));
}

function openChatChannelFromCommand(ctx: Pick<GloomPluginContext, "createPaneFromTemplate">, channelId: string): void {
  ctx.createPaneFromTemplate("new-chat-pane", { arg: channelId });
}

function openDefaultChatPane(
  ctx: Pick<GloomPluginContext, "createPaneFromTemplate" | "getConfig">,
): void {
  const config = ctx.getConfig();
  openChatChannelFromCommand(ctx, getPreferredChatOpenChannelId(config, chatController.getSnapshot()));
}

export async function openDmTargetFromCommand(ctx: GloomPluginContext, usernames: string[]): Promise<void> {
  if (usernames.length === 0) {
    openDefaultChatPane(ctx);
    return;
  }
  // The command bar shows a thrown message as it is, so it says why.
  const snapshot = chatController.getSnapshot();
  const userByUsername = buildChatUserByUsername(snapshot.channels, snapshot.messages);
  const refusal = knownConversationRefusal(usernames, {
    userByUsername,
    currentUserId: snapshot.user?.id,
    channels: snapshot.channels,
  });
  if (refusal) throw new Error(refusal);
  let channel: ChatChannel;
  try {
    channel = usernames.length === 1
      ? await chatController.openDirectChannel({ username: usernames[0] })
      : await chatController.openGroupChannel({ usernames });
  } catch (error) {
    throw new Error(describeConversationStartError(error, usernames, userByUsername));
  }
  openChatConversation(ctx, channel.id);
}

/**
 * `DM` in the command bar. Bare, it lists your DMs and groups, unread first,
 * then the latest, and ends with New DM, which opens the Chat pane's dialog.
 * With names after it, the conversations those names find come first, then
 * the row that starts or opens a DM with exactly what was typed.
 */
export function buildDmCommandResults(ctx: GloomPluginContext, arg: string): CommandResultDef[] {
  const list = chatController.listConversations();
  const conversations = list
    ? buildChatConversations(list.states, list.userId)
      .filter((conversation) => conversation.kind === "direct" || conversation.kind === "group")
    : [];
  const open = (channelId: string) => openChatConversation(ctx, channelId);
  const category = "Chat";
  const trimmed = arg.trim();
  if (trimmed) {
    const usernames = parseDmUsernames(trimmed);
    const valid = hasOnlyDmUsernameArgs(trimmed) && usernames.length > 0;
    const found = selectChatConversations(conversations, { kind: "search", text: trimmed });
    const rows: CommandResultDef[] = found.map((conversation) => ({
      ...chatConversationRow(conversation, open),
      category,
    }));
    // The DM you already share is the row above; a second one would open it too.
    const alreadyShared = usernames.length === 1
      && found.some((conversation) => conversation.kind === "direct" && conversation.username === usernames[0]);
    if (alreadyShared) return rows;
    const label = usernames.length <= 1
      ? `DM ${usernames[0] ? `@${usernames[0]}` : trimmed}`
      : `Group ${usernames.map((username) => `@${username}`).join(", ")}`;
    return [...rows, {
      id: `start:${valid ? usernames.join(",") : trimmed}`,
      label,
      detail: valid
        ? usernames.length === 1
          ? t("Start or open direct message")
          : t("Start group chat")
        : t("Use @username, or multiple usernames for a group chat"),
      category,
      // No tag: it starts a conversation, so it must not read as one.
      right: "",
      disabled: !valid,
      execute: () => openDmTargetFromCommand(ctx, usernames),
    }];
  }

  if (!list) {
    return [{
      id: "empty",
      label: t("No DMs yet"),
      detail: t("Type DM @username to start one"),
      category,
      right: "DM",
      disabled: true,
      execute: () => {},
    }];
  }

  const listed = selectChatConversations(conversations, { kind: "listing" })
    .map((conversation) => ({ ...chatConversationRow(conversation, open), category }));
  return [...listed, { ...chatNewDmRow(() => openChatNewDm(ctx)), category }];
}

/**
 * The one column before a channel's label. Every section now has a header, so
 * every row sits at the same indent and only the active marker differs.
 */
export function channelPrefix(channel: ChatChannel | undefined, active: boolean) {
  if (channel?.kind === "direct") return " ";
  if (channel?.kind === "group") return active ? "+" : " ";
  return active ? "#" : " ";
}
