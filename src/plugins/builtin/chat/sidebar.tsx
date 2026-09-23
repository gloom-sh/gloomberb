import { ActionRow } from "../../../components/ui/action-row";
import { Icon } from "../../../components/ui/icon";
import { useMemo, useSyncExternalStore } from "react";
import {
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  shouldShowPaneSidebar,
} from "../../../components";
import { Box, Span, Text, useUiCapabilities } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { blendHex, colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import type { ChatChannel } from "../../../api-client";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { teamAccentHex, teamPrefix } from "../cloud/team/model";
import { teamStore } from "../cloud/team/store";
import type { ChatController } from "./controller";
import { chatSidebarStore } from "./sidebar-store";
import { buildChatSidebarRows } from "./sidebar-rows";
import {
  channelPrefix,
  formatChannelLabel,
} from "./channels";

const DESKTOP_NOTIFICATION_ICON_WIDTH = 3;
/** Leading gutter plus the one-column active marker every channel row carries. */
const CHANNEL_ROW_INDENT = 2;
/** Width of a header's trailing action, so its label truncates clear of it. */
const SECTION_ACTION_WIDTH = 3;

export function shouldShowChannelSidebar(channelCount: number, width: number, height: number): boolean {
  return shouldShowPaneSidebar(channelCount, width, height);
}

export function getChannelSidebarWidth(
  width: number,
  nativePaneChrome: boolean,
  preferredWidth?: number | null,
): number {
  return getPaneSidebarWidth(width, nativePaneChrome, preferredWidth);
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
      <Icon name={enabled ? "sound-on" : "sound-off"} size={15} />
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
      <Icon name="user" size={15} />
    </Span>
  );
}

