import { useCallback, useEffect, useRef, useState } from "react";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { cloudCongressHousePath, type CloudCongressHouseParams } from "../../../api-client/paths";
import { type CloudCongressHousePayload } from "../../../api-client";
import { useAsyncResource } from "../../../react/async-resource";
import { writeSavedCopy } from "../../../data/pane-saved-copies";
import { loadCongressHouse } from "./client";
import { mergeCongressPages, type nextCongressPage } from "./model";
import { logFailure } from "../../../utils/log-failure";

export function useCongressFeed(request: CloudCongressHouseParams, memberId: string | null = null) {
  const scope = useCloudDisplayScope();
  const path = cloudCongressHousePath(request);
  const key = scope ? { key: ["congress-trades", scope, path, memberId] } : null;
  const previous = useRef<{ payload: CloudCongressHousePayload; owner: unknown } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pageController = useRef<AbortController | null>(null);
  const forceServerRefresh = useRef(false);
  const [page, setPage] = useState<{ first: CloudCongressHousePayload; payload: CloudCongressHousePayload } | null>(null);
  const [pageState, setPageState] = useState<{ first: CloudCongressHousePayload; error: string | null } | null>(null);
  const loader = useCallback(async (refresh: boolean): Promise<CloudCongressHousePayload> => {
    controller.current?.abort();
    pageController.current?.abort();
    pageController.current = null;
    setPageState(null);
    const current = new AbortController();
    controller.current = current;
    const refreshServer = refresh && forceServerRefresh.current;
    forceServerRefresh.current = false;
    const loaded = await loadCongressHouse(refreshServer ? { ...request, refresh: true } : request, undefined, current.signal);
    const last = previous.current;
    if (!current.signal.aborted) setPage(null);
    return refresh && last?.owner === loader
      ? { ...last.payload, asOf: loaded.asOf, fetchedAt: loaded.fetchedAt, trades: mergeCongressPages(last.payload, loaded).trades }
      : loaded;
  }, [path, scope, memberId]);
  useEffect(() => () => { controller.current?.abort(); pageController.current?.abort(); }, [loader]);

  const resource = useAsyncResource(loader, { savedCopy: key });
  const reload = useCallback(() => {
    forceServerRefresh.current = true;
    resource.reload();
  }, [resource.reload]);
  const autoReload = useCallback(() => {
    forceServerRefresh.current = false;
    resource.reload();
  }, [resource.reload]);
  const payload = resource.data && page?.first === resource.data ? page.payload : resource.data;
  previous.current = payload ? { payload, owner: loader } : null;
  const paging = pageState?.first === resource.data ? pageState : null;

  const loadPage = useCallback((next: ReturnType<typeof nextCongressPage>) => {
    const first = resource.data;
    if (!next || !first || !payload || resource.refreshing || pageController.current) return;
    const current = new AbortController();
    pageController.current = current;
    setPageState({ first, error: null });
    loadCongressHouse({ ...request, ...next }, undefined, current.signal)
      .then((loaded) => {
        if (current.signal.aborted) return;
        const merged = mergeCongressPages(payload, loaded);
        setPage({ first, payload: merged });
        if (key) writeSavedCopy(key, merged, resource.updatedAt ?? undefined);
      }, (error: unknown) => {
        if (!current.signal.aborted) setPageState({ first, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (pageController.current !== current) return;
        pageController.current = null;
        setPageState((state) => state?.first === first && state.error === null ? null : state);
      }).catch(logFailure("congress-trades.feed", "Could not load Congress trades page"));
  }, [path, scope, memberId, payload, resource.data, resource.refreshing, resource.updatedAt]);
  return { ...resource, reload, autoReload, payload, loadPage, loadingMore: !!paging && !paging.error, error: resource.error ?? paging?.error ?? null };
}
