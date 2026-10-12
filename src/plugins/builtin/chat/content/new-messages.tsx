import { useState } from "react";
import { Box } from "../../../../ui";
import { Button } from "../../../../components/ui";
import { t, tf } from "../../../../i18n";
import type { ChatMessage } from "../../../../api-client";
import { displayWidth } from "../../../../utils/format";

/**
 * How many messages from other people came in while the reader was away from
 * the bottom, and are still below them. Nothing counts while the reader follows
 * the bottom, where each one is simply shown; the count starts over when they
 * reach it again, by any means, and in another channel.
 */
export function useUnseenMessageCount({
  channelId,
  following,
  messages,
  userId,
}: {
  channelId: string;
  /** The reader is at the bottom, or the list is keeping them there. */
  following: boolean;
  messages: ChatMessage[];
  userId: string | undefined;
}): number {
  const latestId = messages[messages.length - 1]?.id ?? null;
  // The newest message the reader had reached the bottom with. Kept in state and
  // moved during render, so a message that arrives at a reader who is following
  // is never counted for the frame before an effect would catch up.
  const [seen, setSeen] = useState({ channelId, id: latestId });
  if (seen.channelId !== channelId || (following && seen.id !== latestId)) {
    setSeen({ channelId, id: latestId });
  }
  const seenIndex = seen.id ? messages.findIndex((message) => message.id === seen.id) : -1;
  if (seenIndex < 0) return 0;
  let count = 0;
  for (let index = seenIndex + 1; index < messages.length; index += 1) {
    if (messages[index]!.user.id !== userId) count += 1;
  }
  return count;
}

/** A small control over the bottom of the list: scrolls to the newest message when pressed. */
export function NewMessagesJump({
  count,
  nativePaneChrome,
  width,
  onPress,
}: {
  count: number;
  nativePaneChrome: boolean | undefined;
  /** The terminal's row is as wide as the list. */
  width: number;
  onPress: () => void;
}) {
  if (count <= 0) return null;
  const text = count === 1 ? t("1 new message") : tf("{count} new messages", { count });
  const button = (
    <Button
      label="Jump to the newest message"
      displayLabel={text}
      variant="secondary"
      width={nativePaneChrome ? undefined : displayWidth(text) + 2}
      onPress={onPress}
      stopPropagation
    />
  );
  if (!nativePaneChrome) {
    return (
      <Box position="absolute" bottom={0} left={0} width={width} height={1} flexDirection="row" justifyContent="center" data-gloom-role="chat-new-messages">
        {button}
      </Box>
    );
  }
  return (
    <Box
      position="absolute"
      bottom={1}
      left={0}
      right={0}
      alignItems="center"
      data-gloom-role="chat-new-messages"
      // Only the button takes the pointer: the messages behind the row stay clickable.
      style={{ pointerEvents: "none" }}
    >
      <Box style={{ pointerEvents: "auto" }}>{button}</Box>
    </Box>
  );
}
