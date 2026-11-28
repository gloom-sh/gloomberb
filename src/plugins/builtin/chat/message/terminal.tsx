import { Box, Text, TextAttributes, useRendererHost } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { formatInlinePreview, getMessageBodyTokenLines } from "../layout";
import { chatImageLabel, chatImageReviewNote } from "../attachments/model";
import { ChatMessageActions, ChatMessageHeader, type ChatMessageActionIconProps } from "./header";
import { IconButton } from "../../../../components/ui";
import { useSelectionFill } from "../../../../components/ui/selection-fill";
import { canReactToMessage } from "../reactions";
import { TerminalChatReactions } from "./reactions";
import { TerminalChatMessageRow } from "./inline-tokens";
import { TerminalChatPaneChipRow } from "./pane-chip";
import { ChatMessageReplyQuote, useChatMessageModel } from "./shared";
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
  actionKeysShown = false,
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
  const selectionFill = useSelectionFill();
  const canReact = reactionsEnabled && canReactToMessage(msg);
  const { state, paneLinks, content, quotedAuthorIsBot } = useChatMessageModel(
    { msg, index, messages, selectedIdx, hoveredIdx, highlighted, canSend, latestEditableMessageId, userByUsername },
    { host: "terminal", canReact: canReact && !!openReactionPicker },
  );
  const reactAction = openReactionPicker ? (icon: ChatMessageActionIconProps) => (
    <IconButton icon="react" {...icon} hasPopup="dialog" onPress={() => openReactionPicker(index)} />
  ) : undefined;
  const actionProps = { state, index, beginReplyTo, beginEditMessage, retryMessage, reactAction, actionKeysShown };
  // A grouped message floats its actions at the right edge of its first row.
  const floatingRow = { width: contentWidth };
  const attachments = msg.attachments ?? [];
  // An image-only message has no text row; its image rows start where the text would.
  const bodyLines = content.length > 0 || (attachments.length === 0 && paneLinks.length === 0)
    ? getMessageBodyTokenLines(content, messageBodyWidth, catalog)
    : [];
  const reviewNote = chatImageReviewNote(msg);
  const imageColor = state.isSelected ? state.selectedTextColor : colors.textDim;
  const setHovered = () => setHoveredIdx((current) => (current === index ? current : index));
  const clearHovered = () => setHoveredIdx((current) => (current === index ? null : current));
  const messageRowProps = {
    width: contentWidth,
    // The chosen message is quieter while the chat pane does not have the keys.
    backgroundColor: state.isSelected ? selectionFill.bg : state.bgColor,
    onMouseOver: setHovered,
    onMouseOut: clearHovered,
  };

  return (
    <Box key={msg.id} width={contentWidth} flexDirection="column" position={state.isAnnouncement ? "relative" : undefined}>
      <ChatMessageReplyQuote
        msg={msg}
        state={state}
        quotedAuthorIsBot={quotedAuthorIsBot}
        rowProps={messageRowProps}
        jumpToMessage={jumpToMessage}
        host="terminal"
        messageBodyWidth={messageBodyWidth}
        formatTerminalQuote={formatInlinePreview}
      />
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
          {lineIndex === 0 && state.grouped && <ChatMessageActions floating row={floatingRow} {...actionProps} />}
        </Box>
      ))}
      {paneLinks.map((link, linkIndex) => (
        <TerminalChatPaneChipRow
          key={`${msg.id}:pane:${link.kind === "share" ? link.id : link.link.kind}`}
          link={link}
          width={messageBodyWidth}
          rowProps={{
            ...messageRowProps,
            paddingLeft: 3,
            position: state.grouped && bodyLines.length === 0 && linkIndex === 0 ? "relative" : undefined,
          }}
          selected={state.isSelected}
          selectedTextColor={state.selectedTextColor}
          onOpen={openPaneLink}
        >
          {state.grouped && bodyLines.length === 0 && linkIndex === 0 && <ChatMessageActions floating row={floatingRow} {...actionProps} />}
        </TerminalChatPaneChipRow>
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
          {state.grouped && bodyLines.length === 0 && paneLinks.length === 0 && imageIndex === 0 && <ChatMessageActions floating row={floatingRow} {...actionProps} />}
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
