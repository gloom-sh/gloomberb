import { useCallback, useEffect, useState } from "react";
import type { DocsFeed, DocsLesson } from "../../../docs/content";
import { loadDocsFeed, loadDocsLesson, savedDocsFeed, savedDocsLesson } from "../../../docs/load";

export interface DocsFeedState {
  /** Null only until the shipped copy has loaded, a moment on first open. */
  feed: DocsFeed | null;
  /** The site could not be read; the reader shows the saved or shipped copy. */
  offline: boolean;
  reload: () => void;
}

export function useDocsFeed(): DocsFeedState {
  const [state, setState] = useState<{ feed: DocsFeed | null; offline: boolean }>(() => ({ feed: savedDocsFeed(), offline: false }));
  const [request, setRequest] = useState({ force: false, token: 0 });
  useEffect(() => {
    let live = true;
    void loadDocsFeed({ force: request.force }).then((result) => {
      if (live) setState(result);
    });
    return () => {
      live = false;
    };
  }, [request]);
  const reload = useCallback(() => setRequest((current) => ({ force: true, token: current.token + 1 })), []);
  return { ...state, reload };
}

export type DocsLessonState =
  | { status: "loading"; lesson: null }
  | { status: "ready"; lesson: DocsLesson; offline: boolean }
  /** Never read here and the site cannot be reached. */
  | { status: "unavailable"; lesson: null };

export function useDocsLesson(url: string | null): DocsLessonState & { retry: () => void } {
  const [state, setState] = useState<DocsLessonState>(() => {
    const saved = url ? savedDocsLesson(url) : null;
    return saved ? { status: "ready", lesson: saved, offline: false } : { status: "loading", lesson: null };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const saved = savedDocsLesson(url);
    setState(saved ? { status: "ready", lesson: saved, offline: false } : { status: "loading", lesson: null });
    void loadDocsLesson(url, { force: attempt > 0 }).then(
      (result) => {
        if (live) setState({ status: "ready", lesson: result.lesson, offline: result.offline });
      },
      () => {
        if (live) setState({ status: "unavailable", lesson: null });
      },
    );
    return () => {
      live = false;
    };
  }, [url, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}
