import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  appReducer,
  createInitialState,
  type AppAction,
  type AppState,
} from "../core/state/app/state";
import type { TickerRepository } from "../data/ticker-repository";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../data/config/store/normalize";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import { materializeDetachedLayouts } from "../core/state/app/layout";
import {
  __syncContributorInternalsForTests,
  coreConfigSyncContributor,
} from "./core-contributors";
import { CloudSyncController } from "./controller";
import { createSyncBaselineStore } from "./baseline";
import { subscribeToCloudVerification } from "./auth-transition";
import { AppPersistence } from "../data/app-persistence";
import { createTempDbPath, removeTempDbFiles } from "../test-support/temp-db";
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  SyncRevisionConflictError,
  type SyncBaselineStore,
  type SyncContributor,
  type SyncSnapshot,
  type SyncSnapshotResponse,
  type SyncTransport,
} from "./types";

afterEach(removeTempDbFiles);

type SyncRuntimeOptions = Parameters<typeof syncRuntime>[0];

/** A controller syncing through `transport`; state and dispatch default to an idle app. */
function startController(options: SyncRuntimeOptions): CloudSyncController {
  const controller = new CloudSyncController();
  controller.setRuntime(syncRuntime(options));
  return controller;
}

/** The runtime an app hands the controller; each call is a new runtime, as when the app re-creates it. */
function syncRuntime({
  transport,
  contributors = [],
  getState = () => ({} as AppState),
  dispatch = () => {},
  baselineStore,
  getSessionIdentity,
  getAccountId,
}: {
  transport: SyncTransport;
  contributors?: SyncContributor[];
  getState?: () => AppState;
  dispatch?: (action: AppAction) => void;
  baselineStore?: SyncBaselineStore;
  getSessionIdentity?: () => object | null;
  getAccountId?: () => string | null;
}): Parameters<CloudSyncController["setRuntime"]>[0] {
  return {
    getState,
    dispatch,
    tickerRepository: {} as TickerRepository,
    ...(baselineStore ? { baselineStore } : {}),
    getSessionIdentity,
    getAccountId,
    getContributors: () => contributors.map((contributor) => ({ pluginId: "test", contributor })),
    getTransport: () => ({ pluginId: "test", transport }),
  };
}

/** Another client's snapshot holding one schema 1 contributor payload, written at `createdAt`. */
function remoteSnapshot(contributorId: string, payload: unknown, createdAt: string, clientId = "remote-client"): SyncSnapshot {
  return {
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    appId: "gloomberb",
    clientId,
    createdAt,
    contributors: { [contributorId]: { schemaVersion: 1, updatedAt: createdAt, payload } },
  };
}

test.each(["same session", "restart", "different account after restart"])("sign-out preserves unsynced edits for their account: %s", async (scenario) => {
  let account: string | null = "account-a";
  let identity: object | null = {};
  let listener: (() => void) | undefined;
  let pendingSync = Promise.resolve();
  let state = createInitialState(createDefaultConfig(":memory:"));
  const originalConfig = state.config;
  const stored = new Map<string, unknown>();
  const baselineStore = () => createSyncBaselineStore({
    get: <T,>(pluginId: string, key: string) => stored.has(key)
      ? { pluginId, key, value: stored.get(key) as T, schemaVersion: 1, updatedAt: 0 } : null,
    set: (_pluginId, key, value) => { stored.set(key, value); },
  });
  let remote = remoteSnapshot("core.config", __syncContributorInternalsForTests.collectCoreConfigPayload(originalConfig), "2026-10-01T00:00:00.000Z");
  let revision = 8;
  const transport: SyncTransport = {
    id: "account-cloud",
    isAvailable: () => identity !== null,
    pullSnapshot: async () => ({ snapshot: remote, revision, updatedAt: remote.createdAt }),
    pushSnapshot: async (snapshot, options) => {
      expect(options?.baseRevision).toBe(revision);
      remote = snapshot;
      return { revision: ++revision, updatedAt: snapshot.createdAt };
    },
  };
  const start = () => startController({
    transport, contributors: [coreConfigSyncContributor], getState: () => state,
    dispatch: (action) => { state = appReducer(state, action); },
    baselineStore: baselineStore(), getSessionIdentity: () => identity, getAccountId: () => identity ? account : null,
  });
  let controller = start();
  const subscribe = () => subscribeToCloudVerification({
    getCurrentUser: () => account ? { id: account } : null,
    isSignedIn: () => account !== null,
    getVerifiedSessionIdentity: () => identity,
    subscribeCurrentUser: (next) => { listener = next; return () => { listener = undefined; }; },
  }, () => { pendingSync = controller.requestSync({ reason: "session-verified", force: true }); },
  (id) => controller.resetAccount(id), () => controller.retireSession());
  let stop = subscribe();
  try {
    await controller.requestSync();
    state = appReducer(state, { type: "SET_THEME", theme: "green" });
    state = appReducer(state, { type: "RENAME_LAYOUT", index: 0, name: "Unsynced layout" });
    controller.schedulePush("unsynced-edit");
    account = null;
    identity = null;
    listener!();
    remote = remoteSnapshot("core.config", __syncContributorInternalsForTests.collectCoreConfigPayload({
      ...originalConfig, baseCurrency: "EUR",
    }), "2026-10-02T00:00:00.000Z");
    revision = 9;
    if (scenario !== "same session") {
      stop();
      controller.clearRuntime();
      controller = start();
      stop = subscribe();
    }
    account = scenario === "different account after restart" ? "account-b" : "account-a";
    identity = {};
    listener!();
    await pendingSync;
    const expectedTheme = account === "account-a" ? "green" : originalConfig.theme;
    const expectedLayout = account === "account-a" ? "Unsynced layout" : originalConfig.layouts[0]!.name;
    const cloud = remote.contributors["core.config"]!.payload as typeof originalConfig;
    expect(state.config.theme).toBe(expectedTheme);
    expect(state.config.layouts[0]!.name).toBe(expectedLayout);
    expect(state.config.baseCurrency).toBe("EUR");
    expect(cloud.theme).toBe(expectedTheme);
    expect(cloud.layouts[0]!.name).toBe(expectedLayout);
    expect(baselineStore().loadAccountId!()).toBe(account);
  } finally {
    stop();
    controller.clearRuntime();
  }
});

