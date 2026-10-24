import { memo } from "react";
import { Box, Text } from "../../../../ui";
import { accentRuleOverlayStyle } from "../../../../components/ui/quote";
import { useThemeColors } from "../../../../theme/theme-context";
import { t } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { normalizeInlinePreview } from "../layout";
import { DesktopChatMessageImages } from "../attachments/desktop";
import { chatReplyQuoteText } from "../attachments/model";
import { chatAuthorName, heldMessage, isQuotedAuthorManagedBot } from "../ghost-user";
import { ChatBotIcon } from "./person-icons";
import { ChatMessageActions, ChatMessageHeader, chatHeaderFitsEveryIcon } from "./header";
import { MESSAGE_ACTION_WIDTH } from "../layout";
import { canReactToMessage } from "../reactions";
import { DesktopChatReactions, DesktopReactionAction } from "./reactions";
import { DesktopChatMessageText } from "./inline-tokens";
import { DesktopChatPaneChip } from "./pane-chip";
import { chatMessagePaneLinks } from "../pane-links/model";
import { useSlowPendingSend } from "./pending-send";
import { chatAnnouncementBg, chatHighlightBg, getChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

const DESKTOP_MESSAGE_RIGHT_PADDING = 2;

/**
 * The list's width for a desktop row, or undefined when the row draws the same
 * at any width: it only fits its author's icons by it. A row handed a width
 * draws again at every step of a resize.
 */
export function desktopChatMessageWidth(msg: ChatMessageBaseProps["msg"], contentWidth: number): number | undefined {
  return chatHeaderFitsEveryIcon(msg, contentWidth - DESKTOP_MESSAGE_RIGHT_PADDING) ? undefined : contentWidth;
}

export const DesktopChatMessage = memo(function DesktopChatMessage({
  msg,
  index,
  messages,
  selectedIdx,
  hoveredIdx,
  highlighted,
  canSend,
  contentWidth,
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
  reactionsEnabled = false,
  currentUserId = null,
  toggleReaction,
  openReactionPicker,
  reactionPickerMessageId = null,
  closeReactionPicker,
  openPaneLink,
}: ChatMessageBaseProps & {
  registerMessageElement: (messageId: string, node: unknown | null) => void;
  /** The list's width in cells, so a narrow pane keeps its actions in the row before its icons. */
  contentWidth?: number;
}) {
  useAppLanguage();
  const themeColors = useThemeColors();
  const slowSend = useSlowPendingSend(msg);
  const canReact = reactionsEnabled && canReactToMessage(msg) && !!toggleReaction;
  const state = getChatMessageRenderState({
    msg,
    index,
    messages,
    selectedIdx,
    hoveredIdx,
    highlighted,
    canSend,
    canEdit: msg.id === latestEditableMessageId,
    canReact,
    slowSend,
    host: "desktop",
  });
  const reactionPickerOpen = canReact && reactionPickerMessageId === msg.id;
  const reactAction = canReact && toggleReaction ? (
    <DesktopReactionAction
      msg={msg}
      currentUserId={currentUserId}
      open={reactionPickerOpen}
      width={MESSAGE_ACTION_WIDTH}
      variant={state.isSelected ? "primary" : "secondary"}
      onOpenChange={(open) => {
        if (open) openReactionPicker?.(index);
        else closeReactionPicker?.();
      }}
      onToggle={toggleReaction}
    />
  ) : null;
  const actionProps = { state, index, beginReplyTo, beginEditMessage, retryMessage, reactAction, reactionPickerOpen };
  const { links: paneLinks, content } = chatMessagePaneLinks(msg);
  // A share link sent with one picture, such as a pasted screenshot: the
  // picture is the chip's thumbnail rather than a second copy below it.
  const chipPreview = paneLinks.length === 1 && paneLinks[0]!.kind === "share"
    && msg.attachments?.length === 1 && !msg.attachmentReview
    ? msg.attachments[0]!
    : null;
  const attachments = chipPreview ? [] : msg.attachments ?? [];
  const dimmed = state.isSending || msg.clientStatus === "failed";
  // An image-only message has no text row; its images start where the text would.
  const showBody = content.length > 0 || (attachments.length === 0 && paneLinks.length === 0);
  const showChips = paneLinks.length > 0;
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
      data-hovered={state.isHovered ? "true" : "false"}
      data-highlighted={state.isHighlighted ? "true" : "false"}
      data-announcement={state.isAnnouncement ? "true" : undefined}
      style={{
        "--chat-highlight-bg": chatHighlightBg(themeColors),
        minWidth: 0,
        ...(state.isAnnouncement ? { position: "relative", "--chat-highlight-rest": chatAnnouncementBg("desktop") } : {}),
      }}
    >
      {msg.replyTo && (
        <Box
          {...rowProps}
          flexDirection="row"
          height={1}
          paddingLeft={2}
          onMouseDown={() => {
            // The thread handles background clearing in capture, before this
            // jump. Keep bubbling so the pane shell also receives the focus.
            if (msg.replyToId) jumpToMessage(msg.replyToId);
          }}
          style={{ minWidth: 0, alignItems: "flex-start", cursor: "pointer", overflow: "hidden" }}
        >
          {/* One line: the quoted text ends in an ellipsis, the whole message is a click away. */}
          <Text fg={state.replyMetaColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{`${t("reply")} `}</Text>
          {isQuotedAuthorManagedBot(msg.replyTo, userByUsername, () => heldMessage(messages, msg.replyToId)) ? (
            // The bot's icon stands where the colon would.
            <>
              <Text fg={state.replyAuthorColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{msg.replyTo.user.username}</Text>
              <ChatBotIcon selectedColor={state.isSelected ? state.selectedTextColor : undefined} />
              <Text fg={state.replyAuthorColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{" "}</Text>
            </>
          ) : (
            <Text fg={state.replyAuthorColor} style={{ flexShrink: 0, whiteSpace: "pre" }}>{`${msg.replyTo.user.username}: `}</Text>
          )}
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
          fitWidth={contentWidth === undefined ? undefined : contentWidth - DESKTOP_MESSAGE_RIGHT_PADDING}
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
          <Box flexGrow={1} data-gloom-role="chat-message-body" data-gloom-selectable="true" style={{ minWidth: 0 }}>
            <DesktopChatMessageText
              text={content}
              catalog={catalog}
              textColor={state.bodyColor}
              mutedColor={state.bodyMutedColor}
              openTicker={openTicker}
              openPaneLink={openPaneLink}
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
      {showChips && (
        <Box
          {...rowProps}
          paddingLeft={3}
          flexDirection="row"
          position={state.grouped && !showBody ? "relative" : undefined}
          style={{ minWidth: 0, alignItems: "flex-start" }}
        >
          <Box data-gloom-role="chat-pane-chips" style={{ minWidth: 0, flex: "1 1 auto", alignItems: "flex-start" }}>
            {paneLinks.map((link) => (
              <DesktopChatPaneChip
                key={link.kind === "share" ? link.id : link.link.kind}
                link={link}
                preview={chipPreview}
                dimmed={dimmed}
                onOpen={openPaneLink}
                onPreviewError={onImageLoadError}
              />
            ))}
          </Box>
          {state.grouped && !showBody && <ChatMessageActions floating {...actionProps} />}
        </Box>
      )}
      {showImages && (
        <Box
          {...rowProps}
          paddingLeft={3}
          flexDirection="row"
          position={state.grouped && !showBody && !showChips ? "relative" : undefined}
          style={{ minWidth: 0, alignItems: "flex-start" }}
        >
          <DesktopChatMessageImages
            attachments={attachments}
            caption={msg.content}
            author={chatAuthorName(msg.user)}
            review={msg.attachmentReview}
            dimmed={dimmed}
            onLoadError={onImageLoadError}
          />
          {state.grouped && !showBody && !showChips && <ChatMessageActions floating {...actionProps} />}
        </Box>
      )}
      {(msg.reactions?.length ?? 0) > 0 && (
        <Box {...rowProps} paddingLeft={3} flexDirection="row" style={{ minWidth: 0 }}>
          <DesktopChatReactions
            msg={msg}
            currentUserId={currentUserId}
            canReact={canReact}
            onToggle={toggleReaction ?? (() => {})}
          />
        </Box>
      )}
      {/* Last, so it draws over the rows' backgrounds. */}
      {state.isAnnouncement && <Box data-gloom-role="chat-announcement-rule" style={accentRuleOverlayStyle()} />}
    </Box>
  );
});
