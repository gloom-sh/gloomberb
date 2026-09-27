/**
 * The account gates panes share.
 *
 * `SignInWall` is the one wall a pane shows when it cannot load anything until
 * the account is right: same headline grammar, same explanation slot, same two
 * actions, wherever it appears. A pane only supplies the phrase that finishes
 * "Sign in to ...", so the copy stays in one voice instead of drifting per pane.
 * `InlineAuthActions` is the other shape: a row of actions sitting inside a
 * surface that still works signed out, such as the chat composer.
 * `ProWall` is the signed-in counterpart for a pane body that needs Pro.
 */
import { useId } from "react";
import { Box, Text } from "../../../ui";
import { Button, EmptyState, PaneStatusBody, usePaneMenuItems } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
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

export interface InlineAuthActionsProps {
  showSignup?: boolean;
  /**
   * `buttons` is the wall's pair of compact buttons, for a surface such as
   * the chat composer where the actions must read as controls. `plain` is
   * clickable text, for chrome that is itself a row of text (a status bar).
   */
  variant?: "buttons" | "plain";
}

export function InlineAuthActions({ showSignup = true, variant = "buttons" }: InlineAuthActionsProps) {
  const { openCommandBar } = usePluginAppActions();
  const logIn = () => openAuth(openCommandBar, "login");
  const signUp = () => openAuth(openCommandBar, "signup");
  // Inside a pane (the chat composer) the pane menu lists them, so they need
  // no mouse; the status bar copy has the Log In command instead.
  usePaneMenuItems(`inline-auth:${useId()}`, () => [
    { id: "log-in", label: t("Log in"), onSelect: logIn },
    ...(showSignup ? [{ id: "sign-up", label: t("Sign up free"), onSelect: signUp }] : []),
  ], [openCommandBar, showSignup]);
  if (variant === "plain") {
    return (
      <Box flexDirection="row">
        <Button label={t("Log in")} variant="plain" compact stopPropagation onPress={logIn} />
        {showSignup && <>
          <Text fg={colors.textDim}> / </Text>
          <Button label={t("Sign up free")} variant="plain" compact stopPropagation onPress={signUp} />
        </>}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" gap={1}>
      <Button label={t("Log in")} variant="primary" compact stopPropagation onPress={logIn} />
      {showSignup && <Button label={t("Sign up free")} variant="secondary" compact stopPropagation onPress={signUp} />}
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

export interface ProWallProps {
  /** The headline, e.g. "Hiring data is part of Gloom Cloud Pro." */
  title: string;
  /** What Pro unlocks here. */
  message: string;
}

/** The upgrade wall for a pane body that needs Pro; Manage account covers a plan the account already has. */
export function ProWall({ title, message }: ProWallProps) {
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();
  // The status body carries the pane inset that a bare EmptyState lacks.
  return (
    <PaneStatusBody
      empty
      emptyTitle={title}
      emptyMessage={message}
      actions={<>
        <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
        <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
      </>}
    />
  );
}