// One running app keeps its transport when its signed-in account changes.
// Exercise the same auth subscription used by the terminal, desktop and web.
test.each([2, 20])("switching accounts first merges the new account at revision %i", async (revision) => {
  let account: string | null = "account-a";
  let listener: (() => void) | undefined;
  let pendingSync = Promise.resolve();
  let baseline: Record<string, unknown> | null = null;
  let memos: Record<string, unknown> | null = null;
  let state = createInitialState(createDefaultConfig(":memory:"));
  const accountB = {
    ...state.config,
    theme: "green",
    portfolios: [{ id: "account-b-portfolio", name: "Account B", currency: "USD" }],
    layouts: state.config.layouts.map((layout) => ({ ...layout, name: `Account B ${layout.name}` })),
  };
  const snapshots = new Map([
    ["account-a", { snapshot: remoteSnapshot("core.config", __syncContributorInternalsForTests.collectCoreConfigPayload(state.config), "2026-10-01T00:00:00.000Z"), revision: 8 }],
    ["account-b", { snapshot: remoteSnapshot("core.config", __syncContributorInternalsForTests.collectCoreConfigPayload(accountB), "2026-10-01T00:00:00.000Z"), revision }],
  ]);
  const pushes: string[] = [];
  const transport: SyncTransport = {
    id: "account-cloud",
    isAvailable: () => account !== null,
    pullSnapshot: async () => ({ ...snapshots.get(account!)!, updatedAt: null }),
    pushSnapshot: async (snapshot, options) => {
      const cloud = snapshots.get(account!)!;
      expect(options?.baseRevision).toBe(cloud.revision);
      pushes.push(account!);
      snapshots.set(account!, { snapshot, revision: cloud.revision + 1 });
      return { revision: cloud.revision + 1, updatedAt: snapshot.createdAt };
    },
  };
  const controller = startController({
    transport,
    contributors: [coreConfigSyncContributor],
    getState: () => state,
    dispatch: (action) => { state = appReducer(state, action); },
    baselineStore: {
      load: () => baseline,
      save: (next) => { baseline = next; },
      loadMemos: () => memos,
      saveMemos: (next) => { memos = next; },
    },
  });
  const stop = subscribeToCloudVerification({
    getCurrentUser: () => account ? { id: account } : null,
    isSignedIn: () => account !== null,
    getVerifiedSessionIdentity: () => account !== null ? {} : null,
    subscribeCurrentUser: (next) => { listener = next; return () => { listener = undefined; }; },
  }, () => { pendingSync = controller.requestSync({ reason: "session-verified", force: true }); },
  () => controller.resetAccount());
  try {
    await controller.requestSync({ reason: "startup" });
    state = appReducer(state, { type: "NEW_LAYOUT", name: "Account A edit" });
    await controller.requestSync({ reason: "state-change" });
    const accountASnapshot = snapshots.get("account-a")!.snapshot;
    // An edit against account A must not make the new account's cloud
    // portfolio list look older than the local copy.
    state = appReducer(state, { type: "SET_CONFIG", config: {
      ...state.config,
      portfolios: [...state.config.portfolios, { id: "local-portfolio", name: "Local", currency: "USD" }],
    } });
    account = "account-b";
    listener!();
    await pendingSync;
    await controller.requestSync({ reason: "poll" });

    const cloud = snapshots.get("account-b")!.snapshot.contributors["core.config"]!.payload as typeof accountB;
    expect({ local: state.config.layouts.map((layout) => layout.name), cloud: cloud.layouts.map((layout) => layout.name) })
      .toEqual({ local: accountB.layouts.map((layout) => layout.name), cloud: accountB.layouts.map((layout) => layout.name) });
    expect(state.config.theme).toBe("green");
    expect(cloud.portfolios.map((portfolio) => portfolio.id)).toContain("account-b-portfolio");
    expect(snapshots.get("account-a")!.snapshot).toBe(accountASnapshot);
    expect(pushes).toContain("account-b");
  } finally {
    stop();
    controller.clearRuntime();
  }
});

test("an account reset drops an old account's pending pull and persisted merge state", async () => {
  let account = "account-a";
  let local = { value: "a" };
  let baseline: Record<string, unknown> | null = null;
  let memos: Record<string, unknown> | null = null;
  const latePull = Promise.withResolvers<SyncSnapshotResponse>();
  const oldSnapshot = remoteSnapshot("test.data", { value: "a" }, "2026-10-01T00:00:00.000Z");
  let delayPull = false;
  const applied: string[] = [];
  const pushes: string[] = [];
  const contributor: SyncContributor = {
    id: "test.data",
    schemaVersion: 1,
    collect: () => local,
    apply: (payload, context) => {
      if (account === "account-b") {
        expect(context.baselinePayload).toBeNull();
        expect(context.memo!.get()).toBeNull();
      }
      local = payload as typeof local;
      applied.push(local.value);
      context.memo!.set({ account });
    },
  };
  const transport: SyncTransport = {
    id: "account-cloud",
    isAvailable: () => true,
    pullSnapshot: async () => delayPull ? latePull.promise : {
      snapshot: account === "account-a" ? oldSnapshot : remoteSnapshot("test.data", { value: "b" }, "2026-10-02T00:00:00.000Z"),
      revision: account === "account-a" ? 10 : 2,
      updatedAt: null,
    },
    pushSnapshot: async () => {
      pushes.push(account);
      return { revision: 11, updatedAt: "2026-10-02T00:00:00.000Z" };
    },
  };
  const controller = startController({ transport, contributors: [contributor], baselineStore: {
    load: () => baseline,
    save: (next) => { baseline = next; },
    loadMemos: () => memos,
    saveMemos: (next) => { memos = next; },
  } });
  try {
    await controller.requestSync();
    delayPull = true;
    const oldRun = controller.requestSync();
    // The second account can sync before the old account's request returns.
    account = "account-b";
    controller.resetAccount();
    expect(baseline).toEqual({});
    expect(memos).toEqual({});
    expect(controller.getStatus().revision).toBeNull();
    delayPull = false;
    await controller.requestSync();
    latePull.resolve({ snapshot: oldSnapshot, revision: 10, updatedAt: null });
    await oldRun;

    expect(applied).toEqual(["a", "b"]);
    expect(local).toEqual({ value: "b" });
    expect(controller.getStatus().revision).toBe(2);
    expect(pushes).toEqual([]);
    expect(baseline).toEqual({ "test.data": { value: "b" } });
    expect(memos).toEqual({ "test.data": { account: "account-b" } });
  } finally {
    controller.clearRuntime();
  }
});

test("a late contributor cannot restore the previous account's revision or edit memo", async () => {
  const applying = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let value = "a";
  let revision = 10;
  let local = { value };
  let delayApply = false;
  let memos: Record<string, unknown> | null = null;
  const controller = startController({
    contributors: [{
      id: "test.data",
      schemaVersion: 1,
      collect: () => local,
      apply: async (payload, context) => {
        if (delayApply) {
          applying.resolve();
          await release.promise;
          context.memo!.set({ account: "old" });
        }
        if (context.isCurrent()) local = payload as typeof local;
      },
    }],
    baselineStore: {
      load: () => null,
      save: () => {},
      loadMemos: () => memos,
      saveMemos: (next) => { memos = next; },
    },
    transport: {
      id: "account-cloud",
      isAvailable: () => true,
      pullSnapshot: async () => ({ snapshot: remoteSnapshot("test.data", { value }, "2026-10-01T00:00:00.000Z"), revision, updatedAt: null }),
      pushSnapshot: async () => { throw new Error("matching copies should not push"); },
    },
  });
  try {
    await controller.requestSync();
    delayApply = true;
    revision = 11;
    const oldRun = controller.requestSync();
    await applying.promise;
    controller.resetAccount();
    delayApply = false;
    value = "b";
    revision = 2;
    await controller.requestSync();
    release.resolve();
    await oldRun;
    value = "b-edited-elsewhere";
    revision = 3;
    await controller.requestSync();

    expect(local).toEqual({ value });
    expect(controller.getStatus()).toMatchObject({ phase: "synced", revision: 3, error: null });
    expect(memos).toEqual({});
  } finally {
    controller.clearRuntime();
  }
});

