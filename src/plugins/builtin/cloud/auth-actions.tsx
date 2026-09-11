/**
 * The account gates panes share.
 *
 * `SignInWall` is the one wall a pane shows when it cannot load anything until
 * the account is right: same headline grammar, same explanation slot, same two
 * actions, wherever it appears. A pane only supplies the phrase that finishes
 * "Sign in to ...", so the copy stays in one voice instead of drifting per pane.
 * `InlineAuthActions` is the other shape: a row of actions sitting inside a
 * surface that still works signed out, such as the chat composer.
 */
import { Box, Text } from "../../../ui";
import { Button, EmptyState } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
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

export interface SignInWallProps {
  /**
   * Finishes the headline: "Sign in to {action}." / "Verify your email to
   * {action}.". A lowercase verb phrase, no trailing period.
   */
  action: string;
  /** The session exists but the address is unconfirmed, so signing in again solves nothing. */
  needsVerification?: boolean;
  /** One line for anything the pane still has to explain; most panes need none. */
  hint?: string;
}

/** The account wall for a pane body that cannot render until the account is right. */
export function SignInWall({ action, needsVerification = false, hint }: SignInWallProps) {
  const { openCommandBar } = usePluginAppActions();

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} data-gloom-ui="sign-in-wall">
      <EmptyState
        title={needsVerification
          ? tf("Verify your email to {action}.", { action: t(action) })
          : tf("Sign in to {action}.", { action: t(action) })}
        hint={hint}
        actions={needsVerification ? (
          <Button
            label={t("Resend Verification Email")}
            onPress={() => openCommandBar("Resend Verification Email")}
          />
        ) : (
          <>
            <Button label={t("Log in")} variant="primary" onPress={() => openAuth(openCommandBar, "login")} />
            <Button label={t("Sign up free")} variant="secondary" onPress={() => openAuth(openCommandBar, "signup")} />
          </>
        )}
      />
    </Box>
  );
}
