import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type TeamCollection, type TeamCollectionEvent, type TeamCollectionItem } from "../api-client";
import { appReducer, AppContext, createInitialState, type AppAction, type AppContextStoreValue } from "../state/app/context";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { createDefaultConfig, type AppConfig } from "../types/config";
import type { TickerRecord } from "../types/ticker";
import { useTeamCollectionsSync } from "./collections-sync";
import { blankTickerRecord, localMembership, teamCollectionLocalId } from "./collections";
import { teamStore } from "./store";
import { createTestTeam } from "./test-fixture";

const tui = createOpenTuiTestHarness();

function collection(teamId: string, id: string, name: string, overrides: Partial<TeamCollection> = {}): TeamCollection {
  return {
    id, teamId, kind: "watchlist", name, currency: null, createdBy: "u1",
    createdAt: "2026-09-14T12:00:00.000Z", updatedAt: "2026-09-14T12:00:00.000Z", itemCount: 0,
    ...overrides,
  };
}

function item(collectionId: string, symbol: string, quantity: number | null = null): TeamCollectionItem {
  return {
    collectionId, symbol, exchange: "NASDAQ", quantity, note: null, addedBy: "u1",
    addedAt: "2026-09-14T12:00:00.000Z", updatedAt: "2026-09-14T12:00:00.000Z",
  };
}