test("an older read on the same account leaves its newer synced state in place", async () => {
  let local = { value: "current" };
  let revision = 10;
  let remote = remoteSnapshot("test.data", local, "2026-10-02T00:00:00.000Z");
  const applied: unknown[] = [];
  let pushes = 0;
  const controller = startController({
    contributors: [{
      id: "test.data",
      schemaVersion: 1,
      collect: () => local,
      apply: (payload) => { local = payload as typeof local; applied.push(payload); },
    }],
    transport: {
      id: "stale-read",
      isAvailable: () => true,
      pullSnapshot: async () => ({ snapshot: remote, revision, updatedAt: remote.createdAt }),
      pushSnapshot: async () => { pushes += 1; return { revision: 11, updatedAt: remote.createdAt }; },
    },
  });
  try {
    await controller.requestSync();
    revision = 9;
    remote = remoteSnapshot("test.data", { value: "stale" }, "2026-10-01T00:00:00.000Z");
    await controller.requestSync({ reason: "poll" });

    expect(local).toEqual({ value: "current" });
    expect(applied).toEqual([{ value: "current" }]);
    expect(controller.getStatus()).toMatchObject({ phase: "synced", revision: 10, error: null });
    expect(pushes).toBe(0);
  } finally {
    controller.clearRuntime();
  }
});

test("an available custom transport syncs without a Cloud session", async () => {
  const pushed: SyncSnapshot[] = [];
  const controller = startController({
    getSessionIdentity: () => null,
    contributors: [{ id: "test.data", schemaVersion: 1, collect: () => ({ local: true }) }],
    transport: {
      id: "custom-sync",
      isAvailable: () => true,
      pullSnapshot: async () => ({ snapshot: null, revision: 0, updatedAt: null }),
      pushSnapshot: async (snapshot) => { pushed.push(snapshot); return { revision: 1, updatedAt: snapshot.createdAt }; },
    },
  });
  try {
    await controller.requestSync();
    expect(pushed.map((snapshot) => snapshot.contributors["test.data"]?.payload)).toEqual([{ local: true }]);
    expect(controller.getStatus()).toMatchObject({ phase: "synced", revision: 1 });
  } finally {
    controller.clearRuntime();
  }
});

test("keeps workspace edits made while the app was closed and uploads them", async () => {
  // The CLI writes config.json directly, so at launch local state looks
  // pristine and the cloud copy used to overwrite it.
  const syncedConfig = createDefaultConfig("/tmp/gloomberb-sync-offline-edit-test");
  syncedConfig.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
  const syncedPayload = __syncContributorInternalsForTests.collectCoreConfigPayload(syncedConfig);
  const stored: Record<string, unknown> = { "core.config": syncedPayload };
  const baselineStore: SyncBaselineStore = {
    load: () => stored,
    save: (payloads) => Object.assign(stored, payloads),
  };

  let state = createInitialState({
    ...syncedConfig,
    portfolios: [...syncedConfig.portfolios, { id: "research", name: "Research", currency: "USD" }],
  });
  const dispatch = (action: AppAction) => {
    state = appReducer(state, action);
  };
  const pushes: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "offline-edit",
    isAvailable: () => true,
    pullSnapshot: async () => ({
      snapshot: remoteSnapshot("core.config", syncedPayload, "2026-08-23T10:00:00.000Z"),
      revision: 4,
      updatedAt: "2026-08-23T10:00:00.000Z",
    }),
    pushSnapshot: async (snapshot) => {
      pushes.push(snapshot);
      return { revision: 5, updatedAt: "2026-08-23T10:00:05.000Z" };
    },
  };

  const controller = startController({ transport, contributors: [coreConfigSyncContributor], getState: () => state, dispatch, baselineStore });

  await controller.requestSync({ reason: "startup" });

  const pushedPortfolios = (pushes[0]?.contributors["core.config"]?.payload as {
    portfolios: Array<{ id: string }>;
  }).portfolios.map((portfolio) => portfolio.id);
  expect(state.config.portfolios.map((portfolio) => portfolio.id)).toEqual(["main", "research"]);
  expect(pushedPortfolios).toEqual(["main", "research"]);
  expect((stored["core.config"] as { portfolios: Array<{ id: string }> }).portfolios).toHaveLength(2);
});

/**
 * Merge history kept in plugin state that refuses reads while `readable` is false or for `unreadableKeys`, and
 * writes while `writable` is false.
 */
function failingHistoryStorage(stored: Map<string, unknown>) {
  const storage = { readable: true, writable: true, unreadableKeys: new Set<string>(), writes: [] as string[] };
  const store = () => createSyncBaselineStore({
    get: <T,>(pluginId: string, key: string) => {
      if (!storage.readable || storage.unreadableKeys.has(key)) throw new Error("database is locked");
      return stored.has(key) ? { pluginId, key, value: stored.get(key) as T, schemaVersion: 1, updatedAt: 0 } : null;
    },
    set: (_pluginId, key, value) => {
      if (!storage.writable) throw new Error("disk is full");
      storage.writes.push(key);
      stored.set(key, value);
    },
  });
  return Object.assign(storage, { store });
}

function portfolioIds(payload: unknown): string[] {
  return (payload as { portfolios: Array<{ id: string }> }).portfolios.map((portfolio) => portfolio.id);
}

test("a sync history storage cannot read is not taken for a device that never synced", async () => {
  const syncedConfig = createDefaultConfig("/tmp/gloomberb-sync-unreadable-history-test");
  syncedConfig.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
  const syncedPayload = __syncContributorInternalsForTests.collectCoreConfigPayload(syncedConfig);
  const stored = new Map<string, unknown>([
    ["account", { id: "account-a" }],
    ["last-synced-payloads", { "core.config": syncedPayload }],
  ]);
  const storage = failingHistoryStorage(stored);
  storage.readable = false;
  // Edited while the app was closed; the cloud still holds what this device last pushed.
  let state = createInitialState({
    ...syncedConfig,
    portfolios: [...syncedConfig.portfolios, { id: "research", name: "Research", currency: "USD" }],
  });
  let dispatched = 0;
  const pushes: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "unreadable-history",
    isAvailable: () => true,
    pullSnapshot: async () => ({
      snapshot: remoteSnapshot("core.config", syncedPayload, "2026-08-23T10:00:00.000Z"),
      revision: 4,
      updatedAt: "2026-08-23T10:00:00.000Z",
    }),
    pushSnapshot: async (snapshot) => {
      pushes.push(snapshot);
      return { revision: 5, updatedAt: "2026-08-23T10:00:05.000Z" };
    },
  };
  const controller = startController({
    transport, contributors: [coreConfigSyncContributor], getState: () => state,
    dispatch: (action) => { dispatched += 1; state = appReducer(state, action); },
    baselineStore: storage.store(), getAccountId: () => "account-a",
  });
  try {
    await controller.requestSync({ reason: "startup" });
    expect(state.config.portfolios.map((portfolio) => portfolio.id)).toEqual(["main", "research"]);
    expect(dispatched).toBe(0);
    expect(pushes).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(controller.getStatus().phase).toBe("error");

    storage.readable = true;
    await controller.requestSync({ reason: "poll" });
    expect(state.config.portfolios.map((portfolio) => portfolio.id)).toEqual(["main", "research"]);
    expect(pushes.map((snapshot) => portfolioIds(snapshot.contributors["core.config"]!.payload))).toEqual([["main", "research"]]);
    expect(portfolioIds((stored.get("last-synced-payloads") as Record<string, unknown>)["core.config"])).toEqual(["main", "research"]);
    expect(stored.get("account")).toEqual({ id: "account-a" });
    expect(controller.getStatus().phase).toBe("synced");
  } finally {
    controller.clearRuntime();
  }
});

