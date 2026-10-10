import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableView,
  EMPTY_TABLE_CELL,
  QueryBar,
  buildSectionedRows,
  confirmDialog,
  isSectionedItemRow,
  renderSectionedRowHeader,
  usePaneFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { useDialog } from "../../../ui/dialog";
import { usePluginAppActions } from "../../runtime";
import { requestPriceAlertFocus } from "../alerts/focus";
import { teamChannelId, teamNotificationIdFromRef } from "../cloud/team/model";
import { openTeamPane } from "../cloud/team/pane-request";
import { teamStore } from "../cloud/team/store";
import { chatController } from "../chat/controller";
import {
  clearNotificationLog,
  configureNotificationLog,
  getNotificationLog,
  markNotificationLogRead,
  subscribeNotificationLog,
  type NotificationLogEntry,
} from "../../../notifications/notification-log";
import {
  notificationIdsThatAppearUnread,
  type NotificationChatUnread,
} from "../../../notifications/unread-appearance";
import { compareSortValues, nextHeaderSort, type SortPreference } from "../../../utils/sort-values";
import type { GloomPlugin, PaneProps } from "../../../types/plugin";
import {
  NOTIFICATION_CENTER_TEMPLATE_ID,
  catalystEventIdFromRef,
  notificationSourceLabel,
  notificationSourceVisible,
  priceAlertIdFromRef,
  type NotificationSourceFilter,
} from "./filter";

const NOTIFICATION_LOG_KEY = "notification-log";

type NotificationColumnId = "state" | "date" | "source" | "notification";
type NotificationColumn = DataTableColumn & { id: NotificationColumnId };

const COLUMNS: NotificationColumn[] = [
  { id: "state", label: "State", width: 6, align: "left" },
  { id: "date", label: "Time", width: 8, align: "left" },
  { id: "source", label: "Source", width: 8, align: "left" },
  { id: "notification", label: "Notice", flexGrow: 1, width: 24, align: "left" },
];

const SOURCE_FILTERS: ReadonlyArray<{ value: NotificationSourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "alerts", label: "Alerts" },
  { value: "chat", label: "Chat" },
  { value: "team", label: "Team" },
];

