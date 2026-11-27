import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useUiCapabilities, type BoxRenderable } from "../../../../ui";
import { t } from "../../../../i18n";
import { displayWidth } from "../../../../utils/format";
import { formatShortcutForHost } from "../../../../app/keybindings/labels";
import { chatAuthorName, isDiscordGhost } from "../ghost-user";
import { Badge, Button, IconButton } from "../../../../components/ui";
import { ICON_GROUP_ATTRIBUTE } from "../../../../components/ui/icon";
import { TerminalHoverLabel, terminalHoverLabelSide } from "../../../../components/ui/terminal-hover-label";
import { MESSAGE_ICON_ACTION_WIDTH, MESSAGE_RETRY_ACTION_WIDTH } from "../layout";
import { CHAT_PERSON_ICON_WIDTH, chatPersonIcons, fitChatPersonIcons } from "../people";
import { ChatPersonIcons } from "./person-icons";
import type { ChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

/** What every icon action of a message takes: its name, its key where it has one, its colour on the row. */
export interface ChatMessageActionIconProps {
  label: string;
  shortcut?: string;
  color?: string;
  onHoverChange?: (hovered: boolean) => void;
  focusLabel?: boolean;
}

type ChatMessageAction = "reply" | "react" | "edit";

/** The keys that press each action on the row the keyboard is on (the chat's Enter, and the footer's + and e). */
const ACTION_KEYS: Record<ChatMessageAction, string> = { reply: "Enter", react: "+", edit: "e" };
const ACTION_LABELS: Record<ChatMessageAction, string> = { reply: "Reply", react: "React", edit: "Edit" };

type ChatMessageActionProps = Pick<ChatMessageBaseProps, "index" | "beginReplyTo" | "beginEditMessage" | "retryMessage" | "actionKeysShown"> & {
  state: ChatMessageRenderState;
  /** The React action where the message takes reactions, drawn with the props every icon action takes. */
  reactAction?: (icon: ChatMessageActionIconProps) => ReactNode;
  /** The reaction picker is open from this message: its actions stay shown. */
  reactionPickerOpen?: boolean;
};

/**
 * Reply, React and Edit for one message as icons, or Retry for a failed send:
 * after the header, or floated over the first body line of a grouped message.
 * Only the row the keyboard is on names their keys, so a hint never offers a
 * key that would act on another message or type into the composer. The
 * desktop names each in its tooltip, and the one keyboard focus is on beside
 * the group; the terminal, which has no tooltips, names the one under the
 * pointer beside the actions, over the row (`row`).
 */
export function ChatMessageActions({
  state,
  index,
  floating = false,
  floatRight = 0,
  row,
  beginReplyTo,
  beginEditMessage,
  retryMessage,
  reactAction,
  reactionPickerOpen = false,
  actionKeysShown = false,
}: ChatMessageActionProps & {
  floating?: boolean;
  /**
   * Cells between a floating group and its row's right edge. The desktop
   * gives its rows' right padding, so the icons end where the text does and
   * stay clear of an overlay scrollbar: WebKit takes a press on the list's
   * last pixels for its scrollbar, which would swallow the last icon.
   */
  floatRight?: number;
  /**
   * Terminal: the row's width in cells and where the actions start in it, so
   * the name of the one under the pointer goes where it covers none of them.
   * A floating group sits at the row's right edge.
   */
  row?: { width: number; start?: number };
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const [hovered, setHovered] = useState<ChatMessageAction | null>(null);
  const variant = state.isSelected ? "primary" : "secondary";
  if (state.showRetryAction && retryMessage) {
    return (
      <Box
        {...(floating ? { position: "absolute" as const, top: 0, right: floatRight } : {})}
        width={MESSAGE_RETRY_ACTION_WIDTH}
        height={1}
        flexDirection="row"
        data-gloom-role="chat-message-retry-action"
      >
        <Button stopPropagation
          label={t("Retry")}
          width={MESSAGE_RETRY_ACTION_WIDTH}
          variant={variant}
          onPress={() => retryMessage(index)}
        />
      </Box>
    );
  }
  if (!state.showReplyAction) return null;
  const showReact = state.showReactAction && !!reactAction;
  const actions: ChatMessageAction[] = ["reply", ...(showReact ? ["react" as const] : []), ...(state.showEditAction ? ["edit" as const] : [])];
  const width = MESSAGE_ICON_ACTION_WIDTH * actions.length;
  const icon = (action: ChatMessageAction): ChatMessageActionIconProps => ({
    label: ACTION_LABELS[action],
    ...(actionKeysShown ? { shortcut: ACTION_KEYS[action] } : {}),
    // On the selected row the icons take its text colour, as its words do.
    ...(state.isSelected ? { color: state.selectedTextColor } : {}),
    // The desktop names the one the keyboard is on beside the row's icons, as the terminal names the one under the pointer.
    ...(nativePaneChrome ? { focusLabel: true } : {
      onHoverChange: (on: boolean) => setHovered((current) => (on ? action : current === action ? null : current)),
    }),
  });
  const shownHover = hovered && actions.includes(hovered) ? hovered : null;
  let label: ReactNode = null;
  if (!nativePaneChrome && shownHover && row) {
    const start = row.start ?? row.width - width;
    const name = `${t(ACTION_LABELS[shownHover])}${actionKeysShown ? ` (${formatShortcutForHost(ACTION_KEYS[shownHover], "terminal")})` : ""}`;
    const placement = terminalHoverLabelSide(name, { before: Math.max(0, start), after: Math.max(0, row.width - start - width) });
    if (placement) {
      label = (
        <TerminalHoverLabel
          text={placement.text}
          left={placement.side === "after" ? width : -displayWidth(placement.text)}
          role="chat-message-action-label"
        />
      );
    }
  }
  return (
    <Box
      // Relative where it sits in its row, so the terminal's name of the action under the pointer goes beside it.
      {...(floating ? { position: "absolute" as const, top: 0, right: floatRight } : { position: "relative" as const })}
      // The terminal's icons are a glyph and a space either side; the desktop's size themselves.
      width={nativePaneChrome ? undefined : width}
      height={1}
      flexDirection="row"
      data-gloom-role="chat-message-reply-action"
      {...{ [ICON_GROUP_ATTRIBUTE]: "true" }}
      data-picker-open={reactionPickerOpen ? "true" : undefined}
      // Floated over a grouped message's first line, the band under the icons hides the words they cover.
      style={nativePaneChrome && floating ? { backgroundColor: "inherit" } : undefined}
    >
      <IconButton icon="reply" {...icon("reply")} onPress={() => beginReplyTo(index)} />
      {showReact && reactAction(icon("react"))}
      {state.showEditAction && (
        <IconButton icon="edit" {...icon("edit")} onPress={() => beginEditMessage(index)} />
      )}
      {label}
    </Box>
  );
}

/** The widest status a header shows ("just now edited", a date with " edited", "sending..."). */
const WIDEST_HEADER_STATUS = Math.max(...["just now edited", "12/31/99 edited", "sending..."].map(displayWidth));
/** Reply, React and Edit, or Retry, after the cell before them. */
const WIDEST_HEADER_ACTIONS = 1 + Math.max(MESSAGE_ICON_ACTION_WIDTH * 3, MESSAGE_RETRY_ACTION_WIDTH);

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
  // Terminal: where the actions start in the row, after everything drawn before them.
  const terminalRow = typeof rowProps.width === "number"
    ? {
      width: rowProps.width,
      start: 1 + displayWidth(authorLabel)
        + besideName.length * CHAT_PERSON_ICON_WIDTH
        + (showAnnouncementMark ? announcementMarkWidth() : 0)
        + (msg.origin === "discord" ? 8 : 0)
        + 1 + displayWidth(state.headerStatus)
        + (showOnPoint ? onPoint.length * CHAT_PERSON_ICON_WIDTH : 0)
        + 1,
    }
    : undefined;
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
      <ChatMessageActions state={state} row={terminalRow} {...actionProps} />
    </Box>
  );
}
