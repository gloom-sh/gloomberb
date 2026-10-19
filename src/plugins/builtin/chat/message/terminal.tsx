import { Box, Text, TextAttributes, useRendererHost } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { formatInlinePreview, getMessageBodyTokenLines, MESSAGE_ACTION_WIDTH } from "../layout";
import { chatImageLabel, chatImageReviewNote, chatReplyQuoteText } from "../attachments/model";
import { heldMessage, isQuotedAuthorManagedBot } from "../ghost-user";
import { ChatBotIcon } from "./person-icons";
import { CHAT_PERSON_ICON_WIDTH } from "../people";
import { ChatMessageActions, ChatMessageHeader } from "./header";
import { Button } from "../../../../components/ui";
import { canReactToMessage } from "../reactions";
import { TerminalChatReactions } from "./reactions";
import { TerminalChatMessageRow } from "./inline-tokens";
import { TerminalChatPaneChip } from "./pane-chip";
import { chatMessagePaneLinks } from "../pane-links/model";
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
  highlighted,
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
  reactionsEnabled = false,
  currentUserId = null,
  toggleReaction,
  openReactionPicker,
  openPaneLink,
}: TerminalChatMessageProps) {
  const rendererHost = useRendererHost();
  const slowSend = useSlowPendingSend(msg);
  const canReact = reactionsEnabled && canReactToMessage(msg);
  const state = getChatMessageRenderState({
    msg,
    index,
    messages,
    selectedIdx,
    hoveredIdx,
    highlighted,
    canSend,
    canEdit: msg.id === latestEditableMessageId,
    canReact: canReact && !!openReactionPicker,
    slowSend,
    host: "terminal",
  });
  const reactAction = openReactionPicker ? (
    <Button stopPropagation
      label={t("React")}
      width={MESSAGE_ACTION_WIDTH}
      variant={state.isSelected ? "primary" : "secondary"}
      onPress={() => openReactionPicker(index)}
    />
  ) : null;
  const actionProps = { state, index, beginReplyTo, beginEditMessage, retryMessage, reactAction };
  const attachments = msg.attachments ?? [];
  // A share link is its chip's row; a message that was only one has no text row.
  const { links: paneLinks, content } = chatMessagePaneLinks(msg);
  // An image-only message has no text row; its image rows start where the text would.
  const bodyLines = content.length > 0 || (attachments.length === 0 && paneLinks.length === 0)
    ? getMessageBodyTokenLines(content, messageBodyWidth, catalog)
    : [];
  const reviewNote = chatImageReviewNote(msg);
  const imageColor = state.isSelected ? state.selectedTextColor : colors.textDim;
  const quotedAuthorIsBot = !!msg.replyTo
    && isQuotedAuthorManagedBot(msg.replyTo, userByUsername, () => heldMessage(messages, msg.replyToId));
  const setHovered = () => setHoveredIdx((current) => (current === index ? current : index));
  const clearHovered = () => setHoveredIdx((current) => (current === index ? null : current));
  const messageRowProps = {
    width: contentWidth,
    backgroundColor: state.bgColor,
    onMouseOver: setHovered,
    onMouseOut: clearHovered,
  };

  return (
    <Box key={msg.id} width={contentWidth} flexDirection="column" position={state.isAnnouncement ? "relative" : undefined}>
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
          {quotedAuthorIsBot ? (
            // The bot's icon stands where the colon would.
            <>
              <Text fg={state.replyAuthorColor}>{msg.replyTo.user.username}</Text>
              <ChatBotIcon selectedColor={state.isSelected ? state.selectedTextColor : undefined} />
              <Text fg={state.replyAuthorColor}> </Text>
            </>
          ) : (
            <Text fg={state.replyAuthorColor}>{msg.replyTo.user.username}: </Text>
          )}
          <Text fg={state.replyMetaColor}>
            {formatInlinePreview(
              chatReplyQuoteText(msg.replyTo),
              Math.max(messageBodyWidth - `reply ${msg.replyTo.user.username}`.length - (quotedAuthorIsBot ? CHAT_PERSON_ICON_WIDTH + 1 : 2), 0),
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
            <TerminalChatMessageRow
              line={line}
              catalog={catalog}
              textColor={state.bodyColor}
              mutedColor={state.bodyMutedColor}
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
      {paneLinks.map((link, linkIndex) => (
        <Box
          key={`${msg.id}:pane:${link.kind === "share" ? link.id : link.link.kind}`}
          {...messageRowProps}
          paddingLeft={3}
          height={1}
          flexDirection="row"
          position={state.grouped && bodyLines.length === 0 && linkIndex === 0 ? "relative" : undefined}
        >
          <TerminalChatPaneChip
            link={link}
            width={messageBodyWidth}
            selected={state.isSelected}
            selectedTextColor={state.selectedTextColor}
            onOpen={openPaneLink}
          />
          {state.grouped && bodyLines.length === 0 && linkIndex === 0 && <ChatMessageActions floating {...actionProps} />}
        </Box>
      ))}
      {attachments.map((attachment, imageIndex) => (
        <Box
          key={`${msg.id}:image:${attachment.id}`}
          {...messageRowProps}
          paddingLeft={3}
          height={1}
          flexDirection="row"
          position={state.grouped && bodyLines.length === 0 && paneLinks.length === 0 && imageIndex === 0 ? "relative" : undefined}
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
          {state.grouped && bodyLines.length === 0 && paneLinks.length === 0 && imageIndex === 0 && <ChatMessageActions floating {...actionProps} />}
        </Box>
      ))}
      {reviewNote && (
        <Box {...messageRowProps} paddingLeft={3} height={1}>
          <Text fg={state.isSelected ? state.selectedTextColor : reviewNote.tone === "warning" ? colors.warning : colors.textMuted}>
            {formatInlinePreview(t(reviewNote.text), messageBodyWidth)}
          </Text>
        </Box>
      )}
      <TerminalChatReactions
        msg={msg}
        currentUserId={currentUserId}
        canReact={canReact && !!toggleReaction}
        onToggle={toggleReaction ?? (() => {})}
        rowProps={messageRowProps}
        width={messageBodyWidth}
      />
      {state.isAnnouncement && (
        // The accent rule down the band's first column, which every row leaves
        // blank; last, so it draws over the rows' backgrounds.
        <Box position="absolute" left={0} top={0} bottom={0} width={1} border={["left"]} borderStyle="heavy" borderColor={colors.borderFocused} />
      )}
    </Box>
  );
}
