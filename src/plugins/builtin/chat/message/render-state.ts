import { TextAttributes } from "../../../../ui";
import { colors, hoverBg } from "../../../../theme/colors";
import type { ChatMessage } from "../../../../api-client";
import { formatTimeAgo } from "../../../../utils/datetime-format";
import { isGroupedWithPrevious } from "../layout";

export interface ChatMessageRenderState {
  isSelected: boolean;
  isHovered: boolean;
  grouped: boolean;
  showReplyAction: boolean;
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
  canSend,
  canEdit,
  slowSend,
  host,
}: {
  msg: ChatMessage;
  index: number;
  messages: ChatMessage[];
  selectedIdx: number;
  hoveredIdx: number | null;
  canSend: boolean;
  canEdit: boolean;
  /** A pending send that has waited past the threshold; a fresh one is drawn like a sent message. */
  slowSend: boolean;
  /** The desktop reveals actions on hover with CSS, so it renders them on every row. */
  host: "desktop" | "terminal";
}): ChatMessageRenderState {
  const isSelected = index === selectedIdx;
  const isHovered = index === hoveredIdx && !isSelected;
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
    grouped,
    showReplyAction,
    showEditAction: showReplyAction && canEdit,
    showRetryAction: showActions && hasFailed,
    isSending,
    bgColor: isSelected ? colors.selected : isHovered ? hoverBg() : undefined,
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
