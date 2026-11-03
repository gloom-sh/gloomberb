/**
 * The account gates panes share.
 *
 * `SignInWall` is the one wall a pane shows when it cannot load anything until
 * the account is right: same headline grammar, same explanation slot, same two
 * actions, wherever it appears. A pane only supplies the phrase that finishes
 * "Sign in to ...", so the copy stays in one voice instead of drifting per pane.
 * `InlineAuthActions` is the other shape: the same actions, drawn the same
 * way, in a surface that still shows something without them, such as the
 * chat composer of a saved login or an unverified account.
 * `ProWall` is the signed-in counterpart for a pane body that needs Pro.
 */
import { useId } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { Button, EmptyState, PaneStatusBody, usePaneMenuItems } from "../../../components";
import { NATIVE_STATE_INSET } from "../../../components/ui/status";
import { usePluginAppActions } from "../../runtime";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { requestAuthDialog } from "../../../account/auth-dialog";
import type { AccountMode } from "../../../account/auth-model";
import { recordWallCtaClicked } from "../../../api-client/research-activity";
import { WallTeaser } from "../shared/wall-teaser";

function openAuth(
  openCommandBar: (query?: string) => void,
  mode: AccountMode,
) {
  if (!requestAuthDialog({ mode })) {
    openCommandBar(mode === "login" ? "Log In" : "Sign Up");
  }
}

const RESEND_VERIFICATION = "Resend Verification Email";

/**
 * The account actions as buttons: Log in and Sign up free, or the resend for
 * an unconfirmed address. One look for the wall and for the inline copy, so
 * the same action never reads as two different controls.
 */
function AuthButtons({ showSignup, needsVerification, onAuth, onResend, stopPropagation = false }: {
  showSignup: boolean;
  needsVerification: boolean;
  onAuth: (mode: AccountMode) => void;
  onResend: () => void;
  /** Inside a surface with its own pointer handling (the chat), a press stays on the button. */
  stopPropagation?: boolean;
}) {
  if (needsVerification) return <Button label={t(RESEND_VERIFICATION)} stopPropagation={stopPropagation} onPress={onResend} />;
  return (
    <>
      <Button label={t("Log in")} variant="primary" stopPropagation={stopPropagation} onPress={() => onAuth("login")} />
      {showSignup && <Button label={t("Sign up free")} variant="secondary" stopPropagation={stopPropagation} onPress={() => onAuth("signup")} />}
    </>
  );
}

export interface InlineAuthActionsProps {
  showSignup?: boolean;
  /** The session exists but the address is unconfirmed: the resend replaces the sign-in buttons. */
  needsVerification?: boolean;
  /**
   * `buttons` is the wall's buttons in the wall's row, for a surface such as
   * the chat composer where the actions must read as controls. `plain` is
   * clickable text, for chrome that is itself a row of text (a status bar).
   */
  variant?: "buttons" | "plain";
}

export function InlineAuthActions({ showSignup = true, needsVerification = false, variant = "buttons" }: InlineAuthActionsProps) {
  const { openCommandBar } = usePluginAppActions();
  const authenticate = (mode: AccountMode) => openAuth(openCommandBar, mode);
  const logIn = () => authenticate("login");
  const signUp = () => authenticate("signup");
  const resend = () => openCommandBar(RESEND_VERIFICATION);
  // Inside a pane (the chat composer) the pane menu lists them, so they need
  // no mouse; the status bar copy has the Log In command instead.
  usePaneMenuItems(`inline-auth:${useId()}`, () => needsVerification
    ? [{ id: "resend-verification", label: t(RESEND_VERIFICATION), onSelect: resend }]
    : [
      { id: "log-in", label: t("Log in"), onSelect: logIn },
      ...(showSignup ? [{ id: "sign-up", label: t("Sign up free"), onSelect: signUp }] : []),
    ], [openCommandBar, needsVerification, showSignup]);
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
  // The row a wall's actions sit in (EmptyState), wrapping in a narrow pane.
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      <AuthButtons showSignup={showSignup} needsVerification={needsVerification} onAuth={authenticate} onResend={resend} stopPropagation />
    </Box>
  );
}

export interface SignInWallProps {
  /** A fixed, content-free id for this wall, ending in -signin. */
  placement: string;
  width?: number;
  height?: number;
  symbol?: string | null;
  exchange?: string;
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
export function SignInWall({ placement, action, needsVerification = false, hint, width = 0, height = 0, symbol, exchange }: SignInWallProps) {
  const { openCommandBar } = usePluginAppActions();
  const { nativePaneChrome } = useUiCapabilities();
  const title = needsVerification
    ? tf("Verify your email to {action}.", { action: t(action) })
    : tf("Sign in to {action}.", { action: t(action) });
  const authenticate = (mode: AccountMode) => {
    recordWallCtaClicked(placement, mode);
    openAuth(openCommandBar, mode);
  };

  return (
    <WallTeaser experiment="wall_teaser_signin" placement={placement} title={title} message={hint}
      width={width} height={height} symbol={symbol} exchange={exchange}>
      <Box flexDirection="column" paddingX={1} paddingY={1} data-gloom-ui="sign-in-wall" style={nativePaneChrome ? NATIVE_STATE_INSET : undefined}>
        <EmptyState
          title={title}
          hint={hint}
          actions={(
            <AuthButtons
              showSignup
              needsVerification={needsVerification}
              onAuth={authenticate}
              onResend={() => openCommandBar(RESEND_VERIFICATION)}
            />
          )}
        />
      </Box>
    </WallTeaser>
  );
}

export interface ProWallProps {
  width: number;
  height: number;
  symbol?: string | null;
  exchange?: string;
  /** The upgrade intent's placement id, e.g. "jobs-wall"; see `CloudUpgradeOptions.placement`. */
  placement: string;
  /** The headline, e.g. "Hiring data is part of Gloom Cloud Pro." */
  title: string;
  /** What Pro unlocks here. */
  message: string;
}

/** The upgrade wall for a pane body that needs Pro; Manage account covers a plan the account already has. */
export function ProWall({ placement, title, message, width, height, symbol, exchange }: ProWallProps) {
  const openUpgrade = useCloudUpgradeAction(placement);
  const openPlan = useCloudPlanAction();
  // The status body carries the pane inset that a bare EmptyState lacks.
  return (
    <WallTeaser placement={placement} title={title} message={message} width={width} height={height} symbol={symbol} exchange={exchange}>
      <PaneStatusBody
        empty
        emptyTitle={title}
        emptyMessage={message}
        actions={<>
          <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
          <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
        </>}
      />
    </WallTeaser>
  );
}
