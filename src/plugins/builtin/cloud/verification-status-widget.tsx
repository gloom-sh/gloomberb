import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { Button } from "../../../components/ui/button";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useAppActive } from "../../../state/app/activity";
import { useCommandBarShortcut } from "../../../ui";
import { Text } from "../../../ui";
import { useToastHost } from "../../../ui/toast";
import { usePlanAccess } from "../../../api-client/plan-access";
import { requestEmailConfirmation } from "../../../account/auth-dialog";
import { useThemeColors } from "../../../theme/theme-context";
import { logFailure } from "../../../utils/log-failure";

/** How often the widget re-reads the session while a verification is pending. */
const VERIFICATION_POLL_MS = 30_000;
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Persistent nudge for a signed-in account whose email is still unverified.
 * Onboarding no longer blocks on the inbox, so this is where the reminder
 * lives until the link is clicked: it re-checks the session while the app is
 * active and disappears on its own once the account is verified.
 *
 * It is the one thing in the status bar that asks for something, so it is the
 * one drawn in the warning colour. A press sends the link again and opens the
 * confirmation dialog, which names the address and waits for the link.
 */
export function CloudVerificationStatusWidget() {
  useAppLanguage();
  const colors = useThemeColors();
  const access = usePlanAccess();
  const appActive = useAppActive();
  const toast = useToastHost();
  // The status bar takes no keyboard focus; the chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const pending = access.signedIn && !access.emailVerified;

  useEffect(() => {
    if (!pending || !appActive) return;
    const check = () => { void apiClient.getSession().catch(logFailure("cloud.verification", "Check whether the email is verified failed")); };
    check();
    const timer = setInterval(check, VERIFICATION_POLL_MS);
    return () => clearInterval(timer);
  }, [appActive, pending]);

  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), RESEND_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);

  if (!pending) return null;

  const email = apiClient.getCurrentUser()?.email ?? "";
  const resend = () => {
    if (sending || sentAt !== null) return;
    setSending(true);
    void apiClient.sendVerification()
      .then(() => {
        setSentAt(Date.now());
        toast.success(email ? tf("Verification link sent to {email}.", { email }) : t("Verification link sent."));
      })
      .catch((error) => {
        toast.error(error instanceof Error && error.message ? error.message : t("Couldn't send the email. Try again."));
      })
      .finally(() => setSending(false));
  };

  const label = sentAt !== null ? t("verification email sent") : t("verify your email");
  return (
    <Button
      label={label}
      title={tf("Resend the verification email ({key}, then {command})", { key: commandBarKey, command: "Resend Verification Email" })}
      variant="plain"
      compact
      stopPropagation
      disabled={sending}
      // Without a dialog host the press still sends the link, as it always did.
      onPress={() => { if (!requestEmailConfirmation()) resend(); }}
    >
      {/* Once the link is on its way it asks for nothing more, and reads like its neighbours again. */}
      <Text fg={sending ? colors.textMuted : sentAt !== null ? colors.textDim : colors.warning} selectable={false}>{label}</Text>
    </Button>
  );
}
