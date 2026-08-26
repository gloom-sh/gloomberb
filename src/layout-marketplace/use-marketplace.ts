import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api-client";
import type { LayoutConfig } from "../types/config";
import {
  publishableMarketplaceLayout,
  type LayoutMarketplaceEntry,
} from "./payload";

export type LayoutMarketplaceState =
  | { status: "signed-out"; items: [] }
  | { status: "idle"; items: LayoutMarketplaceEntry[] }
  | { status: "loading"; items: LayoutMarketplaceEntry[] }
  | { status: "ready"; items: LayoutMarketplaceEntry[] }
  | { status: "error"; items: LayoutMarketplaceEntry[]; error: string };

export interface LayoutMarketplaceRuntime {
  state: LayoutMarketplaceState;
  refresh: () => void;
  publish: (name: string, layout: LayoutConfig) => Promise<LayoutMarketplaceEntry>;
}

export function useLayoutMarketplace(active: boolean, signedIn: boolean): LayoutMarketplaceRuntime {
  const [state, setState] = useState<LayoutMarketplaceState>(() => (
    signedIn ? { status: "idle", items: [] } : { status: "signed-out", items: [] }
  ));
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!signedIn) {
      setState({ status: "signed-out", items: [] });
      return;
    }
    if (!active) {
      setState((current) => current.status === "signed-out" ? { status: "idle", items: [] } : current);
      return;
    }

    const controller = new AbortController();
    setState((current) => ({ status: "loading", items: current.items }));
    void apiClient.listMarketplaceLayouts({ signal: controller.signal })
      .then((items) => setState({ status: "ready", items }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          status: "error",
          items: current.items,
          error: error instanceof Error ? error.message : "Could not load layouts.",
        }));
      });
    return () => controller.abort();
  }, [active, revision, signedIn]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const publish = useCallback(async (name: string, layout: LayoutConfig) => {
    const item = await apiClient.publishMarketplaceLayout(name, publishableMarketplaceLayout(layout));
    setState((current) => ({
      status: "ready",
      items: [item, ...current.items.filter((candidate) => candidate.id !== item.id)].slice(0, 50),
    }));
    return item;
  }, []);

  return { state, refresh, publish };
}
