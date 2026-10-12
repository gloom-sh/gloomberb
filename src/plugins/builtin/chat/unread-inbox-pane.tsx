import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  DataTableView,
  EmptyState,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import {
  getNotificationLog,
  markNotificationLogRead,
  parseNoticeRef,
  subscribeNotificationLog,
  type MissedNoticeKind,
  type NotificationLogEntry,
} from "../../../notifications/notification-log";
import {
  syncConfigActiveLayoutState,
  useAppDispatch,
  useAppStateRef,
  useOptionalPaneInstanceId,
} from "../../../state/app/context";
import { scheduleConfigSave } from "../../../state/config-save-scheduler";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { formatFeedTime } from "../../../utils/datetime-format";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { requestPriceAlertFocus } from "../alerts/focus";
import { SignInWall } from "../cloud/auth-actions";
import { openTeamPane } from "../cloud/team/pane-request";
import { teamStore } from "../cloud/team/store";
import { chatController, type ChatController } from "./controller";
import { applyUnreadInboxItemToConfig } from "./pane-state";
import { buildUnreadListRows, type UnreadInboxItem, type UnreadListRow } from "./unread-inbox";
import { chatTextWithImages } from "./attachments/model";
import { isManagedBot } from "./ghost-user";
import { CHAT_AI_BADGE_WIDTH, ChatAiBadge } from "./message/ai-badge";

type UnreadController = Pick<ChatController, "getSnapshot" | "listUnreadInbox" | "subscribe" | "markAllChannelsRead">;

interface UnreadInboxPaneProps extends PaneProps {
  controller?: UnreadController;
}

const COLUMNS: DataTableColumn[] = [
  { id: "from", label: "From", width: 18, align: "left" },
  { id: "unread", label: "Unread", width: 6, align: "right" },
  { id: "message", label: "Message", width: 24, align: "left", flexGrow: 1 },
  { id: "time", label: "Time UTC", width: 10, align: "right" },
];

const NOTICE_LABELS: Record<MissedNoticeKind, string> = {
  price: "Price alert",
  catalyst: "Catalyst",
  team: "Team",
};

function chatCell(
  item: UnreadInboxItem,
  column: DataTableColumn,
  now: number,
  rowState: { selected: boolean },
  native: boolean,
): DataTableCell {
  switch (column.id) {
    case "from":
      return { text: item.title };
    case "unread":
      // A mention of you reads like the status bar's count.
      return item.mentionsYou
        ? { text: String(item.unreadCount), value: item.unreadCount, color: colors.positive, attributes: TextAttributes.BOLD }
        : { text: String(item.unreadCount), value: item.unreadCount };
    case "time":
      return item.preview
        ? { text: formatFeedTime(item.preview.createdAt, now, "", { utc: true }), value: item.preview.createdAt, color: colors.textDim }
        : { text: "" };
    default: {
      const preview = item.preview;
      if (!preview) return { text: "" };
      const name = preview.user.username ? `@${preview.user.username}` : "";
      const text = chatTextWithImages(preview.content, preview.attachments?.length ?? 0).replace(/\s+/g, " ").trim();
      if (!isManagedBot(preview.user)) return { text: `${name ? `${name}: ` : ""}${text}` };
      // A managed assistant's name carries the same AI badge as in the transcript.
      const ink = rowState.selected ? colors.selectedText : colors.text;
      // The badge stands where the colon would. The table gives the terminal its resolved width to clip
      // to; the desktop clips the preview with CSS.
      const latest = native ? ` ${text}` : truncateToDisplayWidth(` ${text}`, Math.max(0, column.width - displayWidth(name) - CHAT_AI_BADGE_WIDTH));
      return {
        text: `${name ? `${name} ` : ""}[AI]: ${text}`,
        content: (
          <Box flexDirection="row" height={1} width={native ? "100%" : column.width} overflow="hidden">
            {name ? <Text fg={ink}>{name}</Text> : null}
            <ChatAiBadge selectedColor={rowState.selected ? colors.selectedText : undefined} />
            <Text
              fg={ink}
              style={native ? { flex: "1 1 0", minWidth: 0, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "pre" } : undefined}
            >
              {latest}
            </Text>
          </Box>
        ),
      };
    }
  }
}

/** A missed notice counts one in Unread until it is opened or marked read; a read one stays as history, dimmed. */
function noticeCell(notice: NotificationLogEntry, column: DataTableColumn, now: number): DataTableCell {
  const tone = notice.read ? colors.textDim : undefined;
  switch (column.id) {
    case "from": {
      const kind = parseNoticeRef(notice.refId)?.kind;
      return { text: notice.title ?? (kind ? NOTICE_LABELS[kind] : ""), color: tone };
    }
    case "unread":
      return notice.read ? { text: "", value: 0 } : { text: "1", value: 1 };
    case "time":
      return { text: formatFeedTime(notice.at, now, "", { utc: true }), value: new Date(notice.at).toISOString(), color: colors.textDim };
    default:
      return { text: notice.body.replace(/\s+/g, " ").trim(), color: tone };
  }
}

/**
 * Mark all read: the missed notices, and each unread channel the way opening
 * it in Chat reads it. Team cards stay pending; an invite is answered in TEAM.
 */
