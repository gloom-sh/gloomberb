import { useMemo } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { ListView, type ListViewItem } from "../../ui";

export function AccountChooserPanel({
  choiceIdx,
  onChoiceSelect,
  onChoiceActivate,
  height,
}: {
  choiceIdx: number;
  onChoiceSelect: (index: number) => void;
  onChoiceActivate: (index: number) => void;
  height: number;
}) {
  const language = useAppLanguage();
  const bullets = [
    t("Try Pro free for 7 days — real-time quotes & news"),
    t("Sync portfolios, watchlists & layouts"),
    t("Chat + AI command bar"),
  ];
  const choices = useMemo<ListViewItem[]>(() => [
    { id: "signup", label: t("Create free account"), description: t("Email and password — that's it") },
    { id: "login", label: t("Log In"), description: t("Already have a Gloom Cloud account") },
    { id: "skip", label: t("Skip for now"), description: t("Continue without an account") },
  ], [language]);

  // Bullets are the first rows to go so the choices and footer survive a short terminal.
  const showBullets = height >= 15;
  const showHint = height >= 12;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {t("Create your free Gloom Cloud account")}
        </Text>
      </Box>
      <Box height={1} />

      {showBullets && (
        <>
          {bullets.map((bullet) => (
            <Box key={bullet} height={1} flexDirection="row">
              <Text fg={colors.positive}>{"· "}</Text>
              <Text fg={colors.textDim}>{bullet}</Text>
            </Box>
          ))}
          <Box height={1} />
        </>
      )}

      <ListView
        items={choices}
        selectedIndex={choiceIdx}
        onSelect={onChoiceSelect}
        onActivate={(_item, index) => onChoiceActivate(index)}
        showSelectedDescription
      />

      {showHint && (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={colors.textMuted}>{t("Use ↑↓ to choose")}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
