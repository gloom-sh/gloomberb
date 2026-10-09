import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../../ui";
import type { Dispatch, SetStateAction } from "react";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import type { ChatAttachment, ChatMessage, ChatUserSummary } from "../../../../api-client";
import type { ChatUserContextMenuEvent } from "../message/types";
import { DesktopChatMessage } from "../message/desktop";
import { UserProfilePopover } from "../message/profile-popover";
import { TerminalChatMessage } from "../message/terminal";

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
  latestEditableMessageId: string | null;
  openTicker: (symbol: string) => void;
  profilePopoverUser: ChatUserSummary | null;
  registerMessageElement: (messageId: string, node: unknown | null) => void;
  scheduleProfilePopoverClose: () => void;
  scrollRef: MutableRef<ScrollBoxRenderable | null>;
  selectedIdx: number;
  setHoveredIdx: Dispatch<SetStateAction<number | null>>;
  showProfilePopover: (user: ChatUserSummary) => void;
  /** A click on a name: pins its card, or closes the one it pinned. */
  toggleProfilePopover: (user: ChatUserSummary) => void;
  /** Closes the card at once, pinned or not (a click outside it on the desktop). */
  dismissProfilePopover: () => void;
  onSetUpProfile: () => void;
  /** Right-click on a name or @mention. */
  onUserContextMenu: (user: ChatUserSummary, event: ChatUserContextMenuEvent) => void;
  /** The card's "Message" action for this user, or null where none is offered. */
  profileMessageAction: { label: string; onPress: () => void } | null;
  stickyTranscript: boolean;
  user: { id: string; username: string; emailVerified: boolean } | null;
  userByUsername: Map<string, ChatUserSummary>;
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
  latestEditableMessageId,
  openTicker,
  profilePopoverUser,
  registerMessageElement,
  scheduleProfilePopoverClose,
  scrollRef,
  selectedIdx,
  setHoveredIdx,
  showProfilePopover,
  toggleProfilePopover,
  dismissProfilePopover,
  stickyTranscript,
  user,
  userByUsername,
  onSetUpProfile,
  onUserContextMenu,
  profileMessageAction,
}: ChatTranscriptProps) {
  return (
    <>
      <ScrollBox
        ref={scrollRef}
        height={nativePaneChrome ? undefined : messageAreaHeight}
        flexGrow={nativePaneChrome ? 1 : undefined}
        scrollY
        focusable={false}
        stickyScroll={stickyTranscript}
        stickyStart="bottom"
        onMouseScroll={handleTranscriptScrollActivity}
        style={nativePaneChrome ? { minHeight: 0 } : undefined}
      >
        {loadingOlderMessages && (
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
              hoveredIdx={hoveredIdx}
              canSend={canSend}
              catalog={catalog}
              userByUsername={userByUsername}
              openTicker={openTicker}
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
            />
          ) : (
            <TerminalChatMessage
              key={msg.id}
              msg={msg}
              index={index}
              messages={messages}
              selectedIdx={selectedIdx}
              hoveredIdx={hoveredIdx}
              canSend={canSend}
              contentWidth={contentWidth}
              messageBodyWidth={messageBodyWidth}
              catalog={catalog}
              userByUsername={userByUsername}
              openTicker={openTicker}
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
            />
          )
        ))}
      </ScrollBox>

      {profilePopoverUser && (
        <UserProfilePopover
          user={profilePopoverUser}
          width={chatWidth}
          onClose={scheduleProfilePopoverClose}
          onDismiss={dismissProfilePopover}
          onKeepOpen={cancelProfilePopoverClose}
          isOwnProfile={profilePopoverUser.id === user?.id}
          onSetUpProfile={onSetUpProfile}
          messageAction={profileMessageAction}
        />
      )}
    </>
  );
}
