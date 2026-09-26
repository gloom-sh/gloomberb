import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  apiClient,
  type TeamCollection,
  type TeamCollectionEvent,
  type TeamCollectionItem,
} from "../../../../api-client";
import type { AppTickerRepositoryPort } from "../../../../core/app-service-ports";
import type { AppAction, AppState } from "../../../../core/state/app/types";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../../../state/app/context";
import type { TickerRecord } from "../../../../types/ticker";
import { debugLog } from "../../../../utils/debug-log";
import {
  applyMembership,
  blankTickerRecord,
  diffMembership,
  localMembership,
  parseCollectionRef,
  reconcileConfigCollections,
  teamCollectionLocalId,
} from "./collections";
import { teamStore } from "./store";

export interface TeamCollectionsHost {
  dispatch: (action: AppAction) => void;
  getState: () => AppState;
  persistConfig: (config: AppState["config"]) => void;
  tickerRepository: AppTickerRepositoryPort;
}

type KnownItems = Map<string, Map<string, TeamCollectionItem>>;

const OUTBOUND_DEBOUNCE_MS = 400;
const teamsLog = debugLog.createLogger("teams");

/**
 * Keeps team watchlists and paper portfolios in step with the server at the
 * item level. Inbound: the collection list and every item on start, then each
 * collection.updated frame. Outbound: any local membership change on a team
 * collection is pushed as an add, update, or remove. There are no revisions,
 * so the last known server set is what local edits are diffed against.
 */
