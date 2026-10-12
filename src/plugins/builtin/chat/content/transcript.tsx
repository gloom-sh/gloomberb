import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../../ui";
import { useLayoutEffect, type Dispatch, type SetStateAction } from "react";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import type { ChatAttachment, ChatMessage, ChatUserSummary } from "../../../../api-client";
import type { ChatUserAnchor, ChatUserContextMenuEvent } from "../message/types";
import type { ChatMessagePaneLink } from "../pane-links/model";
import { DesktopChatMessage } from "../message/desktop";
import { UserProfilePopover } from "../message/profile-popover";
import { TerminalChatMessage } from "../message/terminal";
import { NewMessagesJump } from "./new-messages";

interface MutableRef<T> {
  current: T;
}

interface ChatTranscriptProps {
  beginReplyTo: (index: number, options?: { deferFocus?: boolean }) => void;
  beginEditMessage: (index: number, options?: { deferFocus?: boolean }) => boolean;
  canSend: boolean;
  catalog: Record<string, InlineTickerCatalogEntry>;
  cancelProfilePopoverClose: () => void;
  chatWidth: number;
  contentWidth: number;
  handleTranscriptScrollActivity: (event?: { scroll?: { direction?: "up" | "down" | "left" | "right" } }) => void;
  /** The message a notification or a quoted reply sent the reader to, marked for a moment. */
  highlightedMessageId: string | null;
  hoveredIdx: number | null;
  jumpToMessage: (messageId: string) => void;
  loading: boolean;
  loadingOlderMessages: boolean;
  messagesError: string | null;
  onRetryMessages: () => void;
  retryMessage: (index: number) => void;
  onImageLoadError: (attachment: ChatAttachment) => void;
  messageAreaHeight: number;
  messageBodyWidth: number;
  messages: ChatMessage[];
  nativePaneChrome: boolean | undefined;
  /** Desktop: the pointer moved over the list. */
  onPointerMove: (event: { target?: unknown; pixelX?: number; pixelY?: number }) => void;
  /** Desktop: the list started or stopped following its bottom. */
  onStickyPinChange: (pinned: boolean) => void;
  latestEditableMessageId: string | null;
  openTicker: (symbol: string) => void;
  /** Opens what a message's chip stands for. */
  openPaneLink: (link: ChatMessagePaneLink) => void;
  profilePopoverUser: ChatUserSummary | null;
  /** The name or @mention the open card belongs beside. */
  profilePopoverAnchor: ChatUserAnchor;
  registerMessageElement: (messageId: string, node: unknown | null) => void;
  scheduleProfilePopoverClose: () => void;
  scrollRef: MutableRef<ScrollBoxRenderable | null>;
  selectedIdx: number;
  setHoveredIdx: Dispatch<SetStateAction<number | null>>;
  showProfilePopover: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  /** A click on a name: pins its card, or closes the one it pinned. */
  toggleProfilePopover: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  /** Closes the card at once, pinned or not (a click outside it on the desktop). */
  dismissProfilePopover: () => void;
  onSetUpProfile: () => void;
  /** Right-click on a name or @mention. */
  onUserContextMenu: (user: ChatUserSummary, event: ChatUserContextMenuEvent, anchor?: ChatUserAnchor) => void;
  /** The card's "Message" action for this user, or null where none is offered. */
  profileMessageAction: { label: string; onPress: () => void } | null;
  /** Why this user takes no DM from you, for a card that has no profile to show instead. */
  profileMessageRefusal: string | null;
  stickyTranscript: boolean;
  /** Messages from others that came in below a reader who is scrolled back. */
  unseenCount: number;
  onJumpToLatest: () => void;
  /** Called as this transcript comes, to put a reader back where the transcript it replaces left them. */
  takeBackScrollPlace: () => void;
  user: { id: string; username: string; emailVerified: boolean } | null;
  userByUsername: Map<string, ChatUserSummary>;
  /** The server takes reactions and you can send. */
  reactionsEnabled: boolean;
  toggleReaction: (messageId: string, emoji: string) => void;
  openReactionPicker: (index: number) => void;
  reactionPickerMessageId: string | null;
  closeReactionPicker: () => void;
}

