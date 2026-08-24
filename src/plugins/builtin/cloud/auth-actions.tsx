import { useState } from "react";
import { Box, Text } from "../../../ui";
import { Button } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import { colors, hoverBg } from "../../../theme/colors";
import { t } from "../../../i18n";
import { requestAuthDialog } from "./auth-dialog";
import type { AccountMode } from "./auth-model";

function openAuth(
  openCommandBar: (query?: string) => void,
  mode: AccountMode,
  event?: { preventDefault?: () => void; stopPropagation?: () => void },
) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (!requestAuthDialog({ mode })) {
    openCommandBar(mode === "login" ? "Log In" : "Sign Up");
  }
}

export function InlineAuthActions({ showSignup = true }: { showSignup?: boolean }) {
  const { openCommandBar } = usePluginAppActions();
  const [hoveredAction, setHoveredAction] = useState<"login" | "signup" | null>(null);

  return (
    <Box flexDirection="row">
      <Box
        backgroundColor={hoveredAction === "login" ? hoverBg() : undefined}
        onMouseOver={() => setHoveredAction((current) => (current === "login" ? current : "login"))}
        onMouseOut={() => setHoveredAction((current) => (current === "login" ? null : current))}
        onMouseDown={(event: any) => openAuth(openCommandBar, "login", event)}
      >
        <Text fg={hoveredAction === "login" ? colors.text : colors.textDim}>{` ${t("Log In")} `}</Text>
      </Box>
      {showSignup && (
        <>
          <Text fg={colors.textDim}>/</Text>
          <Box
            backgroundColor={hoveredAction === "signup" ? hoverBg() : undefined}
            onMouseOver={() => setHoveredAction((current) => (current === "signup" ? current : "signup"))}
            onMouseOut={() => setHoveredAction((current) => (current === "signup" ? null : current))}
            onMouseDown={(event: any) => openAuth(openCommandBar, "signup", event)}
          >
            <Text fg={hoveredAction === "signup" ? colors.text : colors.textDim}>{` ${t("Sign Up")} `}</Text>
          </Box>
        </>
      )}
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
