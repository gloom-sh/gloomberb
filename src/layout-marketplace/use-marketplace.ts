import { useCallback, useEffect, useState } from "react";
import { apiClient, type TeamSummary } from "../api-client";
import type { CloudLayoutEntry } from "./cloud";
import { linkedLayoutUpdates } from "./linked";
import type {
  LayoutMarketplaceEntry,
  LayoutMarketplacePayload,
} from "../shares/portable-layout";

export type LayoutMarketplaceState =
  | { status: "signed-out"; items: [] }
  | { status: "idle"; items: LayoutMarketplaceEntry[] }
  | { status: "loading"; items: LayoutMarketplaceEntry[] }
  | { status: "ready"; items: LayoutMarketplaceEntry[] }
  | { status: "error"; items: LayoutMarketplaceEntry[]; error: string };

export interface LayoutMarketplaceRuntime {
  state: LayoutMarketplaceState;
  refresh: () => void;
  publish: (name: string, payload: LayoutMarketplacePayload) => Promise<LayoutMarketplaceEntry>;
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
  const publish = useCallback(async (name: string, payload: LayoutMarketplacePayload) => {
    const item = await apiClient.publishMarketplaceLayout(name, payload);
    setState((current) => ({
      status: "ready",
      items: [item, ...current.items.filter((candidate) => candidate.id !== item.id)].slice(0, 50),
    }));
    return item;
  }, []);

  return { state, refresh, publish };
}

export type TeamLayoutsState =
  | { status: "idle"; items: CloudLayoutEntry[] }
  | { status: "loading"; items: CloudLayoutEntry[] }
  | { status: "ready"; items: CloudLayoutEntry[] }
  | { status: "error"; items: CloudLayoutEntry[]; error: string };

export interface TeamLayoutsRuntime {
  state: TeamLayoutsState;
  refresh: () => void;
  /** Adds or replaces one entry after a publish, without a round trip. */
  upsert: (entry: CloudLayoutEntry) => void;
  remove: (layoutId: string) => void;
}

/**
 * Every team's layouts in one list. Each entry's revision is also recorded so
 * linked tabs learn about updates from the same fetch the gallery makes.
 */
export function useTeamLayouts(active: boolean, teams: readonly TeamSummary[]): TeamLayoutsRuntime {
  const [state, setState] = useState<TeamLayoutsState>({ status: "idle", items: [] });
  const [revision, setRevision] = useState(0);
  const teamKey = teams.map((team) => team.id).join(",");

  useEffect(() => {
    if (!active || teams.length === 0) {
      setState((current) => (teams.length === 0 ? { status: "idle", items: [] } : current));
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ status: "loading", items: current.items }));
    void Promise.all(teams.map((team) => apiClient.listTeamLayouts(team.id, { signal: controller.signal })))
      .then((lists) => {
        const items = lists.flat();
        for (const item of items) linkedLayoutUpdates.setRemoteRevision(item.id, item.revision);
        setState({ status: "ready", items });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          status: "error",
          items: current.items,
          error: error instanceof Error ? error.message : "Could not load team layouts.",
        }));
      });
    return () => controller.abort();
    // teamKey stands in for the team list identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revision, teamKey]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const upsert = useCallback((entry: CloudLayoutEntry) => {
    linkedLayoutUpdates.setRemoteRevision(entry.id, entry.revision);
    setState((current) => ({
      status: "ready",
      items: [entry, ...current.items.filter((candidate) => candidate.id !== entry.id)],
    }));
  }, []);
  const remove = useCallback((layoutId: string) => {
    linkedLayoutUpdates.forget(layoutId);
    setState((current) => ({ ...current, items: current.items.filter((candidate) => candidate.id !== layoutId) }));
  }, []);

  return { state, refresh, upsert, remove };
}
