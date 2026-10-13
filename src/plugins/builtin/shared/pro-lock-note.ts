/**
 * The `reportLockNote` of a Pro-only pane (`useProFeatureWall`): what the
 * function is and that a wall shows none of it, what a free account can still
 * read and the command that reads it, and how to unlock it.
 */
export function proLockNote(
  { gate, symbol }: { gate: "sign-in" | "pro"; symbol: string | null },
  pane: {
    /** The function's shortcut, such as `EK`. */
    token: string;
    /** What the function does, finishing "EK is part of Gloom Cloud Pro: it ...". */
    does: string;
    /** What the wall hides, as the object of "none of" and "to read": "it" or "them". */
    shows: "it" | "them";
    /** The free route and what it lists, finishing "Free, with no sign-in: ...". */
    free(ticker: string, company: string): string;
  },
): string {
  const ticker = symbol ?? "<ticker>";
  const unlock = gate === "sign-in"
    ? `To read ${pane.shows} in ${pane.token}, open the app (gloomberb), log in or sign up from the command bar (Ctrl+P, Log In or Sign Up), then upgrade (Ctrl+P, UPGRADE)`
    : `To read ${pane.shows} in ${pane.token}, upgrade in the app (gloomberb, then Ctrl+P, UPGRADE)`;
  return [
    `${pane.token} is part of Gloom Cloud Pro: ${pane.does}. ${gate === "sign-in" ? "Signed out" : "On a free account"} it shows none of ${pane.shows}.`,
    `Free, with no sign-in: ${pane.free(ticker, symbol ?? "the company")}`,
    `${unlock}; gloomberb fn ${pane.token} ${ticker} then reads with that session.`,
  ].join("\n");
}
