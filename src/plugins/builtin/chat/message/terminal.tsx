import { Box, Text } from "../../../../ui";
import { t } from "../../../../i18n";
import { formatInlinePreview, getMessageBodyTokenLines } from "../layout";
import { ChatMessageActions, ChatMessageHeader } from "./header";
import { ResponsiveTickerBadgeText } from "./inline-tokens";
import { getChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

interface TerminalChatMessageProps extends ChatMessageBaseProps {
  contentWidth: number;
  messageBodyWidth: number;
  setHoveredIdx: (updater: (current: number | null) => number | null) => void;
}

export function TerminalChatMessage({
  msg,
  index,
  messages,
  selectedIdx,
  hoveredIdx,
  canSend,
  contentWidth,
  messageBodyWidth,
  catalog,
  userByUsername,
  openTicker,
  onUserHover,
  onUserHoverEnd,
  onUserActivate,
  beginReplyTo,
  beginEditMessage,
  jumpToMessage,
  latestEditableMessageId,
  setHoveredIdx,
}: TerminalChatMessageProps) {
  const state = getChatMessageRenderState({
    msg,
    index,
    messages,
    selectedIdx,
    hoveredIdx,
    canSend,
    canEdit: msg.id === latestEditableMessageId,
    host: "terminal",
  });
  const actionProps = { state, index, beginReplyTo, beginEditMessage };
  const bodyLines = getMessageBodyTokenLines(msg.content, messageBodyWidth, catalog);
  const setHovered = () => setHoveredIdx((current) => (current === index ? current : index));
  const clearHovered = () => setHoveredIdx((current) => (current === index ? null : current));
  const messageRowProps = {
    width: contentWidth,
    backgroundColor: state.bgColor,
    onMouseOver: setHovered,
    onMouseOut: clearHovered,
  };

  return (
    <Box key={msg.id} width={contentWidth} flexDirection="column">
      {msg.replyTo && (
        <Box
          {...messageRowProps}
          flexDirection="row"
          height={1}
          paddingLeft={2}
          onMouseDown={() => {
            if (msg.replyToId) jumpToMessage(msg.replyToId);
          }}
        >
          <Text fg={state.replyMetaColor}>{`${t("reply")} `}</Text>
          <Text fg={state.replyAuthorColor}>{msg.replyTo.user.username}: </Text>
          <Text fg={state.replyMetaColor}>
            {formatInlinePreview(
              msg.replyTo.content,
              Math.max(messageBodyWidth - `reply ${msg.replyTo.user.username}: `.length, 0),
            )}
          </Text>
        </Box>
      )}
      {!state.grouped && (
        <ChatMessageHeader
          msg={msg}
          rowProps={messageRowProps}
          fitAuthorWidth
          onUserHover={onUserHover}
          onUserHoverEnd={onUserHoverEnd}
          onUserActivate={onUserActivate}
          {...actionProps}
        />
      )}
      {bodyLines.map((line, lineIndex) => (
        <Box
          key={`${msg.id}:body:${lineIndex}`}
          {...messageRowProps}
          paddingLeft={3}
          height={1}
          flexDirection="row"
          position={state.grouped ? "relative" : undefined}
        >
          <Box width={messageBodyWidth} height={1}>
            <ResponsiveTickerBadgeText
              tokens={line}
              prewrapped
              catalog={catalog}
              textColor={state.bodyColor}
              openTicker={openTicker}
              userByUsername={userByUsername}
              onUserHover={onUserHover}
              onUserHoverEnd={onUserHoverEnd}
              onUserActivate={onUserActivate}
            />
          </Box>
          {lineIndex === 0 && state.grouped && <ChatMessageActions floating {...actionProps} />}
        </Box>
      ))}
    </Box>
  );
}
