import { requestAuthDialog } from "../account/auth-dialog";
import { apiClient } from "../api-client";
import type { AppNotificationRequest } from "../types/plugin";
import { errorMessage } from "../utils/errors";

type Notify = (notification: AppNotificationRequest) => unknown;

/**
 * Whether the account can make a share link or post to chat now. When it
 * cannot, one toast says what is missing: a sign-in, which then calls `retry`
 * so Share or the report carries on, or a verified email. `purpose` finishes
 * "Sign in to ...".
 */
export function readyToShare(notify: Notify, retry: () => void, purpose: string): boolean {
  if (!apiClient.isSignedIn()) {
    notify({
      body: `Sign in to ${purpose}.`,
      type: "info",
      action: { label: "Sign in", onClick: () => { requestAuthDialog({ onSignedIn: retry }); } },
    });
    return false;
  }
  if (!apiClient.isVerified()) {
    notify({
      body: `Verify your email to ${purpose}.`,
      type: "info",
      action: {
        label: "Resend link",
        onClick: () => {
          void apiClient.sendVerification()
            .then(() => notify({ body: "Verification link sent.", type: "success" }))
            .catch((error) => notify({ body: errorMessage(error, "Couldn't send the email. Try again."), type: "error" }));
        },
      },
    });
    return false;
  }
  return true;
}
