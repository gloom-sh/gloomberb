import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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

interface UseBuildoutDataRuntimeOptions {
  activeTab: BuildoutTabId;
  onBeforeLoad: () => void;
  selectedList: BuildoutList | null;
}

export function useBuildoutDataRuntime({
  activeTab,
  onBeforeLoad,
  selectedList,
}: UseBuildoutDataRuntimeOptions): {
  loadCompanies: (list: BuildoutList, offset: number, append: boolean) => Promise<void>;
  loadIntel: (offset: number, append: boolean) => Promise<void>;
  loadSites: (offset: number, append: boolean) => Promise<void>;
  refresh: () => void;
  resetCompanies: () => void;
  setState: Dispatch<SetStateAction<BuildoutLoadState>>;
  state: BuildoutLoadState;
} {
  const loadingPageKeysRef = useRef<Set<string>>(new Set());
  const [state, setState] = useState<BuildoutLoadState>({ status: "loading" });
  const [refreshVersion, setRefreshVersion] = useState(0);

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      loadingPageKeysRef.current.clear();
      onBeforeLoad();
      // A refresh keeps what is loaded; only the first load replaces the body.
      setState((current) => current.status === "ready"
        ? { ...current, refreshing: true, refreshError: null }
        : { status: "loading" });

      const token = await getBuildoutProToken();
      const data = await loadBuildoutData(token);
      if (!cancelled) {
        setState({
          status: "ready",
          ...data,
          loadedAt: Date.now(),
        });
      }
    }

    load().catch((error) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => current.status === "ready"
        ? { ...current, refreshing: false, refreshError: message }
        : { status: "error", message });
    });

    return () => {
      cancelled = true;
    };
  }, [onBeforeLoad, refreshVersion]);

  const loadCompanies = useCallback(async (list: BuildoutList, offset: number, append: boolean) => {
    const pageKey = `companies:${list.slug}:${offset}`;
    if (loadingPageKeysRef.current.has(pageKey)) return;
    loadingPageKeysRef.current.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    setState((current) => {
      if (current.status !== "ready") return current;
      return {
        ...current,
        companies: {
          ...(append ? current.companies : { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0 }),
          loadingMore: true,
          error: null,
        },
      };
    });

    try {
      const page = await fetchCompaniesPage(token, list.slug, offset);
      setState((current) => {
        if (current.status !== "ready") return current;
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
          },
        };
      });
    } catch (error) {
      setState((current) => {
        if (current.status !== "ready") return current;
        return {
          ...current,
          companies: {
            ...current.companies,
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      });
    } finally {
      loadingPageKeysRef.current.delete(pageKey);
    }
  }, [state]);

  const loadSites = useCallback(async (offset: number, append: boolean) => {
    const pageKey = `sites:${offset}`;
    if (loadingPageKeysRef.current.has(pageKey)) return;
    loadingPageKeysRef.current.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    setState((current) => current.status === "ready"
      ? { ...current, sites: { ...current.sites, loadingMore: true, error: null } }
      : current);

    try {
      const page = await fetchSitesPage(token, offset);
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
    } catch (error) {
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
    } finally {
      loadingPageKeysRef.current.delete(pageKey);
    }
  }, [state]);

  const loadIntel = useCallback(async (offset: number, append: boolean) => {
    const pageKey = `intel:${offset}`;
    if (loadingPageKeysRef.current.has(pageKey)) return;
    loadingPageKeysRef.current.add(pageKey);
    const token = state.status === "ready" ? state.token : null;
    setState((current) => current.status === "ready"
      ? { ...current, intel: { ...current.intel, loadingMore: true, error: null } }
      : current);

    try {
      const page = await fetchIntelPage(token, offset);
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
    } catch (error) {
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
    } finally {
      loadingPageKeysRef.current.delete(pageKey);
    }
  }, [state]);

  useEffect(() => {
    if (state.status !== "ready" || activeTab !== "companies" || !selectedList) return;
    if (state.companies.items.length > 0 || state.companies.loadingMore || state.companies.error) return;
    void loadCompanies(selectedList, 0, false);
  }, [activeTab, loadCompanies, selectedList, state]);

  const resetCompanies = useCallback(() => {
    setState((current) => current.status === "ready"
      ? {
        ...current,
        companies: { ...emptyPage<BuildoutCompany>(), blurredCompanyCount: 0 },
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