test("a sync history storage could not save is saved before it decides a later merge", async () => {
  const syncedConfig = createDefaultConfig("/tmp/gloomberb-sync-unsaved-history-test");
  syncedConfig.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
  const portfolio = (id: string) => ({ id, name: id, currency: "USD" });
  const payloadWith = (ids: string[]) => __syncContributorInternalsForTests.collectCoreConfigPayload({
    ...syncedConfig, portfolios: ids.map(portfolio),
  });
  const stored = new Map<string, unknown>([["last-synced-payloads", { "core.config": payloadWith(["main"]) }]]);
  const storage = failingHistoryStorage(stored);
  let remote = remoteSnapshot("core.config", payloadWith(["main"]), "2026-08-23T10:00:00.000Z");
  let revision = 4;
  let pushes = 0;
  const transport: SyncTransport = {
    id: "unsaved-history",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: remote, revision, updatedAt: remote.createdAt }),
    pushSnapshot: async (snapshot) => {
      pushes += 1;
      remote = snapshot;
      return { revision: ++revision, updatedAt: snapshot.createdAt };
    },
  };
  let state = createInitialState({ ...syncedConfig, portfolios: ["main", "research"].map(portfolio) });
  const controller = startController({
    transport, contributors: [coreConfigSyncContributor], getState: () => state,
    dispatch: (action) => { state = appReducer(state, action); }, baselineStore: storage.store(),
  });
  try {
    storage.writable = false;
    await controller.requestSync({ reason: "startup" });
    expect(portfolioIds(remote.contributors["core.config"]!.payload)).toEqual(["main", "research"]);
    expect(controller.getStatus().phase).toBe("error");

    // Until the history is saved, a later edit waits instead of moving the cloud further from it.
    state = { ...state, config: { ...state.config, portfolios: [...state.config.portfolios, portfolio("growth")] } };
    await controller.requestSync({ reason: "state-change" });
    expect(pushes).toBe(1);

    storage.writable = true;
    await controller.requestSync({ reason: "poll" });
    expect(pushes).toBe(2);
    expect(controller.getStatus().phase).toBe("synced");
    expect(portfolioIds((stored.get("last-synced-payloads") as Record<string, unknown>)["core.config"]))
      .toEqual(["main", "research", "growth"]);
  } finally {
    controller.clearRuntime();
  }
});

test.each([
  ["a damaged merge baseline", "last-synced-payloads", "UPDATE plugin_state SET value = '{\"core.config\":' WHERE plugin_id = 'core.sync' AND key = ?"],
  ["edit memos from another schema version", "contributor-memos", "UPDATE plugin_state SET schema_version = 2 WHERE plugin_id = 'core.sync' AND key = ?"],
])("%s pauses sync and stays stored instead of reading as never synced", async (_row, key, damage) => {
  const persistence = new AppPersistence(createTempDbPath("sync-history-row"));
  const syncedConfig = createDefaultConfig("/tmp/gloomberb-sync-damaged-history-test");
  syncedConfig.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
  const syncedPayload = __syncContributorInternalsForTests.collectCoreConfigPayload(syncedConfig);
  const baselineStore = createSyncBaselineStore(persistence.pluginState);
  const writeHistory = () => {
    baselineStore.save({ "core.config": syncedPayload });
    baselineStore.saveMemos!({});
  };
  baselineStore.saveAccountId!("account-a");
  writeHistory();
  persistence.database.connection.query(damage).run(key);
  const rows = () => persistence.database.connection
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM plugin_state WHERE plugin_id = 'core.sync' AND key = ?")
    .get(key)!.count;
  let state = createInitialState({
    ...syncedConfig,
    portfolios: [...syncedConfig.portfolios, { id: "research", name: "Research", currency: "USD" }],
  });
  let dispatched = 0;
  const pushes: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "damaged-history",
    isAvailable: () => true,
    pullSnapshot: async () => ({
      snapshot: remoteSnapshot("core.config", syncedPayload, "2026-08-23T10:00:00.000Z"),
      revision: 4,
      updatedAt: "2026-08-23T10:00:00.000Z",
    }),
    pushSnapshot: async (snapshot) => {
      pushes.push(snapshot);
      return { revision: 5, updatedAt: "2026-08-23T10:00:05.000Z" };
    },
  };
  const controller = startController({
    transport, contributors: [coreConfigSyncContributor], getState: () => state,
    dispatch: (action) => { dispatched += 1; state = appReducer(state, action); },
    baselineStore, getAccountId: () => "account-a",
  });
  try {
    await controller.requestSync({ reason: "startup" });
    expect(state.config.portfolios.map((portfolio) => portfolio.id)).toEqual(["main", "research"]);
    expect(dispatched).toBe(0);
    expect(pushes).toEqual([]);
    expect(controller.getStatus().phase).toBe("error");
    expect(rows()).toBe(1);

    writeHistory();
    await controller.requestSync({ reason: "poll" });
    expect(pushes.map((snapshot) => portfolioIds(snapshot.contributors["core.config"]!.payload))).toEqual([["main", "research"]]);
    expect(controller.getStatus().phase).toBe("synced");
  } finally {
    controller.clearRuntime();
    persistence.close();
  }
});

test("history the cloud already holds is saved again first, and a new runtime merges against it without reading it back", async () => {
  const syncedConfig = createDefaultConfig("/tmp/gloomberb-sync-held-history-test");
  const portfolio = (id: string) => ({ id, name: id, currency: "USD" });
  const payloadWith = (ids: string[]) => __syncContributorInternalsForTests.collectCoreConfigPayload({
    ...syncedConfig, portfolios: ids.map(portfolio),
  });
  const stored = new Map<string, unknown>([["last-synced-payloads", { "core.config": payloadWith(["main"]) }]]);
  const storage = failingHistoryStorage(stored);
  const baselineStore = storage.store();
  // The cloud already holds this device's edit, as after a push whose history save was lost.
  let remote = remoteSnapshot("core.config", payloadWith(["main", "research"]), "2026-08-23T10:00:00.000Z");
  let revision = 4;
  let pushes = 0;
  const transport: SyncTransport = {
    id: "held-history",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: remote, revision, updatedAt: remote.createdAt }),
    pushSnapshot: async (snapshot) => {
      pushes += 1;
      remote = snapshot;
      return { revision: ++revision, updatedAt: snapshot.createdAt };
    },
  };
  let state = createInitialState({ ...syncedConfig, portfolios: ["main", "research"].map(portfolio) });
  const runtime = () => syncRuntime({
    transport, contributors: [coreConfigSyncContributor], getState: () => state,
    dispatch: (action) => { state = appReducer(state, action); }, baselineStore,
  });
  const controller = new CloudSyncController();
  controller.setRuntime(runtime());
  try {
    storage.writable = false;
    await controller.requestSync({ reason: "startup" });
    expect(pushes).toBe(0);
    expect(controller.getStatus().phase).toBe("error");

    // The app hands over a new runtime on the same store; the history it could not save is still the one to use.
    controller.setRuntime(runtime());
    storage.writable = true;
    storage.unreadableKeys.add("last-synced-payloads");
    state = { ...state, config: { ...state.config, portfolios: [...state.config.portfolios, portfolio("growth")] } };
    await controller.requestSync({ reason: "state-change" });
    expect(pushes).toBe(1);
    expect(portfolioIds(remote.contributors["core.config"]!.payload)).toEqual(["main", "research", "growth"]);
    expect(portfolioIds((stored.get("last-synced-payloads") as Record<string, unknown>)["core.config"]))
      .toEqual(["main", "research", "growth"]);
    expect(controller.getStatus().phase).toBe("synced");
  } finally {
    controller.clearRuntime();
  }
});

