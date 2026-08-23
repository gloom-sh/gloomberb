import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { AccountOutcome } from "../../../plugins/builtin/cloud/auth-model";

export function AccountSignedInPanel({ outcome }: { outcome: AccountOutcome | null }) {
  const email = outcome?.email ?? "";
  const desktop = useUiHost().kind === "desktop-web";

  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      <Box height={1} flexDirection="row">
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{"✓ "}</Text>
        <Text fg={colors.text}>
          {email ? tf("Signed in as {email}", { email }) : t("Signed in to Gloom Cloud")}
        </Text>
      </Box>
      <Box height={desktop ? undefined : 1} style={desktop ? { marginTop: 8 } : undefined} />
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