export function ChatTranscript({
  beginReplyTo,
  beginEditMessage,
  canSend,
  catalog,
  cancelProfilePopoverClose,
  chatWidth,
  contentWidth,
  handleTranscriptScrollActivity,
  highlightedMessageId,
  hoveredIdx,
  jumpToMessage,
  loading,
  loadingOlderMessages,
  messagesError,
  onRetryMessages,
  retryMessage,
  onImageLoadError,
  messageAreaHeight,
  messageBodyWidth,
  messages,
  nativePaneChrome,
  onPointerMove,
  onStickyPinChange,
  latestEditableMessageId,
  openTicker,
  openPaneLink,
  profilePopoverUser,
  profilePopoverAnchor,
  registerMessageElement,
  scheduleProfilePopoverClose,
  scrollRef,
  selectedIdx,
  setHoveredIdx,
  showProfilePopover,
  toggleProfilePopover,
  dismissProfilePopover,
  stickyTranscript,
  unseenCount,
  onJumpToLatest,
  takeBackScrollPlace,
  user,
  userByUsername,
  onSetUpProfile,
  onUserContextMenu,
  profileMessageAction,
  profileMessageRefusal,
  reactionsEnabled,
  toggleReaction,
  openReactionPicker,
  reactionPickerMessageId,
  closeReactionPicker,
}: ChatTranscriptProps) {
  useLayoutEffect(() => {
    takeBackScrollPlace();
  }, [takeBackScrollPlace]);
  const reactionProps = {
    reactionsEnabled,
    currentUserId: user?.id ?? null,
    toggleReaction,
    openReactionPicker,
  };
  return (
    <>
      <Box
        position="relative"
        height={nativePaneChrome ? undefined : messageAreaHeight}
        flexGrow={nativePaneChrome ? 1 : undefined}
        style={nativePaneChrome ? { minHeight: 0 } : undefined}
      >
        <ScrollBox
          ref={scrollRef}
          height={nativePaneChrome ? undefined : messageAreaHeight}
          flexGrow={nativePaneChrome ? 1 : undefined}
          scrollY
          focusable={false}
          // The terminal's list follows the bottom only while nothing is selected; the
          // desktop's follows it for as long as the reader is there (see attachStickyScroll).
          stickyScroll={nativePaneChrome ? true : stickyTranscript}
          stickyStart="bottom"
          onMouseScroll={handleTranscriptScrollActivity}
          {...(nativePaneChrome ? {
            "data-gloom-role": "chat-transcript",
            onMouseMove: onPointerMove,
            onStickyPinChange,
          } : {})}
          style={nativePaneChrome ? { minHeight: 0 } : undefined}
        >
          {!nativePaneChrome && loadingOlderMessages && (
            <Box alignItems="center" justifyContent="center" height={1} width={contentWidth}>
              <Text fg={colors.textDim}>{t("Loading earlier messages...")}</Text>
            </Box>
          )}
          {loading && messages.length === 0 ? (
            <Box alignItems="center" justifyContent="center" flexGrow={1}>
              <Text fg={colors.textDim}>{t("Loading...")}</Text>
            </Box>
          ) : messagesError && messages.length === 0 ? (
            // A failed load must not read as an empty channel.
            <Box alignItems="center" justifyContent="center" flexGrow={1} flexDirection="column" gap={1}>
              <Text fg={colors.warning}>{messagesError}</Text>
            </Box>
          ) : messages.length === 0 && (
            <Box alignItems="center" justifyContent="center" flexGrow={1}>
              <Text fg={colors.textDim}>{t("No messages yet. Be the first to say something!")}</Text>
            </Box>
          )}
          {messages.map((msg, index) => (
            nativePaneChrome ? (
              <DesktopChatMessage
                key={msg.id}
                msg={msg}
                index={index}
                messages={messages}
                selectedIdx={selectedIdx}
                hoveredIdx={hoveredIdx === index ? index : null}
                highlighted={msg.id === highlightedMessageId}
                canSend={canSend}
                contentWidth={contentWidth}
                catalog={catalog}
                userByUsername={userByUsername}
                openTicker={openTicker}
                openPaneLink={openPaneLink}
                onUserHover={showProfilePopover}
                onUserHoverEnd={scheduleProfilePopoverClose}
                onUserActivate={toggleProfilePopover}
                onUserContextMenu={onUserContextMenu}
                beginReplyTo={beginReplyTo}
                beginEditMessage={beginEditMessage}
                jumpToMessage={jumpToMessage}
                latestEditableMessageId={latestEditableMessageId}
                retryMessage={retryMessage}
                onImageLoadError={onImageLoadError}
                registerMessageElement={registerMessageElement}
                {...reactionProps}
                reactionPickerMessageId={reactionPickerMessageId}
                closeReactionPicker={closeReactionPicker}
              />
            ) : (
              <TerminalChatMessage
                key={msg.id}
                msg={msg}
                index={index}
                messages={messages}
                selectedIdx={selectedIdx}
                hoveredIdx={hoveredIdx === index ? index : null}
                highlighted={msg.id === highlightedMessageId}
                canSend={canSend}
                contentWidth={contentWidth}
                messageBodyWidth={messageBodyWidth}
                catalog={catalog}
                userByUsername={userByUsername}
                openTicker={openTicker}
                openPaneLink={openPaneLink}
                onUserHover={showProfilePopover}
                onUserHoverEnd={scheduleProfilePopoverClose}
                onUserActivate={toggleProfilePopover}
                onUserContextMenu={onUserContextMenu}
                beginReplyTo={beginReplyTo}
                beginEditMessage={beginEditMessage}
                jumpToMessage={jumpToMessage}
                latestEditableMessageId={latestEditableMessageId}
                retryMessage={retryMessage}
                setHoveredIdx={setHoveredIdx}
                {...reactionProps}
              />
            )
          ))}
        </ScrollBox>
        {/* Over the list, not in it: a row in the list would push the messages down as it came and went. */}
        {nativePaneChrome && loadingOlderMessages && (
          <Box position="absolute" top={0} left={0} right={0} alignItems="center" style={{ pointerEvents: "none" }}>
            <Box paddingX={1} backgroundColor={colors.panel}>
              <Text fg={colors.textDim}>{t("Loading earlier messages...")}</Text>
            </Box>
          </Box>
        )}
        <NewMessagesJump count={unseenCount} nativePaneChrome={nativePaneChrome} width={contentWidth} onPress={onJumpToLatest} />
      </Box>

      {profilePopoverUser && (
        <UserProfilePopover
          user={profilePopoverUser}
          anchor={profilePopoverAnchor}
          width={chatWidth}
          onClose={scheduleProfilePopoverClose}
          onDismiss={dismissProfilePopover}
          onKeepOpen={cancelProfilePopoverClose}
          isOwnProfile={profilePopoverUser.id === user?.id}
          onSetUpProfile={onSetUpProfile}
          messageAction={profileMessageAction}
          messageRefusal={profileMessageRefusal}
        />
      )}
    </>
  );
}
