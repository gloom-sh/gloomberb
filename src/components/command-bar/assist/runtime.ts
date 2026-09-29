import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  type AssistCommandCandidate,
  type AssistCommandDescriptor,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { AssistErrorKind, AssistRequestSource, AssistRequestState } from "./model";

/** Quiet period after the last keystroke before the query is sent. */
const ASSIST_DEBOUNCE_MS = 300;
/** How long background asks stay off after the server rate-limits us. */
const ASSIST_RATE_LIMIT_BACKOFF_MS = 60_000;

/**
 * The question a query asks, whatever its spacing: "gamestop  options" and
 * "gamestop options" share one answer and one request. Casing is kept, since
 * it can be the question ("chart ON" names ON Semiconductor, "chart on" does not).
 */
function normalizeAssistQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

/** An answer as the bar keeps it: the candidates and the server's record of the ask. */
interface AssistAnswer {
  candidates: AssistCommandCandidate[];
  searchId?: string;
}

function answeredState(query: string, source: AssistRequestSource, answer: AssistAnswer): AssistRequestState {
  return { status: "answered", query, source, candidates: answer.candidates };
}

/** Maps a failed `/assist/command` call onto the row the user should see. */
function classifyAssistError(error: unknown): AssistErrorKind {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  if (status === 503) return "unavailable";
  if (status === 429) return "rate-limited";
  return "failed";
}

/**
 * Owns the `/assist/command` request for the root command-bar list. A query the
 * prefix parser cannot claim is sent on its own once typing settles; answers are
 * memoized for the life of the bar so backspacing never re-asks, and a rate
 * limit silently parks background asks for a minute.
 *
 * Requests, answers, dismissals and explicit asks are keyed on the normalized
 * question, while the state carries the text in the bar, which is what the
 * rows compare against. Editing only the spacing therefore keeps the state and
 * relabels it with the new text. An answer keeps the `searchId` it came with,
 * even an answer with no command, so a later search report for the same
 * question points at the same record (`searchIdFor`).
 */
