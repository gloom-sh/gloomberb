import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type AssistCommandDescriptor } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { AssistErrorKind, AssistRequestState } from "./model";

/** Maps a failed `/assist/command` call onto the row the user should see. */
function classifyAssistError(error: unknown): AssistErrorKind {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  if (status === 503) return "unavailable";
  if (status === 429) return "rate-limited";
  return "failed";
}

/**
 * Owns the `/assist/command` request for the root command-bar list. Nothing is
 * requested while typing: `askAssist` runs only when the user activates the
 * Ask AI row, and any edit to the query drops the answer it was about.
 */
export function useCommandBarAssist({ rootQuery }: { rootQuery: string }): {
  assistState: AssistRequestState;
  askAssist: (inventory: AssistCommandDescriptor[]) => void;
  resetAssist: () => boolean;
} {
  const [assistState, setAssistState] = useState<AssistRequestState>({ status: "idle" });
  const assistStateRef = useRef(assistState);
  assistStateRef.current = assistState;
  const abortRef = useRef<AbortController | null>(null);
  const rootQueryRef = useRef(rootQuery);
  rootQueryRef.current = rootQuery;

  const cancelPending = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetAssist = useCallback((): boolean => {
    if (assistStateRef.current.status === "idle") return false;
    cancelPending();
    setAssistState({ status: "idle" });
    return true;
  }, [cancelPending]);

  useEffect(() => {
    const active = assistStateRef.current;
    if (active.status === "idle" || active.query === rootQuery.trim()) return;
    cancelPending();
    setAssistState({ status: "idle" });
  }, [cancelPending, rootQuery]);

  useEffect(() => cancelPending, [cancelPending]);

  const askAssist = useCallback((inventory: AssistCommandDescriptor[]) => {
    const query = rootQueryRef.current.trim();
    if (!query) return;
    cancelPending();
    const controller = new AbortController();
    abortRef.current = controller;
    setAssistState({ status: "loading", query });

    void (async () => {
      try {
        const response = await apiClient.assistCommand(query, inventory, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAssistState({ status: "answered", query, candidates: response?.candidates ?? [] });
      } catch (error) {
        if (controller.signal.aborted) return;
        setAssistState({ status: "error", query, kind: classifyAssistError(error) });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
  }, [cancelPending]);

  return { assistState, askAssist, resetAssist };
}
