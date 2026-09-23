import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { Button } from "../../../components/ui/button";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useAppActive } from "../../../state/app/activity";
import { useAppSelector } from "../../../state/app/context";
import { useCommandBarShortcut } from "../../../ui";
import { useToastHost } from "../../../ui/toast";
import { usePlanAccess } from "../shared/plan-access";

/** How often the widget re-reads the session while a verification is pending. */
const VERIFICATION_POLL_MS = 30_000;
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Persistent nudge for a signed-in account whose email is still unverified.
 * Onboarding no longer blocks on the inbox, so this is where the reminder
 * lives until the link is clicked: it re-checks the session while the app is
 * active and disappears on its own once the account is verified.
 */
export function CloudVerificationStatusWidget() {
  useAppLanguage();
  const cloudPluginDisabled = useAppSelector((state) => state.config.disabledPlugins).includes("gloomberb-cloud");
  const access = usePlanAccess();
  const appActive = useAppActive();
  const toast = useToastHost();
  // The status bar takes no keyboard focus; the chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const pending = !cloudPluginDisabled && access.signedIn && !access.emailVerified;

  useEffect(() => {
    if (!pending || !appActive) return;
    const check = () => { void apiClient.getSession().catch(() => {}); };
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

  return (
    <Button
      label={sentAt !== null ? t("verification email sent") : t("verify your email")}
      title={tf("Resend the verification email ({key}, then {command})", { key: commandBarKey, command: "Resend Verification Email" })}
      variant="plain"
      compact
      stopPropagation
      disabled={sending}
      onPress={resend}
    />
  );
}
