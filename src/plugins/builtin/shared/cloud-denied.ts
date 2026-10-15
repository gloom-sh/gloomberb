import { ApiRequestError } from "../../../api-client/errors";
import type { PaneLock } from "../../../types/plugin";
import { lockNoteReason } from "./pro-lock-note";

/** A Gloom Cloud refusal the reader can act on: signed out, an unverified email, or no Pro plan. */
type CloudDeniedStatus = 401 | 402 | 403;

/**
 * The account refusal behind a failed request, or null when it failed for
 * another reason. Looks through the errors that wrap it, so a message written
 * for the reader still says which wall it stands for.
 */
function cloudDeniedStatus(error: unknown): CloudDeniedStatus | null {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const status = current instanceof ApiRequestError ? current.status : undefined;
    if (status === 401 || status === 402 || status === 403) return status;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/**
 * The wall a refused read stands for, as the pane's own wall puts it up: no
 * session is the sign-in wall, an unverified email the same wall asking for
 * the email, a plan without access the Pro wall.
 */
export function refusedLock(error: unknown): Pick<PaneLock, "gate" | "verifyEmail"> | null {
  const status = cloudDeniedStatus(error);
  if (status === 402) return { gate: "pro" };
  return status ? { gate: "sign-in", ...status === 403 ? { verifyEmail: true } : {} } : null;
}

/**
 * What a headless read throws when the server refused it behind a wall: the
 * pane's lock note on one line, so every consumer of the read says what is
 * locked and how to unlock it, with the refusal as its cause for `fn`, which
 * prints the whole note. Any other failure is returned as it is.
 */
export function explainRefusal(
  error: unknown,
  note: (lock: PaneLock) => string,
  lock: Pick<PaneLock, "symbol" | "token">,
): unknown {
  const refused = refusedLock(error);
  return refused ? new Error(lockNoteReason(note({ ...refused, ...lock })), { cause: error }) : error;
}
