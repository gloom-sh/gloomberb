import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../../ui";
import type { Dispatch, SetStateAction } from "react";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { Button } from "../../../../components";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import type { ChatMessage, ChatUserSummary } from "../../../../api-client";
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
  onSetUpProfile: () => void;
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
  stickyTranscript,
  user,
  userByUsername,
  onSetUpProfile,
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
              beginReplyTo={beginReplyTo}
              beginEditMessage={beginEditMessage}
              jumpToMessage={jumpToMessage}
              latestEditableMessageId={latestEditableMessageId}
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
              beginReplyTo={beginReplyTo}
              beginEditMessage={beginEditMessage}
              jumpToMessage={jumpToMessage}
              latestEditableMessageId={latestEditableMessageId}
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
          onKeepOpen={cancelProfilePopoverClose}
          isOwnProfile={profilePopoverUser.id === user?.id}
          onSetUpProfile={onSetUpProfile}
        />
      )}
    </>
  );
}
