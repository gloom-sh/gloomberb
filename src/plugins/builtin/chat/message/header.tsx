import { useRef, type ReactNode } from "react";
import { Box, Text, useUiCapabilities, type BoxRenderable } from "../../../../ui";
import { t } from "../../../../i18n";
import { displayWidth } from "../../../../utils/format";
import { chatAuthorName, isDiscordGhost } from "../ghost-user";
import { Badge, Button } from "../../../../components/ui";
import { MESSAGE_ACTION_WIDTH } from "../layout";
import { CHAT_PERSON_ICON_WIDTH, chatPersonIcons, fitChatPersonIcons } from "../people";
import { ChatPersonIcons } from "./person-icons";
import type { ChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

type ChatMessageActionProps = Pick<ChatMessageBaseProps, "index" | "beginReplyTo" | "beginEditMessage" | "retryMessage"> & {
  state: ChatMessageRenderState;
  /** The React action, one action wide, where the message takes reactions. */
  reactAction?: ReactNode;
  /** The reaction picker is open from this message: its actions stay shown. */
  reactionPickerOpen?: boolean;
};

/** Reply, React and Edit for one message, or Retry for a failed send: after the header, or floated over the first body line of a grouped message. */
export function ChatMessageActions({
  state,
  index,
  floating = false,
  beginReplyTo,
  beginEditMessage,
  retryMessage,
  reactAction,
  reactionPickerOpen = false,
}: ChatMessageActionProps & { floating?: boolean }) {
  const variant = state.isSelected ? "primary" : "secondary";
  if (state.showRetryAction && retryMessage) {
    return (
      <Box
        {...(floating ? { position: "absolute", top: 0, right: 0 } : {})}
        width={MESSAGE_ACTION_WIDTH}
        height={1}
        flexDirection="row"
        data-gloom-role="chat-message-retry-action"
      >
        <Button stopPropagation
          label={t("Retry")}
          width={MESSAGE_ACTION_WIDTH}
          variant={variant}
          onPress={() => retryMessage(index)}
        />
      </Box>
    );
  }
  if (!state.showReplyAction) return null;
  const showReact = state.showReactAction && !!reactAction;
  const actionCount = 1 + (showReact ? 1 : 0) + (state.showEditAction ? 1 : 0);
  return (
    <Box
      {...(floating ? { position: "absolute", top: 0, right: 0 } : {})}
      width={MESSAGE_ACTION_WIDTH * actionCount}
      height={1}
      flexDirection="row"
      data-gloom-role="chat-message-reply-action"
      data-picker-open={reactionPickerOpen ? "true" : undefined}
    >
      <Button stopPropagation
        label={t("Reply")}
        width={MESSAGE_ACTION_WIDTH}
        variant={variant}
        onPress={() => beginReplyTo(index)}
      />
      {showReact && reactAction}
      {state.showEditAction && (
        <Button stopPropagation
          label={t("Edit")}
          width={MESSAGE_ACTION_WIDTH}
          variant={variant}
          onPress={() => beginEditMessage(index)}
        />
      )}
    </Box>
  );
}

/** The widest status a header shows ("just now edited", a date with " edited", "sending..."). */
const WIDEST_HEADER_STATUS = Math.max(...["just now edited", "12/31/99 edited", "sending..."].map(displayWidth));
/** Reply, React and Edit, after the cell before them. */
const WIDEST_HEADER_ACTIONS = 1 + MESSAGE_ACTION_WIDTH * 3;

/**
 * Whether a header row `rowWidth` cells wide has room for every icon of its
 * author whatever its status and actions: past that width the icons it shows
 * no longer depend on the width, so a row need not draw again as it changes.
 */
export function chatHeaderFitsEveryIcon(msg: ChatMessageBaseProps["msg"], rowWidth: number): boolean {
  const icons = chatHeaderIcons(msg).length;
  if (icons === 0) return true;
  const spare = rowWidth - 1 - displayWidth(chatAuthorName(msg.user))
    - (msg.origin === "discord" ? 8 : 0)
    - 1 - WIDEST_HEADER_STATUS
    - WIDEST_HEADER_ACTIONS;
  return spare >= icons * CHAT_PERSON_ICON_WIDTH;
}

/** The mark an announcement carries beside its author, in place of the author's icons. */
const ANNOUNCEMENT_LABEL = "Announcement";

/** Cells the mark takes in the terminal: a cell of space, then the chip with a cell inside each edge. */
function announcementMarkWidth(): number {
  return 1 + displayWidth(t(ANNOUNCEMENT_LABEL)) + 2;
}

/** An announcement is signed by its mark alone: Gloom's account is not a bot speaking. */
function chatHeaderIcons(msg: ChatMessageBaseProps["msg"]) {
  return msg.announcement ? [] : chatPersonIcons(msg.user);
}

/**
 * Author, send status and inline actions for the first message of a group.
 *
 * A bot's icon sits beside its name always. The Team and Pro icons show while
 * the row is pointed at or selected, after the status, in the space the row
 * already has: nothing before them moves, and a row that is not pointed at
 * keeps no room for them. A row too narrow for its icons, its status and its
 * actions drops Pro first, then the role, and never cuts the name. An
 * announcement carries its mark beside the name instead, dropped only by a
 * terminal row too narrow for it (the band and its rule still say what it is).
 */
export function ChatMessageHeader({
  msg,
  state,
  rowProps,
  fitAuthorWidth = false,
  fitWidth,
  onUserHover,
  onUserHoverEnd,
  onUserActivate,
  onUserContextMenu,
  ...actionProps
}: ChatMessageActionProps & Pick<ChatMessageBaseProps, "msg" | "onUserHover" | "onUserHoverEnd" | "onUserActivate" | "onUserContextMenu"> & {
  /** Host row props: width, background and hover or selection hooks. */
  rowProps: Record<string, unknown>;
  /** The terminal sizes the author cell to its label. */
  fitAuthorWidth?: boolean;
  /** Cells the row has when `rowProps` sizes it in CSS: the desktop's. */
  fitWidth?: number;
}) {
  const authorLabel = chatAuthorName(msg.user);
  // A Discord ghost has no Gloom profile to open and no one to message.
  const hasProfile = !isDiscordGhost(msg.user);
  const { nativeContextMenu } = useUiCapabilities();
  // The card opens beside the name the pointer is on.
  const nameRef = useRef<BoxRenderable | null>(null);
  const rowWidth = typeof rowProps.width === "number" ? rowProps.width : fitWidth ?? null;
  // Counted with the actions, shown or not, so the icons that fit do not change on hover.
  const spare = rowWidth === null
    ? Number.POSITIVE_INFINITY
    : rowWidth - 1 - displayWidth(authorLabel)
      - (msg.origin === "discord" ? 8 : 0)
      - 1 - displayWidth(state.headerStatus)
      - state.actionsWidth;
  const icons = chatHeaderIcons(msg);
  const showAnnouncementMark = msg.announcement === true && spare >= announcementMarkWidth();
  const besideName = fitChatPersonIcons(icons.filter((icon) => icon.id === "bot"), spare);
  const onPoint = fitChatPersonIcons(icons.filter((icon) => icon.id !== "bot"), spare - besideName.length * CHAT_PERSON_ICON_WIDTH);
  // An open reaction picker keeps the row's actions, so it keeps what stands before them too.
  const showOnPoint = state.showPersonIcons || actionProps.reactionPickerOpen === true;
  const iconColor = state.isSelected ? state.selectedTextColor : undefined;
  const profileTarget: Record<string, unknown> = hasProfile
    ? {
      onMouseOver: () => onUserHover(msg.user, nameRef.current),
      onMouseMove: () => onUserHover(msg.user, nameRef.current),
      onMouseOut: onUserHoverEnd,
      "data-gloom-context-menu-surface": "true",
      onMouseDown: (event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        // A native menu opens on the right-click's contextmenu event instead.
        if (event.button === 2 && nativeContextMenu === true) return;
        onUserActivate?.(msg.user, nameRef.current);
      },
      onContextMenu: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => onUserContextMenu?.(msg.user, event, nameRef.current),
      style: { cursor: "pointer" },
    }
    : {};
  return (
    <Box {...rowProps} flexDirection="row" height={1} paddingLeft={1}>
      <Box
        ref={nameRef}
        width={fitAuthorWidth ? displayWidth(authorLabel) : undefined}
        height={1}
        {...profileTarget}
      >
        <Text fg={state.authorColor} attributes={state.authorAttributes}>
          {authorLabel}
        </Text>
      </Box>
      <ChatPersonIcons icons={besideName} selectedColor={iconColor} terminalTarget={profileTarget} />
      {showAnnouncementMark && (
        <>
          <Text fg={state.headerStatusColor}> </Text>
          <Badge label={ANNOUNCEMENT_LABEL} tone="accent" />
        </>
      )}
      {msg.origin === "discord" && <Text fg={state.originTagColor}> Discord</Text>}
      <Text fg={state.headerStatusColor}> {state.headerStatus}</Text>
      {showOnPoint && <ChatPersonIcons icons={onPoint} selectedColor={iconColor} terminalTarget={profileTarget} />}
      {(state.showReplyAction || (state.showRetryAction && actionProps.retryMessage)) && <Text fg={state.headerStatusColor}> </Text>}
      <ChatMessageActions state={state} {...actionProps} />
    </Box>
  );
}