export function ChannelSidebar({
  channels,
  channelStates,
  activeChannelId,
  cursorHeaderKey = null,
  width,
  paneWidth,
  height,
  focused,
  keyboardFocused,
  loading,
  canManageNotifications,
  canCreateConversation,
  needsProfileSetup = false,
  onSelect,
  onFocusRequest,
  onCreateConversation,
  onOpenProfile,
  onToggleNotifications,
  onCreateTeamChannel,
}: {
  channels: ChatChannel[];
  channelStates: ReturnType<ChatController["getSnapshot"]>["channelStates"];
  activeChannelId: string;
  /** The section header the keyboard cursor rests on, if it is on one. */
  cursorHeaderKey?: string | null;
  width: number;
  /** Width of the whole chat pane, which caps how far the sidebar can grow. */
  paneWidth: number;
  height: number;
  focused: boolean;
  keyboardFocused: boolean;
  loading: boolean;
  canManageNotifications: boolean;
  canCreateConversation: boolean;
  needsProfileSetup?: boolean;
  onSelect?: (channelId: string) => void;
  onFocusRequest?: () => void;
  onCreateConversation?: () => void;
  onOpenProfile?: () => void;
  onToggleNotifications?: (channelId: string, enabled: boolean) => void;
  onCreateTeamChannel?: (teamId: string) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const notificationWidth = canManageNotifications ? (nativePaneChrome ? DESKTOP_NOTIFICATION_ICON_WIDTH : 2) : 0;
  const channelStateById = useMemo(() => new Map(channelStates.map((state) => [state.channelId, state])), [channelStates]);
  const hasUnread = (section: ChatChannel[]) => section.some((channel) => (channelStateById.get(channel.id)?.unreadCount ?? 0) > 0);
  const teamSnapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const sidebarSnapshot = useSyncExternalStore(
    (onChange) => chatSidebarStore.subscribe(onChange),
    () => chatSidebarStore.getSnapshot(),
  );
  const sidebarRows = useMemo(() => buildChatSidebarRows({
    channels,
    collapsedSections: sidebarSnapshot.collapsedSections,
    collapsedTeams: teamSnapshot.collapsedTeams,
    canCreateConversation,
    getTeam: (teamId) => teamStore.getTeam(teamId),
  }), [canCreateConversation, channels, sidebarSnapshot.collapsedSections, teamSnapshot.collapsedTeams, teamSnapshot.teams]);
  const widthRange = getPaneSidebarWidthRange(paneWidth);

  return (
    <PaneSidebar
      width={width}
      height={height}
      focused={focused}
      keyboardFocused={keyboardFocused}
      resize={{
        min: widthRange.min,
        max: widthRange.max,
        onResize: (nextWidth) => chatSidebarStore.setWidth(nextWidth),
        onResizeEnd: (nextWidth) => chatSidebarStore.commitWidth(nextWidth),
      }}
    >
      {({ backgroundColor: sidebarBg, listWidth }) => {
        const labelWidth = Math.max(listWidth - CHANNEL_ROW_INDENT - notificationWidth, 1);
        // The fill a keyboard-focused sidebar gives the row under its cursor.
        const cursorBackground = blendHex(colors.selected, colors.borderFocused, 0.32);
        // Every section reads the same: a caret, a label, and an optional
        // trailing action, so their channels can all share one indent.
        const sectionHeader = ({ key, label, fg, unread, expanded, onToggle, action }: {
          key: string;
          label: string;
          fg?: string;
          unread: boolean;
          expanded: boolean;
          onToggle: () => void;
          action?: { ariaLabel: string; onPress: () => void };
        }) => {
          const rowWidth = Math.max(1, listWidth - (action ? SECTION_ACTION_WIDTH : 0));
          return (
            <Box
              key={key}
              height={1}
              width={listWidth}
              flexDirection="row"
              backgroundColor={keyboardFocused && cursorHeaderKey === key ? cursorBackground : sidebarBg}
            >
              <ActionRow
                label={truncateWithEllipsis(label, Math.max(1, rowWidth - CHANNEL_ROW_INDENT))}
                active={unread}
                expanded={expanded}
                fg={fg}
                width={rowWidth}
                onPress={onToggle}
              />
              {action ? (
                <PaneSidebarAction
                  width={SECTION_ACTION_WIDTH}
                  ariaLabel={action.ariaLabel}
                  onPress={action.onPress}
                >
                  {({ foregroundColor, onMouseDown }) => (
                    <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}>+</Text>
                  )}
                </PaneSidebarAction>
              ) : null}
            </Box>
          );
        };
        return (
          <>
            {sidebarRows.map((row) => {
              if (row.kind === "public-header") {
                return sectionHeader({
                  key: row.key,
                  label: "Channels",
                  unread: hasUnread(row.channels),
                  expanded: row.expanded,
                  onToggle: () => chatSidebarStore.toggleSectionCollapsed("public"),
                });
              }
              if (row.kind === "team-header") {
                const canAddChannel = !!row.team && !!onCreateTeamChannel;
                return sectionHeader({
                  key: row.key,
                  label: row.team ? `${teamPrefix(row.team)} ${row.team.name}` : "Team",
                  fg: row.team ? teamAccentHex(row.team.accentColor) : colors.textDim,
                  unread: hasUnread(row.channels),
                  expanded: row.expanded,
                  onToggle: () => teamStore.toggleTeamCollapsed(row.teamId),
                  action: canAddChannel
                    ? {
                      ariaLabel: `New channel in ${row.team?.name ?? "team"}`,
                      onPress: () => onCreateTeamChannel?.(row.teamId),
                    }
                    : undefined,
                });
              }
              if (row.kind === "direct-header") {
                return sectionHeader({
                  key: row.key,
                  label: "DMs",
                  unread: hasUnread(row.channels),
                  expanded: row.expanded,
                  onToggle: () => chatSidebarStore.toggleSectionCollapsed("direct"),
                  action: canCreateConversation
                    ? { ariaLabel: "New DM", onPress: () => onCreateConversation?.() }
                    : undefined,
                });
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
                      <Text fg={foregroundColor} attributes={unread ? TextAttributes.BOLD : 0} selectable={false} onMouseDown={onMouseDown}>{truncateWithEllipsis(label, labelWidth)}</Text>
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
                      {` ${truncateWithEllipsis(t("Profile"), Math.max(listWidth - 3, 1))}`}
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
          </>
        );
      }}
    </PaneSidebar>
  );
}
