import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { AccountOutcome } from "./model";

export function AccountSignedInPanel({ outcome }: { outcome: AccountOutcome | null }) {
  const email = outcome?.email ?? "";

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Gloom Cloud account")}</Text>
      </Box>
      <Box height={1} />
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"✓ "}</Text>
        <Text fg={colors.text}>
          {email ? tf("Signed in as {email}", { email }) : t("Signed in to Gloom Cloud")}
        </Text>
      </Box>
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textDim}>
          {outcome?.mode === "signup"
            ? t("We sent a verification link to your inbox.")
            : t("Portfolios, watchlists and layouts sync to this account.")}
        </Text>
      </Box>
    </Box>
  );
}
