import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiClient } from "../../../api-client";
import { isPermanentClientError } from "../../../api-client/errors";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy } from "../../../data/pane-saved-copies";
import type {
  BuildoutCompany,
  BuildoutList,
  BuildoutLoadState,
  BuildoutTabId,
} from "./model/types";
import {
  PAGE_SIZE,
  emptyPage,
  fetchCompaniesPage,
  fetchIntelPage,
  fetchSitesPage,
  getBuildoutProToken,
  loadBuildoutData,
} from "./model";
import { appendUniqueById } from "./format";
import { boardThemes, resolveBoardTheme } from "./pane/themes";

/** How long the board rests on a theme before its companies load. */
const THEME_SETTLE_MS = 180;

type BuildoutReady = Extract<BuildoutLoadState, { status: "ready" }>;
type PublicBoard = Pick<BuildoutReady, "lists" | "sites" | "intel">;
const PUBLIC_BOARD = { key: ["buildout", "anonymous", "board", PAGE_SIZE] };
const publicCompanies = (slug: string) => ({ key: ["buildout", "anonymous", "companies", slug, PAGE_SIZE] });

function openingBoard(publicAccess: boolean, activeTab: BuildoutTabId, openedList: BuildoutList | null, themeSlug: string | null): BuildoutLoadState {
  const saved = publicAccess ? readSavedCopy<PublicBoard>(PUBLIC_BOARD) : null;
  if (!saved) return { status: "loading" };
  const list = activeTab === "themes" ? resolveBoardTheme(boardThemes(saved.value.lists), themeSlug) : openedList;
  const companyPage = list && readSavedCopy<BuildoutReady["companies"]>(publicCompanies(list.slug));
  return {
    status: "ready", access: "free", token: null, ...saved.value,
    companies: companyPage ? { ...companyPage.value, savedAt: companyPage.fetchedAt } : { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0, listSlug: null },
    loadedAt: saved.fetchedAt, savedAt: saved.fetchedAt, refreshing: true,
  };
}

interface UseBuildoutDataRuntimeOptions {
  activeTab: BuildoutTabId;
  onBeforeLoad: () => void;
  selectedList: BuildoutList | null;
  /** The theme the Themes board is on, as the pane saved it. */
  themeSlug: string | null;
}

