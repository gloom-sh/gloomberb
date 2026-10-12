import { Badge } from "../../../../components/ui";
import { Box } from "../../../../ui";

/** What the badge takes of a terminal line: the cell before it, then "AI" with a cell of padding either side. */
export const CHAT_AI_BADGE_WIDTH = 5;

/**
 * "AI" and a cell of space before it, beside the name of a managed assistant.
 * The neutral badge is the quietest the kit has; a selected row passes its own
 * text color so the chip stays legible on the selection.
 */
export function ChatAiBadge({ selectedColor }: { selectedColor?: string }) {
  return (
    <Box flexShrink={0} paddingLeft={1} data-gloom-role="chat-ai-badge">
      <Badge label="AI" color={selectedColor} />
    </Box>
  );
}
