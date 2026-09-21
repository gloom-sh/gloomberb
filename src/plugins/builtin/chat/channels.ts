import type { CommandResultDef, GloomPluginContext } from "../../../types/plugin";
import type { ChatChannel, ChatChannelState } from "../../../api-client";
import type { AppConfig } from "../../../types/config";
import { t } from "../../../i18n";
import { chatController } from "./controller";
import { formatChannelLabel } from "./channel-labels";

export { formatChannelLabel, formatChatPaneTitle } from "./channel-labels";

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

export function getLastVisitedChatChannelId(config: { pluginConfig: Record<string, Record<string, unknown>> }) {
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

function conversationDetail(channel: ChatChannel): string {
  if (channel.kind === "direct") {
    const displayName = channel.dmUser?.displayName?.trim();
    const username = channel.dmUser?.username?.trim();
    return [displayName && username ? displayName : null, t("Direct message")].filter(Boolean).join(" - ");
  }
  const members = (channel.members ?? [])
    .map((member) => member.username ? `@${member.username}` : member.displayName)
    .filter(Boolean)
    .slice(0, 4);
  const suffix = (channel.members?.length ?? 0) > members.length ? ` +${(channel.members?.length ?? 0) - members.length}` : "";
  return members.length > 0 ? `${t("Group chat")} - ${members.join(", ")}${suffix}` : t("Group chat");
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
  const channel = usernames.length === 1
    ? await chatController.openDirectChannel({ username: usernames[0] })
    : await chatController.openGroupChannel({ usernames });
  openChatChannelFromCommand(ctx, channel.id);
}

export function buildDmCommandResults(ctx: GloomPluginContext, arg: string): CommandResultDef[] {
  const trimmed = arg.trim();
  if (trimmed) {
    const usernames = parseDmUsernames(trimmed);
    const valid = hasOnlyDmUsernameArgs(trimmed) && usernames.length > 0;
    const label = usernames.length <= 1
      ? `DM ${usernames[0] ? `@${usernames[0]}` : trimmed}`
      : `Group ${usernames.map((username) => `@${username}`).join(", ")}`;
    return [{
      id: `start:${valid ? usernames.join(",") : trimmed}`,
      label,
      detail: valid
        ? usernames.length === 1
          ? t("Start or open direct message")
          : t("Start group chat")
        : t("Use @username, or multiple usernames for a group chat"),
      category: t("Chat"),
      right: "DM",
      disabled: !valid,
      execute: () => openDmTargetFromCommand(ctx, usernames),
    }];
  }

  const conversations = chatController.getSnapshot().channels
    .filter((channel) => channel.kind === "direct" || channel.kind === "group");
  if (conversations.length === 0) {
    return [{
      id: "empty",
      label: t("No DMs yet"),
      detail: t("Type DM @username to start one"),
      category: t("Chat"),
      right: "DM",
      disabled: true,
      execute: () => {},
    }];
  }

  return conversations.map((channel) => ({
    id: `channel:${channel.id}`,
    label: formatChannelLabel(channel, channel.id),
    detail: conversationDetail(channel),
    category: t("Conversations"),
    right: channel.kind === "group" ? t("Group") : t("DM"),
    keywords: [
      channel.name,
      channel.dmUser?.username ?? "",
      ...(channel.members ?? []).map((member) => member.username ?? member.displayName),
    ],
    execute: () => openChatChannelFromCommand(ctx, channel.id),
  }));
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