function formatDay(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t("Today");
  if (date.toDateString() === yesterday.toDateString()) return t("Yesterday");
  return date.toLocaleDateString();
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readChatUnread(): NotificationChatUnread {
  return {
    unreadCount: chatController.totalUnreadCount(),
    unreadMessageIds: chatController.unreadMessageIds(),
  };
}

function sourceDestination(source: string): "alerts" | "chat" | "team" | null {
  if (source === "alerts") return "alerts";
  if (source === "team") return "team";
  if (source === "gloomberb-cloud" || source === "chat") return "chat";
  return null;
}

function notificationSortValue(entry: NotificationLogEntry, column: NotificationColumnId): string | number {
  if (column === "state") return entry.read ? 1 : 0;
  if (column === "date") return entry.at;
  if (column === "source") return notificationSourceLabel(entry.source);
  return `${entry.title ?? ""} ${entry.body}`;
}

function NotificationCenterPane({ focused, width, height }: PaneProps) {
  const dialog = useDialog();
  const search = useQueryBarSearch();
  const { createPaneFromTemplate, showPane } = usePluginAppActions();
  const [entries, setEntries] = useState<readonly NotificationLogEntry[]>(getNotificationLog);
  const [chatUnread, setChatUnread] = useState<NotificationChatUnread>(readChatUnread);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<NotificationSourceFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortPreference<NotificationColumnId>>({
    columnId: "date",
    direction: "desc",
  });

  useEffect(() => subscribeNotificationLog(() => setEntries(getNotificationLog())), []);
  useEffect(() => chatController.subscribe(() => setChatUnread(readChatUnread())), []);

  const unreadIds = useMemo(
    () => notificationIdsThatAppearUnread(entries, chatUnread),
    [chatUnread, entries],
  );

  const rows = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (!notificationSourceVisible(entry.source, sourceFilter)) return false;
      if (!lowerQuery) return true;
      return [entry.title, entry.body, notificationSourceLabel(entry.source), formatDay(entry.at)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(lowerQuery);
    });
    const days = new Map<string, NotificationLogEntry[]>();
    for (const entry of filtered) {
      const label = formatDay(entry.at);
      const group = days.get(label) ?? [];
      group.push(entry);
      days.set(label, group);
    }
    const columnId = sort.columnId ?? "date";
    const orderedDays = [...days.entries()].sort(([, left], [, right]) => {
      const leftAt = Math.max(...left.map((entry) => entry.at));
      const rightAt = Math.max(...right.map((entry) => entry.at));
      return columnId === "date" && sort.direction === "asc" ? leftAt - rightAt : rightAt - leftAt;
    });
    const sections = orderedDays.map(([label, group]) => ({
      label,
      items: [...group].sort((left, right) => compareSortValues(
        notificationSortValue(left, columnId),
        notificationSortValue(right, columnId),
        sort.direction,
      )),
    }));
    return buildSectionedRows(sections, (entry) => entry.id);
  }, [entries, query, sort.columnId, sort.direction, sourceFilter]);

  const selected = useMemo(() => {
    const match = rows.find((row) => row.kind === "item" && row.key === selectedRowId);
    const row = match ?? rows.find((candidate) => candidate.kind === "item");
    return row?.kind === "item" ? row.item : null;
  }, [rows, selectedRowId]);

  const openTeamNotification = useCallback((entry: NotificationLogEntry) => {
    markNotificationLogRead([entry.id]);
    const cardId = teamNotificationIdFromRef(entry.refId);
    const card = cardId
      ? teamStore.getSnapshot().notifications.find((notification) => notification.id === cardId) ?? null
      : null;
    if (cardId) void teamStore.dismissNotifications([cardId]);
    if (!card) {
      openTeamPane(createPaneFromTemplate);
      return;
    }
    if (card.type === "team-joined") {
      createPaneFromTemplate("new-chat-pane", { arg: teamChannelId(card.data.team.id) });
      return;
    }
    openTeamPane(createPaneFromTemplate, {
      teamId: card.data.team.id,
      ...(card.type === "team-invite" ? { section: "invites" as const } : {}),
    });
  }, [createPaneFromTemplate]);

  const openNotification = useCallback((entry: NotificationLogEntry | null) => {
    if (!entry) return;
    const priceAlertId = priceAlertIdFromRef(entry.refId);
    if (priceAlertId) {
      markNotificationLogRead([entry.id]);
      requestPriceAlertFocus(priceAlertId);
      showPane("alerts");
      return;
    }
    const catalystEventId = catalystEventIdFromRef(entry.refId);
    if (catalystEventId) {
      markNotificationLogRead([entry.id]);
      createPaneFromTemplate("catalysts-pane", {
        values: { event: catalystEventId },
        ...(entry.title ? { symbol: entry.title } : {}),
      });
      return;
    }
    if (entry.source === "team") {
      openTeamNotification(entry);
      return;
    }
    const destination = sourceDestination(entry.source);
    if (!destination) return;
    markNotificationLogRead([entry.id]);
    if (destination === "chat" && entry.refId) {
      const channelId = chatController.channelIdForMessage(entry.refId);
      if (channelId) {
        createPaneFromTemplate("new-chat-pane", { arg: channelId, values: { messageId: entry.refId } });
        return;
      }
    }
    showPane(destination);
  }, [createPaneFromTemplate, openTeamNotification, showPane]);

  const openSelected = useCallback(() => openNotification(selected), [openNotification, selected]);
  const markAllRead = useCallback(() => {
    markNotificationLogRead();
    chatController.markAllChannelsRead();
    const teamIds = teamStore.getSnapshot().notifications.map((notification) => notification.id);
    if (teamIds.length > 0) void teamStore.dismissNotifications(teamIds);
  }, []);
  const requestClear = useCallback(async () => {
    const confirmed = await confirmDialog(dialog, {
      title: t("Clear notification history?"),
      body: t("This cannot be undone."),
      confirmLabel: t("Clear"),
    });
    if (confirmed) clearNotificationLog();
  }, [dialog]);

  usePaneFooter("notification-center", () => ({
    hints: [
      ...(selected && sourceDestination(selected.source)
        ? [{ id: "open", key: "o", label: t("pen"), title: t("Open"), onPress: openSelected }]
        : []),
      { id: "mark-all-read", key: "m", label: t("ark all read"), title: t("Mark all read"), onPress: markAllRead },
      ...(entries.length > 0
        ? [{ id: "clear", key: "c", label: t("lear"), title: t("Clear"), onPress: () => { void requestClear(); } }]
        : []),
    ],
  }), [entries.length, markAllRead, openSelected, requestClear, selected]);

  const renderCell = useCallback((
    row: (typeof rows)[number],
    column: NotificationColumn,
  ): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const entry = row.item;
    if (column.id === "state") {
      const unread = unreadIds.has(entry.id);
      return { text: unread ? t("New") : t("Read"), color: unread ? colors.textBright : colors.textDim };
    }
    if (column.id === "date") return { text: formatTime(entry.at), color: colors.textDim };
    if (column.id === "source") return { text: notificationSourceLabel(entry.source), color: colors.textDim };
    return { text: entry.title ? `${entry.title}: ${entry.body}` : entry.body, color: colors.text };
  }, [unreadIds]);

  return (
    <DataTableView
      focused={focused && !search.active}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: (row) => row.key,
        onChange: (id) => setSelectedRowId(String(id)),
      }}
      onActivate={(row) => openNotification(isSectionedItemRow(row) ? row.item : null)}
      isNavigable={isSectionedItemRow}
      renderSectionHeader={renderSectionedRowHeader}
      rootWidth={width}
      rootHeight={height}
      rootBackgroundColor={colors.bg}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            ...search.searchProps,
            value: query,
            onChange: setQuery,
            placeholder: t("Search notifications"),
            focused,
          }}
          view={{
            value: sourceFilter,
            options: SOURCE_FILTERS.map((filter) => ({ value: filter.value, label: t(filter.label) })),
            onChange: (value) => {
              setSourceFilter(value);
              setSelectedRowId(null);
            },
            focused: focused && !search.active,
          }}
        />
      )}
      columns={COLUMNS}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as NotificationColumnId, {
        firstDirection: columnId === "date" ? "desc" : "asc",
      }))}
      onSortChange={(columnId, direction) => setSort({ columnId: columnId as NotificationColumnId, direction })}
      getItemKey={(row) => row.key}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={sourceFilter === "team" ? t("No team notices.") : t("No notices.")}
      emptyStateHint={sourceFilter === "all" ? t("Alerts, chat, and team notices show up here.") : undefined}
    />
  );
}

export const notificationCenterPlugin: GloomPlugin = {
  id: "notification-center",
  name: "Notification Center",
  version: "1.0.0",
  description: "Review alert, chat, and app notification history",
  toggleable: true,
  setup(ctx) {
    configureNotificationLog({
      get: () => {
        const value = ctx.configState.get<unknown>(NOTIFICATION_LOG_KEY);
        return Array.isArray(value) ? value : [];
      },
      set: (next) => ctx.configState.set(NOTIFICATION_LOG_KEY, next),
    });
    ctx.registerPane({
      id: "notification-center",
      name: "Notifications",
      component: NotificationCenterPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 30 },
      tableExport: true,
    });
    ctx.registerPaneTemplate({
      id: NOTIFICATION_CENTER_TEMPLATE_ID,
      paneId: "notification-center",
      label: "Notification Center",
      description: "Review alert, chat, and app notification history",
      keywords: ["notifications", "alerts", "mentions", "history"],
      shortcut: { prefix: "NOT", aliases: ["NOTF", "UNREAD"] },
      createInstance: () => ({ placement: "floating" }),
    });
  },
  dispose() {
    configureNotificationLog(null);
  },
};
