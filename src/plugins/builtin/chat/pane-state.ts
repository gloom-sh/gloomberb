import { updatePaneInstance } from "../../../pane-settings";
import { removePane } from "../../../layout/pane-manager";
import type { AppConfig } from "../../../types/config";
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
