import { useMemo } from "react";
import {
  getPaneSidebarWidth,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  shouldShowPaneSidebar,
} from "../../../components";
import { Box, Span, Text, useUiCapabilities } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { ChatChannel } from "../../../api-client";
import type { ChatController } from "./controller";
import {
  channelPrefix,
  formatChannelLabel,
  truncateChannelLabel,
} from "./channels";

const DESKTOP_NOTIFICATION_ICON_WIDTH = 3;
const DESKTOP_ONLINE_COUNT_PADDING_X = 1;

export function shouldShowChannelSidebar(channelCount: number, width: number, height: number): boolean {
  return shouldShowPaneSidebar(channelCount, width, height);
}

export function getChannelSidebarWidth(width: number, nativePaneChrome: boolean): number {
  return getPaneSidebarWidth(width, nativePaneChrome);
}

function ChannelNotificationIcon({
  enabled,
  onMouseDown,
}: {
  enabled: boolean;
  onMouseDown?: (event: any) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const iconColor = enabled ? colors.positive : colors.textMuted;

  if (!nativePaneChrome) {
    return (
      <Text fg={iconColor} selectable={false} onMouseDown={onMouseDown}>
        {enabled ? "◖)" : "◖·"}
      </Text>
    );
  }

  return (
    <Span
      fg={iconColor}
      onMouseDown={onMouseDown}
      style={{
        color: iconColor,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <path
          d="M4.5 9.5v5h3.2l4.8 4v-13l-4.8 4H4.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {enabled ? (
          <>
            <path
              d="M16 8.5a5 5 0 0 1 0 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M18.8 5.8a9 9 0 0 1 0 12.4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        ) : (
          <path
            d="M19 5 5 19"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        )}
      </svg>
    </Span>
  );
}

function ProfileIcon({
  color,
  onMouseDown,
}: {
  color: string;
  onMouseDown?: (event: any) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();

  if (!nativePaneChrome) {
    return (
      <Text fg={color} selectable={false} onMouseDown={onMouseDown}>@</Text>
    );
  }

  return (
    <Span
      fg={color}
      onMouseDown={onMouseDown}
      style={{
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.4" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M5.5 19.5a6.5 6.5 0 0 1 13 0"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </Span>
  );
}

export function ChannelSidebar({
  channels,
  channelStates,
  activeChannelId,
  onlineCount,
  width,
  height,
  focused,
  keyboardFocused,
  loading,
  canManageNotifications,
  canCreateConversation,
  directExpanded,
  needsProfileSetup = false,
  onSelect,
  onFocusRequest,
  onCreateConversation,
  onOpenProfile,
  onToggleNotifications,
  onToggleDirectExpanded,
}: {
  channels: ChatChannel[];
  channelStates: ReturnType<ChatController["getSnapshot"]>["channelStates"];
  activeChannelId: string;
  onlineCount: number;
  width: number;
  height: number;
  focused: boolean;
  keyboardFocused: boolean;
  loading: boolean;
  canManageNotifications: boolean;
  canCreateConversation: boolean;
  directExpanded: boolean;
  needsProfileSetup?: boolean;
  onSelect?: (channelId: string) => void;
  onFocusRequest?: () => void;
  onCreateConversation?: () => void;
  onOpenProfile?: () => void;
  onToggleNotifications?: (channelId: string, enabled: boolean) => void;
  onToggleDirectExpanded?: () => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const notificationWidth = canManageNotifications ? (nativePaneChrome ? DESKTOP_NOTIFICATION_ICON_WIDTH : 2) : 0;
  const onlineCountPaddingX = nativePaneChrome ? DESKTOP_ONLINE_COUNT_PADDING_X : 0;
  const channelStateById = useMemo(() => new Map(channelStates.map((state) => [state.channelId, state])), [channelStates]);
  const publicChannels = useMemo(() => channels.filter((channel) => (channel.kind ?? "public") === "public"), [channels]);
  const conversationChannels = useMemo(() => channels.filter((channel) => channel.kind === "direct" || channel.kind === "group"), [channels]);
  const conversationUnread = conversationChannels.some((channel) => (channelStateById.get(channel.id)?.unreadCount ?? 0) > 0);
  const sidebarRows = useMemo(() => [
    ...publicChannels.map((channel) => ({ kind: "channel" as const, channel })),
    ...(conversationChannels.length > 0 || canCreateConversation ? [{ kind: "direct-header" as const }] : []),
    ...(directExpanded ? conversationChannels.map((channel) => ({ kind: "channel" as const, channel })) : []),
  ], [canCreateConversation, conversationChannels, directExpanded, publicChannels]);

  return (
    <PaneSidebar
      width={width}
      height={height}
      focused={focused}
      keyboardFocused={keyboardFocused}
    >
      {({ backgroundColor: sidebarBg, listWidth }) => {
        const labelWidth = Math.max(listWidth - 3 - notificationWidth, 1);
        return (
          <>
            {sidebarRows.map((row) => {
              if (row.kind === "direct-header") {
                return (
                  <Box
                    key="direct-header"
                    height={1}
                    width={listWidth}
                    flexDirection="row"
                    backgroundColor={sidebarBg}
                    aria-label={directExpanded ? "Collapse DMs" : "Expand DMs"}
                    data-gloom-role="pane-sidebar-section"
                    onMouseDown={(event: any) => {
                      event?.preventDefault?.();
                      event?.stopPropagation?.();
                      onToggleDirectExpanded?.();
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <Text
                      fg={conversationUnread ? colors.text : colors.textDim}
                      attributes={conversationUnread ? TextAttributes.BOLD : 0}
                    >
                      {` ${directExpanded ? "▾" : "▸"} DMs`}
                    </Text>
                    <Box flexGrow={1} />
                    {canCreateConversation ? (
                      <PaneSidebarAction
                        width={3}
                        ariaLabel="New DM"
                        onPress={onCreateConversation}
                      >
                        {({ foregroundColor, onMouseDown }) => (
                          <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}>+</Text>
                        )}
                      </PaneSidebarAction>
                    ) : null}
                  </Box>
                );
              }
              const channel = row.channel;
              const active = channel.id === activeChannelId;
              const channelState = channelStateById.get(channel.id);
              const notificationsEnabled = channelState?.notificationsEnabled === true;
              const unread = (channelState?.unreadCount ?? 0) > 0;
              const label = formatChannelLabel(channel, channel.id);
              const selectChannel = () => {
                onFocusRequest?.();
                onSelect?.(channel.id);
              };
              const toggleNotifications = () => {
                onToggleNotifications?.(channel.id, !notificationsEnabled);
              };
              return (
                <PaneSidebarRow
                  key={channel.id}
                  active={active}
                  ariaLabel={label}
                  onSelect={selectChannel}
                >
                  {({ foregroundColor, onMouseDown }) => (
                    <>
                      <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}> </Text>
                      <Text fg={foregroundColor} attributes={unread ? TextAttributes.BOLD : 0} selectable={false} onMouseDown={onMouseDown}>{channelPrefix(channel, active)}</Text>
                      <Text fg={foregroundColor} attributes={unread ? TextAttributes.BOLD : 0} selectable={false} onMouseDown={onMouseDown}>{truncateChannelLabel(label, labelWidth)}</Text>
                      <Box flexGrow={1} onMouseDown={onMouseDown} />
                      {canManageNotifications && (
                        <PaneSidebarAction
                          width={notificationWidth}
                          ariaLabel={`${notificationsEnabled ? "Disable" : "Enable"} notifications for ${label}`}
                          highlightOnHover={false}
                          onPress={toggleNotifications}
                        >
                          {({ onMouseDown: onActionMouseDown }) => (
                            <ChannelNotificationIcon enabled={notificationsEnabled} onMouseDown={onActionMouseDown} />
                          )}
                        </PaneSidebarAction>
                      )}
                    </>
                  )}
                </PaneSidebarRow>
              );
            })}
            <Box flexGrow={1} />
            {needsProfileSetup && (
              <PaneSidebarRow
                active={false}
                ariaLabel={t("Profile")}
                onSelect={onOpenProfile}
              >
                {({ foregroundColor, onMouseDown }) => (
                  <>
                    <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}> </Text>
                    <ProfileIcon color={foregroundColor} onMouseDown={onMouseDown} />
                    <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}>
                      {` ${truncateChannelLabel(t("Profile"), Math.max(listWidth - 3, 1))}`}
                    </Text>
                    <Box flexGrow={1} onMouseDown={onMouseDown} />
                  </>
                )}
              </PaneSidebarRow>
            )}
            {loading && focused && (
              <Box height={1} width={listWidth} flexDirection="row">
                <Text fg={colors.textDim}>{` ${t("syncing")}`}</Text>
              </Box>
            )}
            <Box height={1} width={listWidth} flexDirection="row" paddingX={onlineCountPaddingX}>
              <Text fg={colors.positive}>●</Text>
              <Text fg={colors.textDim}>
                {` ${truncateChannelLabel(tf("{count} online", { count: onlineCount }), Math.max(listWidth - 2 - onlineCountPaddingX * 2, 1))}`}
              </Text>
            </Box>
          </>
        );
      }}
    </PaneSidebar>
  );
}