function createStore(config: AppConfig): AppContextStoreValue {
  let state = createInitialState(config);
  const listeners = new Set<() => void>();
  return {
    dispatch: (action: AppAction) => {
      state = appReducer(state, action);
      for (const listener of listeners) listener();
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function Sync(props: Parameters<typeof useTeamCollectionsSync>[0]) {
  useTeamCollectionsSync(props);
  return null;
}

/** Runs a trigger and lets every promise it started run to its end. */
async function settleAfter(trigger: () => void) {
  await act(async () => {
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("team collections sync", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    teamStore.upsertTeam(createTestTeam({ id: "org-a", name: "Alpha" }));
    teamStore.upsertTeam(createTestTeam({ id: "org-b", name: "Beta" }));
  });

  afterEach(async () => {
    await tui.destroy();
    for (const spy of spies.splice(0)) spy.mockRestore();
    teamStore.removeTeam("org-a");
    teamStore.removeTeam("org-b");
  });

  test("a team whose collection list fails keeps its collections, members and config entries", async () => {
    const lists: Record<string, TeamCollection[] | Error> = {
      "org-a": [collection("org-a", "a1", "Alpha list")],
      "org-b": [collection("org-b", "b1", "Beta list"), collection("org-b", "b2", "Beta book", { kind: "portfolio", currency: "EUR" })],
    };
    const items: Record<string, TeamCollectionItem[]> = {
      a1: [item("a1", "AAPL")],
      b1: [item("b1", "MSFT")],
      b2: [item("b2", "TSLA", 5)],
    };
    let verified = false;
    let refreshFromServer = () => {};
    let emitEvent: (event: TeamCollectionEvent) => void = () => {};
    spies.push(
      spyOn(apiClient, "isVerified").mockImplementation(() => verified),
      spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
        refreshFromServer = listener;
        return () => {};
      }),
      spyOn(apiClient, "subscribeCloudEvent").mockImplementation((_type, listener) => {
        emitEvent = (event) => listener(event);
        return () => {};
      }),
      spyOn(apiClient, "listTeamCollections").mockImplementation(async (teamId) => {
        const list = lists[teamId];
        if (!list || list instanceof Error) throw list ?? new Error("unknown team");
        return list;
      }),
      spyOn(apiClient, "getTeamCollection").mockImplementation(async (teamId, collectionId) => {
        const found = (lists[teamId] as TeamCollection[]).find((entry) => entry.id === collectionId)!;
        return { ...found, items: items[collectionId] ?? [] };
      }),
      spyOn(apiClient, "putTeamCollectionItem").mockImplementation(async (_teamId, collectionId, body) => item(collectionId, body.symbol)),
      spyOn(apiClient, "removeTeamCollectionItem").mockResolvedValue(undefined as never),
    );

    const store = createStore({ ...createDefaultConfig("/tmp/gloomberb-team-collections-sync"), watchlists: [{ id: "mine", name: "Mine" }] });
    const records = new Map<string, TickerRecord>();
    const persisted: AppConfig[] = [];
    await tui.render(
      <AppContext value={store}>
        <Sync
          persistConfig={(config) => void persisted.push(config)}
          tickerRepository={{
            loadAllTickers: async () => [...records.values()],
            loadTicker: async (symbol) => records.get(symbol) ?? null,
            saveTicker: async (ticker) => void records.set(ticker.metadata.ticker, ticker),
            createTicker: async (metadata) => {
              const ticker = { metadata };
              records.set(metadata.ticker, ticker);
              return ticker;
            },
            deleteTicker: async (symbol) => void records.delete(symbol),
          }}
        />
      </AppContext>,
      { width: 10, height: 2 },
    );
    verified = true;
    await settleAfter(() => refreshFromServer());

    const teamEntries = (teamId: string) => {
      const { watchlists, portfolios } = store.getState().config;
      return [...watchlists, ...portfolios].filter((entry) => entry.teamId === teamId).map((entry) => `${entry.id}=${entry.name}`).sort();
    };
    const members = (teamId: string, id: string, kind: "watchlist" | "portfolio") =>
      [...localMembership(store.getState().tickers, teamCollectionLocalId(teamId, id), kind)].map(([symbol, entry]) => `${symbol}:${entry.quantity}`);
    expect(teamEntries("org-b")).toEqual(["team:org-b:b1=Beta list", "team:org-b:b2=Beta book"]);
    expect(members("org-b", "b1", "watchlist")).toEqual(["MSFT:null"]);
    expect(members("org-b", "b2", "portfolio")).toEqual(["TSLA:5"]);

    // Beta's list request fails while Alpha's snapshot moves on.
    lists["org-a"] = [collection("org-a", "a1", "Alpha renamed")];
    items.a1 = [item("a1", "NVDA")];
    lists["org-b"] = new Error("timeout");
    persisted.length = 0;
    await settleAfter(() => refreshFromServer());

    expect(teamEntries("org-a")).toEqual(["team:org-a:a1=Alpha renamed"]);
    expect(members("org-a", "a1", "watchlist")).toEqual(["NVDA:null"]);
    expect(teamEntries("org-b")).toEqual(["team:org-b:b1=Beta list", "team:org-b:b2=Beta book"]);
    expect(members("org-b", "b1", "watchlist")).toEqual(["MSFT:null"]);
    expect(members("org-b", "b2", "portfolio")).toEqual(["TSLA:5"]);
    for (const config of persisted) {
      expect(config.watchlists.map((entry) => entry.id)).toContain("team:org-b:b1");
      expect(config.portfolios.map((entry) => entry.id)).toContain("team:org-b:b2");
    }

    // Live updates for Beta keep applying.
    await settleAfter(() => emitEvent({ change: "item-added", teamId: "org-b", actorId: "u2", collectionId: "b1", item: item("b1", "AMZN") }));
    expect(members("org-b", "b1", "watchlist").sort()).toEqual(["AMZN:null", "MSFT:null"]);

    // The next refresh where Beta answers applies its snapshot as usual.
    lists["org-b"] = [collection("org-b", "b1", "Beta renamed")];
    items.b1 = [item("b1", "AMZN")];
    await settleAfter(() => refreshFromServer());

    expect(teamEntries("org-b")).toEqual(["team:org-b:b1=Beta renamed"]);
    expect(members("org-b", "b1", "watchlist")).toEqual(["AMZN:null"]);
    expect(members("org-b", "b2", "portfolio")).toEqual([]);
    expect(teamEntries("org-a")).toEqual(["team:org-a:a1=Alpha renamed"]);
    expect(store.getState().config.watchlists.map((entry) => entry.id)).toContain("mine");
  });

  test("a shared portfolio held in several lots is compared by its total: equal leaves the lots, a change collapses them, nothing echoes back", async () => {
    const localId = teamCollectionLocalId("org-a", "p1");
    const lot = (shares: number, avgCost: number, dateAcquired: string) =>
      ({ portfolio: localId, shares, avgCost, currency: "USD", broker: "manual", dateAcquired });
    const lots = { metadata: { ...blankTickerRecord("AAPL", "NASDAQ", "USD").metadata, portfolios: [localId], positions: [lot(10, 150, "2024-01-02"), lot(5, 170, "2024-06-03")] } };
    const books: TeamCollection[] = [collection("org-a", "p1", "Paper book", { kind: "portfolio", currency: "USD" })];
    const items = { p1: [item("p1", "AAPL", 15)] };
    let refreshFromServer = () => {};
    let emitEvent: (event: TeamCollectionEvent) => void = () => {};
    const pushed: unknown[] = [];
    spies.push(
      spyOn(apiClient, "isVerified").mockImplementation(() => true),
      spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
        refreshFromServer = listener;
        return () => {};
      }),
      spyOn(apiClient, "subscribeCloudEvent").mockImplementation((_type, listener) => {
        emitEvent = (event) => listener(event);
        return () => {};
      }),
      spyOn(apiClient, "listTeamCollections").mockImplementation(async (teamId) => (teamId === "org-a" ? books : [])),
      spyOn(apiClient, "getTeamCollection").mockImplementation(async () => ({ ...books[0]!, items: items.p1 })),
      spyOn(apiClient, "putTeamCollectionItem").mockImplementation(async (_teamId, collectionId, body) => {
        pushed.push(body);
        return item(collectionId, body.symbol, body.quantity ?? null);
      }),
      spyOn(apiClient, "removeTeamCollectionItem").mockResolvedValue(undefined as never),
    );

    const store = createStore(createDefaultConfig("/tmp/gloomberb-team-collections-lots"));
    store.dispatch({ type: "UPDATE_TICKER", ticker: lots });
    const saved: TickerRecord[] = [];
    await tui.render(
      <AppContext value={store}>
        <Sync
          persistConfig={() => {}}
          tickerRepository={{
            loadAllTickers: async () => [],
            loadTicker: async () => null,
            saveTicker: async (ticker) => void saved.push(ticker),
            createTicker: async (metadata) => ({ metadata }),
            deleteTicker: async () => {},
          }}
        />
      </AppContext>,
      { width: 10, height: 2 },
    );

    await settleAfter(() => refreshFromServer());
    expect(saved).toEqual([]);
    expect(store.getState().tickers.get("AAPL")).toBe(lots);

    await settleAfter(() => emitEvent({ change: "item-updated", teamId: "org-a", actorId: "u2", collectionId: "p1", item: item("p1", "AAPL", 20) }));
    expect(store.getState().tickers.get("AAPL")?.metadata.positions).toEqual([
      { portfolio: localId, shares: 20, avgCost: 156.666666666667, currency: "USD", broker: "manual", dateAcquired: "2024-01-02" },
    ]);

    // Past the outbound debounce: the total already matches the server's, so nothing is sent.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(pushed).toEqual([]);
  });

  test("round trip: the purchase date and cost FX rate a teammate set reach the other's lot, and nothing echoes back", async () => {
    const localId = teamCollectionLocalId("org-a", "p1");
    const books: TeamCollection[] = [collection("org-a", "p1", "Lira book", { kind: "portfolio", currency: "TRY" })];
    // The server as the platform keeps it: a field a PUT leaves out stays as it was.
    const server = new Map<string, TeamCollectionItem>([["BRK.B", { ...item("p1", "BRK.B", 10), exchange: "NYSE",
      dateAcquired: null, currency: null, costFxRate: null, costFxCurrency: null }]]);
    const refreshers: Array<() => void> = [];
    const listeners: Array<(event: TeamCollectionEvent) => void> = [];
    const pushed: unknown[] = [];
    spies.push(
      spyOn(apiClient, "isVerified").mockImplementation(() => true),
      spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
        refreshers.push(listener);
        return () => {};
      }),
      spyOn(apiClient, "subscribeCloudEvent").mockImplementation((_type, listener) => {
        listeners.push((event) => listener(event));
        return () => {};
      }),
      spyOn(apiClient, "listTeamCollections").mockImplementation(async (teamId) => (teamId === "org-a" ? books : [])),
      spyOn(apiClient, "getTeamCollection").mockImplementation(async () => ({ ...books[0]!, items: [...server.values()] })),
      spyOn(apiClient, "putTeamCollectionItem").mockImplementation(async (_teamId, collectionId, body) => {
        pushed.push(body);
        const stored = { ...server.get(body.symbol)!, ...body, collectionId, exchange: body.exchange ?? "" } as TeamCollectionItem;
        server.set(body.symbol, stored);
        queueMicrotask(() => { for (const listener of listeners) listener({ change: "item-updated", teamId: "org-a", actorId: "alice", collectionId, item: stored }); });
        return stored;
      }),
      spyOn(apiClient, "removeTeamCollectionItem").mockResolvedValue(undefined as never),
    );

    // Alice set BRK.B in USD at the 2024-03-01 close; Bob holds the team's 10 shares from before, with neither.
    const lot = { portfolio: localId, shares: 10, avgCost: 410, currency: "USD", broker: "manual", dateAcquired: "2024-03-01", costFxRate: 31.3694, costFxCurrency: "TRY" };
    const record = (positions: TickerRecord["metadata"]["positions"]): TickerRecord =>
      ({ metadata: { ...blankTickerRecord("BRK.B", "NYSE", "USD").metadata, portfolios: [localId], positions } });
    const alice = createStore(createDefaultConfig("/tmp/gloomberb-team-terms-alice"));
    alice.dispatch({ type: "UPDATE_TICKER", ticker: record([lot]) });
    const bob = createStore(createDefaultConfig("/tmp/gloomberb-team-terms-bob"));
    bob.dispatch({ type: "UPDATE_TICKER", ticker: record([{ portfolio: localId, shares: 10, avgCost: 0, currency: "USD", broker: "manual" }]) });
    const repository = {
      loadAllTickers: async () => [], loadTicker: async () => null, saveTicker: async () => {},
      createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }), deleteTicker: async () => {},
    };
    await tui.render(
      <>
        <AppContext value={alice}><Sync persistConfig={() => {}} tickerRepository={repository} /></AppContext>
        <AppContext value={bob}><Sync persistConfig={() => {}} tickerRepository={repository} /></AppContext>
      </>,
      { width: 10, height: 2 },
    );
    await settleAfter(() => { for (const refresh of refreshers) refresh(); });
    // Past the outbound debounce, and the event the push makes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });

    expect(pushed).toEqual([{ symbol: "BRK.B", exchange: "NYSE", quantity: 10,
      dateAcquired: "2024-03-01", currency: "USD", costFxRate: 31.3694, costFxCurrency: "TRY" }]);
    expect(bob.getState().tickers.get("BRK.B")?.metadata.positions).toEqual([{ portfolio: localId, shares: 10, avgCost: 0, currency: "USD",
      broker: "manual", dateAcquired: "2024-03-01", costFxRate: 31.3694, costFxCurrency: "TRY" }]);
    expect(alice.getState().tickers.get("BRK.B")?.metadata.positions).toEqual([lot]);

    // Bob's lot now matches the server: another pass sends nothing more.
    const pass = async () => {
      await settleAfter(() => { for (const refresh of refreshers) refresh(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    };
    await pass();
    expect(pushed).toHaveLength(1);

    // Alice empties Purchase Date, then Cost FX: each clear goes up, reaches Bob, and stays through a refresh.
    const { dateAcquired: _date, ...undated } = lot;
    const { costFxRate: _rate, costFxCurrency: _rateCurrency, ...unrated } = undated;
    for (const [cleared, sent] of [
      [undated, { dateAcquired: null }],
      [unrated, { currency: "USD", costFxRate: null, costFxCurrency: null }],
    ] as const) {
      await settleAfter(() => alice.dispatch({ type: "UPDATE_TICKER", ticker: record([cleared]) }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
      expect(pushed.at(-1)).toEqual({ symbol: "BRK.B", exchange: "NYSE", quantity: 10, ...sent });
      const count = pushed.length;
      await pass();
      expect(pushed).toHaveLength(count);
      expect(alice.getState().tickers.get("BRK.B")?.metadata.positions).toEqual([cleared]);
      expect(bob.getState().tickers.get("BRK.B")?.metadata.positions).toEqual([{ ...cleared, avgCost: 0 }]);
    }
    expect(pushed).toHaveLength(3);
  });
});
