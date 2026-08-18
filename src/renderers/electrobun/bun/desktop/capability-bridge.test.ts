import { expect, test } from "bun:test";
import { CapabilityRegistry } from "../../../../capabilities/registry";
import { DesktopCapabilityBridge } from "./capability-bridge";

type TestRpc = {
  key: string;
  send: { "capability.event": (_payload: { subscriptionId: string; event: unknown }) => void };
};

const rpc = (key: string): TestRpc => ({
  key,
  send: { "capability.event": () => {} },
});

test("desktop capability cancellation is window-scoped and window cleanup aborts active work", async () => {
  const signals = new Map<string, AbortSignal>();
  const registry = new CapabilityRegistry();
  registry.register("test", {
    id: "test.capability",
    kind: "plugin-service",
    name: "Test",
    operations: {
      wait: {
        kind: "query",
        rendererSafe: true,
        handler: (input: { name: string }, context) => new Promise((_resolve, reject) => {
          const signal = context.signal!;
          signals.set(input.name, signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      },
    },
  });
  const bridge = new DesktopCapabilityBridge<TestRpc>({
    getRegistry: () => registry,
    getWindowKey: (client) => client.key,
  });
  const windowA = rpc("window-a");
  const windowB = rpc("window-b");
  const invoke = (client: TestRpc, name: string) => bridge.handle(client, {
    method: "capability.invoke",
    payload: {
      capabilityId: "test.capability",
      operationId: "wait",
      payload: { name },
      invocationId: "same-client-id",
    },
  });

  const first = invoke(windowA, "first").catch((error) => error);
  const second = invoke(windowB, "second").catch((error) => error);

  await bridge.handle(windowA, {
    method: "capability.cancel",
    payload: { invocationId: "same-client-id" },
  });
  expect(await first).toMatchObject({ name: "AbortError" });
  expect(signals.get("first")?.aborted).toBe(true);
  expect(signals.get("second")?.aborted).toBe(false);

  bridge.disposeWindow("window-b");
  expect(await second).toMatchObject({ name: "AbortError" });
  expect(signals.get("second")?.aborted).toBe(true);
});
