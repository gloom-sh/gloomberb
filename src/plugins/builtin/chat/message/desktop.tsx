import { memo } from "react";
import { Box, Text } from "../../../../ui";
import { hoverBg } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { t } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { MESSAGE_ACTION_WIDTH, normalizeInlinePreview } from "../layout";
import { Button } from "../../../../components/ui";
import { ResponsiveTickerBadgeText } from "./inline-tokens";
import { getChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

const DESKTOP_MESSAGE_RIGHT_PADDING = 2;

export const DesktopChatMessage = memo(function DesktopChatMessage({
  msg,
  index,
  messages,
  selectedIdx,
  hoveredIdx,
  canSend,
  catalog,
  userByUsername,
  openTicker,
  onUserHover,
  onUserHoverEnd,
  beginReplyTo,
  beginEditMessage,
  jumpToMessage,
  latestEditableMessageId,
  registerMessageElement,
}: ChatMessageBaseProps & {
  registerMessageElement: (messageId: string, node: unknown | null) => void;
}) {
  useAppLanguage();
  const themeColors = useThemeColors();
  const state = getChatMessageRenderState({ msg, index, messages, selectedIdx, hoveredIdx, canSend });
  const canEditMessage = msg.id === latestEditableMessageId;
  const showInlineReplyAction = !state.grouped && canSend;
  const showInlineEditAction = !state.grouped && canSend && canEditMessage;
  const showGroupedReplyAction = state.grouped && canSend;
  const showGroupedEditAction = state.grouped && canSend && canEditMessage;
  const authorLabel = msg.user.username ?? "anon";
  const groupedActionWidth = MESSAGE_ACTION_WIDTH * Number(showGroupedReplyAction) + MESSAGE_ACTION_WIDTH * Number(showGroupedEditAction);
  const rowProps = {
    width: "100%",
    paddingRight: DESKTOP_MESSAGE_RIGHT_PADDING,
    backgroundColor: state.bgColor,
    "data-gloom-role": "chat-message-row",
    "data-selected": state.isSelected ? "true" : "false",
    style: { minWidth: 0 },
  };

  return (
    <Box
      key={msg.id}
      ref={(node: unknown | null) => registerMessageElement(msg.id, node)}
      width="100%"
      flexDirection="column"
      data-gloom-role="chat-message"
      data-gloom-chat-message-id={msg.id}
      data-selected={state.isSelected ? "true" : "false"}
      style={{ "--chat-hover-bg": hoverBg(themeColors), minWidth: 0 }}
    >
      {msg.replyTo && (
        <Box
          {...rowProps}
          flexDirection="row"
          height={1}
          paddingLeft={2}
          onMouseDown={() => {
            if (msg.replyToId) jumpToMessage(msg.replyToId);
          }}
          style={{ minWidth: 0, alignItems: "flex-start", cursor: "pointer", overflow: "hidden" }}
        >
          {/* One line: the quoted text ends in an ellipsis, the whole message is a click away. */}
          <Text fg={state.replyMetaColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>reply </Text>
          <Text fg={state.replyAuthorColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{`${msg.replyTo.user.username}: `}</Text>
          <Text
            fg={state.replyMetaColor}
            style={{
              flex: "1 1 0",
              minWidth: 0,
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {normalizeInlinePreview(msg.replyTo.content)}
          </Text>
        </Box>
      )}
      {!state.grouped && (
        <Box
          {...rowProps}
          flexDirection="row"
          height={1}
          paddingLeft={1}
        >
          <Box
            height={1}
            onMouseOver={() => onUserHover(msg.user)}
            onMouseMove={() => onUserHover(msg.user)}
            onMouseOut={onUserHoverEnd}
            style={{ cursor: "pointer" }}
          >
            <Text
              fg={state.authorColor}
              attributes={state.authorAttributes}
            >
              {authorLabel}
            </Text>
          </Box>
          <Text fg={state.headerStatusColor}> {state.headerStatus}</Text>
          {(showInlineReplyAction || showInlineEditAction) && (
            <>
              <Text fg={state.headerStatusColor}> </Text>
              {showInlineReplyAction && (
                <Box
                  width={MESSAGE_ACTION_WIDTH}
                  height={1}
                  data-gloom-role="chat-message-reply-action"
                >
                  <Button stopPropagation
                    label={t("Reply")}
                    width={MESSAGE_ACTION_WIDTH}
                    variant={state.isSelected ? "primary" : "secondary"}
                    onPress={() => beginReplyTo(index)}
                  />
                </Box>
              )}
              {showInlineEditAction && (
                <Box
                  width={MESSAGE_ACTION_WIDTH}
                  height={1}
                  data-gloom-role="chat-message-reply-action"
                >
                  <Button stopPropagation
                    label={t("Edit")}
                    width={MESSAGE_ACTION_WIDTH}
                    variant={state.isSelected ? "primary" : "secondary"}
                    onPress={() => beginEditMessage(index)}
                  />
                </Box>
              )}
            </>
          )}
        </Box>
      )}
      <Box
        {...rowProps}
        paddingLeft={3}
        flexDirection="row"
        position={state.grouped ? "relative" : undefined}
        style={{ minWidth: 0, alignItems: "flex-start" }}
      >
        <Box flexGrow={1} style={{ minWidth: 0 }}>
          <ResponsiveTickerBadgeText
            text={msg.content}
            catalog={catalog}
            textColor={state.bodyColor}
            openTicker={openTicker}
            userByUsername={userByUsername}
            onUserHover={onUserHover}
            onUserHoverEnd={onUserHoverEnd}
          />
        </Box>
        {(showGroupedReplyAction || showGroupedEditAction) && (
          <Box
            position="absolute"
            top={0}
            right={0}
            width={groupedActionWidth}
            height={1}
            flexDirection="row"
            data-gloom-role="chat-message-reply-action"
          >
            {showGroupedReplyAction && (
              <Button stopPropagation
                label={t("Reply")}
                width={MESSAGE_ACTION_WIDTH}
                variant={state.isSelected ? "primary" : "secondary"}
                onPress={() => beginReplyTo(index)}
              />
            )}
            {showGroupedEditAction && (
              <Button stopPropagation
                label={t("Edit")}
                width={MESSAGE_ACTION_WIDTH}
                variant={state.isSelected ? "primary" : "secondary"}
                onPress={() => beginEditMessage(index)}
              />
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
});