export function useCommandBarAssist({
  autoAsk,
  getInventory,
  logSearches,
  rootQuery,
}: {
  /** Whether this query qualifies for a background ask right now. */
  autoAsk: boolean;
  getInventory: () => AssistCommandDescriptor[];
  /** Whether the server may keep this question, read as each ask goes out. */
  logSearches: (query: string) => boolean;
  rootQuery: string;
}): {
  /** False once Esc has dismissed the section for the query still in the bar. */
  assistActive: boolean;
  assistState: AssistRequestState;
  askAssist: () => void;
  resetAssist: () => boolean;
  /** The server's record of the answer kept for this question, whatever is on screen now. */
  searchIdFor: (query: string) => string | undefined;
} {
  const [assistState, setRenderedAssistState] = useState<AssistRequestState>({ status: "idle" });
  const assistStateRef = useRef(assistState);
  /**
   * Event handlers can run again before React commits the state they just
   * queued. Keep their read model current synchronously so repeated Enter
   * claims one request instead of aborting it and starting another.
   */
  const updateAssistState = useCallback((next: AssistRequestState) => {
    assistStateRef.current = next;
    setRenderedAssistState(next);
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Answers by normalized question. */
  const answersRef = useRef(new Map<string, AssistAnswer>());
  /** Normalized question the runtime has already acted on, updated when a request starts. */
  const handledQueryRef = useRef<string | null>(null);
  /** Normalized question the user dismissed with Esc; the section stays gone until it changes. */
  const dismissedQueryRef = useRef<string | null>(null);
  /** Normalized question the user asked for themselves, so its failures are worth a row. */
  const explicitQueryRef = useRef<string | null>(null);
  const rateLimitedUntilRef = useRef(0);
  const rootQueryRef = useRef(rootQuery);
  rootQueryRef.current = rootQuery;
  const getInventoryRef = useRef(getInventory);
  getInventoryRef.current = getInventory;
  const logSearchesRef = useRef(logSearches);
  logSearchesRef.current = logSearches;

  const cancelPending = useCallback(() => {
    const debounce = debounceRef.current;
    debounceRef.current = null;
    if (debounce !== null) clearTimeout(debounce);

    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
  }, []);

  const resetAssist = useCallback((): boolean => {
    const active = assistStateRef.current;
    // Background rows are ambient: Esc belongs to whoever is listening next.
    if (active.status === "idle" || active.source === "auto") return false;
    cancelPending();
    dismissedQueryRef.current = normalizeAssistQuery(active.query);
    updateAssistState({ status: "idle" });
    return true;
  }, [cancelPending, updateAssistState]);

  const runAssist = useCallback((query: string, source: AssistRequestSource) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const key = normalizeAssistQuery(trimmed);
    cancelPending();
    handledQueryRef.current = key;
    // A background ask the user has since claimed answers to them, not to the
    // debounce, so its outcome is reported rather than swallowed.
    const resolveSource = (): AssistRequestSource => (
      explicitQueryRef.current === key ? "explicit" : source
    );
    // The bar may have been re-spaced while the request was out.
    const resolveQuery = (): string => {
      const current = rootQueryRef.current.trim();
      return normalizeAssistQuery(current) === key ? current : trimmed;
    };

    const cached = answersRef.current.get(key);
    if (cached) {
      updateAssistState(answeredState(trimmed, resolveSource(), cached));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    updateAssistState({ status: "loading", query: trimmed, source: resolveSource() });

    void (async () => {
      try {
        const response = await apiClient.assistCommand(trimmed, getInventoryRef.current(), {
          signal: controller.signal,
          log: logSearchesRef.current(trimmed),
        });
        if (controller.signal.aborted || abortRef.current !== controller) return;
        const answer: AssistAnswer = {
          candidates: response?.candidates ?? [],
          ...(typeof response?.searchId === "string" && response.searchId ? { searchId: response.searchId } : {}),
        };
        answersRef.current.set(key, answer);
        updateAssistState(answeredState(resolveQuery(), resolveSource(), answer));
      } catch (error) {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        const kind = classifyAssistError(error);
        if (kind === "rate-limited") {
          rateLimitedUntilRef.current = Date.now() + ASSIST_RATE_LIMIT_BACKOFF_MS;
        }
        updateAssistState({ status: "error", query: resolveQuery(), source: resolveSource(), kind });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
  }, [cancelPending, updateAssistState]);

  const askAssist = useCallback(() => {
    const trimmed = rootQueryRef.current.trim();
    if (!trimmed) return;
    const key = normalizeAssistQuery(trimmed);
    explicitQueryRef.current = key;
    const active = assistStateRef.current;
    // The background ask already on the wire asks this exact question; asking
    // again would only abort it and start the wait over.
    if (active.status === "loading" && normalizeAssistQuery(active.query) === key) {
      updateAssistState({ ...active, query: trimmed, source: "explicit" });
      return;
    }
    runAssist(trimmed, "explicit");
  }, [runAssist, updateAssistState]);

  useEffect(() => {
    const trimmed = rootQuery.trim();
    const key = normalizeAssistQuery(trimmed);
    const active = assistStateRef.current;
    if (active.status !== "idle" && active.query !== trimmed) {
      // A spacing edit asks the same question, so the state stays.
      const sameQuestion = normalizeAssistQuery(active.query) === key;
      updateAssistState(sameQuestion ? { ...active, query: trimmed } : { status: "idle" });
    }
    if (handledQueryRef.current !== null && handledQueryRef.current !== key) {
      // Whatever is in flight describes text the user has already moved past.
      cancelPending();
      handledQueryRef.current = null;
    }

    if (!autoAsk || dismissedQueryRef.current === key) return;
    // An answer, a failure, or an in-flight ask for this question stands.
    if (handledQueryRef.current === key) return;
    const cached = answersRef.current.get(key);
    if (cached) {
      handledQueryRef.current = key;
      updateAssistState(answeredState(trimmed, "auto", cached));
      return;
    }
    if (Date.now() < rateLimitedUntilRef.current) return;

    const debounce = setTimeout(() => {
      // A cleared timer can already be queued. Only the timer still owned by
      // this effect may start a request.
      if (debounceRef.current !== debounce) return;
      debounceRef.current = null;
      runAssist(trimmed, "auto");
    }, ASSIST_DEBOUNCE_MS);
    debounceRef.current = debounce;
    return () => {
      clearTimeout(debounce);
      if (debounceRef.current === debounce) debounceRef.current = null;
    };
  }, [autoAsk, cancelPending, rootQuery, runAssist, updateAssistState]);

  useEffect(() => cancelPending, [cancelPending]);

  const searchIdFor = useCallback((query: string) => (
    answersRef.current.get(normalizeAssistQuery(query))?.searchId
  ), []);

  return {
    assistActive: dismissedQueryRef.current !== normalizeAssistQuery(rootQuery),
    assistState,
    askAssist,
    resetAssist,
    searchIdFor,
  };
}