test("edit memos storage could not save are pushed by a new runtime without reading them back", async () => {
  const stored = new Map<string, unknown>();
  const storage = failingHistoryStorage(stored);
  const baselineStore = storage.store();
  let note = "draft";
  const contributor: SyncContributor = {
    id: "test.notes",
    schemaVersion: 1,
    observe: ({ memo }) => {
      if (!memo.get()) memo.set({ editedAt: "2026-08-23T09:00:00.000Z" });
    },
    collect: ({ memo }) => ({ note, edit: memo?.get() ?? null }),
  };
  const pushed: unknown[] = [];
  const transport: SyncTransport = {
    id: "unsaved-memos",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: null, revision: null, updatedAt: null }),
    pushSnapshot: async (snapshot) => {
      pushed.push(snapshot.contributors["test.notes"]!.payload);
      return { revision: pushed.length, updatedAt: snapshot.createdAt };
    },
  };
  const runtime = () => syncRuntime({ transport, contributors: [contributor], baselineStore });
  const controller = new CloudSyncController();
  controller.setRuntime(runtime());
  try {
    storage.writable = false;
    await controller.requestSync({ reason: "startup" });
    expect(controller.getStatus().phase).toBe("error");

    controller.setRuntime(runtime());
    storage.writable = true;
    storage.unreadableKeys.add("contributor-memos");
    note = "final";
    await controller.requestSync({ reason: "state-change" });
    expect(pushed).toEqual([
      { note: "draft", edit: { editedAt: "2026-08-23T09:00:00.000Z" } },
      { note: "final", edit: { editedAt: "2026-08-23T09:00:00.000Z" } },
    ]);
    expect(stored.get("contributor-memos")).toEqual({ "test.notes": { editedAt: "2026-08-23T09:00:00.000Z" } });
    expect(controller.getStatus().phase).toBe("synced");
  } finally {
    controller.clearRuntime();
  }
});

test("a push that lands after its sync was retired is recorded as this device's history, unless the account changed", async () => {
  const stored = new Map<string, unknown>();
  const storage = failingHistoryStorage(stored);
  let value = "signed-out";
  const contributor: SyncContributor = { id: "test.data", schemaVersion: 1, collect: () => ({ value }) };
  let landing = Promise.withResolvers<void>();
  let land = Promise.withResolvers<void>();
  let revision = 0;
  const transport: SyncTransport = {
    id: "retired-push",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: null, revision: null, updatedAt: null }),
    pushSnapshot: async () => {
      landing.resolve();
      await land.promise;
      return { revision: ++revision, updatedAt: "2026-08-23T10:00:00.000Z" };
    },
  };
  const controller = startController({ transport, contributors: [contributor], baselineStore: storage.store() });
  try {
    // Signed out while the push was on its way: the cloud holds it, so the history must too.
    const signedOut = controller.requestSync({ reason: "startup" });
    await landing.promise;
    controller.retireSession();
    land.resolve();
    await signedOut;
    expect(stored.get("last-synced-payloads")).toEqual({ "test.data": { value: "signed-out" } });

    // Another account signed in while the push was on its way: its history stays empty.
    value = "account-switch";
    landing = Promise.withResolvers<void>();
    land = Promise.withResolvers<void>();
    const switched = controller.requestSync({ reason: "state-change" });
    await landing.promise;
    controller.resetAccount("account-b");
    land.resolve();
    await switched;
    expect(stored.get("last-synced-payloads")).toEqual({});
  } finally {
    controller.clearRuntime();
  }
});

test("history a store could not save is written by a new runtime on that store, never into another store", async () => {
  const storedA = new Map<string, unknown>();
  const storedB = new Map<string, unknown>();
  const storageA = failingHistoryStorage(storedA);
  const storageB = failingHistoryStorage(storedB);
  const storeA = storageA.store();
  let available = true;
  let value = "first";
  const contributor: SyncContributor = { id: "test.data", schemaVersion: 1, collect: () => ({ value }) };
  let revision = 0;
  const transport: SyncTransport = {
    id: "store-change",
    isAvailable: () => available,
    pullSnapshot: async () => ({ snapshot: null, revision: null, updatedAt: null }),
    pushSnapshot: async () => ({ revision: ++revision, updatedAt: "2026-08-23T10:00:00.000Z" }),
  };
  const runtime = (baselineStore: SyncBaselineStore) => syncRuntime({ transport, contributors: [contributor], baselineStore });
  const controller = new CloudSyncController();
  try {
    storageA.writable = false;
    controller.setRuntime(runtime(storeA));
    await controller.requestSync({ reason: "startup" });
    controller.setRuntime(runtime(storeA));
    storageA.writable = true;
    available = false;
    await controller.requestSync({ reason: "poll" });
    expect(storedA.get("last-synced-payloads")).toEqual({ "test.data": { value: "first" } });

    storageA.writable = false;
    available = true;
    value = "second";
    await controller.requestSync({ reason: "state-change" });
    controller.setRuntime(runtime(storageB.store()));
    available = false;
    await controller.requestSync({ reason: "poll" });
    expect(storageB.writes).toEqual([]);
    expect(storedA.get("last-synced-payloads")).toEqual({ "test.data": { value: "first" } });
  } finally {
    controller.clearRuntime();
  }
});

test("does not push local state when the initial pull fails", async () => {
  let pushes = 0;
  const transport: SyncTransport = {
    id: "failing-pull",
    isAvailable: () => true,
    pullSnapshot: () => Promise.reject(new Error("pull failed")),
    pushSnapshot: async () => {
      pushes += 1;
      return { revision: 1, updatedAt: new Date().toISOString() };
    },
  };
  const controller = startController({ transport });

  await controller.requestSync({ force: true });

  expect(pushes).toBe(0);
  expect(controller.getStatus()).toMatchObject({ phase: "error", error: "pull failed" });
});

test("rejects incompatible snapshot versions before applying or pushing", async () => {
  let applied = 0;
  let pushes = 0;
  const contributor: SyncContributor = {
    id: "test.settings",
    schemaVersion: 2,
    collect: () => ({ local: true }),
    apply: () => {
      applied += 1;
    },
  };
  const snapshot = {
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION + 1,
    appId: "gloomberb",
    clientId: "future-client",
    createdAt: "2026-07-26T00:00:00.000Z",
    contributors: {},
  } as unknown as SyncSnapshot;
  const transport: SyncTransport = {
    id: "future-snapshot",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot, revision: 1, updatedAt: snapshot.createdAt }),
    pushSnapshot: async () => {
      pushes += 1;
      return { revision: 2, updatedAt: snapshot.createdAt };
    },
  };
  const controller = startController({ transport, contributors: [contributor] });

  await controller.requestSync({ force: true });

  expect(applied).toBe(0);
  expect(pushes).toBe(0);
  expect(controller.getStatus()).toMatchObject({
    phase: "error",
    error: `Unsupported sync snapshot schema version ${SYNC_SNAPSHOT_SCHEMA_VERSION + 1}; expected ${SYNC_SNAPSHOT_SCHEMA_VERSION}`,
  });
});

test("rejects incompatible contributor versions before applying or pushing", async () => {
  let applied = 0;
  let pushes = 0;
  const contributor: SyncContributor = {
    id: "test.settings",
    schemaVersion: 2,
    collect: () => ({ local: true }),
    apply: () => {
      applied += 1;
    },
  };
  const snapshot = remoteSnapshot("test.settings", { remote: true }, "2026-07-26T00:00:00.000Z", "old-client");
  const transport: SyncTransport = {
    id: "old-contributor",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot, revision: 1, updatedAt: snapshot.createdAt }),
    pushSnapshot: async () => {
      pushes += 1;
      return { revision: 2, updatedAt: snapshot.createdAt };
    },
  };
  const controller = startController({ transport, contributors: [contributor] });

  await controller.requestSync({ force: true });

  expect(applied).toBe(0);
  expect(pushes).toBe(0);
  expect(controller.getStatus()).toMatchObject({
    phase: "error",
    error: "Unsupported sync contributor schema for test.settings: 1; expected 2",
  });
});

