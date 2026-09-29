import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  apiClient,
  type CommandSearchChoice,
  type CommandSearchOutcome,
} from "../../../../api-client";
import { automationActive } from "../../../../telemetry/usage-counts";
import { VERSION } from "../../../../version";
import type { ResultItem } from "../../list/model";
import type { CommandBarRoute } from "../../workflow/types";

/**
 * Rows of the command that switches the Usage setting, which also covers the
 * report: turning it off from the bar must not be the last thing it sends.
 */
const USAGE_SETTING_ROW_IDS = new Set(["toggle-usage-counts", "command:toggle-usage-counts"]);

/** A root row the user runs, read before it runs: running a row can rewrite the query. */
export interface RootRowRun {
  item: ResultItem;
  /** The root query at that moment, as typed. */
  query: string;
  /** Position in the list on screen; 0 for text that ran before its list rendered. */
  rank: number;
  /**
   * Whether the row is the typed shortcut itself ("DES MSFT" resolving to its
   * own row), rather than another row shown for it. Read only when the run is
   * reported.
   */
  isShortcut: () => boolean;
}

/**
 * Runs a root row as the report sees it. `action` runs the row and may return
 * false when nothing ran after all.
 */
export type RunRootRow = (run: RootRowRun, action: () => boolean | void) => void;

interface PendingChoice {
  query: string;
  choice: CommandSearchChoice;
}

/**
 * What running a root row is reported as, or null for a placeholder that
 * answers nothing ("Thinking…", a failed search). `shortcut` means the typed
 * text itself ran ("DES MSFT"); other rows keep their own kind.
 */
function describeRootChoice(run: RootRowRun): CommandSearchChoice | null {
  const { item, rank } = run;
  if (item.kind === "info") return null;
  const base = {
    label: item.label,
    rank,
    ...(item.category ? { category: item.category } : {}),
  };
  if (item.searchChoice?.kind === "assist") {
    return { kind: "assist", ...base, input: item.searchChoice.input, fromAssist: true };
  }
  if (item.searchChoice?.kind === "ask-gloom") {
    return { kind: "ask-gloom", ...base, fromAssist: false };
  }
  if (run.isShortcut()) return { kind: "shortcut", ...base, input: run.query.trim(), fromAssist: false };
  return { kind: item.kind, ...base, fromAssist: false };
}

interface CommandSearchReportOptions {
  currentRouteRef: RefObject<CommandBarRoute | null>;
  /** Whether automation set this query and the user has not edited it since. */
  isAutomationQuery: (query: string) => boolean;
  /** The Usage setting, read when a report would go out and again as it is sent. */
  isEnabled: () => boolean;
  rootQueryRef: RefObject<string>;
  /** Whether a route is on screen, to notice the user backing out of one. */
  routeOpen: boolean;
  /** The `/assist/command` record the bar kept for this query, answered or not. */
  searchIdFor: (query: string) => string | undefined;
}

/**
 * Reports how one visit to the command bar ended, at most once: the root
 * query the user finished and the row they ran from the root list, or, when
 * the bar closes on a root query with nothing run, that they dismissed it.
 * Keystrokes are never reported, nor an empty query, nor anything typed in a
 * route (a ticker search, a pane form).
 *
 * The first root row that runs is held as the visit's choice until the bar
 * closes. A row that only rewrites the query ("Change Theme" writes "TH ")
 * does not count, and backing out of the route a row opened drops it, so the
 * search goes on. `finish` is the close after something ran: it sends the
 * held choice, or nothing when what ran was not a root choice (a key-bound
 * command, a route a menu opened). `dismiss` is any other close (Esc, a click
 * outside, the bar's own key; unmounting calls it too): it sends the held
 * choice as it stands, or else a dismissal of the root query, skipped while a
 * route is open or the query is still the text the bar opened with. `settle`
 * ends the visit with no report.
 *
 * Reports follow the Usage setting and leave out automation: nothing is sent
 * while remote control is running, nor for a query it typed that the user has
 * not edited. Each report goes out on a later tick, so it never holds up what
 * the user ran; signed out, the client sends nothing.
 */
