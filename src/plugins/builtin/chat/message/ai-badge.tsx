import { Badge } from "../../../../components/ui";
import { Box } from "../../../../ui";
import { useThemeColors } from "../../../../theme/theme-context";
import { chatNameBadgeColor, type ChatNameBadge } from "../people";

/** What the AI badge takes of a terminal line: the cell before it, then "AI" with a cell of padding either side. */
export const CHAT_AI_BADGE_WIDTH = 5;

const AI_BADGE: ChatNameBadge = { id: "ai", label: "AI" };

/**
 * The badges beside a name, each with a cell of space before it: AI in the
 * bot colour, Team in the theme's other accent, Pro in the quietest tone the
 * kit has. A selected row passes its own text color so the chips stay
 * legible on the selection.
 */
export function ChatNameBadges({ badges, selectedColor }: { badges: readonly ChatNameBadge[]; selectedColor?: string }) {
  const palette = useThemeColors();
  return (
    <>
      {badges.map((badge) => (
        <Box key={badge.id} flexShrink={0} paddingLeft={1} data-gloom-role={`chat-${badge.id}-badge`}>
          <Badge label={badge.label} color={selectedColor ?? chatNameBadgeColor(badge, palette)} />
        </Box>
      ))}
    </>
  );
}

/** "AI" beside the name of a managed assistant, where only that badge is shown: a reply quote, the composer, the inbox. */
export function ChatAiBadge({ selectedColor }: { selectedColor?: string }) {
  return <ChatNameBadges badges={[AI_BADGE]} selectedColor={selectedColor} />;
}
