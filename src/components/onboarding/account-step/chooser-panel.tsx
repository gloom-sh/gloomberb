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
  const choices = useMemo<ListViewItem[]>(() => [
    {
      id: "qr",
      label: t("Scan QR with the mobile app"),
      description: t("Approve from your phone, no typing"),
    },
    {
      id: "signup",
      label: t("Sign up free"),
      description: t("Create an account, then verify your email"),
    },
    {
      id: "login",
      label: t("Log in"),
      description: t("Use an existing account"),
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
