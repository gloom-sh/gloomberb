import { expect, test } from "bun:test";
import { CapabilityRegistry } from "../../../../capabilities/registry";
import { DesktopCapabilityBridge } from "./capability-bridge";
import { QUOTE_EVENT_BATCH_INTERVAL_MS, QUOTE_EVENT_BATCH_KIND } from "../../shared/quote-event-batch";

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

test("quote streams reach a window as one batch per interval with the latest tick per instrument", async () => {
  const registry = new CapabilityRegistry();
  let emit: ((event: unknown) => void) | null = null;
  let disposed = 0;
  registry.register("test", {
    id: "asset-data.test",
    kind: "plugin-service",
    name: "Test",
    operations: {
      subscribeQuotes: {
        kind: "stream",
        rendererSafe: true,
        subscribe: (_input: unknown, next) => {
          emit = next;
          return () => { disposed += 1; };
        },
      },
    },
  });
  const sent: unknown[] = [];
  const client: TestRpc = { key: "window-a", send: { "capability.event": (payload) => sent.push(payload.event) } };
  const bridge = new DesktopCapabilityBridge<TestRpc>({ getRegistry: () => registry, getWindowKey: (rpc) => rpc.key });
  await bridge.handle(client, {
    method: "capability.subscribe",
    payload: { subscriptionId: "quote:1", capabilityId: "asset-data.test", operationId: "subscribeQuotes", payload: {} },
  });

  const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
  const msft = { symbol: "MSFT", exchange: "NASDAQ" };
  for (const price of [230, 231, 232]) emit!({ target: aapl, quote: { symbol: "AAPL", price } });
  emit!({ target: msft, quote: { symbol: "MSFT", price: 510 } });
  expect(sent).toEqual([]);

  await Bun.sleep(QUOTE_EVENT_BATCH_INTERVAL_MS + 20);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    kind: QUOTE_EVENT_BATCH_KIND,
    events: [{ target: aapl, quote: { price: 232 } }, { target: msft, quote: { price: 510 } }],
  });

  emit!({ target: aapl, quote: { symbol: "AAPL", price: 233 } });
  await bridge.handle(client, { method: "capability.unsubscribe", payload: { subscriptionId: "quote:1" } });
  await Bun.sleep(QUOTE_EVENT_BATCH_INTERVAL_MS + 20);
  expect(sent).toHaveLength(1);
  expect(disposed).toBe(1);
});
