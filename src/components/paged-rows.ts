import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSavedCopyFooter } from "./layout/pane/footer/registration";
import { afterSavedCopyFrame, deleteSavedCopy, readSavedCopy, savedCopyId, writeSavedCopy, type SavedCopy, type SavedCopyKey } from "../data/pane-saved-copies";
import { isPermanentClientError } from "../api-client/errors";
import { logFailure } from "../utils/log-failure";

/** One page of an offset-paged source. Extra fields (an as-of date, warnings) stay on `pages`. */
export interface RowPage<T> {
  rows: T[];
  hasMore?: boolean;
  /** Where the next page starts. Omitted, it is this page's offset plus the rows it returned. */
  nextOffset?: number | null;
}

export interface PageRequest {
  offset: number;
  /** Aborted once the answer can no longer be shown: a newer query, a reload, or unmount. */
  signal: AbortSignal;
  /** Set on the first page of a `reload()`, for loaders that sit behind a cache. */
  force: boolean;
}

export type PageLoader<P> = (request: PageRequest) => Promise<P>;

/** The row type of a page, so callers write only the loader and get typed rows. */
type PageRow<P> = P extends RowPage<infer T> ? T : never;

export interface PagedRowsOptions<T, P = RowPage<T>> {
  /** Drops rows a later page repeats, as when new items land between two requests. */
  getId?: (row: T) => string;
  /**
   * Leave the previous loader's rows on screen until the new loader's first
   * page answers, for a search that refines as the user types. Without it a
   * new loader starts from an empty list.
   */
  keepPreviousRows?: boolean;
  /**
   * The key the first page is saved under: everything it depends on. The list
   * opens on that page at once, of any age, and loads behind it; a failed
   * load keeps it as a failed reload does (data/pane-saved-copies.ts).
   */
  savedCopy?: SavedCopyKey | null;
  snapshotPage?: (page: P) => P;
}

export interface PagedRows<T, P> {
  rows: T[];
  /** Every page loaded so far, first page first. */
  pages: P[];
  status: "idle" | "loading" | "loaded" | "error";
  /** The first page is in flight and does not have a saved copy. */
  loading: boolean;
  refreshing: boolean;
  /** The first page failed. A failed reload keeps the rows it had. */
  error: Error | null;
  loadingMore: boolean;
  /** The last later page failed. Its rows stay, and the next `loadMore()` asks again. */
  moreError: Error | null;
  hasMore: boolean;
  /** Appends the next page. A no-op while a page is in flight or nothing is left. */
  loadMore: () => void;
  /** Asks for the first page again with `force`, keeping the rows until it answers. */
  reload: () => void;
}

interface PagedState<T, P> {
  /** The loader these pages came from. */
  owner: unknown;
  /** The saved-copy key of the question they answer: a new loader for the same key keeps them while it loads. */
  ownerKey?: string | null;
  savedAt?: number;
  placeholder?: true;
  pages: P[];
  rows: T[];
  nextOffset: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  moreError: Error | null;
}

// Shared so an empty list keeps one identity across renders and memoized
// sorts and selection effects downstream do not rerun for nothing.
const NONE: never[] = [];

function emptyState<T, P>(owner: unknown, loading: boolean): PagedState<T, P> {
  return { owner, pages: NONE, rows: NONE, nextOffset: 0, hasMore: false, loading, loadingMore: false, error: null, moreError: null };
}

