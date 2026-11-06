import type { PaneLock } from "../../../types/plugin";
import { proLockNote } from "../shared/pro-lock-note";

/**
 * BUZZ needs a signed-in account, not a plan. No command reads the posts it
 * counts without one, so the note names no free route. Without a ticker it
 * ranks the market's outliers, and the command it names is bare.
 */
export function socialMentionsLockNote(lock: PaneLock): Promise<string> {
  return proLockNote(lock, {
    token: "BUZZ",
    needs: "sign-in",
    argument: "optional",
    does: lock.symbol
      ? "it counts the daily posts on X that name a company's cashtag, with the top posts and their stance"
      : "it ranks the tickers whose posts on X jump above their own 30-day median, with stance and price move",
    shows: "it",
  });
}
