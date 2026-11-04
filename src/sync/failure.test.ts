import { expect, spyOn, test } from "bun:test";
import type { AppState } from "../core/state/app/state";
import type { TickerRepository } from "../data/ticker-repository";
import { debugLog } from "../utils/debug-log";
import { CloudSyncController } from "./controller";
import type { SyncContributor, SyncTransport } from "./types";

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
