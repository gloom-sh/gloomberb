import { memo } from "react";
import { Box, Text } from "../../../../ui";
import { hoverBg } from "../../../../theme/colors";
import { useThemeColors } from "../../../../theme/theme-context";
import { t } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { normalizeInlinePreview } from "../layout";
import { DesktopChatMessageImages } from "../attachments/desktop";
import { chatReplyQuoteText } from "../attachments/model";
import { ChatMessageActions, ChatMessageHeader } from "./header";
import { ResponsiveTickerBadgeText } from "./inline-tokens";
import { useSlowPendingSend } from "./pending-send";
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
  onUserActivate,
  onUserContextMenu,
  beginReplyTo,
  beginEditMessage,
  jumpToMessage,
  latestEditableMessageId,
  retryMessage,
  onImageLoadError,
  registerMessageElement,
}: ChatMessageBaseProps & {
  registerMessageElement: (messageId: string, node: unknown | null) => void;
}) {
  useAppLanguage();
  const themeColors = useThemeColors();
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
    host: "desktop",
  });
  const actionProps = { state, index, beginReplyTo, beginEditMessage, retryMessage };
  const attachments = msg.attachments ?? [];
  // An image-only message has no text row; its images start where the text would.
  const showBody = msg.content.length > 0 || attachments.length === 0;
  const showImages = attachments.length > 0 || !!msg.attachmentReview;
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
          <Text fg={state.replyMetaColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{`${t("reply")} `}</Text>
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
            {normalizeInlinePreview(chatReplyQuoteText(msg.replyTo))}
          </Text>
        </Box>
      )}
      {!state.grouped && (
        <ChatMessageHeader
          msg={msg}
          rowProps={rowProps}
          onUserHover={onUserHover}
          onUserHoverEnd={onUserHoverEnd}
          onUserActivate={onUserActivate}
          onUserContextMenu={onUserContextMenu}
          {...actionProps}
        />
      )}
      {showBody && (
        <Box
          {...rowProps}
          paddingLeft={3}
          flexDirection="row"
          position={state.grouped ? "relative" : undefined}
          style={{ minWidth: 0, alignItems: "flex-start" }}
        >
          <Box flexGrow={1} data-gloom-role="chat-message-body" style={{ minWidth: 0 }}>
            <ResponsiveTickerBadgeText
              text={msg.content}
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
          {state.grouped && <ChatMessageActions floating {...actionProps} />}
        </Box>
      )}
      {showImages && (
        <Box
          {...rowProps}
          paddingLeft={3}
          flexDirection="row"
          position={state.grouped && !showBody ? "relative" : undefined}
          style={{ minWidth: 0, alignItems: "flex-start" }}
        >
          <DesktopChatMessageImages
            attachments={attachments}
            caption={msg.content}
            author={msg.user.username ?? "anon"}
            review={msg.attachmentReview}
            dimmed={state.isSending || msg.clientStatus === "failed"}
            onLoadError={onImageLoadError}
          />
          {state.grouped && !showBody && <ChatMessageActions floating {...actionProps} />}
        </Box>
      )}
    </Box>
  );
});
