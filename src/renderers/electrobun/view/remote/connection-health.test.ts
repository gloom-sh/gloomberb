import { describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../../../core/connection-health";
import { connectRemoteConnectionHealth } from "./connection-health";

describe("remote connection health bridge", () => {
  test("disposes immediately and unsubscribes after an in-flight subscription completes", async () => {
    let completeSubscribe!: () => void;
    let listener: (event: unknown) => void = () => {};
    let disposedListeners = 0;
    let unsubscribes = 0;
    const health = new ConnectionHealthRegistry();
    const backend = new ConnectionHealthRegistry();
    backend.registerSource({ id: "remote", name: "Remote", kind: "api" });

    const dispose = connectRemoteConnectionHealth(health, {
      subscribe: () => new Promise<void>((resolve) => {
        completeSubscribe = resolve;
      }),
      unsubscribe: async () => {
        unsubscribes += 1;
      },
      onEvent: (next) => {
        listener = next;
        return () => {
          disposedListeners += 1;
        };
      },
    });

    listener(backend.getSnapshot());
    expect(health.getSnapshot().sources.map((source) => source.id)).toEqual(["remote"]);

    dispose();
    listener(backend.getSnapshot());
    expect(disposedListeners).toBe(1);
    expect(health.getSnapshot().sources).toEqual([]);
    expect(unsubscribes).toBe(0);

    completeSubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(unsubscribes).toBe(1);
  });
});
