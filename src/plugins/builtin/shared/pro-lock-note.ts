import type { HeadlessPaneContext } from "../../../types/headless";
import type { PaneLock } from "../../../types/plugin";
import { logFailure } from "../../../utils/log-failure";

/** A lock note on one line, as JSON and CSV say why a locked report is empty and as an error carries it. */
export function lockNoteReason(note: string): string {
  return note.replace(/\s*\n\s*/g, " ");
}

/**
 * A free command a lock note can name in place of the locked function: what
 * it lists, and whether it has data for the symbol the reader asked about. A
 * note never sends a reader to a command that answers "No data".
 */
export interface FreeRoute {
  /** The command and what it lists, finishing "Free, with no sign-in: ...". Run it signed out before naming it. */
  text(ticker: string, company: string): string;
  /**
   * Whether the route has data for the symbol, read as the route reads it.
   * Leave it out only for a route that answers for every symbol the function
   * takes. A read that fails counts as no data.
   */
  answers?(symbol: string, context: HeadlessPaneContext): Promise<boolean>;
}

/** A refused read asks for its note twice (the error it throws, then the report), so an answer is kept a while. */
const ANSWER_TTL_MS = 5 * 60_000;
const answers = new WeakMap<FreeRoute, Map<string, { at: number; answer: Promise<boolean> }>>();

function routeAnswers(route: FreeRoute, symbol: string, context: HeadlessPaneContext): Promise<boolean> {
  if (!route.answers) return Promise.resolve(true);
  const bySymbol = answers.get(route) ?? new Map<string, { at: number; answer: Promise<boolean> }>();
  answers.set(route, bySymbol);
  const key = symbol.trim().toUpperCase();
  const kept = bySymbol.get(key);
  if (kept && Date.now() - kept.at < ANSWER_TTL_MS) return kept.answer;
  const answer = route.answers(symbol, context).catch(logFailure("plugins.pro-lock-note", "Check a free route's data failed", false));
  bySymbol.set(key, { at: Date.now(), answer });
  return answer;
}

/**
 * The first of the routes, best first, that has data for the lock's symbol:
 * GUIDE's guidance ranges where it covers the company, else its 8-Ks. Without
 * a symbol the routes read `<ticker>` and the first is named; without a way to
 * read data, only a route that answers for every symbol is.
 */
async function answeringFreeRoute(lock: PaneLock, routes: readonly FreeRoute[]): Promise<FreeRoute | null> {
  if (!lock.symbol) return routes[0] ?? null;
  for (const route of routes) {
    if (!route.answers) return route;
    if (lock.context && await routeAnswers(route, lock.symbol, lock.context)) return route;
  }
  return null;
}

/**
 * The `reportLockNote` of a pane its wall covers whole (`useProFeatureWall`, a
 * scanner's denied state): what the function is and that a wall shows none of
 * it, what a free reader can still get and the command that reads it, and how
 * to unlock it. One shape for every lock a reader meets in `fn`, so a refused
 * read never ends in a bare "Sign in required".
 */
export async function proLockNote(
  lock: PaneLock,
  pane: {
    /** The function's shortcut, such as `EK`; a pane that serves several names the one run in the lock. */
    token: string;
    /** What the function does, finishing "EK is part of Gloom Cloud Pro: it ...". */
    does: string;
    /** What the wall hides, as the object of "none of" and "to read": "it" or "them". */
    shows: "it" | "them";
    /**
     * The free routes, best first: the note names the first with data for the
     * symbol (`answeringFreeRoute`), or none.
     */
    free?: readonly FreeRoute[];
    /** What the wall asks for: Gloom Cloud Pro (default), or only a free Gloom account. */
    needs?: "pro" | "sign-in";
    /**
     * Whether the function takes a ticker: `none` for a board such as FLOW,
     * `optional` for one that also lists every company (CALLS, JOBS), where the
     * command repeats the ticker only when the reader gave one. Default `ticker`.
     */
    argument?: "ticker" | "optional" | "none";
  },
): Promise<string> {
  const { gate, symbol, token: typed, verifyEmail } = lock;
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
  const free = pane.free ? await answeringFreeRoute(lock, pane.free) : null;
  return [
    `${token} ${what}: ${pane.does}. ${without} it shows none of ${pane.shows}.`,
    ...free ? [`Free, with no sign-in: ${free.text(ticker, symbol ?? "the company")}`] : [],
    `${unlock}; ${command} then reads with that session.`,
  ].join("\n");
}
