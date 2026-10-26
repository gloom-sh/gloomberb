import { createTtlCache, type TtlCache } from "../../../data/ttl-cache";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { PaneLock } from "../../../types/plugin";
import { settleWithin, signalWithTimeout } from "../../../utils/async-deadline";
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
   * takes. A read that fails, or is still out after a few seconds, counts as
   * no data; pass `context.signal` on to reads that take one.
   */
  answers?(symbol: string, context: HeadlessPaneContext): Promise<boolean>;
}

/** A refused read asks for its note twice (the error it throws, then the report), so an answer is kept a while. */
const ANSWER_TTL_MS = 5 * 60_000;

/**
 * How long a note waits on its routes' data checks, all of them together: a
 * check still out then counts as no data, so a stalled service costs the note
 * its route, never the reader's command.
 */
const ROUTE_CHECK_WAIT_MS = 3_000;

const answers = new WeakMap<FreeRoute, TtlCache<boolean>>();

/**
 * Whether the route has data for the symbol, null when its check failed or was
 * still out at the deadline. A check that answered is kept for the TTL; one
 * that failed or ran out of time is dropped, so the next note checks again
 * rather than hiding the route for minutes over one slow read.
 */
async function routeAnswers(route: FreeRoute, check: NonNullable<FreeRoute["answers"]>, symbol: string, context: HeadlessPaneContext, deadline: number): Promise<boolean | null> {
  const bySymbol = answers.get(route) ?? createTtlCache<boolean>({ ttlMs: ANSWER_TTL_MS });
  answers.set(route, bySymbol);
  const key = symbol.trim().toUpperCase();
  const kept = bySymbol.load(key, () => {
    // The check's own reads stop at the deadline where they take a signal.
    const signal = signalWithTimeout(context.signal, Math.max(0, deadline - Date.now()));
    return check(symbol, { ...context, signal }).catch((error: unknown) => {
      logFailure("plugins.pro-lock-note", "Check a free route's data failed")(error);
      throw error;
    });
  });
  const answer = await settleWithin(kept, Math.max(0, deadline - Date.now()));
  // Only this check is dropped: a newer one for the symbol stays.
  if (answer === null) bySymbol.delete(key, kept);
  return answer;
}

/**
 * The first of the routes, best first, that has data for the lock's symbol:
 * GUIDE's guidance ranges where it covers the company, else its 8-Ks. The
 * checks run together under one deadline, so a stalled first route neither
 * holds the note past it nor keeps the next route from being named. Without a
 * symbol the routes read `<ticker>` and the first is named; without a way to
 * read data, only a route that answers for every symbol is.
 */
async function answeringFreeRoute(lock: PaneLock, routes: readonly FreeRoute[]): Promise<FreeRoute | null> {
  const { symbol, context } = lock;
  if (!symbol) return routes[0] ?? null;
  // Routes past the first that needs no check are never named, so they are not checked.
  const unchecked = routes.findIndex((route) => !route.answers);
  const candidates = unchecked < 0 ? routes : routes.slice(0, unchecked + 1);
  const deadline = Date.now() + ROUTE_CHECK_WAIT_MS;
  const checks = candidates.map((route) => !route.answers ? Promise.resolve(true)
    : context ? routeAnswers(route, route.answers, symbol, context, deadline) : Promise.resolve(false));
  for (const [index, check] of checks.entries()) {
    if (await check) return candidates[index]!;
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
    ? `To read ${pane.shows} in ${token}, upgrade in the app (gloom, then Ctrl+P, UPGRADE)`
    : `To read ${pane.shows} in ${token}, open the app (gloom), ${account}${pro ? ", then upgrade (Ctrl+P, UPGRADE)" : ""}`;
  const bare = pane.argument === "none" || (pane.argument === "optional" && !symbol);
  const command = bare ? `gloom fn ${token}` : `gloom fn ${token} ${ticker}`;
  const free = pane.free ? await answeringFreeRoute(lock, pane.free) : null;
  return [
    `${token} ${what}: ${pane.does}. ${without} it shows none of ${pane.shows}.`,
    ...free ? [`Free, with no sign-in: ${free.text(ticker, symbol ?? "the company")}`] : [],
    `${unlock}; ${command} then reads with that session.`,
  ].join("\n");
}
