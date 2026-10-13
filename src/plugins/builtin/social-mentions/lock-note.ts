import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * BUZZ needs a signed-in account, not a plan. No command reads the posts it
 * counts without one, so the note names no free route.
 */
export function socialMentionsLockNote(lock: PaneLock): string {
  return proLockNote(lock, {
    token: "BUZZ",
    needs: "sign-in",
    does: "it counts the daily posts on X that name a company's cashtag, with the top posts and their stance",
    shows: "it",
  });
}