export function useCommandSearchReport({
  currentRouteRef,
  isAutomationQuery,
  isEnabled,
  rootQueryRef,
  routeOpen,
  searchIdFor,
}: CommandSearchReportOptions): {
  choose: (query: string, choice: CommandSearchChoice) => void;
  dismiss: () => void;
  finish: () => void;
  runRootRow: RunRootRow;
  settle: () => void;
} {
  const settledRef = useRef(false);
  const pendingRef = useRef<PendingChoice | null>(null);
  /** The text the bar opened with: menus open it on "HELP" or "TH ", which nobody typed. */
  const initialQueryRef = useRef(rootQueryRef.current);
  const isEnabledRef = useRef(isEnabled);
  isEnabledRef.current = isEnabled;
  const isAutomationQueryRef = useRef(isAutomationQuery);
  isAutomationQueryRef.current = isAutomationQuery;
  const searchIdForRef = useRef(searchIdFor);
  searchIdForRef.current = searchIdFor;

  const send = useCallback((query: string, outcome: CommandSearchOutcome, choice?: CommandSearchChoice) => {
    try {
      const allowed = () => (
        !automationActive() && isEnabledRef.current() && !isAutomationQueryRef.current(query)
      );
      if (!query || !allowed()) return;
      const searchId = searchIdForRef.current(query);
      const report = {
        query,
        ...(searchId ? { searchId } : {}),
        outcome,
        ...(choice ? { choice } : {}),
        appVersion: VERSION,
      };
      setTimeout(() => {
        try {
          // The setting or automation may have changed since the choice.
          if (allowed()) apiClient.reportCommandSearch(report);
        } catch {
          /* A report must never get in the way of the command bar. */
        }
      }, 0);
    } catch {
      /* A report must never get in the way of the command bar. */
    }
  }, []);

  const runRootRow = useCallback<RunRootRow>((run, action) => {
    // The first choice of the visit stands; later runs are not reported.
    if (settledRef.current || pendingRef.current) {
      action();
      return;
    }
    if (USAGE_SETTING_ROW_IDS.has(run.item.id)) {
      settledRef.current = true;
      action();
      return;
    }
    const choice = describeRootChoice(run);
    if (!choice) {
      action();
      return;
    }
    const pending: PendingChoice = { query: run.query.trim(), choice };
    pendingRef.current = pending;
    const ran = action();
    if (settledRef.current || pendingRef.current !== pending) return;
    // Nothing ran, or the row only rewrote the query: the search goes on.
    if (ran === false || rootQueryRef.current !== run.query) pendingRef.current = null;
  }, [rootQueryRef]);

  const choose = useCallback((query: string, choice: CommandSearchChoice) => {
    if (settledRef.current || pendingRef.current) return;
    pendingRef.current = { query: query.trim(), choice };
  }, []);

  const finish = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) send(pending.query, "chosen", pending.choice);
  }, [send]);

  const dismiss = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      send(pending.query, "chosen", pending.choice);
      return;
    }
    if (currentRouteRef.current) return;
    const query = rootQueryRef.current.trim();
    if (!query || query === initialQueryRef.current.trim()) return;
    send(query, "dismissed");
  }, [currentRouteRef, rootQueryRef, send]);

  const settle = useCallback(() => {
    settledRef.current = true;
    pendingRef.current = null;
  }, []);

  // Backing out of the route a root row opened takes that choice back.
  const routeOpenRef = useRef(routeOpen);
  useEffect(() => {
    const wasOpen = routeOpenRef.current;
    routeOpenRef.current = routeOpen;
    if (wasOpen && !routeOpen && !settledRef.current) pendingRef.current = null;
  }, [routeOpen]);

  // The bar unmounts when it closes, whichever way: Esc, the command-bar key
  // pressed again, or something outside it closing it.
  useEffect(() => dismiss, [dismiss]);

  return { choose, dismiss, finish, runRootRow, settle };
}
