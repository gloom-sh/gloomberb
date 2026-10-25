import { expect, setSystemTime, test } from "bun:test";
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
import { subscribeToCloudVerification } from "./auth-transition";
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  SyncRevisionConflictError,
  type SyncBaselineStore,
  type SyncContributor,
  type SyncSnapshot,
  type SyncSnapshotResponse,
  type SyncTransport,
} from "./types";

/** A controller syncing through `transport`; state and dispatch default to an idle app. */
function startController({
  transport,
  contributors = [],
  getState = () => ({} as AppState),
  dispatch = () => {},
  baselineStore,
}: {
  transport: SyncTransport;
  contributors?: SyncContributor[];
  getState?: () => AppState;
  dispatch?: (action: AppAction) => void;
  baselineStore?: SyncBaselineStore;
}): CloudSyncController {
  const controller = new CloudSyncController();
  controller.setRuntime({
    getState,
    dispatch,
    tickerRepository: {} as TickerRepository,
    ...(baselineStore ? { baselineStore } : {}),
    getContributors: () => contributors.map((contributor) => ({ pluginId: "test", contributor })),
    getTransport: () => ({ pluginId: "test", transport }),
  });
  return controller;
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
    isVerified: () => account !== null,
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
