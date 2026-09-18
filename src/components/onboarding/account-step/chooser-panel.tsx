import { useMemo } from "react";
import { Box, useUiHost } from "../../../ui";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import type { ListViewItem } from "../../ui";
import { OnboardingChoiceList } from "../onboarding-frame";

export function AccountChooserPanel({
  choiceIdx,
  onChoiceSelect,
  onChoiceActivate,
}: {
  choiceIdx: number;
  onChoiceSelect: (index: number) => void;
  onChoiceActivate: (index: number) => void;
}) {
  const language = useAppLanguage();
  const desktop = useUiHost().kind === "desktop-web";
  // Same order as ACCOUNT_CHOICE_IDS.
  const choices = useMemo<ListViewItem[]>(() => [
    {
      id: "signup",
      label: t("Continue with email"),
      description: t("New or existing account"),
      detail: t("Free"),
    },
    {
      id: "qr",
      label: t("Continue in browser"),
      description: t("gloom.sh, or scan with your phone"),
    },
    {
      id: "skip",
      label: t("Not now"),
      description: t("Keep this workspace local for now"),
    },
  ], [language]);
  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 10 } : undefined}>
      <OnboardingChoiceList
        items={choices}
        selectedIndex={choiceIdx}
        onSelect={onChoiceSelect}
        onActivate={onChoiceActivate}
      />
    </Box>
  );
}
