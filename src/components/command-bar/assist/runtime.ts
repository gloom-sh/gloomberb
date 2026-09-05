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
  const answersRef = useRef(new Map<string, AssistCommandCandidate[]>());
  /** Query the runtime has already acted on, updated when a request starts. */
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
    dismissedQueryRef.current = active.query;
    updateAssistState({ status: "idle" });
    return true;
  }, [cancelPending, updateAssistState]);

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
      updateAssistState({ status: "answered", query: trimmed, source: resolveSource(), candidates: cached });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    updateAssistState({ status: "loading", query: trimmed, source: resolveSource() });

    void (async () => {
      try {
        const response = await apiClient.assistCommand(trimmed, getInventoryRef.current(), {
          signal: controller.signal,
        });
        if (controller.signal.aborted || abortRef.current !== controller) return;
        const candidates = response?.candidates ?? [];
        answersRef.current.set(trimmed, candidates);
        updateAssistState({ status: "answered", query: trimmed, source: resolveSource(), candidates });
      } catch (error) {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        const kind = classifyAssistError(error);
        if (kind === "rate-limited") {
          rateLimitedUntilRef.current = Date.now() + ASSIST_RATE_LIMIT_BACKOFF_MS;
        }
        updateAssistState({ status: "error", query: trimmed, source: resolveSource(), kind });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
  }, [cancelPending, updateAssistState]);

  const askAssist = useCallback(() => {
    const trimmed = rootQueryRef.current.trim();
    if (!trimmed) return;
    explicitQueryRef.current = trimmed;
    const active = assistStateRef.current;
    // The background ask already on the wire asks this exact question; asking
    // again would only abort it and start the wait over.
    if (active.status === "loading" && active.query === trimmed) {
      updateAssistState({ ...active, source: "explicit" });
      return;
    }
    runAssist(trimmed, "explicit");
  }, [runAssist, updateAssistState]);

  useEffect(() => {
    const trimmed = rootQuery.trim();
    const active = assistStateRef.current;
    if (active.status !== "idle" && active.query !== trimmed) {
      updateAssistState({ status: "idle" });
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
      updateAssistState({ status: "answered", query: trimmed, source: "auto", candidates: cached });
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

  return {
    assistActive: dismissedQueryRef.current !== rootQuery.trim(),
    assistState,
    askAssist,
    resetAssist,
  };
}