export function markAllUnreadRead(controller: Pick<ChatController, "markAllChannelsRead">): void {
  markNotificationLogRead();
  controller.markAllChannelsRead();
}

function readInbox(controller: UnreadController) {
  const snapshot = controller.getSnapshot();
  return {
    items: controller.listUnreadInbox(),
    user: snapshot.user,
    hasSavedSession: snapshot.hasSavedSession,
  };
}

export function UnreadInboxPane({
  width,
  height,
  focused = false,
  controller = chatController,
}: UnreadInboxPaneProps) {
  const dispatch = useAppDispatch();
  const { nativePaneChrome } = useUiCapabilities();
  const stateRef = useAppStateRef();
  const inboxInstanceId = useOptionalPaneInstanceId();
  const { createPaneFromTemplate, showPane } = usePluginAppActions();
  const [inbox, setInbox] = useState(() => readInbox(controller));
  const notices = useSyncExternalStore(subscribeNotificationLog, getNotificationLog, getNotificationLog);
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedRow", null);

  // Counts and messages follow the chat's own socket and refreshes; the list asks for nothing.
  useEffect(() => {
    setInbox(readInbox(controller));
    return controller.subscribe(() => setInbox(readInbox(controller)));
  }, [controller]);

  const rows = useMemo(() => buildUnreadListRows(inbox.items, notices), [inbox.items, notices]);
  const anyUnread = inbox.items.length > 0 || notices.some((notice) => !notice.read);

  const openChatItem = useCallback((item: UnreadInboxItem) => {
    const currentState = stateRef.current;
    const messageId = item.preview?.id ?? null;
    const { config, chatInstanceId } = applyUnreadInboxItemToConfig(
      currentState.config,
      { channelId: item.channelId, messageId, paneTitle: item.title },
      inboxInstanceId,
      currentState.focusedPaneId,
    );
    const syncedConfig = syncConfigActiveLayoutState(
      config,
      currentState.paneState,
      currentState.focusedPaneId,
    );
    dispatch({ type: "SET_CONFIG", config: syncedConfig });
    scheduleConfigSave(syncedConfig);
    if (chatInstanceId) {
      dispatch({ type: "FOCUS_PANE", paneId: chatInstanceId });
      return;
    }
    createPaneFromTemplate("new-chat-pane", {
      arg: item.channelId,
      ...(messageId ? { values: { messageId } } : {}),
    });
  }, [createPaneFromTemplate, dispatch, inboxInstanceId, stateRef]);

  // A notice opens where its toast did: the price rule on ALRT Prices, the catalyst, the team card's place.
  const openNotice = useCallback((notice: NotificationLogEntry) => {
    const ref = parseNoticeRef(notice.refId);
    if (!ref) return;
    markNotificationLogRead([notice.id]);
    if (ref.kind === "price") {
      requestPriceAlertFocus(ref.id);
      showPane("alerts");
      return;
    }
    if (ref.kind === "catalyst") {
      createPaneFromTemplate("catalysts-pane", { values: { event: ref.id } });
      return;
    }
    const card = teamStore.getSnapshot().notifications.find((entry) => entry.id === ref.id) ?? null;
    const action = card ? teamStore.notificationAction(card) : null;
    if (action) action.onClick();
    else openTeamPane(createPaneFromTemplate, card ? { teamId: card.data.team.id } : {});
  }, [createPaneFromTemplate, showPane]);

  const openRow = useCallback((row: UnreadListRow) => {
    if (row.kind === "chat") openChatItem(row.item);
    else openNotice(row.notice);
  }, [openChatItem, openNotice]);

  const markAllRead = useCallback(() => markAllUnreadRead(controller), [controller]);
  usePaneFooter("unread-inbox", () => ({
    hints: anyUnread
      ? [{ id: "mark-all-read", key: "m", label: "ark all read", title: "Mark all read", onPress: markAllRead }]
      : [],
  }), [anyUnread, markAllRead]);

  if (!inbox.user && !inbox.hasSavedSession) {
    return <SignInWall placement="chat-unread-signin" action="see your unread chat" width={width} height={height} />;
  }
  if (inbox.user && !inbox.user.emailVerified) {
    return <SignInWall placement="chat-unread-signin" action="see your unread chat" needsVerification width={width} height={height} />;
  }

  const now = Date.now();
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      {rows.length === 0 ? (
        <EmptyState title="Nothing unread." />
      ) : (
        <DataTableView<UnreadListRow>
          focused={focused}
          columns={COLUMNS}
          items={rows}
          rootWidth={width}
          rootHeight={height}
          getItemKey={(row) => row.key}
          emptyStateTitle="Nothing unread."
          sortColumnId={null}
          sortDirection="asc"
          selection={{
            kind: "id",
            selectedId: selected?.key ?? null,
            getId: (row) => row.key,
            onChange: setSelectedKey,
          }}
          selectedTextOverridesCellColor
          onActivate={openRow}
          renderCell={(row, column, _index, rowState) => (row.kind === "chat"
            ? chatCell(row.item, column, now, rowState, !!nativePaneChrome)
            : noticeCell(row.notice, column, now))}
        />
      )}
    </Box>
  );
}
