import { Box, Text, TextAttributes, useRendererHost } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { formatInlinePreview, getMessageBodyTokenLines } from "../layout";
import { chatImageLabel, chatImageReviewNote, chatReplyQuoteText } from "../attachments/model";
import { ChatMessageActions, ChatMessageHeader } from "./header";
import { ResponsiveTickerBadgeText } from "./inline-tokens";
import { useSlowPendingSend } from "./pending-send";
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
  onUserContextMenu,
  beginReplyTo,
  beginEditMessage,
  jumpToMessage,
  latestEditableMessageId,
  retryMessage,
  setHoveredIdx,
}: TerminalChatMessageProps) {
  const rendererHost = useRendererHost();
  const slowSend = useSlowPendingSend(msg);
  const state = getChatMessageRenderState({
    msg,
    index,
    messages,
    selectedIdx,
    hoveredIdx,
    canSend,
    canEdit: msg.id === latestEditableMessageId,
    slowSend,
    host: "terminal",
  });
  const actionProps = { state, index, beginReplyTo, beginEditMessage, retryMessage };
  const attachments = msg.attachments ?? [];
  // An image-only message has no text row; its image rows start where the text would.
  const bodyLines = msg.content.length > 0 || attachments.length === 0
    ? getMessageBodyTokenLines(msg.content, messageBodyWidth, catalog)
    : [];
  const reviewNote = chatImageReviewNote(msg);
  const imageColor = state.isSelected ? state.selectedTextColor : colors.textDim;
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
              chatReplyQuoteText(msg.replyTo),
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
          onUserContextMenu={onUserContextMenu}
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
              onUserContextMenu={onUserContextMenu}
            />
          </Box>
          {lineIndex === 0 && state.grouped && <ChatMessageActions floating {...actionProps} />}
        </Box>
      ))}
      {attachments.map((attachment, imageIndex) => (
        <Box
          key={`${msg.id}:image:${attachment.id}`}
          {...messageRowProps}
          paddingLeft={3}
          height={1}
          flexDirection="row"
          position={state.grouped && bodyLines.length === 0 && imageIndex === 0 ? "relative" : undefined}
        >
          <Box
            height={1}
            onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
              event.preventDefault?.();
              event.stopPropagation?.();
              void rendererHost.openExternal(attachment.url);
            }}
          >
            <Text fg={imageColor} attributes={TextAttributes.DIM}>
              {formatInlinePreview(`[${chatImageLabel(attachment)}]`, messageBodyWidth)}
            </Text>
          </Box>
          {state.grouped && bodyLines.length === 0 && imageIndex === 0 && <ChatMessageActions floating {...actionProps} />}
        </Box>
      ))}
      {reviewNote && (
        <Box {...messageRowProps} paddingLeft={3} height={1}>
          <Text fg={state.isSelected ? state.selectedTextColor : reviewNote.tone === "warning" ? colors.warning : colors.textMuted}>
            {formatInlinePreview(t(reviewNote.text), messageBodyWidth)}
          </Text>
        </Box>
      )}
    </Box>
  );
}
