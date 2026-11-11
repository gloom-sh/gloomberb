import { ApiRequestError } from "../../../api-client/errors";
import { t } from "../../../i18n";

/**
 * What a refused account delete asks for. The server deletes the account
 * only from a session signed in within a day, or with the password; a
 * session older than that hears `password` (ask for it; a wrong one is
 * refused the same way) or, for an account with no password, `log_in`.
 * Null when the error is anything else.
 */
export function deleteAccountRefusal(error: unknown): "password" | "log_in" | null {
  if (!(error instanceof ApiRequestError) || error.status !== 403) return null;
  const confirm = error.details?.confirm;
  return confirm === "password" || confirm === "log_in" ? confirm : null;
}

/**
 * How an account with no password gets a fresh sign-in. The app signs in
 * through the browser, and the session it gets is no fresher than the
 * browser's, so logging out and in here alone would bring another old one.
 */
export const DELETE_ACCOUNT_LOG_IN_AGAIN =
  "To delete your account, sign out of gloom.sh in your browser and back in, then log out here and back in.";

export type DeleteAccountMessage = { tone: "info" | "success" | "error"; text: string };

export interface DeleteAccountSteps {
  /** Deletes the account, with the password when one is given. */
  remove: (password?: string) => Promise<void>;
  /**
   * Asks for the password. `submit` deletes with it; it throws, with the
   * server's message, to keep asking (a wrong password, too many tries).
   */
  askPassword: (submit: (password: string) => Promise<void>) => void;
  /** The account is gone: what the pane shows and clears. */
  deleted: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setMessage: (message: DeleteAccountMessage | null) => void;
}

/**
 * Deletes the account as the account pane does, once the user confirmed.
 * A session signed in more than a day ago is refused, and this asks for the
 * password and deletes with it, or says how to sign in again for an account
 * without one.
 */
export async function deleteAccountConfirmingSession(steps: DeleteAccountSteps): Promise<void> {
  const logInAgain = (): DeleteAccountMessage => ({ tone: "error", text: t(DELETE_ACCOUNT_LOG_IN_AGAIN) });
  steps.setBusy(true);
  steps.setMessage({ tone: "info", text: t("Deleting account...") });
  let refusal: ReturnType<typeof deleteAccountRefusal> = null;
  try {
    await steps.remove();
    await steps.deleted();
  } catch (error) {
    refusal = deleteAccountRefusal(error);
    steps.setMessage(refusal === "password"
      ? null
      : refusal === "log_in"
        ? logInAgain()
        : { tone: "error", text: error instanceof Error ? error.message : t("Failed to delete account.") });
  } finally {
    steps.setBusy(false);
  }
  if (refusal !== "password") return;
  steps.askPassword(async (password) => {
    steps.setBusy(true);
    try {
      await steps.remove(password);
      await steps.deleted();
    } catch (error) {
      if (deleteAccountRefusal(error) === "log_in") steps.setMessage(logInAgain());
      throw error;
    } finally {
      steps.setBusy(false);
    }
  });
}
