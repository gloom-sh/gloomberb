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

// GLO-692: a layout edited on the Mac was gone the next day once the Linux
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
