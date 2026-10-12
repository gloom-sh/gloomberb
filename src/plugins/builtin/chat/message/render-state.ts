import { TextAttributes } from "../../../../ui";
import { blendHex, colors, hoverBg } from "../../../../theme/colors";
import type { ChatMessage } from "../../../../api-client";
import { formatTimeAgo } from "../../../../utils/datetime-format";
import { isGroupedWithPrevious } from "../layout";

/** The band on a message the reader was sent to: the accent at low strength, between the hover and the selection. */
export function chatHighlightBg(palette = colors): string {
  return blendHex(palette.bg, palette.borderFocused, 0.22);
}

export interface ChatMessageRenderState {
  isSelected: boolean;
  isHovered: boolean;
  isHighlighted: boolean;
  grouped: boolean;
  showReplyAction: boolean;
  /** Reactions are on offer here: the server takes them and the message can have them. */
  showReactAction: boolean;
  showEditAction: boolean;
  /** A failed send of yours offers Retry in place of Reply and Edit. */
  showRetryAction: boolean;
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
    grouped,
    showReplyAction,
    showReactAction: showReplyAction && canReact,
    showEditAction: showReplyAction && canEdit,
    showRetryAction: showActions && hasFailed,
    isSending,
    bgColor: isSelected ? colors.selected : isHighlighted ? chatHighlightBg() : isHovered ? hoverBg() : undefined,
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
    authorColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : colors.positive,
    authorAttributes: (isSending ? TextAttributes.DIM : 0) | TextAttributes.BOLD,
    bodyColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : isSending ? colors.textDim : colors.text,
  };
}
