import { useCallback, useEffect, useState } from "react";
import {
  DataTableView,
  EmptyState,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
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
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import { chatController, type ChatController } from "./controller";
import { applyUnreadInboxItemToConfig } from "./pane-state";
import type { UnreadInboxItem } from "./unread-inbox";
import { chatTextWithImages } from "./attachments/model";
import { isManagedBot } from "./ghost-user";
import { CHAT_AI_BADGE_WIDTH, ChatAiBadge } from "./message/ai-badge";

interface UnreadInboxPaneProps extends PaneProps {
  controller?: Pick<ChatController, "getSnapshot" | "listUnreadInbox" | "subscribe">;
}

const COLUMNS: DataTableColumn[] = [
  { id: "channel", label: "Channel", width: 18, align: "left" },
  { id: "unread", label: "Unread", width: 6, align: "right" },
  { id: "latest", label: "Latest", width: 24, align: "left", flexGrow: 1 },
];

function renderCell(
  item: UnreadInboxItem,
  column: DataTableColumn,
  rowState: { selected: boolean },
  native: boolean,
): DataTableCell {
  switch (column.id) {
    case "channel":
      return { text: item.title };
    case "unread":
      // A mention of you reads like the status bar's count.
      return item.mentionsYou
        ? { text: String(item.unreadCount), value: item.unreadCount, color: colors.positive, attributes: TextAttributes.BOLD }
        : { text: String(item.unreadCount), value: item.unreadCount };
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

function readInbox(controller: NonNullable<UnreadInboxPaneProps["controller"]>) {
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
  const { createPaneFromTemplate } = usePluginAppActions();
  const [inbox, setInbox] = useState(() => readInbox(controller));
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedChannel", null);

  // Counts and messages follow the chat's own socket and refreshes; the list asks for nothing.
  useEffect(() => {
    setInbox(readInbox(controller));
    return controller.subscribe(() => setInbox(readInbox(controller)));
  }, [controller]);

  const renderInboxCell = useCallback(
    (item: UnreadInboxItem, column: DataTableColumn, _index: number, rowState: { selected: boolean }) => renderCell(item, column, rowState, !!nativePaneChrome),
    [nativePaneChrome],
  );

  const openItem = useCallback((item: UnreadInboxItem) => {
    const currentState = stateRef.current;
    const messageId = item.preview?.id ?? null;
    const { config, chatInstanceId } = applyUnreadInboxItemToConfig(
      currentState.config,
      { channelId: item.channelId, messageId, paneTitle: item.title },
      inboxInstanceId,
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

  if (!inbox.user && !inbox.hasSavedSession) {
    return <SignInWall placement="chat-unread-signin" action="see your unread chat" width={width} height={height} />;
  }
  if (inbox.user && !inbox.user.emailVerified) {
    return <SignInWall placement="chat-unread-signin" action="see your unread chat" needsVerification width={width} height={height} />;
  }

  const selected = inbox.items.find((item) => item.channelId === selectedId) ?? inbox.items[0] ?? null;
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      {inbox.items.length === 0 ? (
        <EmptyState title="No unread messages." />
      ) : (
        <DataTableView<UnreadInboxItem>
          focused={focused}
          columns={COLUMNS}
          items={inbox.items}
          rootWidth={width}
          rootHeight={height}
          getItemKey={(item) => item.channelId}
          emptyStateTitle="No unread messages."
          sortColumnId={null}
          sortDirection="asc"
          selection={{
            kind: "id",
            selectedId: selected?.channelId ?? null,
            getId: (item) => item.channelId,
            onChange: setSelectedId,
          }}
          selectedTextOverridesCellColor
          onActivate={openItem}
          renderCell={renderInboxCell}
        />
      )}
    </Box>
  );
}
