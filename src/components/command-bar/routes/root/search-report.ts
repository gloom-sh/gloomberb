import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  apiClient,
  type CommandSearchChoice,
  type CommandSearchOutcome,
} from "../../../../api-client";
import { automationActive } from "../../../../telemetry/usage-counts";
import { VERSION } from "../../../../version";
import type { AssistRequestState } from "../../assist/model";
import type { ResultItem } from "../../list/model";
import type { CommandBarRoute } from "../../workflow/types";

/** A root row the user runs, read before it runs: running a row can rewrite the query. */
export interface RootRowRun {
  item: ResultItem;
  /** The root query at that moment, as typed. */
  query: string;
  /** Position in the list on screen; 0 for text that ran before its list rendered. */
  rank: number;
  /** The typed text resolved and ran before its own list had rendered. */
  typed: boolean;
}

/**
 * What running a root row is reported as, or null for a placeholder that
 * answers nothing ("Thinking…", a failed search). `shortcut` means the query
 * is itself a command-bar command ("DES AAPL"), whichever of its rows ran.
 */
function describeRootChoice(run: RootRowRun, shortcut: boolean): CommandSearchChoice | null {
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
  if (shortcut) return { kind: "shortcut", ...base, input: run.query.trim(), fromAssist: false };
  return { kind: item.kind, ...base, fromAssist: false };
}

interface CommandSearchReportOptions {
  /** The assist answer on screen, whose `searchId` a report for the same query carries. */
  assistStateRef: RefObject<AssistRequestState>;
  currentRouteRef: RefObject<CommandBarRoute | null>;
  /** The Usage setting, read when a report would go out. */
  isEnabled: () => boolean;
  /** Whether the query on screen is itself a command-bar command. */
  isShortcutQuery: () => boolean;
  rootQueryRef: RefObject<string>;
}

/**
 * Reports how one visit to the command bar ended, at most once: the root
 * query the user finished and the row they ran from the root list, or, when
 * the bar closes on a root query with nothing run, that they dismissed it.
 * Keystrokes are never reported, and neither is an empty query.
 *
 * `reportRun` is called as a root row runs, before its action: an action that
 * closes the bar must find the visit already reported. The report is built
 * from the state of that moment and sent on a later tick, so it never holds
 * up what the user ran. `settle` marks the visit as ended by something the
 * report does not describe (a form finished in a sub-route, a theme committed
 * from the picker), so closing is not read as a dismissal. Reports follow the
 * Usage setting; signed out, the client sends nothing.
 */
export function useCommandSearchReport({
  assistStateRef,
  currentRouteRef,
  isEnabled,
  isShortcutQuery,
  rootQueryRef,
}: CommandSearchReportOptions): {
  reportRun: (run: RootRowRun) => void;
  settle: () => void;
} {
  const settledRef = useRef(false);
  const isEnabledRef = useRef(isEnabled);
  isEnabledRef.current = isEnabled;
  const isShortcutQueryRef = useRef(isShortcutQuery);
  isShortcutQueryRef.current = isShortcutQuery;

  const send = useCallback((query: string, outcome: CommandSearchOutcome, choice?: CommandSearchChoice) => {
    try {
      // What remote control types is automation, not the user searching.
      if (automationActive() || !isEnabledRef.current()) return;
      const assist = assistStateRef.current;
      const searchId = assist.status === "answered" && assist.query === query ? assist.searchId : undefined;
      const report = {
        query,
        ...(searchId ? { searchId } : {}),
        outcome,
        ...(choice ? { choice } : {}),
        appVersion: VERSION,
      };
      setTimeout(() => apiClient.reportCommandSearch(report), 0);
    } catch {
      /* A report must never get in the way of the command bar. */
    }
  }, [assistStateRef]);

  const reportRun = useCallback((run: RootRowRun) => {
    if (settledRef.current) return;
    const query = run.query.trim();
    if (!query) return;
    const choice = describeRootChoice(run, run.typed || isShortcutQueryRef.current());
    if (!choice) return;
    settledRef.current = true;
    send(query, "chosen", choice);
  }, [send]);

  const settle = useCallback(() => {
    settledRef.current = true;
  }, []);

  // The bar unmounts when it closes, whichever way: Esc, a click outside, or
  // the command-bar key pressed again.
  useEffect(() => () => {
    if (settledRef.current || currentRouteRef.current) return;
    const query = rootQueryRef.current.trim();
    if (!query) return;
    settledRef.current = true;
    send(query, "dismissed");
  }, [currentRouteRef, rootQueryRef, send]);

  return { reportRun, settle };
}
