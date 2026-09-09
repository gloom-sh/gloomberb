import { Box, Text } from "../../../ui";
import { Button } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { requestAuthDialog } from "./auth-dialog";
import type { AccountMode } from "./auth-model";

function openAuth(
  openCommandBar: (query?: string) => void,
  mode: AccountMode,
) {
  if (!requestAuthDialog({ mode })) {
    openCommandBar(mode === "login" ? "Log In" : "Sign Up");
  }
}

export function InlineAuthActions({ showSignup = true }: { showSignup?: boolean }) {
  const { openCommandBar } = usePluginAppActions();
  return (
    <Box flexDirection="row">
      <Button label={t("Log In")} variant="ghost" compact stopPropagation onPress={() => openAuth(openCommandBar, "login")} />
      {showSignup && <>
        <Text fg={colors.textDim}> / </Text>
        <Button label={t("Sign Up")} variant="ghost" compact stopPropagation onPress={() => openAuth(openCommandBar, "signup")} />
      </>}
    </Box>
  );
}

export function CloudAuthNotice({
  message,
  showSignup = true,
  needsVerification = false,
}: {
  message: string;
  showSignup?: boolean;
  /** Forces the verification branch and uses `message` as its headline. */
  needsVerification?: boolean;
}) {
  const { openCommandBar } = usePluginAppActions();

  if (needsVerification || /verification/i.test(message)) {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text fg={colors.positive}>{needsVerification ? message : t("Verify your email to use Cloud tweets.")}</Text>
        <Button label={t("Resend Verification Email")} variant="secondary" onPress={() => openCommandBar("Resend Verification Email")} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text fg={colors.textDim}>{message}</Text>
      <InlineAuthActions showSignup={showSignup} />
    </Box>
  );
}
