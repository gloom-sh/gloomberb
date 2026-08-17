import { Box, Text, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import type { ListViewItem } from "../../ui";
import { OnboardingChoiceList } from "../onboarding-frame";

export function PortfolioChoicePanel({
  choices,
  optionIdx,
  onOptionSelect,
  onOptionActivate,
}: {
  choices: ListViewItem[];
  optionIdx: number;
  onOptionSelect: (idx: number) => void;
  onOptionActivate: (idx: number) => void;
}) {
  const desktop = useUiHost().kind === "desktop-web";

  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      <OnboardingChoiceList
        items={choices}
        selectedIndex={optionIdx}
        onSelect={onOptionSelect}
        onActivate={onOptionActivate}
      />

      {!desktop ? (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={colors.textMuted}>{t("Use \u2191\u2193 to choose")}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}
