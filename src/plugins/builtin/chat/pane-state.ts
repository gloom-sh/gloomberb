import { updatePaneInstance } from "../../../pane-settings";
import { isPaneInLayout, removePane } from "../../../layout/pane-manager";
import type { AppConfig, LayoutConfig, PaneInstanceConfig } from "../../../types/config";
import { LAST_VISITED_CHAT_CHANNEL_KEY, normalizeChannelId } from "./channels";

type ChatPaneSettings = Record<string, unknown>;

export function setChatPaneChannel(
  settings: ChatPaneSettings | undefined,
  nextChannelId: string,
): ChatPaneSettings {
  const normalizedNextChannelId = normalizeChannelId(nextChannelId);
  const currentChannelId = typeof settings?.channelId === "string"
    ? normalizeChannelId(settings.channelId)
    : null;
  const nextSettings = {
    ...(settings ?? {}),
    channelId: normalizedNextChannelId,
  };

  if (!currentChannelId || currentChannelId === normalizedNextChannelId) {
    return nextSettings;
  }

  return clearChatPaneTargetMessage(nextSettings);
}

export function clearChatPaneTargetMessage(
  settings: ChatPaneSettings | undefined,
): ChatPaneSettings {
  const { targetMessageId: _targetMessageId, ...nextSettings } = settings ?? {};
  return nextSettings;
}

function paneChannelId(instance: PaneInstanceConfig): string | null {
  return typeof instance.settings?.channelId === "string" ? normalizeChannelId(instance.settings.channelId) : null;
}

/**
 * The Chat pane the command bar shows a conversation in: the one already on
 * it, else the focused one, else the one in front. Null when none is open, so
 * the caller opens one.
 */
export function pickChatPaneToReuse(
  layout: LayoutConfig,
  focusedPaneId: string | null,
  channelId: string | null,
): PaneInstanceConfig | null {
  const chatPanes = layout.instances.filter((instance) => (
    instance.paneId === "chat" && isPaneInLayout(layout, instance.instanceId)
  ));
  if (chatPanes.length === 0) return null;
  const onChannel = channelId ? chatPanes.find((instance) => paneChannelId(instance) === channelId) : undefined;
  if (onChannel) return onChannel;
  const focused = chatPanes.find((instance) => instance.instanceId === focusedPaneId);
  if (focused) return focused;
  // A floating pane without a stacking order sits at the default of 50; docked panes sit below every one.
  const zIndexOf = (instance: PaneInstanceConfig) => {
    const entry = layout.floating.find((floating) => floating.instanceId === instance.instanceId);
    return entry ? entry.zIndex ?? 50 : -1;
  };
  return [...chatPanes].sort((left, right) => zIndexOf(right) - zIndexOf(left))[0] ?? null;
}

function setChatPaneJump(
  settings: ChatPaneSettings | undefined,
  channelId: string,
  targetMessageId: string | null | undefined,
): ChatPaneSettings {
  const nextSettings = setChatPaneChannel(settings, channelId);
  if (targetMessageId) {
    return { ...nextSettings, targetMessageId };
  }
  return clearChatPaneTargetMessage(nextSettings);
}

/**
 * Opens an unread channel in the layout's chat pane (the one already on that
 * channel, else the first) at the message, and closes the unread list. With
 * no chat pane, the caller opens one.
 */
export function applyUnreadInboxItemToConfig(
  config: AppConfig,
  item: { channelId: string; messageId: string | null; paneTitle: string },
  inboxInstanceId?: string | null,
): { config: AppConfig; chatInstanceId: string | null } {
  const chatPanes = config.layout.instances.filter((instance) => instance.paneId === "chat");
  const existing = chatPanes.find((instance) => (
    typeof instance.settings?.channelId === "string"
    && normalizeChannelId(instance.settings.channelId) === item.channelId
  )) ?? chatPanes[0];
  let layout = config.layout;
  if (existing) {
    layout = updatePaneInstance(layout, existing.instanceId, (instance) => ({
      ...instance,
      title: item.paneTitle,
      settings: setChatPaneJump(instance.settings, item.channelId, item.messageId),
    }));
  }
  if (inboxInstanceId) {
    layout = removePane(layout, inboxInstanceId);
  }

  return {
    config: {
      ...config,
      layout,
      pluginConfig: {
        ...config.pluginConfig,
        "gloomberb-cloud": {
          ...(config.pluginConfig["gloomberb-cloud"] ?? {}),
          [LAST_VISITED_CHAT_CHANNEL_KEY]: item.channelId,
        },
      },
    },
    chatInstanceId: existing?.instanceId ?? null,
  };
}
