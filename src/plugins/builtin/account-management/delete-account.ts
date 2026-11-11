import { ApiRequestError } from "../../../api-client/errors";

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
