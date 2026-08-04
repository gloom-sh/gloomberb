import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  type AssistCommandCandidate,
  type AssistCommandDescriptor,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { AssistErrorKind, AssistRequestSource, AssistRequestState } from "./model";

/** Quiet period after the last keystroke before the query is sent. */
const ASSIST_DEBOUNCE_MS = 600;
/** How long background asks stay off after the server rate-limits us. */
const ASSIST_RATE_LIMIT_BACKOFF_MS = 60_000;

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
 */
export function useCommandBarAssist({
  autoAsk,
  getInventory,
  rootQuery,
}: {
  /** Whether this query qualifies for a background ask right now. */
  autoAsk: boolean;
  getInventory: () => AssistCommandDescriptor[];
  rootQuery: string;
}): {
  /** False once Esc has dismissed the section for the query still in the bar. */
  assistActive: boolean;
  assistState: AssistRequestState;
  askAssist: () => void;
  resetAssist: () => boolean;
} {
  const [assistState, setAssistState] = useState<AssistRequestState>({ status: "idle" });
  const assistStateRef = useRef(assistState);
  assistStateRef.current = assistState;
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(new Map<string, AssistCommandCandidate[]>());
  /**
   * The query the runtime has already acted on, updated the moment a request
   * starts. Rendered state lags a tick behind, and reading it instead would let
   * a re-render slip a second debounce past an ask that is already in flight.
   */
  const handledQueryRef = useRef<string | null>(null);
  /** Query the user dismissed with Esc; the section stays gone until it changes. */
  const dismissedQueryRef = useRef<string | null>(null);
  /** Query the user asked for themselves, so its failures are worth a row. */
  const explicitQueryRef = useRef<string | null>(null);
  const rateLimitedUntilRef = useRef(0);
  const rootQueryRef = useRef(rootQuery);
  rootQueryRef.current = rootQuery;
  const getInventoryRef = useRef(getInventory);
  getInventoryRef.current = getInventory;

  const cancelPending = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetAssist = useCallback((): boolean => {
    const active = assistStateRef.current;
    // Background rows are ambient: Esc belongs to whoever is listening next.
    if (active.status === "idle" || active.source === "auto") return false;
    cancelPending();
    dismissedQueryRef.current = active.query;
    setAssistState({ status: "idle" });
    return true;
  }, [cancelPending]);

  const runAssist = useCallback((query: string, source: AssistRequestSource) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    cancelPending();
    handledQueryRef.current = trimmed;
    // A background ask the user has since claimed answers to them, not to the
    // debounce, so its outcome is reported rather than swallowed.
    const resolveSource = (): AssistRequestSource => (
      explicitQueryRef.current === trimmed ? "explicit" : source
    );

    const cached = answersRef.current.get(trimmed);
    if (cached) {
      setAssistState({ status: "answered", query: trimmed, source: resolveSource(), candidates: cached });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setAssistState({ status: "loading", query: trimmed, source: resolveSource() });

    void (async () => {
      try {
        const response = await apiClient.assistCommand(trimmed, getInventoryRef.current(), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const candidates = response?.candidates ?? [];
        answersRef.current.set(trimmed, candidates);
        setAssistState({ status: "answered", query: trimmed, source: resolveSource(), candidates });
      } catch (error) {
        if (controller.signal.aborted) return;
        const kind = classifyAssistError(error);
        if (kind === "rate-limited") {
          rateLimitedUntilRef.current = Date.now() + ASSIST_RATE_LIMIT_BACKOFF_MS;
        }
        setAssistState({ status: "error", query: trimmed, source: resolveSource(), kind });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
  }, [cancelPending]);

  const askAssist = useCallback(() => {
    const trimmed = rootQueryRef.current.trim();
    if (!trimmed) return;
    explicitQueryRef.current = trimmed;
    const active = assistStateRef.current;
    // The background ask already on the wire asks this exact question; asking
    // again would only abort it and start the wait over.
    if (active.status === "loading" && active.query === trimmed) {
      setAssistState({ ...active, source: "explicit" });
      return;
    }
    runAssist(trimmed, "explicit");
  }, [runAssist]);

  useEffect(() => {
    const trimmed = rootQuery.trim();
    const active = assistStateRef.current;
    if (active.status !== "idle" && active.query !== trimmed) {
      setAssistState({ status: "idle" });
    }
    if (handledQueryRef.current !== null && handledQueryRef.current !== trimmed) {
      // Whatever is in flight describes text the user has already moved past.
      cancelPending();
      handledQueryRef.current = null;
    }

    if (!autoAsk || dismissedQueryRef.current === trimmed) return;
    // An answer, a failure, or an in-flight ask for this exact text stands.
    if (handledQueryRef.current === trimmed) return;
    const cached = answersRef.current.get(trimmed);
    if (cached) {
      handledQueryRef.current = trimmed;
      setAssistState({ status: "answered", query: trimmed, source: "auto", candidates: cached });
      return;
    }
    if (Date.now() < rateLimitedUntilRef.current) return;

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      runAssist(trimmed, "auto");
    }, ASSIST_DEBOUNCE_MS);
    return () => {
      if (!debounceRef.current) return;
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [autoAsk, cancelPending, rootQuery, runAssist]);

  useEffect(() => cancelPending, [cancelPending]);

  return {
    assistActive: dismissedQueryRef.current !== rootQuery.trim(),
    assistState,
    askAssist,
    resetAssist,
  };
}
