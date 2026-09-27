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
  bgColor: string | undefined;
  selectedTextColor: string;
  replyMetaColor: string;
  replyAuthorColor: string;
  headerStatus: string;
  headerStatusColor: string;
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
}: {
  msg: ChatMessage;
  index: number;
  messages: ChatMessage[];
  selectedIdx: number;
  hoveredIdx: number | null;
  canSend: boolean;
}): ChatMessageRenderState {
  const isSelected = index === selectedIdx;
  const isHovered = index === hoveredIdx && !isSelected;
  const grouped = isGroupedWithPrevious(messages, index);
  const isSending = msg.clientStatus === "sending";
  const hasFailed = msg.clientStatus === "failed";
  const selectedTextColor = hasFailed ? colors.negative : colors.selectedText;
  const headerStatus = isSending
    ? "sending..."
    : hasFailed
      ? "failed"
      : `${formatTimeAgo(msg.createdAt)}${msg.editedAt ? " edited" : ""}`;

  return {
    isSelected,
    isHovered,
    grouped,
    showReplyAction: canSend && (isSelected || hoveredIdx === index),
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
    authorColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : colors.positive,
    authorAttributes: (isSending ? TextAttributes.DIM : 0) | TextAttributes.BOLD,
    bodyColor: isSelected ? selectedTextColor : hasFailed ? colors.negative : isSending ? colors.textDim : colors.text,
  };
}