test("keeps startup layout changes while serializing pull and push", async () => {
  let state = createInitialState(createDefaultConfig("/tmp/gloomberb-sync-controller-test"));
  const dispatch = (action: AppAction) => {
    state = appReducer(state, action);
  };
  let resolvePull!: (response: SyncSnapshotResponse) => void;
  const deferredPull = new Promise<SyncSnapshotResponse>((resolve) => {
    resolvePull = resolve;
  });
  let pulls = 0;
  const pushes: Array<{
    snapshot: SyncSnapshot;
    options?: { baseRevision?: number | null };
  }> = [];
  const transport: SyncTransport = {
    id: "deferred-pull",
    isAvailable: () => true,
    pullSnapshot: () => {
      pulls += 1;
      return deferredPull;
    },
    pushSnapshot: async (snapshot, options) => {
      pushes.push({ snapshot, options });
      return { revision: 8, updatedAt: "2026-07-13T10:00:08.000Z" };
    },
  };
  const contributor: SyncContributor = {
    ...coreConfigSyncContributor,
    apply: (payload, context) => {
      const config = __syncContributorInternalsForTests.mergeConfigPayload(
        context.state.config,
        payload,
        context.baselineState.config,
      );
      if (config) context.dispatch({ type: "SET_CONFIG", config });
    },
  };
  const controller = startController({ transport, contributors: [contributor], getState: () => state, dispatch });

  const startupSync = controller.requestSync({ reason: "startup" });
  const startupPane = {
    instanceId: "help:startup",
    paneId: "help",
    binding: { kind: "none" as const },
  };
  const localLayout = {
    ...state.config.layout,
    instances: [...state.config.layout.instances, startupPane],
    floating: [
      ...state.config.layout.floating,
      { instanceId: startupPane.instanceId, x: 4, y: 3, width: 60, height: 20 },
    ],
  };
  dispatch({
    type: "SET_CONFIG",
    config: {
      ...state.config,
      layout: localLayout,
      layouts: state.config.layouts.map((saved, index) => (
        index === state.config.activeLayoutIndex ? { ...saved, layout: localLayout } : saved
      )),
    },
  });
  const queuedPush = controller.requestSync({ reason: "state-change" });

  const remoteConfig = createDefaultConfig("/remote/path-is-not-synced");
  remoteConfig.theme = "green";
  resolvePull({
    snapshot: remoteSnapshot(
      "core.config",
      __syncContributorInternalsForTests.collectCoreConfigPayload(remoteConfig),
      "2026-07-13T10:00:07.000Z",
    ),
    revision: 7,
    updatedAt: "2026-07-13T10:00:07.000Z",
  });
  await Promise.all([startupSync, queuedPush]);

  const pushedConfig = pushes[0]?.snapshot.contributors["core.config"]?.payload as {
    layout: AppState["config"]["layout"];
  };
  expect(pulls).toBe(2);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.options).toEqual({ baseRevision: 7 });
  expect(state.config.theme).toBe("green");
  expect(state.config.layout.instances).toContainEqual(startupPane);
  expect(pushedConfig.layout.instances).toContainEqual(startupPane);
});

test("keeps a layout switched to while a pull is in flight", async () => {
  let state = createInitialState(createDefaultConfig("/tmp/gloomberb-sync-layout-roundtrip-test"));
  const dispatch = (action: AppAction) => {
    state = appReducer(state, action);
  };

  let resolvePull!: (response: SyncSnapshotResponse) => void;
  const deferredPull = new Promise<SyncSnapshotResponse>((resolve) => {
    resolvePull = resolve;
  });
  const pushes: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "deferred-layout-pull",
    isAvailable: () => true,
    pullSnapshot: () => deferredPull,
    pushSnapshot: async (snapshot) => {
      pushes.push(snapshot);
      return { revision: 12, updatedAt: "2026-07-21T10:00:12.000Z" };
    },
  };
  const controller = startController({ transport, contributors: [coreConfigSyncContributor], getState: () => state, dispatch });

  const startupSync = controller.requestSync({ reason: "startup" });
  dispatch({ type: "SWITCH_LAYOUT", index: 2 });
  const queuedPush = controller.requestSync({ reason: "state-change" });

  const remoteConfig = createDefaultConfig("/remote/path-is-not-synced");
  remoteConfig.theme = "green";
  remoteConfig.layout = remoteConfig.layouts[1]!.layout;
  remoteConfig.activeLayoutIndex = 1;
  resolvePull({
    snapshot: remoteSnapshot(
      "core.config",
      __syncContributorInternalsForTests.collectCoreConfigPayload(remoteConfig),
      "2026-07-21T10:00:11.000Z",
    ),
    revision: 11,
    updatedAt: "2026-07-21T10:00:11.000Z",
  });
  await Promise.all([startupSync, queuedPush]);

  const pushedConfig = pushes[0]?.contributors["core.config"]?.payload as {
    activeLayoutIndex: number;
  };
  expect(state.config.theme).toBe("green");
  expect(state.config.activeLayoutIndex).toBe(2);
  expect(pushedConfig.activeLayoutIndex).toBe(2);
});

// Two clients on one account used to trade views: a pull replaced live pane
// state with the other device's, the resulting config change pushed this
// device's view straight back, and an open detail or a scrolled tab strip
// reset every few seconds on both.
test("another device's layout never replaces this device's view", async () => {
  let state = createInitialState(createDefaultConfig("/tmp/gloomberb-sync-view-test"));
  const dispatch = (action: AppAction) => {
    state = appReducer(state, action);
  };
  dispatch({
    type: "UPDATE_PLUGIN_PANE_STATE",
    paneId: "portfolio-list:main",
    pluginId: "jobs",
    key: "jobs:open",
    value: "NVDA",
  });
  dispatch({ type: "UPDATE_PANE_STATE", paneId: "ticker-detail:main", patch: { activeTabId: "filings" } });

  const remoteConfig = createDefaultConfig("/remote/path-is-not-synced");
  remoteConfig.theme = "green";
  const remotePayload = __syncContributorInternalsForTests.collectCoreConfigPayload(remoteConfig) as {
    layouts: Array<Record<string, unknown>>;
  };
  // A device on an older build still sends the view it is looking at.
  remotePayload.layouts[0] = {
    ...remotePayload.layouts[0],
    paneState: {
      "portfolio-list:main": { pluginState: { jobs: { "jobs:open": null } } },
      "ticker-detail:main": { activeTabId: "overview" },
    },
    focusedPaneId: "chat:main",
  };
  const pushes: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "remote-view",
    isAvailable: () => true,
    pullSnapshot: async () => ({
      snapshot: remoteSnapshot("core.config", remotePayload, "2026-09-20T10:00:00.000Z"),
      revision: 3,
      updatedAt: "2026-09-20T10:00:00.000Z",
    }),
    pushSnapshot: async (snapshot) => {
      pushes.push(snapshot);
      return { revision: 4, updatedAt: "2026-09-20T10:00:01.000Z" };
    },
  };
  const controller = startController({ transport, contributors: [coreConfigSyncContributor], getState: () => state, dispatch });

  await controller.requestSync({ reason: "startup" });

  expect(state.config.theme).toBe("green");
  expect(state.paneState["portfolio-list:main"]?.pluginState?.jobs?.["jobs:open"]).toBe("NVDA");
  expect(state.paneState["ticker-detail:main"]?.activeTabId).toBe("filings");

  // Looking at something else is not a reason to talk to the cloud again.
  const pushesAfterFirstSync = pushes.length;
  dispatch({
    type: "UPDATE_PLUGIN_PANE_STATE",
    paneId: "portfolio-list:main",
    pluginId: "jobs",
    key: "jobs:open",
    value: "AMD",
  });
  await controller.requestSync({ reason: "state-change" });

  expect(pushes).toHaveLength(pushesAfterFirstSync);
  expect(state.paneState["portfolio-list:main"]?.pluginState?.jobs?.["jobs:open"]).toBe("AMD");
});