export function useTeamCollectionsSync(host: Omit<TeamCollectionsHost, "dispatch" | "getState">): void {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const tickers = useAppSelector((state) => state.tickers);
  const teams = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot().teams,
  );
  const known = useRef<KnownItems>(new Map());
  const collectionsRef = useRef<Map<string, TeamCollection>>(new Map());
  const applying = useRef(false);
  const outboundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveTicker = async (ticker: TickerRecord) => {
    await host.tickerRepository.saveTicker(ticker);
    dispatch({ type: "UPDATE_TICKER", ticker });
  };

  const applyItem = async (collection: TeamCollection, symbol: string, exchange: string, item: TeamCollectionItem | null) => {
    const localId = teamCollectionLocalId(collection.teamId, collection.id);
    const current = stateRef.current.tickers;
    let ticker = current.get(symbol) ?? (await host.tickerRepository.loadTicker(symbol));
    if (!ticker) {
      if (!item) return;
      ticker = await host.tickerRepository.createTicker(blankTickerRecord(symbol, exchange, collection.currency ?? "USD").metadata);
    }
    const next = applyMembership(ticker, localId, collection.kind, item, collection.currency ?? "USD");
    if (next) await saveTicker(next);
  };

  const applyCollections = async (teamIds: string[], collections: TeamCollection[]) => {
    applying.current = true;
    try {
      const state = stateRef.current;
      const nextConfig = reconcileConfigCollections(state.config, teamIds, collections);
      if (nextConfig !== state.config) {
        dispatch({ type: "SET_CONFIG", config: nextConfig });
        host.persistConfig(nextConfig);
      }
      // Collections that disappeared upstream release their local members.
      for (const [localId, previous] of collectionsRef.current) {
        if (collections.some((entry) => teamCollectionLocalId(entry.teamId, entry.id) === localId)) continue;
        if (!teamIds.includes(previous.teamId)) continue;
        for (const [symbol] of localMembership(stateRef.current.tickers, localId, previous.kind)) {
          await applyItem(previous, symbol, "", null);
        }
        collectionsRef.current.delete(localId);
        known.current.delete(localId);
      }
      for (const collection of collections) {
        const localId = teamCollectionLocalId(collection.teamId, collection.id);
        collectionsRef.current.set(localId, collection);
        const detail = await apiClient.getTeamCollection(collection.teamId, collection.id).catch(() => null);
        if (!detail) continue;
        const items = new Map(detail.items.map((item) => [item.symbol, item]));
        known.current.set(localId, items);
        for (const item of detail.items) await applyItem(collection, item.symbol, item.exchange, item);
        for (const [symbol] of localMembership(stateRef.current.tickers, localId, collection.kind)) {
          if (!items.has(symbol)) await applyItem(collection, symbol, "", null);
        }
      }
    } finally {
      applying.current = false;
    }
  };

  const refresh = async () => {
    if (!apiClient.isVerified()) return;
    const currentTeams = teamStore.getSnapshot().teams;
    const teamIds = currentTeams.map((team) => team.id);
    const lists = await Promise.all(currentTeams.map((team) => apiClient.listTeamCollections(team.id).catch(() => [] as TeamCollection[])));
    await applyCollections(teamIds, lists.flat());
  };

  const applyEvent = async (event: TeamCollectionEvent) => {
    if (event.change === "created" || event.change === "updated") {
      collectionsRef.current.set(teamCollectionLocalId(event.teamId, event.collection.id), event.collection);
      const all = [...collectionsRef.current.values()].filter((entry) => entry.teamId === event.teamId);
      applying.current = true;
      try {
        const state = stateRef.current;
        const nextConfig = reconcileConfigCollections(state.config, [event.teamId], all);
        if (nextConfig !== state.config) {
          dispatch({ type: "SET_CONFIG", config: nextConfig });
          host.persistConfig(nextConfig);
        }
      } finally {
        applying.current = false;
      }
      if (event.change === "created") known.current.set(teamCollectionLocalId(event.teamId, event.collection.id), new Map());
      return;
    }
    if (event.change === "deleted") {
      const localId = teamCollectionLocalId(event.teamId, event.collectionId);
      const previous = collectionsRef.current.get(localId);
      if (!previous) return;
      const remaining = [...collectionsRef.current.values()].filter((entry) => entry.teamId === event.teamId && entry.id !== event.collectionId);
      await applyCollections([event.teamId], remaining);
      return;
    }
    const localId = teamCollectionLocalId(event.teamId, event.collectionId);
    const collection = collectionsRef.current.get(localId);
    if (!collection) return;
    const items = known.current.get(localId) ?? new Map<string, TeamCollectionItem>();
    known.current.set(localId, items);
    applying.current = true;
    try {
      if (event.change === "item-removed") {
        items.delete(event.item.symbol);
        await applyItem(collection, event.item.symbol, event.item.exchange, null);
      } else {
        items.set(event.item.symbol, event.item);
        await applyItem(collection, event.item.symbol, event.item.exchange, event.item);
      }
    } finally {
      applying.current = false;
    }
  };

  const pushOutbound = async () => {
    if (applying.current || !apiClient.isVerified()) return;
    for (const [localId, collection] of collectionsRef.current) {
      const ref = parseCollectionRef(localId);
      if (ref.scope !== "team") continue;
      const items = known.current.get(localId);
      if (!items) continue;
      const local = localMembership(stateRef.current.tickers, localId, collection.kind);
      const diff = diffMembership(local, items);
      for (const entry of diff.add) {
        const ticker = local.get(entry.symbol)?.ticker;
        try {
          const item = await apiClient.putTeamCollectionItem(collection.teamId, collection.id, {
            symbol: entry.symbol,
            exchange: ticker?.metadata.exchange ?? null,
            ...(collection.kind === "portfolio" ? { quantity: entry.quantity } : {}),
          });
          items.set(item.symbol, item);
        } catch (error) {
          teamsLog.error("Could not add to a team collection", { symbol: entry.symbol, error: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const symbol of diff.remove) {
        const item = items.get(symbol);
        try {
          await apiClient.removeTeamCollectionItem(collection.teamId, collection.id, symbol, item?.exchange ?? "");
          items.delete(symbol);
        } catch (error) {
          teamsLog.error("Could not remove from a team collection", { symbol, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  };

  const teamKey = teams.map((team) => team.id).join(",");
  useEffect(() => {
    void refresh();
    const unsubscribeUser = apiClient.subscribeCurrentUser(() => {
      void refresh();
    });
    const unsubscribeEvents = apiClient.subscribeCloudEvent("collection.updated", (data) => {
      void applyEvent(data as TeamCollectionEvent);
    });
    return () => {
      unsubscribeUser();
      unsubscribeEvents();
    };
    // Team membership drives which collections to follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey]);

  useEffect(() => {
    if (outboundTimer.current) clearTimeout(outboundTimer.current);
    outboundTimer.current = setTimeout(() => {
      outboundTimer.current = null;
      void pushOutbound();
    }, OUTBOUND_DEBOUNCE_MS);
    return () => {
      if (outboundTimer.current) clearTimeout(outboundTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers]);
}
