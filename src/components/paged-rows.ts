import { useCallback, useEffect, useRef, useState } from "react";

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

export interface PagedRowsOptions<T> {
  /** Drops rows a later page repeats, as when new items land between two requests. */
  getId?: (row: T) => string;
  /**
   * Leave the previous loader's rows on screen until the new loader's first
   * page answers, for a search that refines as the user types. Without it a
   * new loader starts from an empty list.
   */
  keepPreviousRows?: boolean;
}

export interface PagedRows<T, P> {
  rows: T[];
  /** Every page loaded so far, first page first. */
  pages: P[];
  status: "idle" | "loading" | "loaded" | "error";
  /** The first page is in flight, on first load or on `reload()`. */
  loading: boolean;
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
  options: PagedRowsOptions<PageRow<P>> = {},
): PagedRows<PageRow<P>, P> {
  type T = PageRow<P>;
  const keepPreviousRows = options.keepPreviousRows === true;
  const [state, setState] = useState<PagedState<T, P>>(() => emptyState(loadPage, !!loadPage));
  const firstRequest = useRef<AbortController | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  // Read when a page lands so an inline getter cannot restart the list.
  const getIdRef = useRef(options.getId);
  getIdRef.current = options.getId;

  const load = useCallback(async (force: boolean) => {
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
    setState((current) => current.owner === loadPage || keepPreviousRows
      ? { ...current, loading: true, loadingMore: false, error: null, moreError: null }
      : emptyState(loadPage, true));
    try {
      const page = await loadPage({ offset: 0, signal: controller.signal, force });
      if (firstRequest.current !== controller) return;
      firstRequest.current = null;
      setState({
        owner: loadPage,
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
      setState((current) => ({
        ...(current.owner === loadPage ? current : emptyState<T, P>(loadPage, false)),
        hasMore: false,
        loading: false,
        error: toError(cause),
      }));
    }
  }, [keepPreviousRows, loadPage]);

  useEffect(() => {
    void load(false);
    return () => {
      firstRequest.current?.abort();
      firstRequest.current = null;
      moreRequest.current?.abort();
      moreRequest.current = null;
    };
  }, [load]);

  const owned = state.owner === loadPage;
  const loadMore = useCallback(() => {
    // The refs, not this render's state, say whether a request is in flight:
    // a reload and a scroll in the same tick must not page the list being replaced.
    if (!loadPage || !owned || !state.hasMore || firstRequest.current || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    const offset = state.nextOffset;
    setState((current) => ({ ...current, loadingMore: true, moreError: null }));
    void (async () => {
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
    })();
  }, [loadPage, owned, state.hasMore, state.nextOffset]);

  const reload = useCallback(() => { void load(true); }, [load]);

  // Before a new loader's effect runs, and while its first page loads, the
  // previous list is either hidden or (with keepPreviousRows) shown but inert.
  const view = owned ? state
    : !loadPage ? emptyState<T, P>(null, false)
      : keepPreviousRows ? { ...state, hasMore: false, loading: true, loadingMore: false, error: null, moreError: null }
        : emptyState<T, P>(loadPage, true);
  // Rows kept from a previous loader are a placeholder, not this loader's answer.
  const status = !owned && loadPage ? "loading"
    : view.error ? "error" : view.pages.length > 0 ? "loaded" : view.loading ? "loading" : "idle";
  return {
    rows: view.rows,
    pages: view.pages,
    status,
    loading: view.loading,
    error: view.error,
    loadingMore: view.loadingMore,
    moreError: view.moreError,
    hasMore: view.hasMore,
    loadMore,
    reload,
  };
}
