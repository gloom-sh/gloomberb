import { useState } from "react";
import type { ChatMessage, ChatReaction } from "../../../../api-client";
import { Button, MenuPopover, type MenuItem } from "../../../../components/ui";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { Box, Text } from "../../../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../../../utils/format";
import {
  isCustomReactionEmoji,
  reactedByText,
  reactionChipText,
  reactionPickerChoices,
  terminalReactionChipWidth,
  terminalReactionGlyph,
  terminalReactionRows,
} from "../reactions";

interface ChatReactionChipsProps {
  msg: ChatMessage;
  currentUserId: string | null;
  /** Signed in, and the server takes reactions: a chip toggles your reaction. */
  canReact: boolean;
  onToggle: (messageId: string, emoji: string) => void;
}

function chipLabel(reaction: ChatReaction, currentUserId: string | null): string {
  const who = reactedByText(reaction, currentUserId);
  return who ? `${reaction.emoji} ${reaction.count}: ${who}` : `${reaction.emoji} ${reaction.count}`;
}

function chipPress(
  props: ChatReactionChipsProps,
  reaction: ChatReaction,
): (() => void) | undefined {
  // A custom Discord emoji is added and taken back on Discord only.
  if (!props.canReact || isCustomReactionEmoji(reaction.emoji)) return undefined;
  return () => props.onToggle(props.msg.id, reaction.emoji);
}

/**
 * The reactions under a terminal message: a row of chips (wrapping when the
 * body is narrow), yours filled. Hovering a chip names who reacted in a
 * one-line tip just above it, over the message's own last line (drawn before
 * the chips, so the tip stays on top).
 */
export function TerminalChatReactions({
  rowProps,
  width,
  ...props
}: ChatReactionChipsProps & {
  /** Host row props: width, background and hover or selection hooks. */
  rowProps: Record<string, unknown>;
  /** Cells the body has. */
  width: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const reactions = props.msg.reactions ?? [];
  if (reactions.length === 0) return null;
  const rows = terminalReactionRows(reactions, width);
  return (
    <>
      {rows.map((row, rowIndex) => {
        let offset = 0;
        const offsets = row.map((reaction, index) => {
          const at = offset + (index > 0 ? 1 : 0);
          offset = at + terminalReactionChipWidth(reaction);
          return at;
        });
        const hoveredIndex = row.findIndex((reaction) => reaction.emoji === hovered);
        const hoveredReaction = hoveredIndex >= 0 ? row[hoveredIndex]! : null;
        const who = hoveredReaction ? reactedByText(hoveredReaction, props.currentUserId) : "";
        const glyph = hoveredReaction ? terminalReactionGlyph(hoveredReaction.emoji) : null;
        const tipText = glyph && who ? truncateToDisplayWidth(who, Math.max(1, width - glyph.width - 3)) : "";
        const tipWidth = glyph && tipText ? glyph.width + displayWidth(tipText) + 3 : 0;
        const tipLeft = hoveredIndex >= 0 ? Math.max(0, Math.min(offsets[hoveredIndex]!, width - tipWidth)) : 0;
        return (
          <Box
            key={`${props.msg.id}:reactions:${rowIndex}`}
            {...rowProps}
            paddingLeft={3}
            height={1}
            flexDirection="row"
            position="relative"
            data-gloom-role="chat-message-reactions"
          >
            {row.map((reaction, index) => (
              <Box
                key={reaction.emoji}
                flexDirection="row"
                height={1}
                onMouseOver={() => setHovered(reaction.emoji)}
                onMouseOut={() => setHovered((current) => (current === reaction.emoji ? null : current))}
              >
                {index > 0 && <Text> </Text>}
                <Button
                  label={chipLabel(reaction, props.currentUserId)}
                  displayLabel={reactionChipText(reaction, "terminal")}
                  variant={reaction.me ? "primary" : "secondary"}
                  stopPropagation
                  onPress={chipPress(props, reaction)}
                />
              </Box>
            ))}
            {tipWidth > 0 && glyph && (
              <Box
                position="absolute"
                top={-1}
                left={3 + tipLeft}
                width={tipWidth}
                height={1}
                flexDirection="row"
                // Inverted, so the tip reads as one over the chips and text it covers.
                backgroundColor={colors.text}
                style={{ zIndex: 5 }}
              >
                <Text fg={colors.bg}>{" "}</Text>
                <Text fg={colors.bg}>{glyph.text}</Text>
                <Text fg={colors.bg}>{` ${tipText} `}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </>
  );
}

/** The reactions under a desktop message, wrapping with the width; each chip's tooltip names who reacted. */
export function DesktopChatReactions(props: ChatReactionChipsProps) {
  const reactions = props.msg.reactions ?? [];
  if (reactions.length === 0) return null;
  return (
    <Box
      flexDirection="row"
      data-gloom-role="chat-message-reactions"
      style={{ flexWrap: "wrap", gap: 4, minWidth: 0, paddingTop: 2, paddingBottom: 4 }}
    >
      {reactions.map((reaction) => (
        <Button
          key={reaction.emoji}
          label={chipLabel(reaction, props.currentUserId)}
          displayLabel={reactionChipText(reaction, "desktop")}
          title={reactedByText(reaction, props.currentUserId) || undefined}
          // Yours carries the focus outline, which reads on a selected row too.
          active={reaction.me}
          stopPropagation
          onPress={chipPress(props, reaction)}
        />
      ))}
    </Box>
  );
}

/** The picker's entries: each emoji, ticked when you reacted, with its count and who reacted. */
function reactionMenuItems(msg: ChatMessage, currentUserId: string | null): MenuItem[] {
  return reactionPickerChoices(msg).map((reaction) => ({
    id: reaction.emoji,
    label: reaction.emoji,
    checked: reaction.me,
    ...(reaction.count > 0
      ? { hint: String(reaction.count), description: reactedByText(reaction, currentUserId) }
      : {}),
  }));
}

/**
 * The React action on the desktop: a button in the message's actions that
 * opens the picker beside it (also from the keyboard, on the selected message).
 */
export function DesktopReactionAction({
  msg,
  currentUserId,
  open,
  width,
  variant,
  onOpenChange,
  onToggle,
}: {
  msg: ChatMessage;
  currentUserId: string | null;
  open: boolean;
  width: number;
  variant: "primary" | "secondary";
  onOpenChange: (open: boolean) => void;
  onToggle: (messageId: string, emoji: string) => void;
}) {
  const trigger = (
    <Button
      stopPropagation
      label={t("React")}
      width={width}
      variant={variant}
      expanded={open}
      onPress={() => onOpenChange(!open)}
    />
  );
  if (!open) return trigger;
  return (
    <MenuPopover
      open
      onOpenChange={onOpenChange}
      trigger={trigger}
      placement="bottom-end"
      minWidth={150}
      label={t("React")}
      items={reactionMenuItems(msg, currentUserId)}
      onSelect={(emoji) => onToggle(msg.id, emoji)}
    />
  );
}
