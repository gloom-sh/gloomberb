import { Icon } from "../../../../components/ui";
import { Box, useUiCapabilities } from "../../../../ui";
import { useThemeColors } from "../../../../theme/theme-context";
import { t } from "../../../../i18n";
import { CHAT_BOT_ICON, CHAT_PERSON_ICON_WIDTH, chatPersonIconColor, type ChatPersonIcon } from "../people";

/**
 * The icons beside a name, each two cells wide: a cell of space, then the
 * icon in its own colour, or in the row's text colour on a selected row. The
 * desktop names each one in its tooltip. The terminal has none, so it hands
 * the name's own pointer handlers to `terminalTarget`: pointing at an icon
 * opens the card that names it.
 */
export function ChatPersonIcons({
  icons,
  selectedColor,
  terminalTarget,
}: {
  icons: readonly ChatPersonIcon[];
  selectedColor?: string;
  terminalTarget?: Record<string, unknown>;
}) {
  const palette = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <>
      {icons.map((icon) => {
        const label = t(icon.label);
        return (
          <Box
            key={icon.id}
            width={CHAT_PERSON_ICON_WIDTH}
            height={1}
            flexShrink={0}
            flexDirection="row"
            justifyContent="flex-end"
            alignItems="center"
            data-gloom-role="chat-person-icon"
            data-person-icon={icon.id}
            {...(nativePaneChrome ? { title: label, role: "img", "aria-label": label } : terminalTarget)}
          >
            <Icon name={icon.icon} color={selectedColor ?? chatPersonIconColor(icon, palette)} />
          </Box>
        );
      })}
    </>
  );
}

/** The bot's icon beside a bot's name where only that one is shown: a reply quote, the composer, the inbox. */
export function ChatBotIcon({ selectedColor }: { selectedColor?: string }) {
  return <ChatPersonIcons icons={[CHAT_BOT_ICON]} selectedColor={selectedColor} />;
}