test("pulls remote changes on later syncs instead of only once per session", async () => {
  const applied: unknown[] = [];
  const contributor: SyncContributor = {
    id: "test.data",
    schemaVersion: 1,
    collect: () => ({ local: applied.at(-1) ?? null }),
    apply: (payload) => {
      applied.push(payload);
    },
  };
  let remote = { value: 1 };
  let remoteRevision = 4;
  let pulls = 0;
  const transport: SyncTransport = {
    id: "repeat-pull",
    isAvailable: () => true,
    pullSnapshot: async () => {
      pulls += 1;
      return {
        snapshot: remoteSnapshot("test.data", remote, "2026-08-27T00:00:00.000Z"),
        revision: remoteRevision,
        updatedAt: "2026-08-27T00:00:00.000Z",
      };
    },
    pushSnapshot: async () => ({ revision: remoteRevision + 1, updatedAt: "2026-08-27T00:00:01.000Z" }),
  };
  const controller = startController({ transport, contributors: [contributor] });

  await controller.requestSync({ reason: "startup" });
  remote = { value: 2 };
  remoteRevision = 12;
  await controller.requestSync({ reason: "poll" });

  expect(pulls).toBe(2);
  expect(applied).toEqual([{ value: 1 }, { value: 2 }]);
});

// The cloud copy's signature is kept between polls; another write
// that comes back under a revision number seen before must not reuse it.
test("a cloud copy written again under a revision number seen before is compared as written", async () => {
  let local: unknown = { value: 1 };
  const contributor: SyncContributor = { id: "test.data", schemaVersion: 1, collect: () => local };
  let remote = remoteSnapshot("test.data", { value: 1 }, "2026-08-27T00:00:00.000Z", "device-a");
  let pushes = 0;
  const transport: SyncTransport = {
    id: "same-revision",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: remote, revision: 7, updatedAt: remote.createdAt }),
    pushSnapshot: async () => {
      pushes += 1;
      return { revision: 8, updatedAt: "2026-08-27T00:00:02.000Z" };
    },
  };
  const controller = startController({ transport, contributors: [contributor] });

  await controller.requestSync({ reason: "startup" });
  await controller.requestSync({ reason: "poll" });
  // A rewritten copy at the same revision, which this device already holds.
  remote = remoteSnapshot("test.data", { value: 2 }, "2026-08-27T00:00:01.000Z", "device-b");
  local = { value: 2 };
  await controller.requestSync({ reason: "poll" });

  expect(pushes).toBe(0);
});

test("a broker profile removed on one device stays removed after another device that synced it since syncs", async () => {
  // One cloud document, written whole by each device after it pulls.
  let cloud: { snapshot: SyncSnapshot | null; revision: number } = { snapshot: null, revision: 0 };
  const transport: SyncTransport = {
    id: "shared-cloud",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: cloud.snapshot, revision: cloud.snapshot ? cloud.revision : null, updatedAt: null }),
    pushSnapshot: async (snapshot) => {
      cloud = { snapshot, revision: cloud.revision + 1 };
      return { revision: cloud.revision, updatedAt: "2026-09-29T00:00:00.000Z" };
    },
  };
  const flex = { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", config: { token: "secret" }, lastSyncedAt: 100 };
  const signedIn = { id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, lastSyncedAt: 100 };
  const device = () => {
    let state = createInitialState({
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-removal-test"),
      brokerInstances: [flex, signedIn],
    });
    const stored: Record<string, unknown> = {};
    const controller = startController({
      transport,
      contributors: [coreConfigSyncContributor],
      getState: () => state,
      dispatch: (action) => { state = appReducer(state, action); },
      baselineStore: { load: () => stored, save: (payloads) => Object.assign(stored, payloads) },
    });
    const setBrokerInstances = (brokerInstances: AppState["config"]["brokerInstances"]) => {
      state = appReducer(state, { type: "SET_CONFIG", config: { ...state.config, brokerInstances } });
    };
    return { controller, profileIds: () => state.config.brokerInstances.map((instance) => instance.id), setBrokerInstances };
  };
  const laptop = device();
  const desktop = device();
  await laptop.controller.requestSync({ reason: "startup" });
  await desktop.controller.requestSync({ reason: "startup" });

  laptop.setBrokerInstances([flex]);
  await laptop.controller.requestSync({ reason: "state-change" });
  // The desktop's own broker sync moved the profile before it saw the removal.
  desktop.setBrokerInstances([flex, { ...signedIn, lastSyncedAt: 200 }]);
  await desktop.controller.requestSync({ reason: "state-change" });
  await laptop.controller.requestSync({ reason: "poll" });

  const cloudProfiles = (cloud.snapshot?.contributors["core.config"]?.payload as { brokerInstances: Array<{ id: string }> })
    .brokerInstances.map((instance) => instance.id);
  expect({ laptop: laptop.profileIds(), desktop: desktop.profileIds(), cloud: cloudProfiles }).toEqual({
    laptop: ["ibkr-flex"],
    desktop: ["ibkr-flex"],
    cloud: ["ibkr-flex"],
  });
});

/**
 * One account's synced copy, replaced whole by each push. Like the Cloud with
 * If-Match, it refuses a push merged with an older revision than it holds.
 */
function createSharedCloud() {
  let snapshot: SyncSnapshot | null = null;
  let revision = 0;
  return {
    config: () => snapshot?.contributors["core.config"]?.payload as AppState["config"] | undefined,
    transport: (device: { online: boolean; duringPull?: () => void; beforePush?: () => Promise<void> }): SyncTransport => ({
      id: "shared-cloud",
      isAvailable: () => true,
      pullSnapshot: async () => {
        if (!device.online) throw new Error("offline");
        const response = { snapshot, revision: snapshot ? revision : null, updatedAt: snapshot?.createdAt ?? null };
        device.duringPull?.();
        return response;
      },
      pushSnapshot: async (next, options) => {
        await device.beforePush?.();
        if (options?.baseRevision != null && options.baseRevision !== revision) throw new SyncRevisionConflictError();
        snapshot = next;
        revision += 1;
        return { revision, updatedAt: next.createdAt };
      },
    }),
  };
}

/**
 * A signed-in app on its own machine. Its config, sync baseline and memos
 * survive a restart. A terminal has no desktop windows, so like the terminal
 * app it draws a pane in one as a floating pane.
 */
