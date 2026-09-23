import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getPaneSidebarWidthRange,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
} from "../../../../components";
import { t } from "../../../../i18n";
import { colors } from "../../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../../ui";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import {
  askgConversationLabel,
  askgConversationListStore,
} from "./conversation-store";

/** Leading gutter plus the one column active marker every row carries. */
const ROW_INDENT = 2;
/** Width of the delete affordance, so a label truncates clear of it. */
const ROW_ACTION_WIDTH = 3;

export function ASKGConversationSidebar({
  activeConversationId,
  width,
  paneWidth,
  height,
  focused,
  keyboardFocused,
  onSelect,
  onFocusRequest,
  onNewConversation,
  onDelete,
}: {
  activeConversationId: string | null;
  width: number;
  /** Width of the whole pane, which caps how far the sidebar can grow. */
  paneWidth: number;
  height: number;
  focused: boolean;
  keyboardFocused: boolean;
  onSelect: (conversationId: string) => void;
  onFocusRequest: () => void;
  onNewConversation: () => void;
  onDelete: (conversationId: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    (onChange) => askgConversationListStore.subscribe(onChange),
    () => askgConversationListStore.getSnapshot(),
    () => askgConversationListStore.getSnapshot(),
  );
  const widthRange = getPaneSidebarWidthRange(paneWidth);

  // More conversations than rows: show a window of them that follows the row
  // the keyboard is on, and scrolls with the wheel.
  const conversations = snapshot.conversations;
  const statusRow = !!snapshot.error || (snapshot.loading && focused);
  const capacity = Math.max(1, height - 1 - (statusRow ? 1 : 0));
  const maxStart = Math.max(0, conversations.length - capacity);
  const activeIndex = conversations.findIndex((conversation) => conversation.id === activeConversationId);
  const [scrollStart, setScrollStart] = useState(0);
  useEffect(() => {
    if (activeIndex < 0) return;
    setScrollStart((start) => (
      activeIndex < start ? activeIndex : activeIndex >= start + capacity ? activeIndex - capacity + 1 : start
    ));
  }, [activeIndex, capacity]);
  const start = Math.min(Math.max(0, scrollStart), maxStart);
  const visibleConversations = conversations.slice(start, start + capacity);

  return (
    <PaneSidebar
      width={width}
      height={height}
      focused={focused}
      keyboardFocused={keyboardFocused}
      resize={{
        min: widthRange.min,
        max: widthRange.max,
        onResize: (next) => askgConversationListStore.setWidth(next),
        onResizeEnd: (next) => askgConversationListStore.commitWidth(next),
      }}
    >
      {({ backgroundColor, listWidth }) => {
        const labelWidth = Math.max(listWidth - ROW_INDENT - ROW_ACTION_WIDTH, 1);
        return (
          <>
            <Box
              height={1}
              width={listWidth}
              flexDirection="row"
              backgroundColor={backgroundColor}
            >
              <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
                {` ${truncateWithEllipsis(t("Conversations"), Math.max(1, listWidth - ROW_ACTION_WIDTH - 1))}`}
              </Text>
              <Box flexGrow={1} />
              <PaneSidebarAction
                width={ROW_ACTION_WIDTH}
                ariaLabel={t("New conversation")}
                onPress={onNewConversation}
              >
                {({ foregroundColor, onMouseDown }) => (
                  <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}>
                    +
                  </Text>
                )}
              </PaneSidebarAction>
            </Box>
            <Box
              flexDirection="column"
              width={listWidth}
              onMouseScroll={(event: { scroll?: { direction?: string } }) => {
                const direction = event.scroll?.direction;
                if (direction !== "up" && direction !== "down") return;
                setScrollStart(Math.min(Math.max(0, start + (direction === "up" ? -3 : 3)), maxStart));
              }}
            >
            {visibleConversations.map((conversation) => {
              const active = conversation.id === activeConversationId;
              const label = askgConversationLabel(conversation);
              return (
                <PaneSidebarRow
                  key={conversation.id}
                  active={active}
                  ariaLabel={label}
                  onSelect={() => {
                    onFocusRequest();
                    onSelect(conversation.id);
                  }}
                >
                  {({ foregroundColor, onMouseDown }) => (
                    <>
                      <Text fg={foregroundColor} selectable={false} onMouseDown={onMouseDown}>
                        {active ? " ›" : "  "}
                      </Text>
                      <Text
                        fg={foregroundColor}
                        attributes={active ? TextAttributes.BOLD : 0}
                        selectable={false}
                        onMouseDown={onMouseDown}
                      >
                        {truncateWithEllipsis(label, labelWidth)}
                      </Text>
                      <Box flexGrow={1} onMouseDown={onMouseDown} />
                      <PaneSidebarAction
                        width={ROW_ACTION_WIDTH}
                        ariaLabel={`${t("Delete")} ${label}`}
                        highlightOnHover={false}
                        onPress={() => onDelete(conversation.id)}
                      >
                        {({ foregroundColor: actionColor, hovered, onMouseDown: onActionMouseDown }) => (
                          <Text
                            fg={hovered ? colors.negative : actionColor}
                            selectable={false}
                            onMouseDown={onActionMouseDown}
                          >
                            {hovered ? "x" : " "}
                          </Text>
                        )}
                      </PaneSidebarAction>
                    </>
                  )}
                </PaneSidebarRow>
              );
            })}
            </Box>
            <Box flexGrow={1} />
            {snapshot.error ? (
              <Box height={1} width={listWidth}>
                <Text fg={colors.negative}>
                  {` ${truncateWithEllipsis(t("List unavailable"), Math.max(1, listWidth - 1))}`}
                </Text>
              </Box>
            ) : snapshot.loading && focused ? (
              <Box height={1} width={listWidth}>
                <Text fg={colors.textDim}>{` ${t("syncing")}`}</Text>
              </Box>
            ) : null}
          </>
        );
      }}
    </PaneSidebar>
  );
}
