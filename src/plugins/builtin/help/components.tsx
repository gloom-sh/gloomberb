import { Badge, Section } from "../../../components";
import { t } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";

export interface HelpShortcutEntry {
  id: string;
  badges: string[];
  description: string;
  category: string;
}

export function ShortcutRow({
  badges,
  description,
}: {
  badges: string[];
  description: string;
}) {
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {badges.map((badge, index) => <Badge variant="solid" key={`${badge}:${index}`} label={badge} />)}
      </Box>
      <Box flexGrow={1}>
        <Text fg={colors.text} wrapText>{t(description)}</Text>
      </Box>
    </Box>
  );
}

export function ShortcutGroup({ title, entries }: { title: string; entries: HelpShortcutEntry[] }) {
  return (
    <Section title={title}>
      {entries.map((entry) => (
        <ShortcutRow
          key={entry.id}
          badges={entry.badges}
          description={entry.description}
        />
      ))}
    </Section>
  );
}
