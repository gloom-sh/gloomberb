import { expect, spyOn, test } from "bun:test";
import type { AppState } from "../core/state/app/state";
import type { TickerRepository } from "../data/ticker-repository";
import { debugLog } from "../utils/debug-log";
import { CloudSyncController } from "./controller";
import { SYNC_SNAPSHOT_SCHEMA_VERSION, type SyncContributor, type SyncSnapshot, type SyncTransport } from "./types";

test("a contributor that cannot date an edit is logged without the error, and the others are still observed", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "sync.controller") logged.push([entry.level, entry.message, entry.data]);
  });
  const observed: string[] = [];
  const contributor = (id: string, observe: SyncContributor["observe"]): SyncContributor => ({ id, schemaVersion: 1, collect: () => ({}), observe });
  const offline: SyncTransport = {
    id: "offline",
    isAvailable: () => false,
    pullSnapshot: async () => { throw new Error("offline"); },
    pushSnapshot: async () => { throw new Error("offline"); },
  };
  const controller = new CloudSyncController();
  controller.setRuntime({
    getState: () => ({} as AppState),
    dispatch: () => {},
    tickerRepository: {} as TickerRepository,
    getContributors: () => [
      contributor("broken", () => { throw new Error("portfolio=private account=private"); }),
      contributor("working", () => { observed.push("working"); }),
    ].map((entry) => ({ pluginId: "test", contributor: entry })),
    getTransport: () => ({ pluginId: "test", transport: offline }),
  });
  try {
    await controller.requestSync();
    expect(observed).toEqual(["working"]);
    expect(controller.getStatus().phase).toBe("disabled");
    expect(logged).toEqual([["warn", expect.stringMatching(/^Observe sync contributor edit failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    controller.clearRuntime();
    stop();
    now.mockRestore();
  }
});

test("a contributor that cannot collect its data leaves sync in its error state, says nothing private, and pushes nothing", async () => {
  const remote: SyncSnapshot = {
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    appId: "gloomberb",
    clientId: "remote-client",
    createdAt: "2026-10-01T00:00:00.000Z",
    contributors: {},
  };
  const pushed: SyncSnapshot[] = [];
  const transport: SyncTransport = {
    id: "cloud",
    isAvailable: () => true,
    pullSnapshot: async () => ({ snapshot: remote, revision: 3, updatedAt: remote.createdAt }),
    pushSnapshot: async (snapshot) => {
      pushed.push(snapshot);
      return { revision: 4, updatedAt: snapshot.createdAt };
    },
  };
  const broken: SyncContributor = { id: "broken", schemaVersion: 1, collect: () => { throw new Error("portfolio=private"); } };
  const controller = new CloudSyncController();
  controller.setRuntime({
    getState: () => ({} as AppState),
    dispatch: () => {},
    tickerRepository: {} as TickerRepository,
    getContributors: () => [{ pluginId: "test", contributor: broken }],
    getTransport: () => ({ pluginId: "test", transport }),
  });
  try {
    await controller.requestSync();
    const status = controller.getStatus();
    expect(status.phase).toBe("error");
    expect(status.error).toBeString();
    expect(status.error).not.toContain("private");
    expect(pushed).toEqual([]);
  } finally {
    controller.clearRuntime();
  }
});
