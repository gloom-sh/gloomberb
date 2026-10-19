import { TextAttributes } from "../../../../ui";
import { blendHex, colors, hoverBg } from "../../../../theme/colors";
import type { ChatMessage } from "../../../../api-client";
import { formatTimeAgo } from "../../../../utils/datetime-format";
import { accentTint } from "../../../../components/ui/quote";
import { isGroupedWithPrevious, MESSAGE_ACTION_WIDTH } from "../layout";
import { chatAuthorNameColor } from "../people";

/** The band on a message the reader was sent to: the accent at low strength, between the hover and the selection. */
export function chatHighlightBg(palette = colors): string {
  return blendHex(palette.bg, palette.borderFocused, 0.22);
}

/** How far an announcement's band leans toward the accent in the terminal: a quote's faint tint. */
const ANNOUNCEMENT_TINT = 0.07;

/**
 * An announcement's band at rest, well under a message the reader was sent
 * to: on the desktop and the web the kit's accent tint over the list's own
 * surface (a quote's), in the terminal the same strength over the background.
 * Pointed at, a terminal band takes a step toward the selection, as a plain
 * row does from nothing; the desktop's takes the hover band like any row.
 */
export function chatAnnouncementBg(host: "desktop" | "terminal", palette = colors, hovered = false): string {
  if (host === "desktop") return accentTint();
  const band = blendHex(palette.bg, palette.borderFocused, ANNOUNCEMENT_TINT);
  return hovered ? blendHex(band, palette.selected, 0.5) : band;
}

export interface ChatMessageRenderState {
  isSelected: boolean;
  isHovered: boolean;
  isHighlighted: boolean;
  /** An announcement Gloom posted: its own band, rule and mark. */
  isAnnouncement: boolean;
  grouped: boolean;
  showReplyAction: boolean;
  /** Reactions are on offer here: the server takes them and the message can have them. */
  showReactAction: boolean;
  showEditAction: boolean;
  /** A failed send of yours offers Retry in place of Reply and Edit. */
  showRetryAction: boolean;
  /**
   * Cells the header's actions take whenever they show, hovered or not, so a
   * narrow row fits its icons once instead of again on every hover.
   */
  actionsWidth: number;
  /**
   * The Team and Pro icons show: the row is under the pointer or selected.
   * A bot's icon shows always.
   */
  showPersonIcons: boolean;
  /** Still pending past the slow threshold: drawn dim. */
  isSending: boolean;
  bgColor: string | undefined;
  selectedTextColor: string;
  replyMetaColor: string;
  replyAuthorColor: string;
  headerStatus: string;
  headerStatusColor: string;
  /** The dim "Discord" tag beside the author of a message that came from Discord. */
  originTagColor: string;
  authorColor: string;
  authorAttributes: number;
  bodyColor: string;
  /** Code, list markers and a quote's bar in the body. */
  bodyMutedColor: string;
}

export function getChatMessageRenderState({
  msg,
  index,
  messages,
  selectedIdx,
  hoveredIdx,
  highlighted = false,
  canSend,
  canEdit,
  canReact = false,
  slowSend,
  host,
}: {
  msg: ChatMessage;
  index: number;
  messages: ChatMessage[];
  selectedIdx: number;
  hoveredIdx: number | null;
  highlighted?: boolean;
  canSend: boolean;
  canEdit: boolean;
  /** The message takes a reaction from you. */
  canReact?: boolean;
  /** A pending send that has waited past the threshold; a fresh one is drawn like a sent message. */
  slowSend: boolean;
  /** The desktop reveals actions on hover with CSS, so it renders them on every row. */
  host: "desktop" | "terminal";
}): ChatMessageRenderState {
  const isSelected = index === selectedIdx;
  const isHovered = index === hoveredIdx && !isSelected;
  const isHighlighted = highlighted && !isSelected;
  const isAnnouncement = msg.announcement === true;
  const grouped = isGroupedWithPrevious(messages, index);
  const isSending = msg.clientStatus === "sending" && slowSend;
  const hasFailed = msg.clientStatus === "failed";
  const selectedTextColor = hasFailed ? colors.negative : colors.selectedText;
  const headerStatus = isSending
    ? "sending..."
    : hasFailed
      ? "failed"
      : `${formatTimeAgo(msg.createdAt)}${msg.editedAt ? " edited" : ""}`;
  const showActions = canSend && (host === "desktop" || isSelected || hoveredIdx === index);
  const showReplyAction = showActions && !hasFailed;

  return {
    isSelected,
    isHovered,
    isHighlighted,
    isAnnouncement,
    grouped,
    showReplyAction,
    showReactAction: showReplyAction && canReact,
    showEditAction: showReplyAction && canEdit,
    showRetryAction: showActions && hasFailed,
    actionsWidth: !canSend ? 0 : 1 + MESSAGE_ACTION_WIDTH * (hasFailed ? 1 : 1 + (canReact ? 1 : 0) + (canEdit ? 1 : 0)),
    showPersonIcons: isSelected || hoveredIdx === index,
    isSending,
    bgColor: isSelected
      ? colors.selected
      : isHighlighted
        ? chatHighlightBg()
        : isAnnouncement && (host === "terminal" || !isHovered)
          ? chatAnnouncementBg(host, colors, isHovered)
          : isHovered ? hoverBg() : undefined,
    selectedTextColor,
    replyMetaColor: isSelected ? selectedTextColor : colors.textMuted,
    replyAuthorColor: isSelected ? selectedTextColor : colors.textDim,
    headerStatus,
    headerStatusColor: isSelected
      ? selectedTextColor
      : isSending
        ? colors.textDim
        : hasFailed
          ? colors.negative
          : colors.textMuted,
    originTagColor: isSelected ? selectedTextColor : colors.textDim,
    authorColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : chatAuthorNameColor(msg.user),
    authorAttributes: (isSending ? TextAttributes.DIM : 0) | TextAttributes.BOLD,
    bodyColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : isSending ? colors.textDim : colors.text,
    bodyMutedColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : colors.textDim,
  };
}
