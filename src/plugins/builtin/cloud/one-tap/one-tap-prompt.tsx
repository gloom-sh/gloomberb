/**
 * Mounts Google One Tap on the hosted terminal (term.gloom.sh) for signed-out
 * visitors, in browsers that can show it. It draws nothing of its own: Google
 * (the browser, with FedCM) draws the prompt. When and whether it is asked
 * for lives in controller.ts; this feeds it the terminal's state and signs in
 * with what Google returns, where the visitor already is.
 *
 * Never on the desktop app, the terminal app, or any gloom.sh page.
 */
import { useEffect, useRef } from "react";
import { apiClient } from "../../../../api-client";
import { usePlanAccess } from "../../../../api-client/plan-access";
import { exposeWebExperiment, recordResearchActivity } from "../../../../api-client/research-activity";
import { requestAuthDialog } from "../../../../account/auth-dialog";
import { performGoogleOneTapAuth } from "../../../../account/auth-model";
import { t, tf } from "../../../../i18n";
import { useAppVisible } from "../../../../state/app/activity";
import { useAppSelector } from "../../../../state/app/context";
import { subscribeFunctionOpens } from "../../../../telemetry/usage-counts";
import { useDialogState } from "../../../../ui/dialog";
import { getCurrentPluginTarget } from "../../../current-target";
import { usePluginAppActions, usePluginState } from "../../../runtime";
import { OneTapController, ONE_TAP_EXPERIMENT, oneTapFailureReason, type OneTapDeps } from "./controller";
import { browserSupportsOneTap, loadGoogleIdentity } from "./google-identity";

export interface OneTapPromptProps {
  /** Replaced in tests. */
  expose?: (experiment: string) => Promise<string | null>;
  loadGoogle?: OneTapDeps["google"];
}

const loadGoogleOnce: OneTapDeps["google"] = () => loadGoogleIdentity();

export function OneTapPrompt(props: OneTapPromptProps) {
  if (getCurrentPluginTarget() !== "web" || !browserSupportsOneTap()) return null;
  return <WebOneTap {...props} />;
}

function WebOneTap({ expose = exposeWebExperiment, loadGoogle = loadGoogleOnce }: OneTapPromptProps) {
  const access = usePlanAccess();
  const visible = useAppVisible();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const { notify, openCommandBar } = usePluginAppActions();
  const [snoozedAt, setSnoozedAt] = usePluginState<number | null>("one-tap-snoozed-at", null);
  const latest = useRef({ snoozedAt, setSnoozedAt, notify, openCommandBar });
  latest.current = { snoozedAt, setSnoozedAt, notify, openCommandBar };
  const controllerRef = useRef<OneTapController | null>(null);
  const conditions = { visible, signedOut: !access.signedIn, overlayOpen: dialogOpen || commandBarOpen };
  const conditionsRef = useRef(conditions);
  conditionsRef.current = conditions;

  useEffect(() => {
    const controller = new OneTapController({
      expose: () => expose(ONE_TAP_EXPERIMENT),
      clientId: async () => (await apiClient.getOneTapConfig()).clientId,
      google: loadGoogle,
      signIn: async (credential) => {
        try {
          const user = await performGoogleOneTapAuth(credential);
          latest.current.notify({ body: tf("Signed in as {email}.", { email: user.email }), type: "success" });
        } catch (error) {
          showFailure(error);
          throw error;
        }
      },
      record: (event, reason) => recordResearchActivity(event, undefined, undefined, { reason }),
      snoozedAt: () => latest.current.snoozedAt,
      snooze: (at) => latest.current.setSnoozedAt(at),
    });
    const showFailure = (error: unknown) => {
      const { notify: show, openCommandBar: openBar } = latest.current;
      const reason = oneTapFailureReason(error);
      if (reason === "account_not_linked") {
        // The address has an account here that was never verified, so Google
        // cannot join it; its owner logs in with the password.
        show({ body: t("This email already has an account. Log in with email."), type: "info" });
        if (!requestAuthDialog({ mode: "login" })) openBar("Log In");
      } else if (reason === "email_not_verified") {
        show({ body: t("Verify your email with Google first, or use email."), type: "error" });
      } else {
        show({ body: t("Sign-in with Google did not finish. Try again or use email."), type: "error" });
      }
    };
    controllerRef.current = controller;
    controller.update(conditionsRef.current);
    const stopListening = subscribeFunctionOpens(() => controller.noteFunctionOpen());
    return () => {
      stopListening();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [expose, loadGoogle]);

  const { signedOut, overlayOpen } = conditions;
  useEffect(() => {
    controllerRef.current?.update({ visible, signedOut, overlayOpen });
  }, [overlayOpen, signedOut, visible]);

  return null;
}
