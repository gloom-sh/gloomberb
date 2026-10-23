/**
 * What follows "Start free trial": checkout opens in the browser, and this
 * dialog says so, keeps the way back to it and waits for Pro to arrive. The
 * browser button reopens the same checkout instead of starting another, and
 * a terminal that cannot open a browser (over SSH, say) gets the short link
 * and its QR code to finish on any device.
 */
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api-client";
import { hasProAccess, usePlanAccess, type PlanAccessUser } from "../api-client/plan-access";
import { Button } from "../components/ui/button";
import { DialogActions } from "../components/ui/dialog-actions";
import { FORM_DIALOG_WIDTH, DialogFrame } from "../components/ui/frame";
import { SignInCodePanel } from "../components/sign-in-code-panel";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useViewport } from "../react/input";
import { colors } from "../theme/colors";
import { Box, Text, TextAttributes, useUiCapabilities } from "../ui";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../ui/dialog";
import { logFailure } from "../utils/log-failure";
import { accountSession } from "./session";

/** The checkout once it exists and the browser was asked to open it. */
export interface CheckoutHandoffTarget {
  /** The checkout page itself, which the browser button opens again. */
  url: string;
  /** A short link to the same checkout, to read or scan; null when the server sent none. */
  link: string | null;
  /** False when no browser could be opened from here. */
  opened: boolean;
}

/** Where the account stands while checkout is open in the browser. */
type CheckoutHandoffPlan = "waiting" | "pro" | "verify";

/**
 * Pro once the account has it; "verify" when checkout went through but Pro
 * waits for the email to be confirmed, which an unverified account can reach.
 */
function checkoutHandoffPlan(user: PlanAccessUser | null | undefined): CheckoutHandoffPlan {
  if (hasProAccess(user)) return "pro";
  if (user?.plan === "pro" && user.emailVerified !== true) return "verify";
  return "waiting";
}

/** How often the account is asked again while checkout is open. */
const POLL_MS = 5_000;
/** Polling stops after this; coming back to the app still refreshes the account. */
const POLL_FOR_MS = 15 * 60_000;
/** How long "Pro is on" stays before the dialog closes itself. */
const PRO_HOLD_MS = 1_500;

/** Rows around the panel, as in the sign-in dialog: margins, frame, title block and key line. */
const TERMINAL_DIALOG_ROWS = 12;
const DESKTOP_DIALOG_ROWS = 10;

function handoffStatus(target: CheckoutHandoffTarget | null, plan: CheckoutHandoffPlan): { text: string; color: string } {
  if (plan === "pro") return { text: t("Pro is on."), color: colors.positive };
  if (plan === "verify") return { text: t("Checkout done. Confirm your email to turn Pro on."), color: colors.warning };
  if (!target) return { text: t("Opening checkout..."), color: colors.textDim };
  return { text: t("Waiting for checkout..."), color: colors.textDim };
}

function CheckoutHandoffDialog({
  resolve,
  dismiss,
  target: pending,
}: PromptContext<true> & { target: Promise<CheckoutHandoffTarget> }) {
  useAppLanguage();
  const { nativePaneChrome } = useUiCapabilities();
  const { height: termHeight } = useViewport();
  const [target, setTarget] = useState<CheckoutHandoffTarget | null>(null);
  // Re-renders when the account changes; the plan is read from the account itself.
  usePlanAccess();
  const plan = checkoutHandoffPlan(apiClient.getCurrentUser());

  useEffect(() => {
    let live = true;
    // A checkout that could not be created closes this; the caller opens the Cloud page.
    void pending.then(
      (value) => { if (live) setTarget(value); },
      () => { if (live) dismiss(); },
    );
    return () => {
      live = false;
    };
  }, [dismiss, pending]);

  useEffect(() => {
    if (!target || plan !== "waiting") return;
    let live = true;
    const stopAt = Date.now() + POLL_FOR_MS;
    const timer = setInterval(() => {
      if (Date.now() > stopAt) {
        clearInterval(timer);
        return;
      }
      // A plain read; the session (and with it every footer and tab) is
      // refreshed only once the account has changed.
      void apiClient.getAccountProfile()
        .then((profile) => {
          if (live && checkoutHandoffPlan(profile) !== "waiting") return accountSession.refreshSession();
        })
        .catch(logFailure("account-upgrade", "Checking for Pro after checkout failed"));
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [plan, target]);

  const finish = useCallback(() => resolve(true), [resolve]);
  useEffect(() => {
    if (plan !== "pro") return;
    const timer = setTimeout(finish, PRO_HOLD_MS);
    return () => clearTimeout(timer);
  }, [finish, plan]);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
    } else if ((event.name === "enter" || event.name === "return") && plan === "pro") {
      event.stopPropagation?.();
      finish();
    }
  });

  const title = t("Finish checkout in your browser");
  // Where nothing opened, the terminal host left Stripe's own link on the clipboard.
  const subtitle = !target || target.opened
    ? t("Pro turns on here as soon as it's done.")
    : target.link
      ? t("No browser opens from here. Open the link on any device.")
      : t("No browser opens from here. Paste the copied link in a browser.");
  const panel = (rows: number) => (
    <SignInCodePanel
      url={target?.url ?? null}
      link={target?.link ?? null}
      code={null}
      status={handoffStatus(target, plan)}
      height={Math.max(4, rows)}
      shortcutScope="checkout-handoff:browser"
    />
  );

  if (nativePaneChrome) {
    return (
      <Box width={FORM_DIALOG_WIDTH} maxWidth="calc(100vw - 72px)" flexDirection="column">
        <DialogFrame title={title} subtitle={subtitle} onClose={dismiss} desktopFooter={null}>
          {panel(termHeight - DESKTOP_DIALOG_ROWS)}
          <Box style={{ marginTop: "var(--gloom-space-md)" }}>
            <DialogActions alignEnd>
              <Button label="Close" variant="secondary" desktopShortcut="Esc" onPress={dismiss} />
            </DialogActions>
          </Box>
        </DialogFrame>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1}>
        <Text fg={colors.textDim}>{subtitle}</Text>
      </Box>
      <Box height={1} />
      {panel(termHeight - TERMINAL_DIALOG_ROWS)}
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("esc to close")}</Text>
      </Box>
    </Box>
  );
}

/**
 * Shows the hand-off while `target` creates and opens the checkout, and keeps
 * it up until Pro arrives or the person closes it. Resolves true once the
 * account has Pro, otherwise when it is closed.
 */
export async function promptCheckoutHandoff(
  dialog: DialogApi,
  target: Promise<CheckoutHandoffTarget>,
): Promise<boolean> {
  const result = await dialog
    .prompt<true>({
      size: "full",
      content: (context) => <CheckoutHandoffDialog {...context} target={target} />,
    })
    .catch(logFailure("account-upgrade", "Checkout hand-off failed", undefined));
  return result === true;
}