export function useBuildoutDataRuntime({
  activeTab,
  onBeforeLoad,
  selectedList: openedList,
  themeSlug,
}: UseBuildoutDataRuntimeOptions): {
  loadCompanies: (list: BuildoutList, offset: number, append: boolean) => void;
  loadIntel: (offset: number, append: boolean) => void;
  loadSites: (offset: number, append: boolean) => void;
  refresh: () => void;
  resetCompanies: () => void;
  setState: Dispatch<SetStateAction<BuildoutLoadState>>;
  state: BuildoutLoadState;
} {
  const scope = useCloudDisplayScope();
  const publicAccess = !apiClient.isSignedIn();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const loadingPageKeysRef = useRef<Set<string>>(new Set());
  const [owner, setOwner] = useState(scope);
  const [current, setState] = useState<BuildoutLoadState>(() => openingBoard(publicAccess, activeTab, openedList, themeSlug));
  if (owner !== scope) {
    setOwner(scope);
    setState(openingBoard(publicAccess, activeTab, openedList, themeSlug));
  }
  const state: BuildoutLoadState = owner === scope ? current : { status: "loading" };
  const boardList = state.status === "ready" && activeTab === "themes" ? resolveBoardTheme(boardThemes(state.lists), themeSlug) : openedList;
  const savedCompanies = state.status === "ready" && boardList?.slug === state.companies.listSlug ? state.companies : null;
  useSavedCopyFooter(state.status === "ready" ? state.savedAt ?? savedCompanies?.savedAt : null,
    state.status === "ready" && (state.refreshing === true || savedCompanies?.loadingMore === true));
  const [refreshVersion, setRefreshVersion] = useState(0);

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      loadingPageKeysRef.current = new Set();
      // A refresh keeps what is loaded; only the first load replaces the body.
      setState((current) => current.status === "ready"
        ? { ...current, refreshing: true, refreshError: null }
        : { status: "loading" });

      // A refresh the user pressed asks for access again: a plan bought or ended since shows at once.
      const token = await getBuildoutProToken({ fresh: refreshVersion > 0 });
      const data = await loadBuildoutData(token);
      if (!cancelled && scopeRef.current === scope) {
        const loadedAt = Date.now();
        if (publicAccess && data.access === "free") {
          const board: PublicBoard = { lists: data.lists, sites: data.sites, intel: data.intel };
          writeSavedCopy(PUBLIC_BOARD, board, loadedAt);
        }
        if (refreshVersion > 0) onBeforeLoad();
        setState((previous) => ({
          status: "ready",
          ...data,
          companies: previous.status === "ready" && previous.access === data.access && previous.savedAt != null
            ? previous.companies : data.companies,
          loadedAt,
        }));
      }
    }

    load().catch((error) => {
      if (cancelled || scopeRef.current !== scope) return;
      const message = error instanceof Error ? error.message : String(error);
      if (isPermanentClientError(error)) {
        if (publicAccess) deleteSavedCopy(PUBLIC_BOARD);
        setState({ status: "error", message });
        return;
      }
      setState((current) => current.status === "ready"
        ? { ...current, refreshing: false, refreshError: message }
        : { status: "error", message });
    });

    return () => {
      cancelled = true;
    };
  }, [onBeforeLoad, publicAccess, refreshVersion, scope]);

  // A page load nobody waits on: its failure lands in the page's `error`.
  const loadCompanies = useCallback((list: BuildoutList, offset: number, append: boolean) => {
    const pageKey = `companies:${list.slug}:${offset}`;
    const requests = loadingPageKeysRef.current;
    if (requests.has(pageKey)) return;
    requests.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    const savedKey = publicCompanies(list.slug);
    setState((current) => {
      if (current.status !== "ready") return current;
      return {
        ...current,
        companies: {
          ...(current.companies.listSlug === list.slug ? current.companies : { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0, listSlug: list.slug }),
          loadingMore: true,
          error: null,
        },
      };
    });

    fetchCompaniesPage(token, list.slug, offset).then((page) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      if (publicAccess && offset === 0) {
        const pageCopy: BuildoutReady["companies"] = {
          items: page.items, offset: page.items.length, hasMore: page.items.length >= PAGE_SIZE,
          loadingMore: false, error: null, blurredCompanyCount: page.blurredCompanyCount, listSlug: list.slug,
        };
        writeSavedCopy(savedKey, pageCopy);
      }
      setState((current) => {
        // A list closed or replaced since keeps the answer out.
        if (current.status !== "ready" || current.companies.listSlug !== list.slug) return current;
        const previousItems = append ? current.companies.items : [];
        const items = appendUniqueById(previousItems, page.items);
        return {
          ...current,
          companies: {
            items,
            offset: items.length,
            hasMore: page.items.length >= PAGE_SIZE,
            loadingMore: false,
            error: null,
            blurredCompanyCount: append
              ? Math.max(current.companies.blurredCompanyCount, page.blurredCompanyCount)
              : page.blurredCompanyCount,
            listSlug: list.slug,
          },
        };
      });
    }).catch((error: unknown) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      if (publicAccess && isPermanentClientError(error)) deleteSavedCopy(savedKey);
      setState((current) => {
        if (current.status !== "ready" || current.companies.listSlug !== list.slug) return current;
        return {
          ...current,
          companies: {
            ...(isPermanentClientError(error)
              ? { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0, listSlug: list.slug }
              : current.companies),
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      });
    }).finally(() => {
      requests.delete(pageKey);
    });
  }, [publicAccess, scope, state]);

  const loadSites = useCallback((offset: number, append: boolean) => {
    const pageKey = `sites:${offset}`;
    const requests = loadingPageKeysRef.current;
    if (requests.has(pageKey)) return;
    requests.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    setState((current) => current.status === "ready"
      ? { ...current, sites: { ...current.sites, loadingMore: true, error: null } }
      : current);

    fetchSitesPage(token, offset).then((page) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      setState((current) => {
        if (current.status !== "ready") return current;
        const previousItems = append ? current.sites.items : [];
        const items = appendUniqueById(previousItems, page);
        return {
          ...current,
          sites: {
            items,
            offset: items.length,
            hasMore: page.length >= PAGE_SIZE,
            loadingMore: false,
            error: null,
          },
        };
      });
    }).catch((error: unknown) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      setState((current) => current.status === "ready"
        ? {
          ...current,
          sites: {
            ...current.sites,
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }
        : current);
    }).finally(() => {
      requests.delete(pageKey);
    });
  }, [scope, state]);

  const loadIntel = useCallback((offset: number, append: boolean) => {
    const pageKey = `intel:${offset}`;
    const requests = loadingPageKeysRef.current;
    if (requests.has(pageKey)) return;
    requests.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    setState((current) => current.status === "ready"
      ? { ...current, intel: { ...current.intel, loadingMore: true, error: null } }
      : current);

    fetchIntelPage(token, offset).then((page) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      setState((current) => {
        if (current.status !== "ready") return current;
        const previousItems = append ? current.intel.items : [];
        const items = appendUniqueById(previousItems, page);
        return {
          ...current,
          intel: {
            items,
            offset: items.length,
            hasMore: page.length >= PAGE_SIZE,
            loadingMore: false,
            error: null,
          },
        };
      });
    }).catch((error: unknown) => {
      if (scopeRef.current !== scope || loadingPageKeysRef.current !== requests) return;
      setState((current) => current.status === "ready"
        ? {
          ...current,
          intel: {
            ...current.intel,
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }
        : current);
    }).finally(() => {
      requests.delete(pageKey);
    });
  }, [scope, state]);

  // The open list's companies, once; the Themes board waits for the pointer or the keys to settle on a theme.
  useEffect(() => {
    if (state.status !== "ready") return;
    const selectedList = activeTab === "themes" ? resolveBoardTheme(boardThemes(state.lists), themeSlug) : openedList;
    if ((activeTab !== "companies" && activeTab !== "themes") || !selectedList) return;
    // A list that answered with no company this account can see is loaded too (no more pages), not asked again.
    const { companies } = state;
    const loaded = companies.listSlug === selectedList.slug;
    if (companies.loadingMore && loaded) return;
    if (loaded && (companies.error || (companies.savedAt == null && (companies.items.length > 0 || !companies.hasMore)))) return;
    if (state.refreshing) return;
    if (activeTab === "companies") {
      loadCompanies(selectedList, 0, false);
      return;
    }
    const timer = setTimeout(() => loadCompanies(selectedList, 0, false), THEME_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [activeTab, loadCompanies, openedList, state, themeSlug]);

  const resetCompanies = useCallback(() => {
    setState((current) => current.status === "ready"
      ? {
        ...current,
        companies: { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0, listSlug: null },
      }
      : current);
  }, []);

  return {
    loadCompanies,
    loadIntel,
    loadSites,
    refresh,
    resetCompanies,
    setState,
    state,
  };
}