/** A list opening on its saved first page, the first page loading behind it. */
function openingState<T, P extends RowPage<unknown>>(owner: unknown, copy: SavedCopy<P> | null): PagedState<T, P> {
  const saved = copy?.value;
  if (!saved || !Array.isArray(saved.rows) || saved.rows.length === 0) return emptyState(owner, true);
  return {
    owner, pages: [saved], rows: saved.rows as T[], nextOffset: saved.nextOffset ?? saved.rows.length,
    hasMore: saved.hasMore === true, loading: true, loadingMore: false, error: null, moreError: null, savedAt: copy.fetchedAt,
  };
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function appendRows<T>(current: T[], next: T[], getId: ((row: T) => string) | undefined): T[] {
  if (next.length === 0) return current;
  if (!getId) return [...current, ...next];
  const seen = new Set(current.map(getId));
  const merged = [...current];
  for (const row of next) {
    const id = getId(row);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
  }
  return merged;
}

/**
 * An offset-paged list: the first page, later pages appended on demand, and
 * their loading and failure state. Pair `loadMore` with `useTableLoadMore`.
 * Like `useAsyncResource`, a stable loader owns the list: a new loader (a new
 * query or filter) aborts what is in flight and starts over, and null clears
 * it. Answers from a superseded request are ignored.
 */
export function usePagedRows<P extends RowPage<unknown>>(
  loadPage: PageLoader<P> | null,
  options: PagedRowsOptions<PageRow<P>, P> = {},
): PagedRows<PageRow<P>, P> {
  type T = PageRow<P>;
  const keepPreviousRows = options.keepPreviousRows === true;
  const requestedKey = loadPage ? options.savedCopy ?? null : null;
  const savedId = requestedKey ? `${savedCopyId(requestedKey)}#${requestedKey.version ?? 1}` : null;
  const savedKey = useMemo(() => requestedKey, [savedId]);
  const open = (): PagedState<T, P> => loadPage
    ? { ...openingState<T, P>(loadPage, savedKey ? readSavedCopy<P>(savedKey) : null), ownerKey: savedId }
    : emptyState(null, false);
  const [state, setState] = useState(open);
  let view = state;
  if (state.owner !== loadPage || (state.ownerKey ?? null) !== savedId) {
    const sameQuestion = savedId !== null && state.ownerKey === savedId;
    const opening = sameQuestion ? state : open();
    const retainAsPlaceholder = !!loadPage && keepPreviousRows && !sameQuestion && state.pages.length > 0 && opening.pages.length === 0;
    view = sameQuestion || retainAsPlaceholder
      ? { ...state, owner: loadPage, ownerKey: savedId, hasMore: false, loading: true, loadingMore: false, error: null, moreError: null,
        placeholder: retainAsPlaceholder ? true : state.placeholder }
      : opening;
    setState(view);
  }
  const firstRequest = useRef<AbortController | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  // Read when a page lands so an inline getter cannot restart the list.
  const getIdRef = useRef(options.getId);
  getIdRef.current = options.getId;
  const snapshotPageRef = useRef(options.snapshotPage);
  snapshotPageRef.current = options.snapshotPage;

  const fetchFirst = useCallback(async (force: boolean) => {
    firstRequest.current?.abort();
    moreRequest.current?.abort();
    moreRequest.current = null;
    if (!loadPage) {
      firstRequest.current = null;
      setState(emptyState(null, false));
      return;
    }
    const controller = new AbortController();
    firstRequest.current = controller;
    const key = savedKey;
    const keyId = savedId;
    setState((current) => current.owner === loadPage && (current.ownerKey ?? null) === keyId
      && (!current.loading || current.loadingMore || current.error !== null || current.moreError !== null)
      ? { ...current, loading: true, loadingMore: false, error: null, moreError: null }
      : current);
    try {
      const page = await loadPage({ offset: 0, signal: controller.signal, force });
      if (firstRequest.current !== controller) return;
      firstRequest.current = null;
      if (key) writeSavedCopy(key, page.rows.length > 0 ? (snapshotPageRef.current?.(page) ?? page) : null);
      setState({
        owner: loadPage,
        ownerKey: keyId,
        pages: [page],
        rows: page.rows as T[],
        nextOffset: page.nextOffset ?? page.rows.length,
        hasMore: page.hasMore === true,
        loading: false,
        loadingMore: false,
        error: null,
        moreError: null,
      });
    } catch (cause) {
      if (firstRequest.current !== controller) return;
      firstRequest.current = null;
      const discard = key !== null && isPermanentClientError(cause);
      if (discard) deleteSavedCopy(key);
      setState((current) => ({
        ...(!discard && !current.placeholder && current.owner === loadPage && (current.ownerKey ?? null) === keyId
          ? current : { ...emptyState<T, P>(loadPage, false), ownerKey: keyId }),
        hasMore: false,
        loading: false,
        error: toError(cause),
      }));
    }
  }, [loadPage, savedId, savedKey]);
  // A load nobody waits on: its failures end in `error`, and anything else
  // that escapes is logged.
  const load = useCallback((force: boolean) => {
    fetchFirst(force).catch(logFailure("components.paged-rows", "First page load failed"));
  }, [fetchFirst]);

  useEffect(() => {
    let active = true;
    const frame = view.savedAt != null && !view.placeholder ? afterSavedCopyFrame() : undefined;
    if (frame) {
      void frame.then(() => {
        if (active && !firstRequest.current) load(false);
      }).catch(logFailure("components.paged-rows", "Refresh after the saved page failed"));
    } else load(false);
    return () => {
      active = false;
      firstRequest.current?.abort();
      firstRequest.current = null;
      moreRequest.current?.abort();
      moreRequest.current = null;
    };
  }, [load]);

  const loadMore = useCallback(() => {
    // The refs, not this render's state, say whether a request is in flight:
    // a reload and a scroll in the same tick must not page the list being replaced.
    if (!loadPage || !view.hasMore || view.loading || firstRequest.current || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    const offset = view.nextOffset;
    setState((current) => ({ ...current, loadingMore: true, moreError: null }));
    (async () => {
      try {
        const page = await loadPage({ offset, signal: controller.signal, force: false });
        if (moreRequest.current !== controller) return;
        moreRequest.current = null;
        setState((current) => ({
          ...current,
          pages: [...current.pages, page],
          rows: appendRows(current.rows, page.rows as T[], getIdRef.current),
          nextOffset: page.nextOffset ?? offset + page.rows.length,
          hasMore: page.hasMore === true,
          loadingMore: false,
        }));
      } catch (cause) {
        if (moreRequest.current !== controller) return;
        moreRequest.current = null;
        setState((current) => ({ ...current, loadingMore: false, moreError: toError(cause) }));
      }
    })().catch(logFailure("components.paged-rows", "Next page load failed"));
  }, [loadPage, view.hasMore, view.loading, view.nextOffset]);

  const reload = useCallback(() => load(true), [load]);

  const status = view.error ? "error" : view.placeholder ? "loading" : view.pages.length > 0 ? "loaded" : view.loading ? "loading" : "idle";
  useSavedCopyFooter(view.savedAt, view.loading);
  return {
    rows: view.rows,
    pages: view.pages,
    status,
    loading: view.loading && view.savedAt == null,
    refreshing: view.loading && view.pages.length > 0,
    error: view.error,
    loadingMore: view.loadingMore,
    moreError: view.moreError,
    hasMore: view.hasMore,
    loadMore,
    reload,
  };
}
