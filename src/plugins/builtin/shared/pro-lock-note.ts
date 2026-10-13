import type { PaneLock } from "../../../types/plugin";

/** A lock note on one line, as JSON and CSV say why a locked report is empty and as an error carries it. */
export function lockNoteReason(note: string): string {
  return note.replace(/\s*\n\s*/g, " ");
}

/**
 * The `reportLockNote` of a pane its wall covers whole (`useProFeatureWall`, a
 * scanner's denied state): what the function is and that a wall shows none of
 * it, what a free reader can still get and the command that reads it, and how
 * to unlock it. One shape for every lock a reader meets in `fn`, so a refused
 * read never ends in a bare "Sign in required".
 */
export function proLockNote(
  { gate, symbol, token: typed, verifyEmail }: PaneLock,
  pane: {
    /** The function's shortcut, such as `EK`; a pane that serves several names the one run in the lock. */
    token: string;
    /** What the function does, finishing "EK is part of Gloom Cloud Pro: it ...". */
    does: string;
    /** What the wall hides, as the object of "none of" and "to read": "it" or "them". */
    shows: "it" | "them";
    /**
     * The free route and what it lists, finishing "Free, with no sign-in: ...".
     * Name one only after running it signed out; leave it out when none answers.
     */
    free?(ticker: string, company: string): string;
    /** What the wall asks for: Gloom Cloud Pro (default), or only a free Gloom account. */
    needs?: "pro" | "sign-in";
    /**
     * Whether the function takes a ticker: `none` for a board such as FLOW,
     * `optional` for one that also lists every company (CALLS, JOBS), where the
     * command repeats the ticker only when the reader gave one. Default `ticker`.
     */
    argument?: "ticker" | "optional" | "none";
  },
): string {
  const token = typed ?? pane.token;
  const ticker = symbol ?? "<ticker>";
  // A plan refused at the server is Pro whatever the function usually asks for.
  const pro = pane.needs !== "sign-in" || gate === "pro";
  const without = gate === "pro" ? "On a free account" : verifyEmail ? "Until the email is verified" : "Signed out";
  const what = pro ? "is part of Gloom Cloud Pro" : "needs a free Gloom sign-in";
  const account = verifyEmail
    ? "verify your email (Ctrl+P, Resend Verification Email)"
    : `log in or sign up${pro ? "" : " free"} from the command bar (Ctrl+P, Log In or Sign Up)`;
  const unlock = gate === "pro"
    ? `To read ${pane.shows} in ${token}, upgrade in the app (gloomberb, then Ctrl+P, UPGRADE)`
    : `To read ${pane.shows} in ${token}, open the app (gloomberb), ${account}${pro ? ", then upgrade (Ctrl+P, UPGRADE)" : ""}`;
  const bare = pane.argument === "none" || (pane.argument === "optional" && !symbol);
  const command = bare ? `gloomberb fn ${token}` : `gloomberb fn ${token} ${ticker}`;
  return [
    `${token} ${what}: ${pane.does}. ${without} it shows none of ${pane.shows}.`,
    ...pane.free ? [`Free, with no sign-in: ${pane.free(ticker, symbol ?? "the company")}`] : [],
    `${unlock}; ${command} then reads with that session.`,
  ].join("\n");
}