function createDevice(cloud: ReturnType<typeof createSharedCloud>, name: string, { terminal = false } = {}) {
  let config = createDefaultConfig(`/devices/${name}`);
  let baseline: Record<string, unknown> | null = null;
  let memos: Record<string, unknown> | null = null;
  let state!: AppState;
  let controller: CloudSyncController | null = null;
  const device = {
    online: true,
    duringPull: undefined as (() => void) | undefined,
    beforePush: undefined as (() => Promise<void>) | undefined,
    get state() { return state; },
    dispatch: (action: AppAction) => {
      state = appReducer(state, terminal && action.type === "SET_CONFIG"
        ? { ...action, config: materializeDetachedLayouts(action.config) }
        : action);
    },
    sync: (reason: string) => controller!.requestSync({ reason }),
    /** Quits, then launches again from config.json, read the way a launch reads it. */
    restart: () => {
      config = state?.config ?? config;
      controller?.clearRuntime();
      const saved = JSON.parse(JSON.stringify(normalizeConfigForSave(config))) as Record<string, unknown>;
      const loaded = normalizeLoadedConfig(saved, config.dataDir).config;
      state = createInitialState(terminal ? materializeDetachedLayouts(loaded) : loaded);
      controller = startController({
        transport: cloud.transport(device),
        contributors: [coreConfigSyncContributor],
        getState: () => state,
        dispatch: device.dispatch,
        baselineStore: {
          load: () => baseline,
          save: (payloads) => { baseline = payloads; },
          loadMemos: () => memos,
          saveMemos: (next) => { memos = next; },
        },
      });
    },
    layoutNames: () => state.config.layouts.map((layout) => layout.name),
  };
  device.restart();
  return device;
}

const DEFAULT_LAYOUT_NAMES = createDefaultConfig("/devices/defaults").layouts.map((layout) => layout.name);

function cloudLayoutNames(cloud: ReturnType<typeof createSharedCloud>): string[] | undefined {
  return cloud.config()?.layouts.map((layout) => layout.name);
}

/** The portfolio list settles its cursor while the app starts, which rewrites the pane state its layout mirrors. */
function settleCursorAtLaunch(device: ReturnType<typeof createDevice>): () => void {
  return () => device.dispatch({ type: "UPDATE_PANE_STATE", paneId: "portfolio-list:main", patch: { cursorSymbol: "AAPL" } });
}

// A layout edited on the Mac was gone the next day once the Linux
// terminal started. Its cursor settled during its first pull, the pulled
// layout was refused as if Linux had edited its own, and its startup push
// wrote the older layout over the Mac's everywhere.
test("a layout edited on one device survives another device's launch", async () => {
  const cloud = createSharedCloud();
  const linux = createDevice(cloud, "linux");
  const mac = createDevice(cloud, "mac");
  await linux.sync("startup");
  await mac.sync("startup");

  mac.dispatch({ type: "NEW_LAYOUT", name: "Mac edit" });
  await mac.sync("state-change");
  linux.restart();
  linux.duringPull = settleCursorAtLaunch(linux);
  await linux.sync("startup");
  mac.restart();
  await mac.sync("startup");

  const edited = [...DEFAULT_LAYOUT_NAMES, "Mac edit"];
  expect({ linux: linux.layoutNames(), mac: mac.layoutNames(), cloud: cloudLayoutNames(cloud) })
    .toEqual({ linux: edited, mac: edited, cloud: edited });
});

test("a device's first sync takes the cloud's layout instead of pushing its own", async () => {
  const cloud = createSharedCloud();
  const mac = createDevice(cloud, "mac");
  await mac.sync("startup");
  mac.dispatch({ type: "NEW_LAYOUT", name: "Mac edit" });
  await mac.sync("state-change");

  const laptop = createDevice(cloud, "laptop");
  laptop.duringPull = settleCursorAtLaunch(laptop);
  await laptop.sync("startup");

  const edited = [...DEFAULT_LAYOUT_NAMES, "Mac edit"];
  expect({ laptop: laptop.layoutNames(), cloud: cloudLayoutNames(cloud) }).toEqual({ laptop: edited, cloud: edited });
});

test("a layout edited offline wins over an older cloud edit and gives way to a newer one", async () => {
  const at = (time: string) => setSystemTime(new Date(`2026-10-14T${time}:00.000Z`));
  const run = async (offlineEditAt: string, macEditAt: string) => {
    at("09:00");
    const cloud = createSharedCloud();
    const linux = createDevice(cloud, "linux");
    const mac = createDevice(cloud, "mac");
    await linux.sync("startup");
    await mac.sync("startup");
    linux.online = false;
    const edits = [
      { time: offlineEditAt, edit: async () => {
        linux.dispatch({ type: "NEW_LAYOUT", name: "Linux offline" });
        await linux.sync("state-change");
      } },
      { time: macEditAt, edit: async () => {
        mac.dispatch({ type: "NEW_LAYOUT", name: "Mac edit" });
        await mac.sync("state-change");
      } },
    ].sort((left, right) => left.time.localeCompare(right.time));
    for (const { time, edit } of edits) {
      at(time);
      await edit();
    }
    at("12:00");
    linux.restart();
    linux.online = true;
    await linux.sync("startup");
    await mac.sync("poll");
    return { linux: linux.layoutNames().at(-1), mac: mac.layoutNames().at(-1), cloud: cloudLayoutNames(cloud)?.at(-1) };
  };

  try {
    expect(await run("11:00", "10:00")).toEqual({ linux: "Linux offline", mac: "Linux offline", cloud: "Linux offline" });
    expect(await run("10:00", "11:00")).toEqual({ linux: "Mac edit", mac: "Mac edit", cloud: "Mac edit" });
  } finally {
    setSystemTime();
  }
});

test("two devices editing different settings at once both keep their edit", async () => {
  const cloud = createSharedCloud();
  const linux = createDevice(cloud, "linux");
  const mac = createDevice(cloud, "mac");
  await linux.sync("startup");
  await mac.sync("startup");

  mac.dispatch({ type: "SET_CONFIG", config: { ...mac.state.config, theme: "green" } });
  linux.dispatch({ type: "NEW_LAYOUT", name: "Linux edit" });
  // The Mac's push lands between Linux's pull and Linux's push.
  linux.beforePush = async () => {
    linux.beforePush = undefined;
    await mac.sync("state-change");
  };
  await linux.sync("state-change");
  await mac.sync("poll");

  const edited = [...DEFAULT_LAYOUT_NAMES, "Linux edit"];
  expect({
    linux: [linux.state.config.theme, linux.layoutNames()],
    mac: [mac.state.config.theme, mac.layoutNames()],
    cloud: [cloud.config()?.theme, cloudLayoutNames(cloud)],
  }).toEqual({
    linux: ["green", edited],
    mac: ["green", edited],
    cloud: ["green", edited],
  });
});

test("a terminal that syncs leaves a desktop pane in its own window", async () => {
  const cloud = createSharedCloud();
  const desktop = createDevice(cloud, "desktop");
  const layout = desktop.state.config.layout;
  desktop.dispatch({
    type: "UPDATE_LAYOUT",
    layout: {
      ...layout,
      instances: [...layout.instances, createPaneInstance("help", { instanceId: "help:window" })],
      detached: [{ instanceId: "help:window", x: 120, y: 80, width: 640, height: 420 }],
    },
  });
  await desktop.sync("startup");
  const terminal = createDevice(cloud, "terminal", { terminal: true });
  await terminal.sync("startup");
  await desktop.sync("poll");

  expect(terminal.state.config.layout.floating.map((entry) => entry.instanceId)).toContain("help:window");
  expect({
    desktop: desktop.state.config.layout.detached.map((entry) => entry.instanceId),
    cloud: cloud.config()?.layout.detached.map((entry) => entry.instanceId),
  }).toEqual({ desktop: ["help:window"], cloud: ["help:window"] });
});
